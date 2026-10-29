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
import { isFeatureEnabled } from "./security_rules";
import { hasGroupAccessLive } from "./access";
import { MODES, ACTIONS, ACTIONS_2, SECTIONS, buildSettingsView, type SettingsState, type SettingsSection } from "./settings_menu";
import { handleStartCommand } from "./start";
import { showGroupChooser } from "./settings_groups";

async function getSettingsState(env: EnvWithBot, gid: number): Promise<SettingsState> {
  const rdb = createRedis(env);
  const rawTimeout = Number((await rdb.get(`group:${gid}:kick_timeout`)) ?? 60);
  const timeout = Number.isFinite(rawTimeout) ? Math.max(5, Math.min(rawTimeout, 3600)) : 60;
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
  const cas = isFeatureEnabled(await rdb.get(`group:${gid}:cas_enabled`));
  const antiFlood = isFeatureEnabled(await rdb.get(`group:${gid}:antiflood_enabled`));
  const antiLink = isFeatureEnabled(await rdb.get(`group:${gid}:antilink_enabled`));
  const info = await getChatTitle(env, gid);
  const groupName = info?.title ?? `Grupo ${gid}`;
  return { timeout, captcha, mode, action, admRep, action2, delBot, delSys, silentMode, cas, antiFlood, antiLink, groupName, isForum: info?.isForum === true };
}

type EnvWithBot = RedisEnv & { BOT_TOKEN: string };

/** Acceso cacheado o comprobación en vivo (para admins recién ascendidos). */
export async function hasGroupAccess(env: EnvWithBot, api: TelegramApi, gid: number, userId: number): Promise<boolean> {
  return hasGroupAccessLive(env, api, gid, userId);
}

async function getChatTitle(env: EnvWithBot, chatId: number): Promise<{ title?: string; isForum: boolean } | null> {
  const api = new TelegramApi(env.BOT_TOKEN);
  const res = await api.getChat(chatId);
  const resAny = res as any;
  const result = resAny?.result ?? resAny;
  if (!result) return null;
  return { title: result.title, isForum: result.is_forum === true };
}

