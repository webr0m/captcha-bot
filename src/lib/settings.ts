/**
 * Módulo settings — menú de configuración por grupo (/config, callbacks setup:*, pop:*, mode:set, action:set, lang, nightmode_status, summary, etc).
 * Portado desde `bot/modules/settings_menu.lua`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import * as captcha from "./captcha";
import { handleNightmodeCallback } from "./nightmode";
import { handleSummaryCallback } from "./config_summary";
import { handleLanguageCallback } from "./block_lang";
import { handleKnownCallback } from "./known_users";

const MODES: Record<string, string> = {
  emoji: "🧩 Emojis",
  button: "🔘 Button",
  turnstile: "🌐 Turnstile",
  math: "🤓 Math",
  image: "🏞️ Image",
  qr: "⛶ QR",
  dice: "🎲 Dice (Game)",
};

const ACTIONS: Record<string, string> = {
  ban: "🔨 Ban",
  kick: "🪓 Kick",
};

const ACTIONS_2: Record<string, string> = {
  mute: "🤫 Mute",
  restrict: "🚫 Restrict",
};

function secondsToHuman(seconds: number): string {
  const units = [
    { name: "año", secs: 31536000 },
    { name: "mes", secs: 2592000 },
    { name: "semana", secs: 604800 },
    { name: "día", secs: 86400 },
    { name: "hora", secs: 3600 },
    { name: "minuto", secs: 60 },
    { name: "segundo", secs: 1 },
  ];
  const parts: string[] = [];
  let remaining = seconds;
  for (const u of units) {
    const value = Math.floor(remaining / u.secs);
    if (value > 0) {
      parts.push(`${value} ${u.name}${value > 1 ? "s" : ""}`);
      remaining = remaining % u.secs;
    }
  }
  return parts.join(", ");
}

interface SettingsState {
  timeout: number;
  captcha: boolean;
  mode: string;
  action: string;
  admRep: boolean;
  action2: string;
  delBot: boolean;
  delSys: boolean;
  silentMode: boolean;
  groupName?: string;
}

async function getSettingsState(env: EnvWithBot, gid: number): Promise<SettingsState> {
  const rdb = createRedis(env);
  const timeout = Number((await rdb.get(`group:${gid}:kick_timeout`)) ?? 60);
  const captcha = (await rdb.get(`group:${gid}:captcha_enabled`)) === "true";
  const mode = (await rdb.get(`group:${gid}:captcha_mode`)) ?? "button";
  const action = (await rdb.get(`group:${gid}:captcha_action`)) ?? "kick";
  const admRep = (await rdb.get(`group:${gid}:adm_report`)) === "true";
  const action2 = (await rdb.get(`group:${gid}:captcha_action_2`)) ?? "mute";
  const delBotRaw = await rdb.get(`group:${gid}:delete_bot_messages`);
  const delBot = delBotRaw === undefined || delBotRaw === null || delBotRaw === "true";
  const delSysRaw = await rdb.get(`group:${gid}:delete_service_messages`);
  const delSys = delSysRaw === undefined || delSysRaw === null || delSysRaw === "true";
  const silentMode = (await rdb.get(`group:${gid}:silent_mode`)) === "true";
  const info = await getChatTitle(env, gid);
  const groupName = info?.title ?? `Grupo ${gid}`;
  return { timeout, captcha, mode, action, admRep, action2, delBot, delSys, silentMode, groupName };
}

type EnvWithBot = RedisEnv & { BOT_TOKEN: string };

/** Acceso cacheado o comprobación en vivo (para admins recién ascendidos). */
export async function hasGroupAccess(env: EnvWithBot, api: TelegramApi, gid: number, userId: number): Promise<boolean> {
  const rdb = createRedis(env);
  if ((await rdb.get(`group_access:${gid}:${userId}`)) === "true") return true;
  if (await captcha.isAdmin(env, api, gid, userId)) {
    await rdb.set(`group_access:${gid}:${userId}`, "true");
    return true;
  }
  return false;
}

