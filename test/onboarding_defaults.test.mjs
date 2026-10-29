import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/ts_loader.mjs";
import { mockBot, env, message, callback } from "./helpers/bot_mock.mjs";
const { TelegramApi } = await import("../src/lib/telegram.ts");
const { handleMyChatMember, auditKnownGroups } = await import("../src/lib/onboarding.ts");
const { getCaptchaEnabled, getCaptchaMode } = await import("../src/lib/captcha.ts");
const { processTasks } = await import("../src/lib/tasks.ts");
const { handleUpdate } = await import("../src/lib/dispatcher.ts");
const { startPerformance } = await import("../src/lib/performance.ts");
const api = () => new TelegramApi(env.BOT_TOKEN);
const member = (rights = {}) => ({ status: "administrator", user: { id: 999 }, can_delete_messages: true, can_restrict_members: true, ...rights });
const change = (rights) => ({ chat: { id: -1001, type: "supergroup" }, old_chat_member: { status: "member" }, new_chat_member: member(rights) });
const advance = (t, seconds) => { const now = Date.now(); t.mock.method(Date, "now", () => now + seconds * 1000); };

test("sin configuración, la protección comienza ON y usa Turnstile", async (t) => {
  mockBot(t);
  assert.equal(await getCaptchaEnabled(env, -1001), true);
  assert.equal(await getCaptchaMode(env, -1001), "turnstile");
});

test("el primer toque de Captcha desactiva el ON implícito y el segundo lo activa", async (t) => {
  const state = mockBot(t);
  const cb = callback("setup:toggle:captcha:-1001", { message: message({ chat: { id: 7, type: "private" } }) });
  await handleUpdate(env, api(), { callback_query: cb });
  assert.equal(state.get("group:-1001:captcha_enabled"), "false");
  await handleUpdate(env, api(), { callback_query: cb });
  assert.equal(state.get("group:-1001:captcha_enabled"), "true");
});

test("auditoría pospone trabajo si las tareas del cron ya consumieron el presupuesto", async (t) => {
  const state = mockBot(t, { values: { "group_known:-1001": "true" } });
  const scope = startPerformance(env, "test");
  const { createRedis } = await import("../src/lib/redis.ts");
  for (let i = 0; i < 21; i++) await createRedis(scope.env).ping();
  const before = state.requestCount;
  const result = await auditKnownGroups(scope.env, TelegramApi.fromEnv(scope.env));
  assert.equal(result.checked, 0);
  assert.equal(state.requestCount, before);
});

test("un alta con permisos rellena ON y Turnstile sin cambiar decisiones existentes", async (t) => {
  const state = mockBot(t, { values: { "group:-1001:captcha_enabled": "false", "group:-1001:captcha_mode": "math" } });
  await handleMyChatMember(env, api(), change());
  assert.equal(state.get("group:-1001:captcha_enabled"), "false");
  assert.equal(state.get("group:-1001:captcha_mode"), "math");
  assert.ok(state.sets.get("admin_groups:v1:7").has("-1001"));
  await handleMyChatMember(env, api(), { ...change(), chat: { id: -1002, type: "group" } });
  assert.equal(state.get("group:-1002:captcha_enabled"), "true");
  assert.equal(state.get("group:-1002:captcha_mode"), "turnstile");
});

test("Turnstile predeterminado emite un enlace y respeta 50 peticiones", async (t) => {
  const state = mockBot(t, { maxRequests: 50 });
  await handleUpdate(env, api(), { message: message({ text: undefined, new_chat_members: [{ id: 42, first_name: "Nuevo" }] }) });
  assert.equal(state.get("verify:-1001:42"), "pending");
  assert.ok(state.calls.some((call) => call.method === "sendMessage" && JSON.stringify(call.body).includes("/verify?")));
  assert.ok(state.requestCount <= 50);
});

