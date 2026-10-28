/**
 * Dispatcher de updates de Telegram (migración del loop de copas en bot/main.lua).
 * - message -> captcha / joins / comandos / verificaciones privadas
 * - callback_query -> verificadores (math, qr, simple, regen, dice, crypto, nightmode, langblock, summary, kun, checkadmin)
 * - chat_join_request -> aprobación/denegación de verificación en canales
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import * as captcha from "./captcha";
import { issueDice, handleDiceCallback } from "./dice";
import { handleBroadcast } from "./broadcast";
import { checkNightMode, handleNightmodeCallback, handleNightmodeCommand } from "./nightmode";
import { handleBotAddedAlert } from "./bot_detector";
import { handleChannelJoinRequest, handlePrivateCheck, handleStartVerify } from "./channel_verify";
import { handleVerifyPublicChannel } from "./verifi_public_channel";
import { handleJoinLeave } from "./report_user_activity";
import { handleDonate, handleCryptoCallback } from "./donate";
import { handleDi } from "./di";
import { handleLangCommand } from "./lang_command";
import { handleSummaryCallback } from "./config_summary";
import { handleKnownCommand, handleKnownCallback, saveUserMeta } from "./known_users";
import { handleTestMessage } from "./test_message";
import { handleSaveGroups, trackGroup } from "./save_groups";
import { handleConfigCommand, handleSettingsCallback } from "./settings";
import { handleStartCommand } from "./start";
import { runCleaner } from "./cleaner";
import { addTask } from "./tasks";
import { blockIfUnauthorized, handleLanguageCallback } from "./block_lang";

export type BotEnv = RedisEnv & { BOT_TOKEN: string; DEEPL_AUTH_KEY?: string };

const DEV_USER_ID = 180791241; // MY_DEV_ID

export async function handleUpdate(env: BotEnv, api: TelegramApi, update: any): Promise<void> {
  if (!update) return;
  if (update.message) {
    await handleMessage(env, api, update.message);
  } else if (update.callback_query) {
    await handleCallbackQuery(env, api, update.callback_query);
  } else if (update.chat_join_request) {
    const req = update.chat_join_request;
    await handleChannelJoinRequest(env, api, req);
  }
}

async function getMyBotId(env: BotEnv, api: TelegramApi): Promise<number> {
  try {
    const me = await api.getMe();
    const id = Number((me as any)?.id);
    if (id) return id;
  } catch { /* ignore */ }
  return 0;
}

async function getBotUsername(api: TelegramApi): Promise<string> {
  try {
    const me = await api.getMe();
    const username = (me as any)?.username;
    if (username) return username;
  } catch { /* ignore */ }
  return "";
}

