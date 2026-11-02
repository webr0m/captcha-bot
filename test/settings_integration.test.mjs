import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/ts_loader.mjs";
import { mockBot, env, message, callback } from "./helpers/bot_mock.mjs";
const { TelegramApi } = await import("../src/lib/telegram.ts");
const { handleUpdate } = await import("../src/lib/dispatcher.ts");
const { readSettings, saveSettings, MINIAPP_URL } = await import(
  "../src/lib/miniapp.ts"
);
const { ensureMiniAppMenu } = await import("../src/lib/miniapp_menu.ts");
const { processTasks } = await import("../src/lib/tasks.ts");
const { default: worker } = await import("../src/index.ts");
const api = () => TelegramApi.fromEnv(env);
const cb = (data) =>
  callback(data, { message: message({ chat: { id: 7, type: "private" } }) });
const dm = (text) =>
  message({ chat: { id: 7, type: "private" }, from: { id: 7 }, text });
const run = (data) => handleUpdate(env, api(), { callback_query: cb(data) });
const input = (text) => handleUpdate(env, api(), { message: dm(text) });

test("/config muestra los nuevos controles y comparte límites con la Mini App", async (t) => {
  const state = mockBot(t, { maxRequests: 50 });
  await run("settings:section:-1001:moderation");
  let view = state.calls
    .filter((c) => c.method === "editMessageText")
    .at(-1).body;
  for (const data of ["cfg:flood:-1001", "cfg:links:-1001:0"])
    assert.ok(
      view.reply_markup.inline_keyboard
        .flat()
        .some((b) => b.callback_data === data),
    );
  await run("cfg:set:-1001:flood_limit:20");
  assert.equal((await readSettings(env, -1001)).antiflood_limit, 20);
  state.resetRequestCount();
  await saveSettings(env, api(), -1001, 7, {
    antiflood_limit: 6,
    antiflood_mute: 90,
  });
  await run("cfg:flood:-1001");
  view = state.calls.filter((c) => c.method === "editMessageText").at(-1).body;
  assert.match(view.text, /6 mensajes/);
  assert.match(view.text, /1.5 minutos \(90 segundos\)/);
});
test("/config permite tiempo exacto, límite exacto y duración fraccionaria", async (t) => {
  const state = mockBot(t, { maxRequests: 50 });
  for (const [field, value, key, expected] of [
    ["timeout", "91", "kick_timeout", "91"],
    ["flood_limit", "15", "antiflood_limit", "15"],
    ["flood_mute", "1,5", "antiflood_mute", "90"],
  ]) {
    state.resetRequestCount();
    await run(`cfg:input:-1001:${field}`);
    await input(value);
    assert.equal(state.get(`group:-1001:${key}`), expected);
    assert.equal(state.get("config_input:v1:7"), null);
    assert.ok(state.requestCount < 50);
  }
});
test("entradas inválidas no cambian ajustes; los comandos y /cancel conservan su prioridad", async (t) => {
  const state = mockBot(t, {
    values: {
      "group:-1001:antiflood_limit": "12",
      "group_known:-1001": "true",
    },
  });
  await run("cfg:input:-1001:flood_limit");
  const pending = state.get("config_input:v1:7");
  await input("51");
  assert.equal(state.get("group:-1001:antiflood_limit"), "12");
  assert.equal(state.get("config_input:v1:7"), pending);
  await input("/config");
  assert.equal(state.get("config_input:v1:7"), pending);
  await input("/cancel");
  assert.equal(state.get("config_input:v1:7"), null);
});
test("un exadministrador no guarda ajustes pendientes aunque existan cachés antiguas", async (t) => {
  const state = mockBot(t, { values: { "admin_access:v2:-1001:7": "true" } });
  await run("cfg:input:-1001:timeout");
  state.admins.delete(7);
  await input("180");
  assert.equal(state.get("group:-1001:kick_timeout"), null);
  assert.equal(state.get("config_input:v1:7"), null);
  await run("cfg:set:-1001:flood_limit:3");
  assert.equal(state.get("group:-1001:antiflood_limit"), null);
});
test("solicitudes nocturnas y ajustes exactos se sustituyen sin consumir códigos de canal", async (t) => {
  const state = mockBot(t);
  await run("nightmode_set_auto:-1001");
  assert.ok(state.get("nightmode_pending:7"));
  await run("cfg:input:-1001:timeout");
  assert.equal(state.get("nightmode_pending:7"), null);
  await run("nightmode_set_manual:-1001");
  assert.equal(state.get("config_input:v1:7"), null);
  await run("cfg:input:-1001:timeout");
  const pending = state.get("config_input:v1:7");
  state.values.set("jr:last_channel:7", "-2001");
  state.values.set("jr:-2001:7:code", "ABC123");
  await input("ABC123");
  assert.ok(state.calls.some((c) => c.method === "approveChatJoinRequest"));
  assert.equal(state.get("config_input:v1:7"), pending);
});
test("un botón Cancelar anterior no borra una solicitud nueva del mismo grupo", async (t) => {
  const state = mockBot(t);
  await run("cfg:input:-1001:timeout");
  const old = JSON.parse(state.get("config_input:v1:7"));
  await run("cfg:input:-1001:flood_limit");
  const current = state.get("config_input:v1:7");
  await run(`cfg:cancel:-1001:${old.nonce}`);
  assert.equal(state.get("config_input:v1:7"), current);
});
test("guardar una respuesta antigua no elimina una solicitud creada durante el guardado", async (t) => {
  let armed = false,
    state;
  const replacement = JSON.stringify({
    gid: -1002,
    field: "flood_limit",
    nonce: "new",
  });
  state = mockBot(t, {
    telegram(method) {
      if (armed && method === "getChatMember") {
        armed = false;
        state.values.set("config_input:v1:7", replacement);
      }
    },
  });
  await run("cfg:input:-1001:timeout");
  armed = true;
  await input("120");
  assert.equal(state.get("group:-1001:kick_timeout"), "120");
  assert.equal(state.get("config_input:v1:7"), replacement);
});
test("enlaces: añadir, quitar y reemplazar comparten la lista y validan antes de escribir", async (t) => {
  const state = mockBot(t, {
    values: { "group:-1001:link_whitelist": "old.example.org" },
  });
  await run("cfg:input:-1001:whitelist_add");
  await input("example.com\nhttps://other.org");
  assert.deepEqual((await readSettings(env, -1001)).link_whitelist, [
    "old.example.org",
    "example.com",
    "other.org",
  ]);
  await run("cfg:input:-1001:whitelist_replace");
  const before = state.get("group:-1001:link_whitelist");
  await input("valid.org\nnot a domain");
  assert.equal(state.get("group:-1001:link_whitelist"), before);
  await input("new.org");
  assert.deepEqual((await readSettings(env, -1001)).link_whitelist, [
    "new.org",
  ]);
  await run("cfg:input:-1001:whitelist_remove");
  await input("webrom.cc");
  assert.equal(state.get("group:-1001:link_whitelist"), "new.org");
  await input("new.org");
  assert.deepEqual((await readSettings(env, -1001)).link_whitelist, []);
});
test("enlaces: la lista larga se pagina y vaciar exige confirmar", async (t) => {
  const entries = Array.from({ length: 25 }, (_, i) => `example${i}.org`);
  const state = mockBot(t, {
    values: { "group:-1001:link_whitelist": entries.join(",") },
  });
  await run("cfg:links:-1001:2");
  const view = state.calls
    .filter((c) => c.method === "editMessageText")
    .at(-1).body;
  assert.match(view.text, /Página 3 de 3/);
  assert.match(view.text, /example24/);
  assert.ok(view.text.length < 4096);
  await run("cfg:clear_links:-1001");
  assert.equal(state.get("group:-1001:link_whitelist"), entries.join(","));
  await run("cfg:confirm_clear:-1001");
  assert.equal(state.get("group:-1001:link_whitelist"), "");
});
test("desactivar nocturno desde Telegram restaura permisos con la cola existente", async (t) => {
  const now = Math.floor(Date.now() / 1000),
    permissions = { can_send_messages: true, can_send_photos: false };
  const state = mockBot(t, {
    values: {
      "nightmode:-1001": JSON.stringify({ mode: "manual" }),
      "nightmode:active:-1001": "1",
      "lockdown:permissions:-1001": JSON.stringify(permissions),
      "nightmode_pending:7": JSON.stringify({ mode: "auto", chat_id: -1001 }),
    },
  });
  await run("cfg:night_off:-1001");
  assert.equal(JSON.parse(state.get("nightmode:-1001")).mode, "off");
  assert.equal(state.get("nightmode_pending:7"), null);
  t.mock.method(Date, "now", () => (now + 10) * 1000);
  await processTasks(env, api());
  assert.deepEqual(
    state.calls.find((c) => c.method === "setChatPermissions").body.permissions,
    permissions,
  );
});
test("el botón Menú se configura y verifica una sola vez sin enviar mensajes", async (t) => {
  const state = mockBot(t);
  await ensureMiniAppMenu(env, api());
  await ensureMiniAppMenu(env, api());
  const sets = state.calls.filter((c) => c.method === "setChatMenuButton");
  assert.equal(sets.length, 1);
  assert.equal(sets[0].body.menu_button.web_app.url, MINIAPP_URL);
  assert.equal(sets[0].body.chat_id, undefined);
  assert.ok(state.calls.some((c) => c.method === "getChatMenuButton"));
  assert.equal(
    state.calls.some((c) => c.method === "sendMessage"),
    false,
  );
});
test("un Menú que Telegram no confirma se vuelve a intentar", async (t) => {
  let fail = true;
  const state = mockBot(t, {
    telegram(method) {
      if (fail && method === "getChatMenuButton") return { type: "commands" };
    },
  });
  await assert.rejects(ensureMiniAppMenu(env, api()));
  assert.equal(state.get("telegram_menu:miniapp:v1"), null);
  fail = false;
  await ensureMiniAppMenu(env, api());
  assert.equal(state.get("telegram_menu:miniapp:v1"), MINIAPP_URL);
});
test("banner publicitario aislado: código HTTPS y sin privilegios de la Mini App", async () => {
  const response = await worker.fetch(
    new Request("https://test.local/miniapp/ad"),
    env,
    {},
  );
  const html = await response.text(),
    policy = response.headers.get("Content-Security-Policy");
  assert.equal(response.status, 200);
  assert.match(policy, /sandbox allow-scripts/);
  assert.doesNotMatch(policy, /allow-same-origin|allow-top-navigation/);
  assert.match(html, /https:\/\/data527.click\/js\/responsive.js/);
  assert.match(html, /8723667a248063be5c06\/16dd7e0692/);
  assert.doesNotMatch(html, /telegram-web-app|initData|BOT_TOKEN/);
  const app = await (
    await worker.fetch(new Request("https://test.local/miniapp"), env, {})
  ).text();
  assert.match(app, /data-src="\/miniapp\/ad"/);
  assert.doesNotMatch(app, /src="https:\/\/data527/);
});
