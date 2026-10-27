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

async function getDiceSticker(env: any, chatId: number, face: string): Promise<string | null> {
  const manual = FILE_IDS[face];
  if (manual && manual !== "") return manual;
  const v = await createRedis(env).get(`group:${chatId}:dice:${face}`);
  return v;
}

async function getDiceSpin(env: any, chatId: number): Promise<string | null> {
  const manual = FILE_ID_DICE_SPIN;
  if (manual && manual !== "") return manual;
  const v = await createRedis(env).get(`group:${chatId}:dice:spin`);
  return v;
}

export async function issueDice(env: any, api: TelegramApi, chatId: number, userId: number, msg: any): Promise<void> {
  const timeout = await captcha.getKickTimeout(env, chatId);
  const rdb = createRedis(env);
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
  const sent = await api.sendMessage(chatId, "*Elige un dado:*", { parse_mode: "Markdown", reply_markup: keyboard });
  const sentAny = sent as any;
  const msgBotId = sentAny?.result?.message_id;
  const spinRes = await api.sendSticker(chatId, spinId);
  const spinAny = spinRes as any;
  const msgSpinId = spinAny?.result?.message_id;

  await rdb.setex(`ID_msgbot:${chatId}:${userId}`, timeout + 60, msgBotId);
  await rdb.setex(`ID_msgsys:${chatId}:${userId}`, timeout + 60, msg?.message_id);
  await rdb.setex(`ID_msgspin:${chatId}:${userId}`, timeout + 60, msgSpinId);
  await rdb.setex(`verify:${chatId}:${userId}:status`, timeout + 60, "pending");
  await addTask(env, { type: "kick", chatId, param: userId, runAt: Math.floor(Date.now() / 1000) + timeout + 5 });
}

export async function handleDiceCallback(env: any, api: TelegramApi, cb: any): Promise<void> {
  const chatId = cb?.message?.chat?.id;
  if (!chatId) return;
  const m = cb?.data?.match(/^dice_answer:(-?\d+):(.+)$/);
  if (!m) return;
  const uid = Number(m[1]);
  const token = m[2];
  const fromId = cb?.from?.id;
  if (fromId !== uid) {
    await api.answerCallbackQuery(cb.id, "❌ No es tu desafío.", true).catch(() => null);
    return;
  }
  const rdb = createRedis(env);
  const chosen = await rdb.get(`dice_token:${chatId}:${uid}:${token}`);
  const target = await rdb.get(`dice_target:${chatId}:${uid}`);
  if (!chosen || !target) {
    await api.answerCallbackQuery(cb.id, "⏳ Expirado.", true).catch(() => null);
    return;
  }
  const msgBotId = await rdb.get(`ID_msgbot:${chatId}:${uid}`);
  const msgSpinId = await rdb.get(`ID_msgspin:${chatId}:${uid}`);
  if (msgBotId) { try { await api.deleteMessage(chatId, Number(msgBotId)); } catch { /* ignore */ } }
  if (msgSpinId) { try { await api.deleteMessage(chatId, Number(msgSpinId)); } catch { /* ignore */ } }

  if (String(chosen) === String(target)) {
    const face = await getDiceSticker(env, chatId, String(chosen));
    if (face) { try { await api.sendSticker(chatId, face); } catch { /* ignore */ } }
    const action2 = await captcha.getCaptchaAction2(env, chatId);
    const canUnmute = action2 !== "mute" && (await captcha.botHasPermissions(env, api, chatId));
    if (canUnmute) {
      try { await captcha.unmuteUser(api, chatId, uid); } catch { /* ignore */ }
    }
    await createRedis(env).setex(`verify:${chatId}:${uid}`, 86400, "ok");
    await api.answerCallbackQuery(cb.id, "✅ Correcto", true);
  } else {
    const banFace = await getDiceSticker(env, chatId, "ban");
    if (banFace) { try { await api.sendSticker(chatId, banFace); } catch { /* ignore */ } }
    const action = await captcha.getCaptchaAction(env, chatId);
    if (action === "ban") {
      await api.banChatMember(chatId, uid, true, Math.floor(Date.now() / 1000) + 86400);
    } else {
      await api.kickChatMember(chatId, uid);
    }
    await api.answerCallbackQuery(cb.id, "❌ Incorrecto", true);
  }
}
