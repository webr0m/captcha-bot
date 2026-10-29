import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/ts_loader.mjs";
import { mockBot, env, message, callback } from "./helpers/bot_mock.mjs";

const { TelegramApi } = await import("../src/lib/telegram.ts");
const { handleUpdate } = await import("../src/lib/dispatcher.ts");
const { processTasks } = await import("../src/lib/tasks.ts");
const { buildMathChallenge, markVerified, muteUser, issueCaptcha } = await import("../src/lib/captcha.ts");
const { hasGroupAccess, hasGroupAccessLive } = await import("../src/lib/access.ts");
const { handleChannelJoinRequest, handlePrivateCheck } = await import("../src/lib/channel_verify.ts");
const { issueDice } = await import("../src/lib/dice.ts");
const { default: worker } = await import("../src/index.ts");
const api = () => new TelegramApi(env.BOT_TOKEN);
const now = () => Math.floor(Date.now() / 1000);

test("webhook falla cerrado sin secreto y rechaza JSON inválido", async () => {
  const ctx = { waitUntil() { throw new Error("No update should execute"); } };
  const request = (body, secret = "test-secret") => new Request("https://worker.test/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body });
  assert.equal((await worker.fetch(request("{}"), { ...env, WEBHOOK_SECRET: "" }, ctx)).status, 503);
  assert.equal((await worker.fetch(request("{}", "wrong"), env, ctx)).status, 401);
  assert.equal((await worker.fetch(request("{"), env, ctx)).status, 400);
  assert.equal((await worker.fetch(request('{"update_id":-1}'), env, ctx)).status, 400);
});

test("exadministradores no conservan acceso por cachés permanentes o positivas", async (t) => {
  const mock = mockBot(t, { admins: [], values: { "group_access:-1001:42": "true", "admin_access:v2:-1001:42": "true" } });
  assert.equal(await hasGroupAccessLive(env, api(), -1001, 42), false);
  assert.equal(mock.get("admin_access:v2:-1001:42"), null);
  assert.equal(mock.get("group_access:-1001:42"), null);
  mock.admins.add(42);
  assert.equal(await hasGroupAccessLive(env, api(), -1001, 42), true);
  assert.ok(mock.expires.get("admin_access:v2:-1001:42") <= Date.now() + 60_000);
  assert.equal(await hasGroupAccess(env, api(), -1001, 42), true);
});

test("new_chat_members procesa a todos los miembros y usa el tópico configurado", async (t) => {
  const mock = mockBot(t, { values: { "group:-1001:captcha_enabled": "true", "group:-1001:captcha_topic": "77" } });
  await handleUpdate(env, api(), { message: message({ new_chat_members: [{ id: 42, first_name: "Uno" }, { id: 43, first_name: "Dos" }], text: undefined }) });
  const challenges = mock.calls.filter((c) => c.method === "sendMessage" && c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("simple:"));
  assert.equal(challenges.length, 2);
  assert.ok(challenges.every((c) => c.body.chat_id === -1001 && c.body.message_thread_id === 77));
  assert.equal(mock.get("verify:-1001:42"), "pending");
  assert.equal(mock.get("verify:-1001:43"), "pending");
});

test("captchas también se emiten en grupos básicos", async (t) => {
  const mock = mockBot(t, { values: { "group:-1001:captcha_enabled": "true" }, forum: false });
  await handleUpdate(env, api(), { message: message({ chat: { id: -1001, type: "group" }, is_topic_message: undefined, message_thread_id: undefined, new_chat_members: [{ id: 42 }], text: undefined }) });
  assert.equal(mock.get("verify:-1001:42"), "pending");
});

test("captchas fallidos al enviarse no dejan una expulsión activa", async (t) => {
  const mock = mockBot(t, { telegram(method) { if (method === "sendMessage") return Response.json({ ok: false, description: "message thread not found" }, { status: 400 }); } });
  await assert.rejects(issueCaptcha(env, api(), -1001, 42, { id: 42 }, message()));
  assert.equal(mock.get("verify:-1001:42"), null);
  assert.equal(mock.sets.get("tasks")?.size ?? 0, 0);
});

test("mensajes editados y comandos no pueden eludir el filtro de enlaces", async (t) => {
  const mock = mockBot(t);
  await handleUpdate(env, api(), { edited_message: message({ text: "https://spam.example/" }) });
  await handleUpdate(env, api(), { message: message({ message_id: 21, text: "/desconocido https://spam.example/" }) });
  assert.deepEqual(mock.calls.filter((c) => c.method === "deleteMessage").map((c) => c.body.message_id), [20, 21]);
  assert.ok(mock.calls.filter((c) => c.method === "sendMessage").every((c) => c.body.message_thread_id === 55));
});

test("un usuario pendiente no puede saltarse el captcha usando /test", async (t) => {
  const mock = mockBot(t, { values: { "verify:-1001:42": "pending" } });
  await handleUpdate(env, api(), { message: message({ text: "/test" }) });
  assert.equal(mock.calls.some((c) => c.method === "deleteMessage"), true);
  assert.equal(mock.calls.some((c) => c.method === "sendMessage"), false);
});

test("un administrador de grupo no puede activar un broadcast global", async (t) => {
  const mock = mockBot(t, { sets: { "known_users:-1001": ["88"] } });
  await handleUpdate(env, api(), { message: message({ from: { id: 7 }, text: "/broadcast", reply_to_message: { text: "Mensaje masivo" } }) });
  assert.equal(mock.calls.some((c) => c.method === "sendMessage" && c.body.chat_id === 88), false);
  assert.match(mock.calls.find((c) => c.method === "sendMessage").body.text, /propietario/);
});

test("la resta tiene una solución coherente incluso si el resultado es negativo", async (t) => {
  const mock = mockBot(t);
  const sequence = [0, 0.9, 0.9];
  // Después de elegir operandos se necesitan opciones distintas.
  let n = 0;
  t.mock.method(Math, "random", () => sequence.length ? sequence.shift() : ((n++ % 11) + 0.1) / 11);
  const challenge = await buildMathChallenge(env, -1001, 42, "es", 60);
  assert.equal(mock.get("math_captcha:-1001:42"), "-8");
  assert.ok(challenge.keyboard.inline_keyboard.flat().some((b) => b.text.includes("-")));
});

test("un mute breve se eleva a 60 segundos y evita restricción permanente", async (t) => {
  const mock = mockBot(t);
  await muteUser(api(), -1001, 42, 5);
  const call = mock.calls.find((c) => c.method === "restrictChatMember");
  assert.ok(call.body.until_date >= now() + 59);
});

test("verificación atómica no cuenta dos veces y rechaza desafíos caducados", async (t) => {
  const mock = mockBot(t, { values: { "verify:-1001:42": "pending", "verify_deadline:-1001:42": String(now() + 60) } });
  const results = await Promise.all([markVerified(env, api(), -1001, 42), markVerified(env, api(), -1001, 42)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(mock.get("verify:-1001:42"), "ok");
  mock.values.set("verify:-1001:43", "pending");
  mock.values.set("verify_deadline:-1001:43", String(now() - 1));
  assert.equal(await markVerified(env, api(), -1001, 43), false);
});

test("un callback antiguo no valida un nuevo desafío", async (t) => {
  const mock = mockBot(t, { values: { "verify:-1001:42": "pending", "verify_deadline:-1001:42": String(now() + 60), "ID_msgbot:-1001:42": "123" } });
  await handleUpdate(env, api(), { callback_query: callback("simple:42", { from: { id: 42 } }) });
  assert.equal(mock.get("verify:-1001:42"), "pending");
  assert.match(mock.calls.find((c) => c.method === "answerCallbackQuery").body.text, /no está disponible/);
});

test("tareas antiguas ignoran desafíos cancelados y usuarios verificados", async (t) => {
  const due = now() - 10;
  const mock = mockBot(t, { values: { "verify:-1001:43": "ok" }, sets: { tasks: [`kick|-1001|42|${due}`, `kick|-1001|43|${due}`] } });
  await processTasks(env, api());
  assert.equal(mock.calls.some((c) => c.method === "banChatMember"), false);
  assert.equal(mock.get("verify:-1001:43"), "ok");
});

test("dos cron concurrentes reclaman una tarea solo una vez", async (t) => {
  const mock = mockBot(t, { values: { "verify:-1001:42": "pending", "verify_deadline:-1001:42": String(now() - 10) }, sets: { tasks: [`kick|-1001|42|${now() - 5}`] } });
  await Promise.all([processTasks(env, api()), processTasks(env, api())]);
  assert.equal(mock.calls.filter((c) => c.method === "banChatMember").length, 1);
});

test("un error transitorio de sanción conserva la tarea para reintentar", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const mock = mockBot(t, { values: { "verify:-1001:42": "pending" }, sets: { tasks: [`kick|-1001|42|${now() - 5}`] }, telegram(method) { if (method === "banChatMember") return Response.json({ ok: false, parameters: { retry_after: 30 } }, { status: 429 }); } });
  await processTasks(env, api());
  assert.ok([...mock.sets.get("tasks")].some((task) => task.startsWith("kick|-1001|42|")));
  assert.equal(mock.get("verify:-1001:42"), "expiring");
  assert.equal(errors.length, 1);
});

test("modo nocturno restaura los permisos originales sin abrir permisos extra", async (t) => {
  const original = { can_send_messages: true, can_send_photos: false, can_invite_users: false };
  const mock = mockBot(t, { permissions: original, sets: { tasks: [`lockdown|-1001|0|${now() - 1}`] } });
  await processTasks(env, api());
  mock.sets.get("tasks").add(`unlock|-1001|0|${now() - 1}`);
  await processTasks(env, api());
  assert.deepEqual(mock.calls.filter((c) => c.method === "setChatPermissions").at(-1).body.permissions, original);
  assert.equal(mock.get("lockdown:permissions:-1001"), null);
});

test("join request usa user_chat_id y cancela ban/decline tras código correcto", async (t) => {
  const mock = mockBot(t);
  await handleChannelJoinRequest(env, api(), { chat: { id: -1002, type: "channel" }, from: { id: 42 }, user_chat_id: 90042 });
  assert.equal(mock.calls.find((c) => c.method === "sendMessage").body.chat_id, 90042);
  const code = mock.get("jr:-1002:42:code");
  await handlePrivateCheck(env, api(), { chat: { id: 42, type: "private" }, from: { id: 42 }, text: "WRONG" });
  await handlePrivateCheck(env, api(), { chat: { id: 42, type: "private" }, from: { id: 42 }, text: code });
  const future = [...mock.sets.get("tasks")].filter((item) => /^(ban|decline)\|/.test(item));
  mock.sets.set("tasks", new Set(future.map((item) => item.replace(/\d+$/, String(now() - 1)))));
  await processTasks(env, api());
  assert.equal(mock.calls.some((c) => c.method === "banChatMember" || c.method === "declineChatJoinRequest"), false);
});

for (const mode of ["button", "math", "qr", "emoji", "image", "dice"]) {
  test(`regresión: ${mode} conserva emisión, respuesta correcta y limpieza dentro de un tópico`, async (t) => {
    const mock = mockBot(t, { values: { "group:-1001:captcha_mode": mode } });
    if (mode === "dice") await issueDice(env, api(), -1001, 42, message());
    else await issueCaptcha(env, api(), -1001, 42, { id: 42, first_name: "Usuario" }, message());
    const storedMessageId = Number(mock.get("ID_msgbot:-1001:42"));
    assert.ok(storedMessageId > 0);
    assert.equal(mock.get("verify:-1001:42"), "pending");
    if (mode === "emoji" || mode === "image") {
      const answer = mock.get(`${mode}_captcha:-1001:42`);
      await handleUpdate(env, api(), { message: message({ text: answer }) });
    } else {
      let data = "simple:42";
      if (mode !== "button") {
        const answer = mock.get(mode === "dice" ? "dice_target:-1001:42" : `${mode}_captcha:-1001:42`);
        const tokenEntry = [...mock.values].find(([key, value]) => key.startsWith(`${mode}_token:-1001:42:`) && value === answer);
        assert.ok(tokenEntry);
        data = `${mode}_answer:42:${tokenEntry[0].split(":").at(-1)}`;
      }
      await handleUpdate(env, api(), { callback_query: callback(data, { from: { id: 42 }, message: message({ message_id: storedMessageId }) }) });
    }
    assert.equal(mock.get("verify:-1001:42"), "ok");
    assert.equal(mock.get("stats:-1001:verifications"), "1");
    assert.equal(mock.get("verify_deadline:-1001:42"), null);
    assert.ok(mock.calls.filter((c) => c.method.startsWith("send") && c.body.chat_id === -1001).every((c) => c.body.message_thread_id === 55));
  });
}

test("regresión: Turnstile silencioso no filtra el ID del tópico al privado", async (t) => {
  const mock = mockBot(t, { values: { "group:-1001:captcha_mode": "turnstile", "group:-1001:silent_mode": "true" } });
  await issueCaptcha(env, api(), -1001, 42, { id: 42 }, message());
  const dm = mock.calls.find((c) => c.method === "sendMessage");
  assert.equal(dm.body.chat_id, 42);
  assert.equal(dm.body.message_thread_id, undefined);
  assert.match(dm.body.reply_markup.inline_keyboard[0][0].url, /chat_id=-1001&user_id=42/);
  assert.equal(mock.get("verify:-1001:42"), "pending");
});

test("regresión: Turnstile vuelve al tópico si no puede enviar el privado", async (t) => {
  const mock = mockBot(t, { values: { "group:-1001:captcha_mode": "turnstile", "group:-1001:silent_mode": "true" }, telegram(method, body) {
    if (method === "sendMessage" && body.chat_id === 42) return Response.json({ ok: false }, { status: 403 });
  } });
  await issueCaptcha(env, api(), -1001, 42, { id: 42 }, message());
  assert.equal(mock.calls.filter((c) => c.method === "sendMessage").at(-1).body.message_thread_id, 55);
  assert.equal(mock.get("verify:-1001:42"), "pending");
});