async function getChatTitle(env: EnvWithBot, chatId: number): Promise<{ title?: string } | null> {
  const api = new TelegramApi(env.BOT_TOKEN);
  const res = await api.getChat(chatId);
  const resAny = res as any;
  const result = resAny?.result ?? resAny;
  if (!result) return null;
  return { title: result.title };
}

function buildSettingsKeyboard(s: SettingsState & { groupName?: string }, gid: number): any {
  const kb: any = { inline_keyboard: [] };
  const row = (btns: Array<{ text: string; callback_data: string }>) => kb.inline_keyboard.push(btns);

  row([
    { text: `🧩 Estado del Bot:`, callback_data: `pop:captcha:${gid}` },
    { text: s.captcha ? "✅ ON" : "❌ OFF", callback_data: `setup:toggle:captcha:${gid}` },
  ]);
  row([
    { text: `⏱ Tiempo Actual: ${secondsToHuman(s.timeout)} ⏱`, callback_data: `pop:timeout:${gid}` },
  ]);
  row([
    { text: `⏱ -5s`, callback_data: `setup:timeout:sub:${gid}` },
    { text: `⏱ +5s`, callback_data: `setup:timeout:add:${gid}` },
  ]);
  row([{ text: `🔢 Modos 🔢`, callback_data: `pop:modes:${gid}` }]);

  const modeRows: Array<Array<{ text: string; callback_data: string }>> = [];
  let r: Array<{ text: string; callback_data: string }> = [];
  let count = 0;
  for (const [id, label] of Object.entries(MODES)) {
    const btn = { text: `${s.mode === id ? "✅ " : ""}${label}`, callback_data: `mode:set:${gid}:${id}` };
    r.push(btn);
    count++;
    if (r.length === 2) { modeRows.push(r); r = []; }
  }
  if (r.length) modeRows.push(r);
  for (const rr of modeRows) row(rr);

  row([{ text: `⛔ Acciones ⛔`, callback_data: `pop:actions:${gid}` }]);
  const actionRows: Array<Array<{ text: string; callback_data: string }>> = [];
  r = [];
  count = 0;
  for (const [id, label] of Object.entries(ACTIONS)) {
    const btn = { text: `${s.action === id ? "✅ " : ""}${label}`, callback_data: `action:set:${gid}:${id}` };
    r.push(btn);
    count++;
    if (r.length === 2) { actionRows.push(r); r = []; }
  }
  if (r.length) actionRows.push(r);
  for (const rr of actionRows) row(rr);

  const action2Rows: Array<Array<{ text: string; callback_data: string }>> = [];
  r = [];
  count = 0;
  for (const [id, label] of Object.entries(ACTIONS_2)) {
    const btn = { text: `${s.action2 === id ? "✅ " : ""}${label}`, callback_data: `action_2:set:${gid}:${id}` };
    r.push(btn);
    count++;
    if (r.length === 2) { action2Rows.push(r); r = []; }
  }
  if (r.length) action2Rows.push(r);
  for (const rr of action2Rows) row(rr);

  row([
    { text: `🗑Eliminar mensajes del Bot:`, callback_data: `pop:delbot:${gid}` },
    { text: s.delBot ? "✅ ON" : "❌ OFF", callback_data: `setup:toggle:delbot:${gid}` },
  ]);
  row([
    { text: `🗑 Eliminar mensajes del Sistema:`, callback_data: `pop:delsys:${gid}` },
    { text: s.delSys ? "✅ ON" : "❌ OFF", callback_data: `setup:toggle:delsys:${gid}` },
  ]);
  row([
    { text: `👮 Reporte de Usuarios a Adm.:`, callback_data: `pop:admrep:${gid}` },
    { text: s.admRep ? "✅ ON" : "❌ OFF", callback_data: `setup:toggle:adm_rep:${gid}` },
  ]);
  row([
    { text: `🤫 Modo Silencioso:`, callback_data: `pop:silent:${gid}` },
    { text: s.silentMode ? "✅ ON" : "❌ OFF", callback_data: `setup:toggle:silent_mode:${gid}` },
  ]);
  row([{ text: `🌓 Modo Nocturno 🌓`, callback_data: `nightmode_status:${gid}` }]);
  row([{ text: `🗣️ Filtro de Idiomas 🗣️`, callback_data: `langblock_menu:${gid}` }]);
  row([{ text: `🌐 Idioma del Bot 🌐`, callback_data: `lang:${gid}` }]);
  row([{ text: `📊 Ver resumen 📊`, callback_data: `summary:${gid}` }]);
  row([
    { text: `🔙 Volver`, callback_data: `setup:back:back:${gid}` },
  ]);
  row([
    { text: `❌ Cerrar`, callback_data: `setup:close:close:${gid}` },
  ]);

  return kb;
}

