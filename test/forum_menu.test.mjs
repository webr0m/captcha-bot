import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/ts_loader.mjs";
import { mockBot, env, message, callback } from "./helpers/bot_mock.mjs";

const { TelegramApi } = await import("../src/lib/telegram.ts");
const { topicContext, topicParameters, parseTopicId } = await import("../src/lib/forum.ts");
const { handleUpdate } = await import("../src/lib/dispatcher.ts");
const { buildSettingsView, SECTIONS } = await import("../src/lib/settings_menu.ts");
const state = { timeout: 60, captcha: true, mode: "button", action: "kick", admRep: false, action2: "mute", delBot: true, delSys: true, silentMode: false, cas: true, antiFlood: true, antiLink: true, isForum: true, groupName: "Grupo de prueba" };
const api = () => new TelegramApi(env.BOT_TOKEN);
const privateCallback = (data, userId = 7) => callback(data, { from: { id: userId }, message: message({ message_id: 100, chat: { id: 7, type: "private" }, is_topic_message: undefined, message_thread_id: undefined }) });

test("solo los mensajes de tópicos válidos generan contexto de foro", () => {
  assert.deepEqual(topicContext(message()), { chatId: -1001, threadId: 55 });
  assert.equal(topicContext(message({ is_topic_message: false })), undefined);
  assert.equal(topicContext(message({ message_thread_id: -1 })), undefined);
  assert.equal(topicContext(message({ chat: { id: 42, type: "private" } })), undefined);
  assert.deepEqual(topicParameters({ chatId: -1001, threadId: 1 }, -1001), {});
  assert.deepEqual(topicParameters({ chatId: -1001, threadId: 55 }, 42), {});
  for (const value of [null, "", "0", "-4", "NaN", "1.5", "9007199254740993"]) assert.equal(parseTopicId(value), undefined);
});

test("texto, imágenes, stickers y acciones siguen el tópico sin contaminar otros chats", async (t) => {
  const mock = mockBot(t);
  const scoped = api().forMessage(message());
  await Promise.all([
    scoped.sendMessage(-1001, "hola"), scoped.sendPhoto(-1001, "photo", "caption"), scoped.sendSticker(-1001, "sticker"), scoped.sendChatAction(-1001, "typing"),
    scoped.sendMessage(42, "privado"), scoped.sendMessage(-1002, "otro grupo"), scoped.deleteMessage(-1001, 20), scoped.editMessageText(-1001, 20, "editado"),
  ]);
  for (const call of mock.calls) {
    const shouldHaveThread = call.body.chat_id === -1001 && call.method.startsWith("send");
    assert.equal(call.body.message_thread_id, shouldHaveThread ? 55 : undefined);
  }
  await scoped.sendMessage(-1001, "destino explícito", { message_thread_id: 77 });
  assert.equal(mock.calls.at(-1).body.message_thread_id, 77);
});

test("updates concurrentes mantienen cada respuesta en su propio tópico", async (t) => {
  const mock = mockBot(t);
  const shared = api();
  await Promise.all([
    handleUpdate(env, shared, { message: message({ text: "/test", message_thread_id: 55 }) }),
    handleUpdate(env, shared, { message: message({ text: "/test", message_thread_id: 66, from: { id: 43 } }) }),
  ]);
  assert.deepEqual(mock.calls.filter((c) => c.method === "sendMessage").map((c) => c.body.message_thread_id).sort(), [55, 66]);
});

test("menú principal breve y secciones con ayuda y vuelta", () => {
  const home = buildSettingsView(state, -1001);
  assert.ok(home.keyboard.inline_keyboard.length <= 7);
  const buttons = home.keyboard.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === "topics:-1001"));
  assert.ok(buttons.some((b) => b.callback_data.endsWith(":help")));
  assert.equal(buttons.some((b) => b.callback_data.startsWith("mode:set:")), false);
  for (const section of SECTIONS) {
    const view = buildSettingsView(state, -1001234567890123, section);
    assert.ok(view.text.length < 4096);
    for (const button of view.keyboard.inline_keyboard.flat()) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    if (section !== "home") assert.ok(view.keyboard.inline_keyboard.flat().some((b) => b.callback_data === "settings:-1001234567890123"));
  }
  assert.equal(buildSettingsView({ ...state, isForum: false }, -1001).keyboard.inline_keyboard.flat().some((b) => b.callback_data.startsWith("topics:")), false);
});

