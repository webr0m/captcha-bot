/**
 * Módulo broadcast — envía un mensaje a todos los usuarios "known" desde el privado del bot.
 * Portado desde bot/modules/broadcast.lua
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

function normalizeCaption(caption: string | undefined): { caption: string; trimmed: boolean; origLen: number } {
  if (!caption) return { caption: "", trimmed: false, origLen: 0 };
  const len = caption.length;
  if (len > 1024) return { caption: caption.slice(0, 1021) + "...", trimmed: true, origLen: len };
  return { caption, trimmed: false, origLen: len };
}

async function collectAllUserIds(env: RedisEnv): Promise<number[]> {
  const rdb = createRedis(env);
  const keys = await rdb.keys("known_users:*");
  const seen = new Set<string>();
  const ids: number[] = [];
  for (const key of keys) {
    if (key.startsWith("known_users:tmp:")) continue;
    if (key === "known_users:all") continue;
    const members = await rdb.smembers(key);
    for (const uid of members) {
      if (seen.has(uid)) continue;
      seen.add(uid);
      ids.push(Number(uid));
    }
  }
  return ids;
}

export async function sendBroadcast(env: RedisEnv, api: TelegramApi, fromId: number, replyMsg: any): Promise<void> {
  const rdb = createRedis(env);
  const ids = await collectAllUserIds(env);
  const total = ids.length;
  if (total === 0) {
    await api.sendMessage(fromId, "⚠️ No hay usuarios registrados para broadcast.");
    return;
  }
  const normCaption = normalizeCaption(replyMsg?.caption);
  if (normCaption.trimmed) {
    await api.sendMessage(fromId, `⚠️ El caption original tenía ${normCaption.origLen} caracteres y fue recortado a 1024.`);
  }
  await api.sendMessage(fromId, `📣 Iniciando broadcast a ${total} usuarios…`);

  let sent = 0;
  let failed = 0;
  for (const uid of ids) {
    let ok = false;
    try {
      if (replyMsg?.text) {
        await api.sendMessage(uid, replyMsg.text);
        ok = true;
      } else if (replyMsg?.photo) {
        const fileId = replyMsg.photo[replyMsg.photo.length - 1].file_id;
        await api.sendPhoto(uid, fileId, normCaption.caption);
        ok = true;
      } else if (replyMsg?.video) {
        const fileId = replyMsg.video.file_id;
        await api.sendVideo(uid, fileId, normCaption.caption);
        ok = true;
      } else if (replyMsg?.animation) {
        const fileId = replyMsg.animation.file_id;
        await api.sendAnimation(uid, fileId, normCaption.caption);
        ok = true;
      } else if (replyMsg?.document) {
        const fileId = replyMsg.document.file_id;
        await api.sendDocument(uid, fileId, normCaption.caption);
        ok = true;
      } else if (replyMsg?.sticker) {
        const fileId = replyMsg.sticker.file_id;
        await api.sendSticker(uid, fileId);
        ok = true;
      } else if (replyMsg?.voice) {
        const fileId = replyMsg.voice.file_id;
        await api.sendVoice(uid, fileId);
        ok = true;
      } else if (replyMsg?.audio) {
        const fileId = replyMsg.audio.file_id;
        await api.sendAudio(uid, fileId, normCaption.caption);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (ok) sent++;
    else failed++;
  }

  await api.sendMessage(fromId, `✅ Broadcast finalizado. Enviados: ${sent}, fallidos: ${failed}`);
}

export async function handleBroadcast(env: RedisEnv & { BOT_TOKEN: string }, api: TelegramApi, fromId: number, replyMsg: any): Promise<void> {
  await sendBroadcast(env, api, fromId, replyMsg);
}