export async function showSettingsMenu(env: EnvWithBot, api: TelegramApi, chatId: number, messageId: number, gid: number): Promise<void> {
  const s = await getSettingsState(env, gid);
  const lang = (await createRedis(env).get(`group:${gid}:lang`)) ?? "es";
  const kb = buildSettingsKeyboard(s, gid);
  // Sin parse_mode: los títulos de grupo pueden contener *, _ o ` y romper Markdown.
  const text = `🔧 Configuración actual de tu grupo: ${s.groupName}`;
  await api.editMessageText(chatId, messageId, text, { reply_markup: kb } as any);
}

export async function handleSettingsCallback(env: RedisEnv & { BOT_TOKEN: string }, api: TelegramApi, cb: any): Promise<void> {
  const data = cb?.data ?? "";
  if (data.startsWith("langblock")) {
    await handleLanguageCallback(env, api, cb);
    return;
  }
  if (data.startsWith("nightmode_")) {
    await handleNightmodeCallback(env, api, cb);
    return;
  }
  if (data.startsWith("summary:")) {
    await handleSummaryCallback(env, api, cb);
    return;
  }
  if (data.startsWith("kun:")) {
    await handleKnownCallback(env, api, cb);
    return;
  }

  let m: RegExpMatchArray | null;

  // settings:<gid> -> abrir menu
  m = data.match(/^settings:(-?\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    const isAdminUser = await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0);
    if (isAdminUser) {
      await api.answerCallbackQuery(cb.id, "⚙️ Menú de configuración.").catch(() => null);
      await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid);
    }
    return;
  }

  // settings:groupupdate:<x> -> refrescar lista de grupos
  m = data.match(/^settings:groupupdate:(.+)$/);
  if (m) {
    const userId = Number(cb.from?.id ?? 0);
    const chatId = Number(m[1]);
    const lang = (await createRedis(env).get(`group:${chatId}:lang`)) ?? "es";
    const groups: number[] = [];
    const keys = await createRedis(env).keys("group_known:*");
    const rdb = createRedis(env);
    for (const key of keys) {
      const owner = key.replace(/^group_known:/, "");
      const n = Number(owner);
      if (Number.isFinite(n) && owner !== "all" && !key.startsWith("group_known:tmp:")) groups.push(n);
    }
    const allowed = groups.filter(async (gid) => (await rdb.get(`group_access:${gid}:${userId}`)) === "true");
    const kb = { inline_keyboard: allowed.slice(0, 8).map((gid) => [{ text: `⚙️ ${gid}`, callback_data: `settings:${gid}` }]) };
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⚙️ Elige un grupo para configurar:")).catch(() => null);
    await api.sendMessage(Number(cb.message?.chat?.id ?? chatId), await autoTranslate(env, lang, "⚙️ Elige un grupo para configurar:"), { reply_markup: kb });
    return;
  }

  // pop:<x>:<gid>
  m = data.match(/^pop:(.+):(-?\d+)$/);
  if (m) {
    const popup = m[1];
    const gid = Number(m[2]);
    const lang = (await createRedis(env).get(`group:${gid}:lang`)) ?? "es";
    const texts: Record<string, string> = {
      captcha: "Activa o desactiva el estado del bot en tu grupo.",
      timeout: "Incrementa o disminuye en 5s el tiempo de verificacón para el usuario.",
      modes: "Permite configurar el modo de verificación del usuario, puede ser por botón, por emojis, un problema matemático simple o turnstile (similar a recaptcha) o 🆕Imagen Captcha.",
      actions: "🆕 Permite configurar la acción a realizar por el bot sobre el usuario, puede ser entre expulsar o banear y restringir o eliminar sus mensajes.",
      delbot: "Permite configurar el borrado automatico de mensajes que envía el bot para mayor limpieza en tu grupo.",
      delsys: "Permite configurar el borrado automatico de mensajes que envía el sistema (usuario se unió al grupo o añadiste a un usuario) para mayor limpieza en tu grupo.",
      admrep: "🆕 Permite enviar un reporte a los admins sobre el usuario que entra, además de poder autorizar, banear o expulsar sin tener que esperar la verificación .",
      silent: "🤫 En modo silencioso el bot no envía el mensaje de captcha al grupo; el usuario queda restringido y debe verificarse igualmente.",
    };
    const text = texts[popup];
    if (text) {
      await api.answerCallbackQuery(cb.id, text, true).catch(() => null);
    }
    return;
  }

  // lang:<gid> -> abrir menu de idiomas del bot
  m = data.match(/^lang:(-?\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    const lang = (await createRedis(env).get(`group:${gid}:lang`)) ?? "es";
    const isAdminUser = await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0);
    if (!isAdminUser) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.").catch(() => null);
      return;
    }
    const langs: Array<[string, string]> = [
      ["🇪🇸", "es"], ["🇬🇧", "en"], ["🇫🇷", "fr"], ["🇵🇹", "pt"], ["🇨🇳", "zh"], ["🇯🇵", "ja"],
      ["🇮🇷", "fa"], ["🇸🇦", "ar"], ["🇩🇪", "de"], ["🇰🇷", "ko"], ["🇷🇺", "ru"], ["🇮🇹", "it"],
    ];
    const kb: any = { inline_keyboard: [] };
    for (let i = 0; i < langs.length; i += 3) {
      const row: any[] = [];
      for (let j = i; j < Math.min(i + 3, langs.length); j++) {
        row.push({ text: langs[j][0], callback_data: `langset:${gid}:${langs[j][1]}` });
      }
      kb.inline_keyboard.push(row);
    }
    kb.inline_keyboard.push([{ text: await autoTranslate(env, lang, "🔙 Volver"), callback_data: `settings:${gid}` }]);
    const title = `${await autoTranslate(env, lang, "🌐 Elige idioma del Bot para el grupo:")}`;
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "🌐 Menu de Idiomas para el Bot.")).catch(() => null);
    await api.editMessageText(Number(cb.message?.chat?.id ?? gid), cb.message?.message_id ?? 0, title, { reply_markup: kb } as any);
    return;
  }

  // langset:<gid>:<code>
  m = data.match(/^langset:(-?\d+):([A-Za-z]{2})$/);
  if (m) {
    const gid = Number(m[1]);
    const langCode = m[2].toLowerCase();
    const isAdminUser = await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0);
    if (!isAdminUser) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.").catch(() => null);
      return;
    }
    const rdb = createRedis(env);
    await rdb.set(`group:${gid}:lang`, langCode);
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, "es", "✅ Idioma actualizado.")).catch(() => null);
    await api.editMessageText(Number(cb.message?.chat?.id ?? gid), cb.message?.message_id ?? 0, `${await autoTranslate(env, "es", "🌐 Idioma del Bot para el grupo:")}: ${langCode}`, { reply_markup: { inline_keyboard: [[{ text: await autoTranslate(env, "es", "🔙 Volver"), callback_data: `settings:${gid}` }]] } } as any);
    return;
  }

  // mode:set:<gid>:<mode>
  m = data.match(/^mode:set:(.+):(.+)$/);
  if (m) {
    const gid = Number(m[1]);
    const modeCap = m[2];
    const userId = Number(cb.from?.id ?? 0);
    const rdb = createRedis(env);
    if (!(await hasGroupAccess(env, api, gid, userId))) {
      const lang = (await rdb.get(`group:${gid}:lang`)) ?? "es";
      await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⛔ No tienes permiso para este grupo."), true).catch(() => null);
      return;
    }
    await rdb.set(`group:${gid}:captcha_mode`, modeCap);
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, "es", "✅ Modo de captcha actualizado.")).catch(() => null);
    await api.editMessageText(Number(cb.message?.chat?.id ?? gid), cb.message?.message_id ?? 0, await autoTranslate(env, "es", "⏳ Actualizando configuración...")).catch(() => null);
    await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid);
    return;
  }

  // action:set:<gid>:<action>
  m = data.match(/^action:set:(.+):(.+)$/);
  if (m) {
    const gid = Number(m[1]);
    const actionCap = m[2];
    const userId = Number(cb.from?.id ?? 0);
    const rdb = createRedis(env);
    if (!(await hasGroupAccess(env, api, gid, userId))) {
      const lang = (await rdb.get(`group:${gid}:lang`)) ?? "es";
      await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⛔ No tienes permiso para este grupo."), true).catch(() => null);
      return;
    }
    await rdb.set(`group:${gid}:captcha_action`, actionCap);
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, "es", "✅ Acción actualizada.")).catch(() => null);
    await api.editMessageText(Number(cb.message?.chat?.id ?? gid), cb.message?.message_id ?? 0, await autoTranslate(env, "es", "⏳ Actualizando configuración...")).catch(() => null);
    await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid);
    return;
  }

  // action_2:set:<gid>:<action>
  m = data.match(/^action_2:set:(.+):(.+)$/);
  if (m) {
    const gid = Number(m[1]);
    const action2Cap = m[2];
    const userId = Number(cb.from?.id ?? 0);
    const rdb = createRedis(env);
    if (!(await hasGroupAccess(env, api, gid, userId))) {
      const lang = (await rdb.get(`group:${gid}:lang`)) ?? "es";
      await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⛔ No tienes permiso para este grupo."), true).catch(() => null);
      return;
    }
    await rdb.set(`group:${gid}:captcha_action_2`, action2Cap);
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, "es", "✅ Acción actualizada.")).catch(() => null);
    await api.editMessageText(Number(cb.message?.chat?.id ?? gid), cb.message?.message_id ?? 0, await autoTranslate(env, "es", "⏳ Actualizando configuración...")).catch(() => null);
    await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid);
    return;
  }

  // setup:<action>:<param>:<gid> -> back / timeout / toggle / close
  m = data.match(/^setup:([^:]+):([^:]+):(-?\d+)$/);
  if (m) {
    const action = m[1];
    const param = m[2];
    const gid = Number(m[3]);
    const userId = Number(cb.from?.id ?? 0);
    const lang = (await createRedis(env).get(`group:${gid}:lang`)) ?? "es";
    if (!(await hasGroupAccess(env, api, gid, userId))) {
      await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⛔ No tienes permiso para este grupo."), true).catch(() => null);
      return;
    }

    if (action === "back") {
      const groups: number[] = [];
      const keys = await createRedis(env).keys("group_known:*");
      const rdb = createRedis(env);
      for (const key of keys) {
        const owner = key.replace(/^group_known:/, "");
        const n = Number(owner);
        if (Number.isFinite(n) && owner !== "all" && !key.startsWith("group_known:tmp:")) groups.push(n);
      }
      const allowed: number[] = [];
      for (const g of groups) {
        if (await hasGroupAccess(env, api, g, userId)) allowed.push(g);
      }
      const kb = { inline_keyboard: allowed.slice(0, 8).map((g) => [{ text: `⚙️ ${g}`, callback_data: `settings:${g}` }]) };
      await api.answerCallbackQuery(cb.id, "⚙️ Elige un grupo para configurar:").catch(() => null);
      await api.sendMessage(Number(cb.message?.chat?.id ?? gid), await autoTranslate(env, lang, "⚙️ Elige un grupo para configurar:"), { reply_markup: kb });
      return;
    }

    if (action === "timeout") {
      const current = Number((await createRedis(env).get(`group:${gid}:kick_timeout`)) ?? 60);
      const nv = param === "add" ? Math.min(current + 5, 3600) : Math.max(current - 5, 5);
      await createRedis(env).set(`group:${gid}:kick_timeout`, String(nv));
      await api.answerCallbackQuery(cb.id, `${await autoTranslate(env, lang, "⏱ Tiempo actualizado.")} ${nv}s`).catch(() => null);
      await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid);
      return;
    }

    if (action === "toggle") {
      const keyMap: Record<string, string> = {
        captcha: `group:${gid}:captcha_enabled`,
        delbot: `group:${gid}:delete_bot_messages`,
        delsys: `group:${gid}:delete_service_messages`,
        adm_rep: `group:${gid}:adm_report`,
        silent_mode: `group:${gid}:silent_mode`,
      };
      const key = keyMap[param];
      if (key) {
        // delbot/delsys están activos por defecto cuando la clave no existe.
        const raw = await createRedis(env).get(key);
        const defaultOn = param === "delbot" || param === "delsys";
        const val = raw === null || raw === undefined ? defaultOn : raw === "true";
        await createRedis(env).set(key, val ? "false" : "true");
        await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, `🧩 Bot: ${val ? "❌ OFF" : "✅ ON"}`)).catch(() => null);
      } else {
        await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "❌ Opción desconocida."), true).catch(() => null);
      }
      await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid);
      return;
    }

    if (action === "close") {
      const lang2 = (await createRedis(env).get(`group:${gid}:lang`)) ?? "es";
      await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang2, "❎ Menú cerrado.")).catch(() => null);
      await api.editMessageText(Number(cb.message?.chat?.id ?? gid), cb.message?.message_id ?? 0, await autoTranslate(env, lang2, "❎ Menú cerrado.")).catch(() => null);
      return;
    }
  }

  await api.answerCallbackQuery(cb.id, await autoTranslate(env, "es", "❌ Acción desconocida.")).catch(() => null);
}