test("/config abre lista, configuración, submenú y ayuda sin salir del mismo mensaje", async (t) => {
  const mock = mockBot(t, { sets: { "group_known:unused": [] }, values: { "group_known:-1001": "true" } });
  await handleUpdate(env, api(), { message: { chat: { id: 7, type: "private" }, from: { id: 7 }, message_id: 1, text: "/config" } });
  const chooser = mock.calls.find((c) => c.method === "sendMessage");
  assert.ok(chooser.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "settings:-1001"));
  assert.equal(chooser.body.reply_markup.inline_keyboard[0][0].text, "⚙️ Grupo de prueba");
  for (const data of ["settings:-1001", "settings:section:-1001:captcha", "settings:section:-1001:help", "settings:section:-1001:help_topics", "settings:-1001"]) {
    await handleUpdate(env, api(), { callback_query: privateCallback(data) });
    const edited = mock.calls.filter((c) => c.method === "editMessageText").at(-1);
    assert.equal(edited.body.chat_id, 7);
    assert.equal(edited.body.message_id, 100);
  }
});

test("toggles y cambios de modo permanecen en el submenú correspondiente", async (t) => {
  const mock = mockBot(t);
  for (const [data, title] of [["setup:toggle:antiflood:-1001", "🛡️ Moderación"], ["setup:toggle:delbot:-1001", "🧹 Mensajes"], ["mode:set:-1001:math", "🔐 Captcha"], ["setup:timeout:add:-1001", "🔐 Captcha"]]) {
    await handleUpdate(env, api(), { callback_query: privateCallback(data) });
    assert.ok(mock.calls.filter((c) => c.method === "editMessageText").at(-1).body.text.startsWith(title));
  }
  assert.equal(mock.get("group:-1001:antiflood_enabled"), "false");
  assert.equal(mock.get("group:-1001:delete_bot_messages"), "false");
  assert.equal(mock.get("group:-1001:captcha_mode"), "math");
  assert.equal(mock.get("group:-1001:kick_timeout"), "65");
});

test("un exadministrador no puede cambiar ajustes ni el destino de los tópicos", async (t) => {
  const mock = mockBot(t, { admins: [], values: { "group_access:-1001:7": "true" } });
  for (const data of ["settings:section:-1001:captcha", "setup:toggle:captcha:-1001", "topic:set:-1001:1:0"]) {
    await handleUpdate(env, api(), { callback_query: privateCallback(data) });
  }
  assert.equal(mock.get("group:-1001:captcha_enabled"), null);
  assert.equal(mock.get("group:-1001:captcha_topic"), null);
  assert.equal(mock.calls.filter((c) => c.method === "editMessageText").length, 0);
});

test("menú de tópicos descubre nombres, permite elegir, paginar y volver a automático", async (t) => {
  const mock = mockBot(t);
  await handleUpdate(env, api(), { message: message({ from: { id: 7 }, text: undefined, forum_topic_created: { name: "Bienvenida" } }) });
  for (let id = 56; id < 65; id++) {
    mock.sets.get("forum:topics:-1001").add(String(id));
    mock.values.set(`forum:topic:-1001:${id}`, JSON.stringify({ id, name: `Tema ${id}`, closed: false }));
  }
  await handleUpdate(env, api(), { callback_query: privateCallback("topics:-1001") });
  let view = mock.calls.filter((c) => c.method === "editMessageText").at(-1).body;
  assert.ok(view.reply_markup.inline_keyboard.flat().some((b) => b.text.includes("Bienvenida")));
  await handleUpdate(env, api(), { callback_query: privateCallback("topics:-1001:1") });
  view = mock.calls.filter((c) => c.method === "editMessageText").at(-1).body;
  assert.ok(view.reply_markup.inline_keyboard.flat().some((b) => b.text.includes("Tema 64")));
  await handleUpdate(env, api(), { callback_query: privateCallback("topic:set:-1001:55:0") });
  assert.equal(mock.get("group:-1001:captcha_topic"), "55");
  await handleUpdate(env, api(), { callback_query: privateCallback("topic:set:-1001:auto:0") });
  assert.equal(mock.get("group:-1001:captcha_topic"), null);
});