async function handleMessage(env: BotEnv, api: TelegramApi, msg: any): Promise<void> {
  // Limpieza de mensajes de salida (service) en supergrupos
  if (msg?.left_chat_member && msg?.chat && msg?.chat.type === "supergroup") {
    const chatId = msg.chat.id;
    const delSys = await captcha.getDeleteServiceMessages(env, chatId);
    if (delSys) {
      try { await api.deleteMessage(chatId, msg.message_id); } catch { /* ignore */ }
    }
    // notificación de salida
    await handleJoinLeave(env, api, msg);
    return;
  }

  if (!msg?.chat || !msg?.from || !msg?.chat.id || !msg?.from.id) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const chatType = msg.chat.type;

  // Registrar grupo + admins (equivalente a save_groups.lua en cada mensaje).
  if (chatType === "supergroup" || chatType === "group") {
    try { await trackGroup(env, api, Number(chatId)); } catch { /* no bloquear el update */ }
  }

  // Registro de usuarios conocidos + metadatos (nombre/@usuario) para /known.
  const rdb = createRedis(env);
  const newMember = msg.new_chat_member;
  const fromUser = msg.from;
  if (newMember && !newMember.is_bot) {
    await rdb.sadd("known_users:all", String(newMember.id));
    await rdb.sadd(`known_users:${chatId}`, String(newMember.id));
    await saveUserMeta(env, newMember);
  }
  if (fromUser && !fromUser.is_bot) {
    await rdb.sadd("known_users:all", String(fromUser.id));
    await rdb.sadd(`known_users:${chatId}`, String(fromUser.id));
    await saveUserMeta(env, fromUser);
  }

  // Reporte de entrada (independiente del captcha).
  if (newMember) {
    try { await handleJoinLeave(env, api, msg); } catch { /* no bloquear */ }
  }

  const text = String(msg.text ?? "");

  // Mensajes privados: deep-links de verificación (/start verify_...) y validación de código
  if (chatType === "private") {
    const text = String(msg.text ?? "");
    const isStartVerifyChan = text.startsWith("/start") && /^\/start\s+verify_channel_/.test(text);
    const isStartVerify = text.startsWith("/start") && /^\/start\s+verify_/.test(text);
    const lastC = await createRedis(env).get(`jr:last_channel:${userId}`);
    const expectedJr = lastC ? await createRedis(env).get(`jr:${Number(lastC)}:${userId}:code`) : null;
    const lastChanV = await createRedis(env).get(`chanverify:last:${userId}`);
    const expectedChan = lastChanV ? await createRedis(env).get(`chanverify:${Number(lastChanV)}:${userId}:code`) : null;
    if (isStartVerifyChan) { await handleVerifyPublicChannel(env, api, msg); return; }
    if (isStartVerify) { await handleStartVerify(env, api, msg); return; }
    // /start y /start config_<gid> en privado (no deben tratarse como código de verificación)
    const privateCmd = (text.match(/^\/([a-z_]+)(?:@\S+)?(?:\s|$)/) ?? [])[1]?.toLowerCase();
    if (privateCmd === "start") { await handleStartCommand(env, api, msg); return; }
    // Un comando nunca debe interpretarse como código de verificación.
    if (expectedJr && !text.startsWith("/")) { await handlePrivateCheck(env, api, msg); return; }
    if (expectedChan && !text.startsWith("/")) { await handleVerifyPublicChannel(env, api, msg); return; }
  }

  // Comandos (privados y grupos)
  if (text.startsWith("/")) {
    const cmd = (text.match(/^\/([a-z_]+)(?:@\S+)?\s*/) ?? [])[1]?.toLowerCase();
    if (cmd === "start") { await handleStartCommand(env, api, msg); return; }
    if (cmd === "test") { await handleTestMessage(api, msg); return; }
    if (cmd === "di") { await handleDi(env, api, msg); return; }
    if (cmd === "donate") { await handleDonate(env, api, chatId); return; }
    if (cmd === "lang") { await handleLangCommand(env, api, msg); return; }
    if (cmd === "nightmode") { await handleNightmodeCommand(env, api, msg); return; }
    if (cmd === "config") { await handleConfigCommand(env, api, msg); return; }
    if (cmd === "post_verify") { await handleVerifyPublicChannel(env, api, msg); return; }
    if (cmd === "list_verified") { await handleVerifyPublicChannel(env, api, msg); return; }
    if (cmd === "known" || cmd === "groups") { await handleKnownCommand(env, api, msg); return; }
    if (cmd === "save_groups" || cmd === "group_access") { await handleSaveGroups(env, api, msg); return; }
    if (cmd === "cleaner") { await runCleaner(env, api, msg); return; }
    if (cmd === "broadcast") {
      if (Number(chatId) < 0) {
        if (!(await captcha.isAdmin(env, api, chatId, userId))) {
          const sent = await api.sendMessage(chatId, "🚫 Solo administradores pueden usar /broadcast.").catch(() => null);
          const mid = Number((sent as any)?.message_id ?? 0);
          if (mid) await addTask(env, { type: "del", chatId, param: mid, runAt: Math.floor(Date.now() / 1000) + 5 });
          return;
        }
        if (!msg.reply_to_message) {
          await api.sendMessage(chatId, "❗ Responde al mensaje que quieras retransmitir con /broadcast");
          return;
        }
        await handleBroadcast(env, api, chatId, msg.reply_to_message);
        return;
      }
    }
  }

  const stateKey = captcha.verifyKey(chatId, userId);
  const state = await rdb.get(stateKey);

  // Nuevo miembro en grupo -> lanzar captcha o alertar de bots.
  // Se procesa antes del estado "pending" para que un usuario pendiente no
  // bloquee la verificación de otra persona que acaba de entrar.
  if (msg.new_chat_member && msg.chat && msg.chat.type === "supergroup") {
    const user = msg.new_chat_member;
    const userIdNum = user.id;
    const myBotId = await getMyBotId(env, api);
    if (userIdNum === myBotId) return;
    if (user.is_bot) {
      await handleBotAddedAlert(env, api, msg);
      return;
    }
    if (await captcha.isAdmin(env, api, chatId, userIdNum)) return;
    if (!(await captcha.getCaptchaEnabled(env, chatId))) return;
    const modeNow = await captcha.getCaptchaMode(env, chatId);
    if (modeNow === "dice") {
      await issueDice(env, api, chatId, userIdNum, msg);
      return;
    }
    await captcha.issueCaptcha(env, api, chatId, userIdNum, user, msg);
    return;
  }

  if (state === "pending") {
    const mode = await captcha.getCaptchaMode(env, chatId);
    const timeout = await captcha.getKickTimeout(env, chatId);
    const typed = String(msg.text ?? "").trim();

    // Modos en los que se responde escribiendo el texto/emoji.
    if ((mode === "emoji" || mode === "image") && typed) {
      const answerKey = mode === "emoji"
        ? captcha.emojiAnswerKey(chatId, userId)
        : captcha.imageAnswerKey(chatId, userId);
      const expected = await rdb.get(answerKey);
      const ok = !!expected && typed.toUpperCase() === expected.toUpperCase();
      if (ok) {
        await captcha.markVerified(env, api, chatId, userId, msg.from.username);
      } else {
        // El mensaje del usuario no debe quedar visible mientras esté pendiente.
        try { await api.deleteMessage(chatId, msg.message_id); } catch { /* ignore */ }
        await captcha.markFailed(env, api, chatId, userId);
      }
      return;
    }

    // Modos con botones: cualquier texto del usuario pendiente se borra o se muta.
    const action2 = await captcha.getCaptchaAction2(env, chatId);
    if (action2 === "mute") {
      try { await api.deleteMessage(chatId, msg.message_id); } catch { /* ignore */ }
    } else if (await captcha.botHasPermissions(env, api, chatId)) {
      try { await captcha.muteUser(api, chatId, userId, timeout); } catch { /* ignore */ }
    }
    return;
  }

  if (state === "ok") return;

  // Bloqueo de idiomas no autorizados (solo mensajes normales).
  if (!text.startsWith("/") && (await blockIfUnauthorized(env, api, msg))) return;
}

