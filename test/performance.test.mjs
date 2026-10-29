import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/ts_loader.mjs";
import { mockBot, env, message, callback } from "./helpers/bot_mock.mjs";
const { createRedis } = await import("../src/lib/redis.ts");
const { TelegramApi } = await import("../src/lib/telegram.ts");
const { handleUpdate } = await import("../src/lib/dispatcher.ts");
const { startPerformance } = await import("../src/lib/performance.ts");

test("MGET conserva orden, valores vacíos y ausentes; MSET conserva las claves", async (t) => {
  const state = mockBot(t, { values: { a: "", b: "0" } });
  const redis = createRedis(env);
  assert.deepEqual(await redis.mget("b", "missing", "a"), ["0", null, ""]);
  await redis.mset({ a: "nombre", b: "" });
  assert.equal(state.get("a"), "nombre");
  assert.equal(state.get("b"), "");
  const before = state.requestCount;
  assert.deepEqual(await redis.mget(), []);
  await redis.mset({});
  assert.deepEqual(await redis.pipeline([]), []);
  assert.equal(state.requestCount, before);
});

test("pipeline no reintenta escrituras si un comando falla después de ejecutar otro", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json([{ result: 1 }, { error: "WRONGTYPE" }]); });
  await assert.rejects(createRedis(env).pipeline([["INCR", "counter"], ["GET", "wrong-type"]]), /WRONGTYPE/);
  assert.equal(calls, 1);
});

test("registro de usuario mantiene nombre, alias y conjuntos con una sola petición", async (t) => {
  const state = mockBot(t, { values: { "group_known:-1001": "true" } });
  await handleUpdate(env, new TelegramApi(env.BOT_TOKEN), { message: message({ chat: { id: 7, type: "private" }, from: { id: 7, first_name: "Ana", last_name: "Pérez", username: "ana" }, text: "/config" }) });
  assert.equal(state.get("user_meta:7"), "Ana");
  assert.equal(state.get("user_meta:7:last"), "Pérez");
  assert.equal(state.get("user_meta:7:username"), "ana");
  assert.ok(state.sets.get("known_users:7").has("7"));
  assert.ok(state.sets.get("known_users:all").has("7"));
  assert.equal(state.commands.some((cmd) => cmd.slice(1).some((key) => typeof key === "string" && /^(jr:|chanverify:)/.test(key))), false);
  assert.equal(state.requestCount, 7); // one page row, no hidden verification reads
});

test("una sección de configuración mantiene valores y autorización en seis peticiones", async (t) => {
  const state = mockBot(t, { maxRequests: 6, values: { "group:-1001:kick_timeout": "90", "group:-1001:captcha_mode": "math" } });
  await handleUpdate(env, new TelegramApi(env.BOT_TOKEN), { callback_query: callback("settings:section:-1001:captcha", { message: message({ chat: { id: 7, type: "private" } }) }) });
  const edit = state.calls.find((call) => call.method === "editMessageText");
  assert.match(edit.body.text, /90s/);
  assert.match(edit.body.text, /Matemáticas/);
  assert.equal(state.calls.filter((call) => call.method === "getChatMember").length, 1);
  assert.equal(state.commands.filter((cmd) => cmd[0] === "MGET").length, 1);
});

test("getMe se comparte dentro del update, sin mezclar bots ni cachear errores", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return calls === 1 ? Response.json({ ok: false }, { status: 400 }) : Response.json({ ok: true, result: { id: calls } }); });
  const api = new TelegramApi("first");
  await assert.rejects(api.getMe());
  const [a, b] = await Promise.all([api.getMe(), api.forMessage(message()).getMe()]);
  assert.equal(a.id, b.id);
  assert.equal(calls, 2);
  assert.equal((await new TelegramApi("second").getMe()).id, 3);
});

test("retry_after largo sigue sin adelantarse ni provocar reintentos", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ ok: false, parameters: { retry_after: 60 } }, { status: 429 }); });
  await assert.rejects(new TelegramApi("test").getMe(), (error) => error.retryAfter === 60);
  assert.equal(calls, 1);
});

test("métricas separan servicios sin registrar secretos, claves o contenido", async (t) => {
  mockBot(t);
  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args));
  const trace = startPerformance({ ...env, PERFORMANCE_SAMPLE_RATE: "1" }, "test", "AMS");
  await createRedis(trace.env).mget("private-key", "secret-user-id");
  await TelegramApi.fromEnv(trace.env).getMe();
  trace.finish();
  assert.equal(logs[0][1].redis.requests, 1);
  assert.equal(logs[0][1].telegram.requests, 1);
  const text = JSON.stringify(logs);
  for (const value of [env.BOT_TOKEN, env.UPSTASH_REDIS_REST_TOKEN, "private-key", "secret-user-id"]) assert.equal(text.includes(value), false);
});