test("tópicos cerrados o no registrados no se pueden seleccionar", async (t) => {
  const mock = mockBot(t);
  await handleUpdate(env, api(), { message: message({ text: undefined, forum_topic_closed: {} }) });
  for (const id of [55, 999]) await handleUpdate(env, api(), { callback_query: privateCallback(`topic:set:-1001:${id}:0`) });
  assert.equal(mock.get("group:-1001:captcha_topic"), null);
  await handleUpdate(env, api(), { message: message({ text: undefined, forum_topic_reopened: {} }) });
  await handleUpdate(env, api(), { callback_query: privateCallback("topic:set:-1001:55:0") });
  assert.equal(mock.get("group:-1001:captcha_topic"), "55");
});

test("/topico configura destino sin alterar el hilo de su respuesta", async (t) => {
  const mock = mockBot(t);
  await handleUpdate(env, api(), { message: message({ from: { id: 7 }, text: "/topico captcha aqui" }) });
  assert.equal(mock.get("group:-1001:captcha_topic"), "55");
  assert.equal(mock.calls.filter((c) => c.method === "sendMessage").at(-1).body.message_thread_id, 55);
});

test("/config dentro de un tópico ofrece el enlace al privado", async (t) => {
  const mock = mockBot(t);
  await handleUpdate(env, api(), { message: message({ from: { id: 7 }, text: "/config" }) });
  const reply = mock.calls.filter((c) => c.method === "sendMessage").at(-1).body;
  assert.equal(reply.message_thread_id, 55);
  assert.match(reply.reply_markup.inline_keyboard[0][0].url, /start=config_-1001/);
});

test("los nombres se conservan al refrescar y volver a Mis grupos", async (t) => {
  const mock = mockBot(t, { values: { "group_known:-1001": "true" } });
  for (const data of ["settings:groupupdate:7", "setup:back:back:-1001"]) {
    await handleUpdate(env, api(), { callback_query: privateCallback(data) });
    const view = mock.calls.filter((c) => c.method === "editMessageText").at(-1).body;
    assert.equal(view.reply_markup.inline_keyboard[0][0].text, "⚙️ Grupo de prueba");
    assert.equal(view.reply_markup.inline_keyboard[0][0].callback_data, "settings:-1001");
  }
});

test("un nombre inaccesible tiene respaldo sin impedir mostrar otros grupos", async (t) => {
  const mock = mockBot(t, { values: { "group_known:-1001": "true", "group_known:-1002": "true" }, telegram(method, body) {
    if (method === "getChat" && body.chat_id === -1002) return Response.json({ ok: false, description: "chat not found" }, { status: 400 });
  } });
  await handleUpdate(env, api(), { message: { chat: { id: 7, type: "private" }, from: { id: 7 }, message_id: 1, text: "/config" } });
  const buttons = mock.calls.filter((c) => c.method === "sendMessage").at(-1).body.reply_markup.inline_keyboard.flat().filter((b) => /^settings:-/.test(b.callback_data));
  assert.deepEqual(buttons.map((b) => b.text), ["⚙️ Grupo de prueba", "⚙️ Grupo -1002"]);
});

test("/config responde con 80 grupos conocidos dentro del límite real de 50 subrequests", async (t) => {
  const nativeSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => ms < 1000 ? nativeSetTimeout(fn, 0, ...args) : nativeSetTimeout(fn, ms, ...args));
  const values = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`group_known:${-1001 - i}`, "true"]));
  const mock = mockBot(t, { values, maxRequests: 50 });
  await handleUpdate(env, api(), { message: { chat: { id: 7, type: "private" }, from: { id: 7 }, message_id: 1, text: "/config" } });
  assert.ok(mock.requestCount <= 50);
  const reply = mock.calls.find((c) => c.method === "sendMessage");
  assert.ok(reply, "Debe enviar la respuesta antes de agotar el presupuesto de subrequests");
  assert.ok(reply.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "settings:groups:1"));
});

