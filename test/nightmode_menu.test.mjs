import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/ts_loader.mjs";
import { mockBot, env, message, callback } from "./helpers/bot_mock.mjs";
const { TelegramApi } = await import("../src/lib/telegram.ts");
const { handleUpdate } = await import("../src/lib/dispatcher.ts");
const { runSweep } = await import("../src/lib/tasks.ts");
const { handleChannelJoinRequest } = await import("../src/lib/channel_verify.ts");
const api = () => new TelegramApi(env.BOT_TOKEN);
const cb = (data) => callback(data, { message: message({ chat: { id: 7, type: "private" } }) });
const dm = (text) => message({ chat: { id: 7, type: "private" }, from: { id: 7 }, text });

function geodata(t) {
  const previous = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).startsWith("https://api.geonames.org/")) return Response.json({ gmtOffset: 0, time: "2026-10-29 12:00" });
    if (String(url).startsWith("https://api.sunrise-sunset.org/")) {
      const now = Date.now();
      return Response.json({ status: "OK", results: { sunrise: new Date(now - 3600000).toISOString(), sunset: new Date(now + 3600000).toISOString() } });
    }
    return previous(url, init);
  });
}

test("modo nocturno abre opciones aunque el grupo nunca se haya configurado", async (t) => {
  const state = mockBot(t);
  await handleUpdate(env, api(), { callback_query: cb("nightmode_status:-1001") });
  const edit = state.calls.find((call) => call.method === "editMessageText");
  assert.match(edit.body.text, /Todavía no está configurado/);
  const buttons = edit.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  for (const value of ["nightmode_set_auto:-1001", "nightmode_set_manual:-1001", "settings:-1001"]) assert.ok(buttons.includes(value));
});

for (const mode of ["auto", "manual"]) test(`configuración ${mode} acepta la respuesta privada y vuelve al menú`, async (t) => {
  const state = mockBot(t, { values: { "nightmode:geo:santiago, chile": JSON.stringify({ lat: -33.45, lon: -70.66 }) } });
  geodata(t);
  await handleUpdate(env, api(), { callback_query: cb(`nightmode_set_${mode}:-1001`) });
  assert.equal(JSON.parse(state.get("nightmode_pending:7")).mode, mode);
  await handleUpdate(env, api(), { message: dm(mode === "auto" ? "Santiago, Chile" : "22:00 06:00 Santiago, Chile") });
  const cfg = JSON.parse(state.get("nightmode:-1001"));
  assert.equal(cfg.mode, mode);
  assert.equal(cfg.city, "Santiago, Chile");
  assert.equal(state.get("nightmode_pending:7"), null);
  const confirmation = state.calls.filter((call) => call.method === "sendMessage").at(-1);
  assert.equal(confirmation.body.chat_id, 7);
  assert.ok(confirmation.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "settings:-1001"));
  assert.equal(state.commands.some((cmd) => cmd[0] === "KEYS" && cmd[1] === "nightmode:*"), false);
});

test("los comandos conservan prioridad y la entrada nocturna permite cancelar", async (t) => {
  const pending = JSON.stringify({ mode: "auto", chat_id: -1001 });
  const state = mockBot(t, { values: { "nightmode_pending:7": pending, "group_known:-1001": "true" } });
  await handleUpdate(env, api(), { message: dm("/config") });
  assert.equal(state.get("nightmode_pending:7"), pending);
  await handleUpdate(env, api(), { message: dm("/cancel") });
  assert.equal(state.get("nightmode_pending:7"), null);
  assert.equal(state.get("nightmode:-1001"), null);
});

test("un exadministrador no configura horarios con una conversación pendiente", async (t) => {
  const state = mockBot(t, { admins: [], values: { "nightmode_pending:7": JSON.stringify({ mode: "auto", chat_id: -1001 }), "admin_access:v2:-1001:7": "true" } });
  await handleUpdate(env, api(), { message: dm("Santiago, Chile") });
  assert.equal(state.get("nightmode:-1001"), null);
  assert.equal(state.get("nightmode_pending:7"), null);
  assert.equal(state.calls.filter((call) => call.method === "sendMessage").at(-1).body.chat_id, 7);
});

test("un código de verificación de canal conserva prioridad sobre la ciudad nocturna", async (t) => {
  const pending = JSON.stringify({ mode: "auto", chat_id: -1001 });
  const state = mockBot(t, { values: { "nightmode_pending:7": pending } });
  await handleChannelJoinRequest(env, api(), { chat: { id: -1002, type: "channel" }, from: { id: 7 }, user_chat_id: 7 });
  const code = state.get("jr:-1002:7:code");
  assert.ok(code);
  await handleUpdate(env, api(), { message: dm(code) });
  assert.ok(state.calls.some((call) => call.method === "approveChatJoinRequest"));
  assert.equal(state.get("nightmode_pending:7"), pending);
});

test("cancelar desde un mensaje antiguo no elimina la conversación de otro grupo", async (t) => {
  const pending = JSON.stringify({ mode: "manual", chat_id: -1002 });
  const state = mockBot(t, { values: { "nightmode_pending:7": pending } });
  await handleUpdate(env, api(), { callback_query: cb("nightmode_cancel:-1001") });
  assert.equal(state.get("nightmode_pending:7"), pending);
});

test("reconfigurar durante un cierre conserva el estado y restaura los permisos guardados", async (t) => {
  const permissions = { can_send_messages: true, can_send_photos: false };
  const state = mockBot(t, { values: { "nightmode_pending:7": JSON.stringify({ mode: "manual", chat_id: -1001 }), "nightmode:active:-1001": "1", "lockdown:permissions:-1001": JSON.stringify(permissions), "nightmode:geo:santiago, chile": JSON.stringify({ lat: -33.45, lon: -70.66 }) } });
  geodata(t);
  const time = (offset) => { const d = new Date(Date.now() + offset * 60000); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
  await handleUpdate(env, api(), { message: dm(`${time(1)} ${time(2)} Santiago, Chile`) });
  assert.equal(state.get("nightmode:active:-1001"), "0");
  assert.ok([...state.sets.get("tasks")].some((task) => task.includes("unlock")));
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 3000);
  await runSweep(env, api());
  assert.deepEqual(state.calls.find((call) => call.method === "setChatPermissions").body.permissions, permissions);
});
