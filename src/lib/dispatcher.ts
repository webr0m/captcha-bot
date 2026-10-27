/**
 * Dispatcher de updates de Telegram (migración del loop de copas en bot/main.lua).
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import * as captcha from "./captcha";

export type BotEnv = RedisEnv & { BOT_TOKEN: string; DEEPL_AUTH_KEY?: string };

export async function handleUpdate(env: BotEnv, api: TelegramApi, update: any): Promise<void> {
  if (!update) return;
  if (update.message) {
    await handleMessage(env, api, update.message);
  } else if (update.callback_query) {
    await handleCallbackQuery(env, api, update.callback_query);
  } else if (update.chat_join_request) {
    await handleChatJoinRequest(env, api, update.chat_join_request);
  }
}

async function getMyBotId(env: BotEnv, api: TelegramApi): Promise<number> {
  try {
    const me = await api.getMe();
    const id = (me as any)?.id;
    if (id) return id;
  } catch { /* ignore */ }
  return 0;
}

async function handleMessage(env: BotEnv, api: TelegramApi, msg: any): Promise<void> {
  // Limpieza de mensajes de salida (service) en supergrupos
  if (msg.left_chat_member && msg.chat && msg.chat.type === "supergroup") {
    const chatId = msg.chat.id;
    const delSys = await captcha.getDeleteServiceMessages(env, chatId);
    if (delSys) {
      try { await api.deleteMessage(chatId, msg.message_id); } catch { /* ignore */ }
    }
    return;
  }

  if (!msg.chat || !msg.from || !msg.chat.id || !msg.from.id) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const rdb = createRedis(env);
  const stateKey = captcha.verifyKey(chatId, userId);
  const state = await rdb.get(stateKey);

  // Si hay un captcha pendiente y el usuario responde con texto -> validar / mutear
  if (state === "pending") {
    const mode = await captcha.getCaptchaMode(env, chatId);
    const timeout = await captcha.getKickTimeout(env, chatId);

    if (mode === "emoji") {
      const expected = await rdb.get(stateKey);
      const text = String(msg.text ?? "").trim();
      if (text.toUpperCase() === String(expected ?? "").toUpperCase()) {
        await captcha.markVerified(env, api, chatId, userId, msg.from.username);
      } else {
        await captcha.markFailed(env, api, chatId, userId);
      }
      return;
    }

    // Modos math/button/turnstile/qr con texto entrante -> mute/borrar segun action
    const action2 = await captcha.getCaptchaAction2(env, chatId);
    const action = await captcha.getCaptchaAction(env, chatId);
    if (action2 === "mute") {
      try { await api.deleteMessage(chatId, msg.message_id); } catch { /* ignore */ }
    } else if (action2 !== "mute" && (await captcha.botHasPermissions(env, api, chatId))) {
      await captcha.muteUser(api, chatId, userId, timeout);
    }
    return;
  }

  if (state === "ok") return;

  // Nuevo miembro en grupo -> lanzar captcha
  if (msg.new_chat_member && msg.chat && msg.chat.type === "supergroup") {
    const user = msg.new_chat_member;
    const userIdNum = user.id;
    const myBotId = await getMyBotId(env, api);
    if (userIdNum === myBotId) return;
    if (!(await captcha.isAdmin(env, api, chatId, userIdNum))) return;
    if (user.is_bot) return;
    if (!(await captcha.getCaptchaEnabled(env, chatId))) return;
    await captcha.issueCaptcha(env, api, chatId, userIdNum, user, msg);
  }
}

async function answerNotForYou(env: BotEnv, api: TelegramApi, cbId: string, chatId: number): Promise<void> {
  await api.answerCallbackQuery(cbId, await autoTranslate(env, await captcha.getGroupLang(env, chatId) || "es", "❌ Esta identificación no es para ti."), true).catch(() => null);
}