test("faltan permisos: avisa, pausa moderación y sale después del plazo", async (t) => {
  const state = mockBot(t, { telegram(method) { if (method === "getChatMember") return member({ can_restrict_members: false }); } });
  await handleMyChatMember(env, api(), change({ can_restrict_members: false }));
  assert.ok(Number(state.get("leave_scheduled:-1001")) > Date.now() / 1000);
  await handleUpdate(env, api(), { message: message({ new_chat_members: [{ id: 42 }], text: undefined }) });
  assert.equal(state.get("verify:-1001:42"), null);
  await processTasks(env, api());
  assert.equal(state.calls.some((call) => call.method === "leaveChat"), false);
  advance(t, 301);
  await processTasks(env, api());
  assert.equal(state.calls.filter((call) => call.method === "leaveChat").length, 1);
  assert.equal(state.get("group_known:-1001"), null);
});

test("recuperar permisos cancela una salida antigua aunque se pierdan de nuevo", async (t) => {
  const state = mockBot(t);
  await handleMyChatMember(env, api(), change({ can_delete_messages: false }));
  await handleMyChatMember(env, api(), change());
  advance(t, 200);
  await handleMyChatMember(env, api(), change({ can_delete_messages: false }));
  advance(t, 101);
  await processTasks(env, api());
  assert.equal(state.calls.some((call) => call.method === "leaveChat"), false);
});

test("un error temporal en leaveChat conserva la tarea y no marca al bot como salido", async (t) => {
  const state = mockBot(t, { telegram(method) {
    if (method === "getChatMember") return member({ can_delete_messages: false });
    if (method === "leaveChat") return Response.json({ ok: false, parameters: { retry_after: 60 } }, { status: 429 });
  } });
  await handleMyChatMember(env, api(), change({ can_delete_messages: false }));
  advance(t, 301);
  await processTasks(env, api());
  assert.equal(state.get("group_known:-1001"), "true");
  assert.ok([...state.sets.get("tasks")].some((task) => task.startsWith("leave|")));
});

test("auditoría inicial revisa todos los grupos sin omitir los que siguen a uno abandonado", async (t) => {
  const values = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`group_known:${-1001 - i}`, "true"]));
  const state = mockBot(t, { values, maxRequests: 50, telegram(method, body) { if (method === "getChatMember" && body.chat_id === -1001) return { status: "left" }; } });
  let complete = false;
  for (let page = 0; page < 4; page++) {
    state.resetRequestCount();
    const scope = startPerformance(env, "test");
    const result = await auditKnownGroups(scope.env, TelegramApi.fromEnv(scope.env), { force: true });
    assert.ok(state.requestCount <= 50);
    complete = result.complete;
  }
  assert.equal(complete, true);
  assert.equal(state.get("admin_index:v1:ready"), "1");
  for (let i = 1; i < 7; i++) {
    assert.equal(state.get(`group:${-1001 - i}:captcha_mode`), "turnstile");
    assert.ok(state.sets.get("admin_groups:v1:7").has(String(-1001 - i)));
  }
});

test("errores de consulta no se convierten en expulsiones del bot", async (t) => {
  const state = mockBot(t, { values: { "group_known:-1001": "true" }, telegram(method) { if (method === "getChatMember") return Response.json({ ok: false, parameters: { retry_after: 60 } }, { status: 429 }); } });
  const result = await auditKnownGroups(env, api());
  assert.equal(result.unknown, 1);
  assert.equal(state.get("leave_scheduled:-1001"), null);
  assert.equal(state.calls.some((call) => call.method === "leaveChat"), false);
});

test("la revisión periódica espera cinco minutos y no reescribe índices sin cambios", async (t) => {
  const state = mockBot(t, { values: { "group_known:-1001": "true", "group:-1001:defaults_v2": "true" }, sets: { "group_admins:v1:-1001": ["7"], "admin_groups:v1:7": ["-1001"] } });
  await auditKnownGroups(env, api());
  assert.equal(state.commands.some((cmd) => ["SADD", "SREM"].includes(cmd[0]) && /^(admin_groups|group_admins):v1:/.test(cmd[1])), false);
  const before = state.calls.length;
  assert.equal((await auditKnownGroups(env, api())).checked, 0);
  assert.equal(state.calls.length, before);
});