test("todas las páginas, Volver y el refresco antiguo respetan el límite de subrequests", async (t) => {
  const values = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`group_known:${-1001 - i}`, "true"]));
  const mock = mockBot(t, { values, maxRequests: 50 });
  const seen = new Set();
  for (let page = 0; page < 16; page++) {
    mock.resetRequestCount();
    await handleUpdate(env, api(), { callback_query: privateCallback(`settings:groups:${page}`) });
    assert.ok(mock.requestCount <= 50);
    const view = mock.calls.filter((c) => c.method === "editMessageText").at(-1).body;
    for (const button of view.reply_markup.inline_keyboard.flat()) if (/^settings:-/.test(button.callback_data)) seen.add(button.callback_data);
  }
  assert.equal(seen.size, 80);
  for (const data of ["settings:groupupdate:7", "setup:back:back:-1001"]) {
    mock.resetRequestCount();
    await handleUpdate(env, api(), { callback_query: privateCallback(data) });
    assert.ok(mock.requestCount <= 50);
  }
});

test("la lista muestra cinco grupos por página y conserva el último sin omisiones", async (t) => {
  const values = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`group_known:${-1001 - i}`, "true"]));
  const mock = mockBot(t, { values });
  for (const [page, expected] of [[0, 5], [1, 5], [2, 2]]) {
    await handleUpdate(env, api(), { callback_query: privateCallback(`settings:groups:${page}`) });
    const view = mock.calls.filter((call) => call.method === "editMessageText").at(-1).body;
    const groups = view.reply_markup.inline_keyboard.flat().filter((button) => /^settings:-/.test(button.callback_data));
    assert.equal(groups.length, expected);
    assert.match(view.text, new RegExp(`Página ${page + 1} de 3`));
  }
});

test("una página sin acceso permite continuar y no muestra nombres de grupos ajenos", async (t) => {
  const values = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`group_known:${-1001 - i}`, "true"]));
  const mock = mockBot(t, { values, admins: [], maxRequests: 50 });
  await handleUpdate(env, api(), { message: { chat: { id: 7, type: "private" }, from: { id: 7 }, message_id: 1, text: "/config" } });
  const view = mock.calls.find((c) => c.method === "sendMessage").body;
  assert.match(view.text, /esta página/);
  assert.equal(view.reply_markup.inline_keyboard.flat().some((b) => /^settings:-/.test(b.callback_data)), false);
  assert.equal(mock.calls.some((c) => c.method === "getChat"), false);
  assert.ok(view.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "settings:groups:1"));
});

test("el listado verifica administradores en vivo sin escribir una caché por fila", async (t) => {
  const mock = mockBot(t, { values: { "group_known:-1001": "true", "group_access:-1001:7": "true" }, admins: [] });
  await handleUpdate(env, api(), { message: { chat: { id: 7, type: "private" }, from: { id: 7 }, message_id: 1, text: "/config" } });
  assert.ok(mock.calls.some((c) => c.method === "getChatMember" && c.body.chat_id === -1001 && c.body.user_id === 7));
  assert.equal(mock.commands.some((c) => String(c[1]).startsWith("admin_access:")), false);
  const view = mock.calls.find((c) => c.method === "sendMessage").body;
  assert.equal(view.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "settings:-1001"), false);
});

test("un foro con 80 tópicos solo consulta los nombres de la página visible", async (t) => {
  const ids = Array.from({ length: 80 }, (_, i) => String(10 + i));
  const values = Object.fromEntries(ids.map((id) => [`forum:topic:-1001:${id}`, JSON.stringify({ id: Number(id), name: `Tema ${id}`, closed: false })]));
  values["group:-1001:captcha_topic"] = "89";
  const mock = mockBot(t, { values, sets: { "forum:topics:-1001": ids }, maxRequests: 50 });
  await handleUpdate(env, api(), { callback_query: privateCallback("topics:-1001") });
  assert.ok(mock.requestCount <= 50);
  const view = mock.calls.filter((c) => c.method === "editMessageText").at(-1).body;
  assert.match(view.text, /Destino actual: Tema 89/);
  assert.equal(mock.commands.filter((c) => c[0] === "GET" && String(c[1]).startsWith("forum:topic:")).length, 9);
  mock.resetRequestCount();
  await handleUpdate(env, api(), { callback_query: privateCallback("topic:set:-1001:89:9") });
  assert.ok(mock.requestCount <= 50);
  assert.equal(mock.get("group:-1001:captcha_topic"), "89");
});