async function handleCallbackQuery(env: BotEnv, api: TelegramApi, cb: any): Promise<void> {
  if (!cb || !cb.data) return;
  const chatId = cb.message?.chat?.id;
  const fromId = cb.from?.id;
  const data = cb.data;
  const rdb = createRedis(env);
  const lang = (await captcha.getGroupLang(env, chatId ?? 0)) || "es";

  let m: RegExpMatchArray | null;

  // simple:<userId> -> boton de verificacion
  m = data.match(/^simple:(-?\d+)$/);
  if (m) {
    const uid = Number(m[1]);
    if (fromId !== uid) { await answerNotForYou(env, api, cb.id, chatId ?? 0); return; }
    await captcha.markVerified(env, api, chatId ?? 0, uid, cb.from?.username);
    return;
  }

  // math_answer:<userId>:<token>
  m = data.match(/^math_answer:(-?\d+):(.+)$/);
  if (m) {
    const uid = Number(m[1]);
    const token = m[2];
    if (fromId !== uid) { await answerNotForYou(env, api, cb.id, chatId ?? 0); return; }
    const expected = await rdb.get(captcha.mathAnswerKey(chatId ?? 0, uid));
    const chosen = await rdb.get(captcha.mathTokenKey(chatId ?? 0, uid, token));
    await rdb.srem(captcha.mathTokenKey(chatId ?? 0, uid, token), token);
    if (expected && chosen && String(chosen) === String(expected)) {
      await captcha.markVerified(env, api, chatId ?? 0, uid, cb.from?.username);
    } else {
      await captcha.markFailed(env, api, chatId ?? 0, uid, cb.id);
    }
    return;
  }

  // math_regen:<userId>
  m = data.match(/^math_regen:(-?\d+)$/);
  if (m) {
    const uid = Number(m[1]);
    if (fromId !== uid) { await answerNotForYou(env, api, cb.id, chatId ?? 0); return; }
    const pending = await rdb.get(captcha.mathPendingKey(chatId ?? 0, uid));
    if (pending !== "pending") { await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⏳ Este desafío ya no está disponible."), true).catch(() => null); return; }
    const cnt = Number(await rdb.get(`math_regen:${chatId}:${uid}`) ?? 0);
    if (cnt >= 3) { await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⛔ Límite de regeneraciones alcanzado."), true).catch(() => null); return; }
    await rdb.setex(`math_regen:${chatId}:${uid}`, await captcha.getKickTimeout(env, chatId), String(cnt + 1));
    await captcha.issueCaptcha(env, api, chatId ?? 0, uid, cb.from, cb);
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "🤩 Nuevo desafío generado.")).catch(() => null);
    return;
  }

  // qr_answer:<userId>:<choice>
  m = data.match(/^qr_answer:(-?\d+):(.+)$/);
  if (m) {
    const uid = Number(m[1]);
    const choice = m[2];
    if (fromId !== uid) { await answerNotForYou(env, api, cb.id, chatId ?? 0); return; }
    const tokenKey = captcha.qrTokenKey(chatId ?? 0, uid, choice);
    const chosen = await rdb.get(tokenKey);
    await rdb.srem(tokenKey, choice);
    const expected = await rdb.get(captcha.qrAnswerKey(chatId ?? 0, uid));
    if (expected && chosen) {
      if (String(chosen) === String(expected)) {
        await captcha.markVerified(env, api, chatId ?? 0, uid, cb.from?.username);
      } else {
        await captcha.markFailed(env, api, chatId ?? 0, uid, cb.id);
      }
    } else {
      await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⏳ Este desafío ya no está disponible."), true).catch(() => null);
    }
    return;
  }

  // qr_regen:<userId>
  m = data.match(/^qr_regen:(-?\d+)$/);
  if (m) {
    const uid = Number(m[1]);
    if (fromId !== uid) { await answerNotForYou(env, api, cb.id, chatId ?? 0); return; }
    const pending = await rdb.get(captcha.qrPendingKey(chatId ?? 0, uid));
    if (pending !== "pending") { await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⏳ Este desafío ya no está disponible."), true).catch(() => null); return; }
    const cnt = Number(await rdb.get(`qr_regen:${chatId}:${uid}`) ?? 0);
    if (cnt >= 3) { await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⛔ Límite de regeneraciones alcanzado."), true).catch(() => null); return; }
    await rdb.setex(`qr_regen:${chatId}:${uid}`, await captcha.getKickTimeout(env, chatId), String(cnt + 1));
    await captcha.issueCaptcha(env, api, chatId ?? 0, uid, cb.from, cb);
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "🤩 Nuevo desafío generado.")).catch(() => null);
    return;
  }

  await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "❌ Acción desconocida."), true).catch(() => null);
}

async function handleChatJoinRequest(env: BotEnv, api: TelegramApi, req: any): Promise<void> {
  const chatId = req?.chat?.id;
  const userId = req?.from?.id;
  if (!chatId || !userId) return;
  const state = await createRedis(env).get(captcha.verifyKey(chatId, userId));
  if (state === "ok") {
    try { await api.approveChatJoinRequest(chatId, userId); } catch { /* ignore */ }
  } else {
    try { await api.declineChatJoinRequest(chatId, userId); } catch { /* ignore */ }
  }
}