async function answerNotForYou(env: BotEnv, api: TelegramApi, cbId: string, chatId: number): Promise<void> {
  await api.answerCallbackQuery(cbId, await autoTranslate(env, await captcha.getGroupLang(env, chatId) || "es", "❌ Esta identificación no es para ti."), true).catch(() => null);
}

async function deletePreviousChallenge(env: BotEnv, api: TelegramApi, chatId: number, userId: number): Promise<void> {
  const rdb = createRedis(env);
  const mid = Number((await rdb.get(`ID_msgbot:${chatId}:${userId}`)) ?? 0);
  if (!mid) return;
  try { await api.deleteMessage(chatId, mid); } catch { /* ignore */ }
  await rdb.del(`ID_msgbot:${chatId}:${userId}`);
}

async function handleCallbackQuery(env: BotEnv, api: TelegramApi, cb: any): Promise<void> {
  if (!cb || !cb.data) return;
  const chatId = cb.message?.chat?.id;
  const fromId = cb.from?.id;
  const data = cb.data;
  const rdb = createRedis(env);
  const lang = (await captcha.getGroupLang(env, chatId ?? 0)) || "es";

  if (data.startsWith("dice_answer:")) {
    await handleDiceCallback(env, api, cb);
    return;
  }

  if (data === "crypto") {
    const targetChatId = cb.message?.chat?.id;
    if (!targetChatId) return;
    await handleCryptoCallback(env, api, targetChatId, cb);
    return;
  }

  let m: RegExpMatchArray | null;

  // simple:<userId> -> boton de verificacion
  m = data.match(/^simple:(-?\d+)$/);
  if (m) {
    const uid = Number(m[1]);
    if (fromId !== uid) { await answerNotForYou(env, api, cb.id, chatId ?? 0); return; }
    const state = await rdb.get(captcha.verifyKey(chatId ?? 0, uid));
    if (state !== "pending") {
      await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⏳ Este desafío ya no está disponible."), true).catch(() => null);
      return;
    }
    await captcha.markVerified(env, api, chatId ?? 0, uid, cb.from?.username);
    return;
  }

  // math_answer:<userId>:<token>
  m = data.match(/^math_answer:(-?\d+):(.+)$/);
  if (m) {
    const uid = Number(m[1]);
    const token = m[2];
    if (fromId !== uid) { await answerNotForYou(env, api, cb.id, chatId ?? 0); return; }
    const tokenKey = captcha.mathTokenKey(chatId ?? 0, uid, token);
    const expected = await rdb.get(captcha.mathAnswerKey(chatId ?? 0, uid));
    const chosen = await rdb.get(tokenKey);
    await rdb.del(tokenKey);
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
    await deletePreviousChallenge(env, api, chatId ?? 0, uid);
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
    await rdb.del(tokenKey);
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
    await deletePreviousChallenge(env, api, chatId ?? 0, uid);
    await captcha.issueCaptcha(env, api, chatId ?? 0, uid, cb.from, cb);
    await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "🤩 Nuevo desafío generado.")).catch(() => null);
    return;
  }

  // nightmode callbacks
  if (data.startsWith("nightmode_")) {
    await handleNightmodeCallback(env, api, cb);
    return;
  }

  // langblock:<gid>:<code>
  if (data.startsWith("langblock:")) {
    await handleLanguageCallback(env, api, cb);
    return;
  }

  // summary:<gid>
  if (data.startsWith("summary:")) {
    await handleSummaryCallback(env, api, cb);
    return;
  }

  // kun:pg:<token>:<page> / kun:export:<token> / kun:close:<token>
  if (data.startsWith("kun:")) {
    await handleKnownCallback(env, api, cb);
    return;
  }

  // checkadmin:<gid> (comprobar administración del bot)
  m = data.match(/^checkadmin:(-?\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    const ok = await captcha.botHasPermissions(env, api, gid);
    const lang = await captcha.getGroupLang(env, gid);
    const rdbLocal = createRedis(env);
    const msgBotId = await rdbLocal.get(`perms_bot:${gid}`);
    const kb = { inline_keyboard: [[{ text: await autoTranslate(env, lang, "🔐 Abrir bot en privado para configurar"), url: `https://t.me/${await getBotUsername(api)}?start=config_${gid}` }]] };
    const textOut = ok
      ? await autoTranslate(env, lang, "Gracias por darme administración, ahora mi trabajo empieza, vamor a por ello!!!")
      : await autoTranslate(env, lang, "Es necesario que para poder ayudarte en tu grupo debas activarme y darme administración, incluyendo los permisos de borrar mensajes y restringir usuarios, de lo contrario tendré que salir de tu grupo en 5 minutos, (luego de darme administración toca el botón comprobar o envía cualquier mensaje en el chat para comprobar la configuración)");
    if (msgBotId) {
      await api.editMessageText(gid, Number(msgBotId), textOut, { reply_markup: kb } as any).catch(() => null);
    }
    return;
  }

  // settings:* / pop:* / setup:* / mode:set / action:set / action_2:set / lang / langset / langblock_menu -> menu de configuracion
  if (
    data.startsWith("settings:") ||
    data.startsWith("pop:") ||
    data.startsWith("setup:") ||
    data.startsWith("langblock_menu:") ||
    data.startsWith("mode:set") ||
    data.startsWith("action_2:set") ||
    data.startsWith("action:set") ||
    data.startsWith("lang:") ||
    data.startsWith("langset:")
  ) {
    await handleSettingsCallback(env, api, cb);
    return;
  }

  await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "❌ Acción desconocida."), true).catch(() => null);
}

async function handleChatJoinRequest(env: BotEnv, api: TelegramApi, req: any): Promise<void> {
  await handleChannelJoinRequest(env, api, req);
}
