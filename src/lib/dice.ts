/**
 * Módulo de verificación con dados (dice) — portado desde bot/modules/dice.lua.
 * Requiere sticker "spin" configurado (manual o Redis: group:<chat>:dice:spin).
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { addTask } from "./tasks";
import * as captcha from "./captcha";

const FILE_ID_DICE_SPIN = "CAACAgQAAxkBAAEX-2NooULqxxs0ebCGHqtJYmW1BSq5IwACQAADyPrsEwABS8ZSKgqsrjYE";
const FILE_IDS: Record<string, string> = {
  "1": "CAACAgEAAxkBAAEX-2xooUNpXr_eDe2HW9yx0QtjCjtYawACfw4AAoI0egGMUY9GQldDATYE",
  "2": "CAACAgEAAxkBAAEX-2hooUNBwMQk8OCSKsGRv2gJOX7nsgACgA4AAoI0egEMlvotM7vbaDYE",
  "3": "CAACAgEAAxkBAAEX-25ooUOLG-wHjLOtqVaOA1iGBAH1cAACgQ4AAoI0egHmMZTw4jEsUjYE",
  "4": "CAACAgEAAxkBAAEX-3BooUOf996YtwyZexynFtV5ND5a8QACgg4AAoI0egFxeg_q3jlyvTYE",
  "5": "CAACAgEAAxkBAAEX-3JooUO0jYTeBIyMDZSfvlMCmiUX9AACgw4AAoI0egHMmDGMXUyPXzYE",
  "6": "CAACAgEAAxkBAAEX-2pooUNUcoJBj8sSFXk0LnlkSaGISQAChA4AAoI0egEyx_5CLNK94DYE",
};

function randToken(n: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(chars[Math.floor(Math.random() * chars.length)]);
  return out.join("");
}

async function getDiceSticker(env: RedisEnv, chatId: number, face: string): Promise<string | null> {
  // Permite sobreescribir el sticker desde Redis; si no, usa el file_id por defecto.
  const v = await createRedis(env).get(`group:${chatId}:dice:${face}`);
  if (v) return v;
  return FILE_IDS[face] ?? null;
}

async function getDiceSpin(env: RedisEnv, chatId: number): Promise<string | null> {
  const v = await createRedis(env).get(`group:${chatId}:dice:spin`);
  if (v) return v;
  return FILE_ID_DICE_SPIN;
}

export async function issueDice(env: RedisEnv, api: TelegramApi, chatId: number, userId: number, msg: any): Promise<void> {
  const timeout = await captcha.getKickTimeout(env, chatId);
  const rdb = createRedis(env);
  const now = Math.floor(Date.now() / 1000);
  const target = Math.floor(Math.random() * 6) + 1;
  await rdb.setex(`dice_target:${chatId}:${userId}`, timeout, String(target));

  const row1: any[] = [];
  const row2: any[] = [];
  for (let n = 1; n <= 6; n++) {
    const token = randToken(10);
    await rdb.setex(`dice_token:${chatId}:${userId}:${token}`, timeout, String(n));
    const row = n <= 3 ? row1 : row2;
    row.push({ text: String(n), callback_data: `dice_answer:${userId}:${token}` });
  }
  const keyboard = { inline_keyboard: [row1, row2] };

  const spinId = await getDiceSpin(env, chatId);
  if (!spinId) {
    await api.sendMessage(chatId, "⚠️ Falta configurar el sticker 'spin' (manual o Redis)");
    return;
  }

  // Estado común de verificación: el cron solo expulsa si sigue "pending".
  // La expulsión se programa únicamente después de enviar los mensajes.
  await rdb.setex(captcha.verifyKey(chatId, userId), timeout + 60, "pending");
  await rdb.setex(captcha.verifyDeadlineKey(chatId, userId), timeout + 120, String(now + timeout + 5));

  let sent: any;
  let spinRes: any;
  try {
    sent = await api.sendMessage(chatId, "*Elige un dado:*", { parse_mode: "Markdown", reply_markup: keyboard });
    spinRes = await api.sendSticker(chatId, spinId);
  } catch (err) {
    await captcha.clearChallengeState(env, chatId, userId).catch(() => null);
    await rdb.del(captcha.verifyKey(chatId, userId), captcha.verifyDeadlineKey(chatId, userId)).catch(() => null);
    throw err;
  }

  try {
    await addTask(env, { type: "kick", chatId, param: userId, runAt: now + timeout + 5 });
  } catch (err) {
    console.error("No se pudo programar el kick de dice:", err);
  }

  const msgBotId = Number((sent as any)?.message_id ?? 0);
  const msgSpinId = Number((spinRes as any)?.message_id ?? 0);

  if (msgBotId) await rdb.setex(`ID_msgbot:${chatId}:${userId}`, timeout + 60, String(msgBotId));
  if (msg?.message_id) await rdb.setex(`ID_msgsys:${chatId}:${userId}`, timeout + 60, String(msg.message_id));
  if (msgSpinId) await rdb.setex(`ID_msgspin:${chatId}:${userId}`, timeout + 60, String(msgSpinId));
}

export async function handleDiceCallback(env: RedisEnv, api: TelegramApi, cb: any): Promise<void> {
  const chatId = cb?.message?.chat?.id;
  if (!chatId) return;
  const m = cb?.data?.match(/^dice_answer:(-?\d+):(.+)$/);
  if (!m) return;
  const uid = Number(m[1]);
  const token = m[2];
  const fromId = Number(cb?.from?.id ?? 0);
  if (fromId !== uid) {
    await api.answerCallbackQuery(cb.id, "❌ No es tu desafío.", true).catch(() => null);
    return;
  }

  const rdb = createRedis(env);
  const state = await rdb.get(captcha.verifyKey(chatId, uid));
  if (state !== "pending") {
    await api.answerCallbackQuery(cb.id, "⏳ Este desafío ya no está disponible.", true).catch(() => null);
    return;
  }

  const chosen = await rdb.get(`dice_token:${chatId}:${uid}:${token}`);
  const target = await rdb.get(`dice_target:${chatId}:${uid}`);
  if (!chosen || !target) {
    await api.answerCallbackQuery(cb.id, "⏳ Expirado.", true).catch(() => null);
    return;
  }

  const msgBotId = Number((await rdb.get(`ID_msgbot:${chatId}:${uid}`)) ?? 0);
  const msgSpinId = Number((await rdb.get(`ID_msgspin:${chatId}:${uid}`)) ?? 0);
  if (msgBotId) { try { await api.deleteMessage(chatId, msgBotId); } catch { /* ignore */ } }
  if (msgSpinId) { try { await api.deleteMessage(chatId, msgSpinId); } catch { /* ignore */ } }

  if (String(chosen) === String(target)) {
    const face = await getDiceSticker(env, chatId, String(chosen));
    if (face) { try { await api.sendSticker(chatId, face); } catch { /* ignore */ } }
    // markVerified desmutea, limpia el estado y registra la verificación.
    await captcha.markVerified(env, api, chatId, uid, cb?.from?.username);
    await api.answerCallbackQuery(cb.id, "✅ Correcto", true).catch(() => null);
  } else {
    const banFace = await getDiceSticker(env, chatId, "ban");
    if (banFace) { try { await api.sendSticker(chatId, banFace); } catch { /* ignore */ } }

    const action = await captcha.getCaptchaAction(env, chatId);
    try {
      if (action === "ban") {
        // until_date = 0 -> ban permanente.
        await api.banChatMember(chatId, uid, 0);
      } else {
        await api.kickChatMember(chatId, uid);
      }
    } catch { /* el usuario pudo salir */ }

    await captcha.clearChallengeState(env, chatId, uid);
    await rdb.del(`ID_msgbot:${chatId}:${uid}`, `ID_msgsys:${chatId}:${uid}`, `ID_msgspin:${chatId}:${uid}`);
    await api.answerCallbackQuery(cb.id, "❌ Incorrecto", true).catch(() => null);
  }
}
