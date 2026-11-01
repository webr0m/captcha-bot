import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Script } from "node:vm";
import "./helpers/ts_loader.mjs";
import { mockBot, env, message, callback } from "./helpers/bot_mock.mjs";
const { validateInitData, readSettings, saveSettings, listAdminGroups } =
  await import("../src/lib/miniapp.ts");
const { TelegramApi } = await import("../src/lib/telegram.ts");
const { handleUpdate } = await import("../src/lib/dispatcher.ts");
const { processTasks } = await import("../src/lib/tasks.ts");
const { default: worker } = await import("../src/index.ts");

function signed(overrides = {}) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 7, first_name: "Ángela %20 + 🐱" }),
    query_id: "test-query",
    signature: "telegram-signature",
    ...overrides,
  });
  const secret = createHmac("sha256", "WebAppData")
    .update(env.BOT_TOKEN)
    .digest();
  const data = [...params]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  params.set("hash", createHmac("sha256", secret).update(data).digest("hex"));
  return params.toString();
}
async function request(path, { method = "GET", body, auth = signed() } = {}) {
  return worker.fetch(
    new Request(`https://test.local${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `tma ${auth}` } : {}),
      },
      ...(method === "POST"
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    }),
    env,
    { waitUntil() {} },
  );
}
const api = () => TelegramApi.fromEnv(env);

test("Mini App valida la firma HMAC y conserva el JSON y Unicode sin doble decodificación", async () => {
  const auth = await validateInitData(signed(), env.BOT_TOKEN);
  assert.equal(auth.ok, true);
  assert.equal(auth.userId, 7);
  assert.equal(auth.firstName, "Ángela %20 + 🐱");
  assert.equal(
    (
      await validateInitData(
        signed().replace("test-query", "tampered"),
        env.BOT_TOKEN,
      )
    ).ok,
    false,
  );
  assert.equal(
    (await validateInitData(signed() + "&user=%7B%7D", env.BOT_TOKEN)).ok,
    false,
  );
});
test("Mini App rechaza sesiones caducadas, futuras, corruptas y usuarios inválidos", async () => {
  for (const data of [
    signed({ auth_date: String(Math.floor(Date.now() / 1000) - 3601) }),
    signed({ auth_date: String(Math.floor(Date.now() / 1000) + 120) }),
    signed({ auth_date: "Infinity" }),
    signed({ user: "null" }),
    signed({ user: JSON.stringify({ id: 7.5 }) }),
    signed({ user: JSON.stringify({ id: "7" }) }),
    "hash=bad",
    "",
  ]) {
    assert.equal((await validateInitData(data, env.BOT_TOKEN)).ok, false);
  }
});
test("Mini App usa los defaults del bot y lee ajustes en dos viajes a Redis", async (t) => {
  const state = mockBot(t);
  const settings = await readSettings(env, -1001);
  assert.equal(settings.captcha_enabled, true);
  assert.equal(settings.captcha_mode, "turnstile");
  assert.equal(settings.captcha_action_2, "mute");
  assert.equal(settings.nightmode.mode, "off");
  assert.equal(state.requestCount, 2);
  state.values.set("group:-1001:captcha_enabled", "false");
  state.values.set("group:-1001:captcha_mode", "math");
  assert.equal((await readSettings(env, -1001)).captcha_enabled, false);
  assert.equal((await readSettings(env, -1001)).captcha_mode, "math");
});
test("Mini App lista nombres y pagina 5/5/2 sin escanear los 80 grupos conocidos", async (t) => {
  const ids = Array.from({ length: 12 }, (_, i) => String(-1001 - i));
  const state = mockBot(t, {
    maxRequests: 50,
    values: {
      "admin_index:v1:ready": "1",
      ...Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => [
          `group_known:${-1001 - i}`,
          "true",
        ]),
      ),
    },
    sets: { "admin_groups:v1:7": ids },
  });
  const found = [];
  for (let page = 0; page < 3; page++) {
    state.resetRequestCount();
    const result = await listAdminGroups(env, api(), 7, page);
    assert.equal(result.groups.length, page === 2 ? 2 : 5);
    assert.equal(result.pages, 3);
    assert.ok(result.groups.every((g) => g.title === "Grupo de prueba"));
    assert.ok(state.requestCount <= 12);
    found.push(...result.groups.map((g) => g.id));
  }
  assert.equal(new Set(found).size, 12);
  assert.equal(
    state.commands.some((c) => c[0] === "KEYS"),
    false,
  );
});
test("Mini App comprueba acceso en vivo y no muestra grupos abandonados o de otros administradores", async (t) => {
  mockBot(t, {
    admins: [],
    values: {
      "admin_index:v1:ready": "1",
      "group_known:-1001": "true",
      "admin_access:v2:-1001:7": "true",
    },
    sets: { "admin_groups:v1:7": ["-1001", "-1002"] },
  });
  assert.deepEqual((await listAdminGroups(env, api(), 7)).groups, []);
  const response = await request("/api/miniapp/settings?gid=-1001");
  assert.equal(response.status, 403);
  const post = await request("/api/miniapp/settings", {
    method: "POST",
    body: { gid: -1001, changes: { captcha_enabled: false } },
  });
  assert.equal(post.status, 403);
});
test("Mini App valida todos los cambios antes de escribir y rechaza valores ambiguos", async (t) => {
  const state = mockBot(t, {
    values: { "group:-1001:captcha_enabled": "true" },
  });
  for (const changes of [
    { captcha_enabled: false, captcha_mode: "invalid" },
    { captcha_enabled: "false" },
    { kick_timeout: NaN },
    { antiflood_limit: 51 },
    { blocked_langs: ["invalid"] },
    {
      nightmode: {
        mode: "manual",
        city: "Santiago",
        start: "25:00",
        stop: "06:00",
      },
    },
    {
      nightmode: {
        mode: "manual",
        city: "Santiago",
        start: "22:00",
        stop: "22:00",
      },
    },
    null,
    [],
    { unknown: true },
  ]) {
    await assert.rejects(saveSettings(env, api(), -1001, 7, changes));
  }
  assert.equal(state.get("group:-1001:captcha_enabled"), "true");
  assert.equal(
    state.commands.some((c) => ["SET", "MSET", "DEL", "SADD"].includes(c[0])),
    false,
  );
});
test("Mini App guarda opciones y filtros en una transacción y conserva otros ajustes", async (t) => {
  const state = mockBot(t, {
    values: {
      "group:-1001:captcha_mode": "math",
      "nightmode:-1001": JSON.stringify({
        mode: "manual",
        city: "Ciudad",
        start: "22:00",
        stop: "06:00",
        tz_offset: 0,
      }),
    },
    sets: { "group:-1001:blocked_langs": ["en"] },
  });
  const originalFetch = globalThis.fetch;
  let transactions = 0;
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    if (String(url).endsWith("/multi-exec")) transactions++;
    return originalFetch(url, opts);
  });
  const response = await request("/api/miniapp/settings", {
    method: "POST",
    body: {
      gid: -1001,
      changes: {
        captcha_enabled: false,
        antiflood_limit: 15,
        blocked_langs: ["es", "fr"],
        link_whitelist: ["example.org"],
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(transactions, 1);
  assert.equal(state.get("group:-1001:captcha_enabled"), "false");
  assert.equal(state.get("group:-1001:captcha_mode"), "math");
  assert.equal(JSON.parse(state.get("nightmode:-1001")).city, "Ciudad");
  assert.deepEqual(
    [...state.sets.get("group:-1001:blocked_langs")],
    ["es", "fr"],
  );
});
test("Mini App desactiva modo nocturno y restaura permisos sin ejecutar un cierre pendiente", async (t) => {
  const now = Math.floor(Date.now() / 1000);
  const permissions = { can_send_messages: true, can_send_photos: false };
  const state = mockBot(t, {
    values: {
      "nightmode:-1001": JSON.stringify({ mode: "manual" }),
      "nightmode:active:-1001": "1",
      "lockdown:permissions:-1001": JSON.stringify(permissions),
    },
    sets: { tasks: [`lockdown|-1001|0|${now - 1}`] },
  });
  await saveSettings(env, api(), -1001, 7, { nightmode: { mode: "off" } });
  assert.equal(state.get("nightmode:active:-1001"), "0");
  assert.ok(state.get("lockdown:permissions:-1001"));
  t.mock.method(Date, "now", () => (now + 10) * 1000);
  await processTasks(env, api());
  const writes = state.calls.filter((c) => c.method === "setChatPermissions");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.permissions, permissions);
  assert.equal(state.get("lockdown:permissions:-1001"), null);
});
test("Mini App no vuelve a geocodificar la misma ciudad al cambiar el horario", async (t) => {
  const state = mockBot(t, {
    values: {
      "nightmode:-1001": JSON.stringify({
        mode: "manual",
        city: "Santiago, Chile",
        lat: -33,
        lon: -70,
        tz_offset: -3,
      }),
    },
  });
  await saveSettings(env, api(), -1001, 7, {
    nightmode: {
      mode: "manual",
      city: "Santiago, Chile",
      start: "23:00",
      stop: "06:00",
    },
  });
  assert.equal(JSON.parse(state.get("nightmode:-1001")).start, "23:00");
});
test("Mini App devuelve errores JSON controlados, sin caché ni secretos", async (t) => {
  mockBot(t);
  for (const [path, options, status] of [
    ["/api/miniapp/settings?gid=-1001", { auth: "" }, 401],
    ["/api/miniapp/settings?gid=7", {}, 400],
    ["/api/miniapp/settings?gid=-1.2", {}, 400],
    ["/api/miniapp/settings", { method: "POST", body: "{" }, 400],
    ["/api/miniapp/settings", { method: "POST", body: null }, 400],
    ["/api/miniapp/groups?page=-1", {}, 400],
    ["/api/miniapp/unknown", {}, 404],
    ["/api/miniapp/groups", { method: "POST", body: {} }, 405],
  ]) {
    const res = await request(path, options);
    assert.equal(res.status, status, path);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal((await res.json()).ok, false);
  }
  const previous = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, init) =>
    String(url).startsWith(env.UPSTASH_REDIS_REST_URL)
      ? Response.json({ error: "private-upstream-credential" }, { status: 400 })
      : previous(url, init),
  );
  const response = await request("/api/miniapp/groups");
  assert.equal(response.status, 503);
  assert.doesNotMatch(
    await response.text(),
    /private-upstream-credential|test-redis|test-token/,
  );
});
test("Mini App estadísticas y lectura usan las mismas claves y permisos del bot", async (t) => {
  const state = mockBot(t, {
    maxRequests: 10,
    values: {
      "stats:-1001:messages": "42",
      "group:-1001:captcha_mode": "emoji",
    },
    sets: { "known_users:-1001": ["1", "2"] },
  });
  const read = await request("/api/miniapp/settings?gid=-1001");
  const data = await read.json();
  assert.equal(data.settings.captcha_mode, "emoji");
  assert.equal(data.group.title, "Grupo de prueba");
  state.resetRequestCount();
  const stats = await (await request("/api/miniapp/stats?gid=-1001")).json();
  assert.equal(stats.stats.messages, 42);
  assert.equal(stats.stats.known_users, 2);
  assert.equal(stats.stats.members, 10);
});
test("Mini App se sirve como UTF-8 desde la única fuente, incluida la ruta con barra", async () => {
  for (const path of ["/miniapp", "/miniapp/"]) {
    const response = await request(path, { auth: "" });
    const html = await response.text();
    assert.match(html, /<title>AntiUBot — Configuración<\/title>/);
    assert.doesNotMatch(html, /ConfiguraciÃ|initData=|atob\(/);
    assert.match(html, /Authorization/);
    // Inline UI code is outside tsc's scope: catch broken scripts before deploy.
    assert.doesNotThrow(
      () => new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]),
    );
  }
});
test("Mini App abre desde grupos a través del privado y el enlace entrega el grupo correcto", async (t) => {
  const state = mockBot(t);
  await handleUpdate(env, api(), {
    message: message({ from: { id: 7 }, text: "/miniapp" }),
  });
  const groupMessage = state.calls
    .filter((c) => c.method === "sendMessage")
    .at(-1).body;
  assert.equal(
    groupMessage.reply_markup.inline_keyboard[0][0].url,
    "https://t.me/Antiubot?start=miniapp_-1001",
  );
  assert.equal(
    groupMessage.reply_markup.inline_keyboard.flat().some((b) => b.web_app),
    false,
  );
  await handleUpdate(env, api(), {
    message: message({
      chat: { id: 7, type: "private" },
      from: { id: 7 },
      text: "/start miniapp_-1001",
    }),
  });
  assert.equal(
    state.calls.filter((c) => c.method === "sendMessage").at(-1).body
      .reply_markup.inline_keyboard[0][0].web_app.url,
    "https://verify.webrom.cc/miniapp?gid=-1001",
  );
});
test("Mini App conserva /config y su botón de regreso abre el selector real", async (t) => {
  const state = mockBot(t, { values: { "group_known:-1001": "true" } });
  await handleUpdate(env, api(), {
    callback_query: callback("settings:-1001", {
      message: message({ chat: { id: 7, type: "private" } }),
    }),
  });
  assert.ok(
    state.calls
      .filter((c) => c.method === "editMessageText")
      .at(-1)
      .body.reply_markup.inline_keyboard.flat()
      .some((b) => b.web_app),
  );
  await handleUpdate(env, api(), {
    callback_query: callback("config_open", {
      message: message({ chat: { id: 7, type: "private" } }),
    }),
  });
  const menu = state.calls
    .filter((c) => c.method === "editMessageText")
    .at(-1).body;
  assert.match(menu.text, /Elige un grupo/);
  assert.equal(
    menu.reply_markup.inline_keyboard[0][0].callback_data,
    "settings:-1001",
  );
});