export async function showSettingsMenu(env: EnvWithBot, api: TelegramApi, chatId: number, messageId: number, gid: number, section: SettingsSection = "home"): Promise<void> {
  const s = await getSettingsState(env, gid);
  const view = buildSettingsView(s, gid, section);
  await api.editMessageText(chatId, messageId, view.text, { reply_markup: view.keyboard });
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

  m = data.match(/^settings:section:(-?\d+):([a-z_]+)$/);
  if (m) {
    const gid = Number(m[1]);
    const section = m[2] as SettingsSection;
    if (!SECTIONS.includes(section)) { await api.answerCallbackQuery(cb.id, "Sección no válida.", true); return; }
    if (!(await hasGroupAccessLive(env, api, gid, Number(cb.from?.id)))) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden configurar este grupo.", true);
      return;
    }
    await api.answerCallbackQuery(cb.id, "⚙️ Configuración.").catch(() => null);
    await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid, section);
    return;
  }

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

  // Botones antiguos de refresco y paginación nueva usan la misma lista acotada.
  m = data.match(/^settings:groupupdate:(-?\d+)$/);
  const pageMatch = data.match(/^settings:groups:(\d+)$/);
  if (m || pageMatch) {
    const userId = Number(cb.from?.id ?? 0);
    const chatId = Number(cb.message?.chat?.id ?? 0);
    if (cb.message?.chat?.type !== "private" || chatId !== userId) {
      await api.answerCallbackQuery(cb.id, "Abre /config en mi chat privado para ver tus grupos.", true);
      return;
    }
    await api.answerCallbackQuery(cb.id, "⚙️ Actualizando grupos...").catch(() => null);
    await showGroupChooser(env, api, { chatId, userId, messageId: Number(cb.message?.message_id) }, Number(pageMatch?.[1] ?? 0));
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
      cas: "🛡️ CAS consulta la lista pública de Combot Anti-Spam al entrar un usuario y lo banea si está listado. Si la API falla, no bloquea la entrada.",
      antiflood: "🌊 Anti-flood limita los mensajes seguidos por usuario (12 cada 10 s por defecto) y aplica un mute temporal. Ajusta el límite con /antiflood limit.",
      antilink: "🔗 Anti-enlaces borra los enlaces no permitidos enviados por usuarios que no son administradores. Añade dominios con /allowlink.",
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
    if (!MODES[modeCap]) {
      await api.answerCallbackQuery(cb.id, "❌ Modo no válido.", true).catch(() => null);
      return;
    }
    await rdb.set(`group:${gid}:captcha_mode`, modeCap);
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, "es", "✅ Modo de captcha actualizado.")).catch(() => null);
    await api.editMessageText(Number(cb.message?.chat?.id ?? gid), cb.message?.message_id ?? 0, await autoTranslate(env, "es", "⏳ Actualizando configuración...")).catch(() => null);
    await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid, "captcha");
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
    if (!ACTIONS[actionCap]) {
      await api.answerCallbackQuery(cb.id, "❌ Acción no válida.", true).catch(() => null);
      return;
    }
    await rdb.set(`group:${gid}:captcha_action`, actionCap);
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, "es", "✅ Acción actualizada.")).catch(() => null);
    await api.editMessageText(Number(cb.message?.chat?.id ?? gid), cb.message?.message_id ?? 0, await autoTranslate(env, "es", "⏳ Actualizando configuración...")).catch(() => null);
    await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid, "captcha");
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
    if (!ACTIONS_2[action2Cap]) {
      await api.answerCallbackQuery(cb.id, "❌ Acción no válida.", true).catch(() => null);
      return;
    }
    await rdb.set(`group:${gid}:captcha_action_2`, action2Cap);
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, "es", "✅ Acción actualizada.")).catch(() => null);
    await api.editMessageText(Number(cb.message?.chat?.id ?? gid), cb.message?.message_id ?? 0, await autoTranslate(env, "es", "⏳ Actualizando configuración...")).catch(() => null);
    await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid, "captcha");
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
      await api.answerCallbackQuery(cb.id, "⚙️ Tus grupos.").catch(() => null);
      await showGroupChooser(env, api, { chatId: Number(cb.message?.chat?.id ?? gid), userId, messageId: Number(cb.message?.message_id) });
      return;
    }

    if (action === "timeout") {
      const raw = Number((await createRedis(env).get(`group:${gid}:kick_timeout`)) ?? 60);
      const current = Number.isFinite(raw) ? Math.max(5, Math.min(raw, 3600)) : 60;
      const nv = param === "add" ? Math.min(current + 5, 3600) : Math.max(current - 5, 5);
      await createRedis(env).set(`group:${gid}:kick_timeout`, String(nv));
      await api.answerCallbackQuery(cb.id, `${await autoTranslate(env, lang, "⏱ Tiempo actualizado.")} ${nv}s`).catch(() => null);
      await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid, "captcha");
      return;
    }

    if (action === "toggle") {
      const keyMap: Record<string, string> = {
        captcha: `group:${gid}:captcha_enabled`,
        delbot: `group:${gid}:delete_bot_messages`,
        delsys: `group:${gid}:delete_service_messages`,
        adm_rep: `group:${gid}:adm_report`,
        silent_mode: `group:${gid}:silent_mode`,
        cas: `group:${gid}:cas_enabled`,
        antiflood: `group:${gid}:antiflood_enabled`,
        antilink: `group:${gid}:antilink_enabled`,
      };
      const key = keyMap[param];
      if (key) {
        // delbot/delsys/cas/antiflood/antilink están activos por defecto cuando la clave no existe.
        const raw = await createRedis(env).get(key);
        const defaultOn = param === "delbot" || param === "delsys" || param === "cas" || param === "antiflood" || param === "antilink";
        const val = raw === null || raw === undefined ? defaultOn : raw === "true";
        await createRedis(env).set(key, val ? "false" : "true");
        await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, `Opción ${val ? "desactivada" : "activada"}.`)).catch(() => null);
      } else {
        await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "❌ Opción desconocida."), true).catch(() => null);
      }
      await showSettingsMenu(env, api, cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, gid, ["cas", "antiflood", "antilink"].includes(param) ? "moderation" : ["delbot", "delsys", "adm_rep"].includes(param) ? "messages" : "captcha");
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
  if (msg?.chat?.type !== "private") {
    await handleStartCommand(env, api, { ...msg, text: "/start" });
    return;
  }
  await showGroupChooser(env, api, { chatId: Number(msg.chat.id), userId: Number(msg.from?.id) });
}