export async function handleConfigCommand(env: RedisEnv & { BOT_TOKEN: string }, api: TelegramApi, msg: any): Promise<void> {
  const text = String(msg?.text ?? "");
  const chatId = Number(msg?.chat?.id);
  const userId = Number(msg?.from?.id);
  if (msg?.chat?.type !== "private") return;

  const rdb = createRedis(env);
  const groups: number[] = [];
  const keys = await rdb.keys("group_known:*");
  for (const key of keys) {
    const owner = key.replace(/^group_known:/, "");
    const n = Number(owner);
    if (Number.isFinite(n) && owner !== "all" && !key.startsWith("group_known:tmp:")) {
      // El acceso cacheado puede estar desactualizado; comprobar también en vivo.
      const cached = (await rdb.get(`group_access:${n}:${userId}`)) === "true";
      if (cached || (await captcha.isAdmin(env, api, n, userId))) {
        if (!cached) await rdb.set(`group_access:${n}:${userId}`, "true");
        groups.push(n);
      }
    }
  }
  const kb = { inline_keyboard: groups.slice(0, 8).map((g) => [{ text: `⚙️ ${g}`, callback_data: `settings:${g}` }]) };
  const textOut = groups.length
    ? await autoTranslate(env, (await rdb.get(`group:${userId}:lang`)) ?? "es", "⚙️ Elige un grupo para configurar:")
    : await autoTranslate(env, "es", "🤖 No hay grupos conocidos aún.");
  if (groups.length) {
    await api.sendMessage(chatId, textOut, { reply_markup: kb });
  } else {
    await api.sendMessage(chatId, textOut);
  }
}
