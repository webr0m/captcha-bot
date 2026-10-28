/**
 * Verificación para canales públicos vía deep-link (/start verify_channel_<channel>).
 * Portado desde `bot/modules/verifi_public_channel.lua`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import { addTask } from "./tasks";

const CODE_TTL_SEC = 60;
const VERIFIED_TTL_SEC = 30 * 24 * 3600;
const CODE_LEN = 5;

function vkeyCode(chatId: number, userId: number): string {
  return `chanverify:${chatId}:${userId}:code`;
}
function vkeyFlag(chatId: number, userId: number): string {
  return `chanver:${chatId}:${userId}`;
}
function lastChannelKey(userId: number): string {
  return `chanverify:last:${userId}`;
}

function randomCode(n: number): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * chars.length);
    out += chars[idx];
  }
  return out;
}

export async function isVerified(env: RedisEnv, chatId: number, userId: number): Promise<boolean> {
  const v = await createRedis(env).get(vkeyFlag(chatId, userId));
  return v === "ok";
}

async function postVerifyButton(env: RedisEnv, api: TelegramApi, channelId: number): Promise<void> {
  const botUsername = await getBotUsername(api);
  const text = await autoTranslate(env, "es", "🔐 Para participar en dinámicas del canal, toca **Verificar** y completa un CAPTCHA en privado.");
  const kb = { inline_keyboard: [[{ text: "🔐 Verificar", url: `https://t.me/${botUsername}?start=verify_channel_${channelId}` }]] };
  await api.sendMessage(channelId, text, { parse_mode: "Markdown", reply_markup: kb });
}

async function getBotUsername(api: TelegramApi): Promise<string> {
  try {
    const me = await api.getMe();
    const username = (me as any)?.username;
    if (username) return username;
  } catch { /* ignore */ }
  return "TuBot";
}

async function onPostVerifyCommand(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  if (!msg?.text) return;
  const input = String(msg.text).match(/^\/post_verify\s+([@%-\w_]+)$/)?.[1];
  if (!input) {
    await api.sendMessage(msg.chat.id, "⛔ Uso: /post_verify <channel_id_o_alias>");
    return;
  }
  let channelId = input;
  if (channelId.startsWith("@")) {
    const info = await api.getChat(Number(channelId));
    const id = (info as any)?.result?.id;
    if (id === undefined) {
      await api.sendMessage(msg.chat.id, "❌ No pude obtener el ID del canal.");
      return;
    }
    channelId = String(id);
  }
  const chatId = Number(channelId);
  await postVerifyButton(env, api, chatId);
}

async function onStartVerify(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  if (msg?.chat?.type !== "private" || !msg?.text) return;
  const channelId = String(msg.text).match(/^\/start\s+verify_channel_(-?\d+)$/)?.[1];
  if (!channelId) return;
  const userId = Number(msg.from?.id);
  const code = randomCode(CODE_LEN);
  const rdb = createRedis(env);
  await rdb.setex(vkeyCode(Number(channelId), userId), CODE_TTL_SEC, code);
  await rdb.setex(lastChannelKey(userId), CODE_TTL_SEC, channelId);
  const text = await autoTranslate(env, String((await rdb.get(`group:${channelId}:lang`)) ?? "es"), `🔎 Verificación para el canal \`${channelId}\`\n\nEnvía exactamente este código en este chat en ${CODE_TTL_SEC} s:\n\n\`${code}\``);
  await api.sendMessage(msg.chat.id, text);
}

async function onPrivateValidate(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  if (msg?.chat?.type !== "private" || !msg?.text) return;
  const userId = Number(msg.from?.id);
  const lastC = await createRedis(env).get(lastChannelKey(userId));
  if (!lastC) return;
  const chatId = Number(lastC);
  const expected = await createRedis(env).get(vkeyCode(chatId, userId));
  if (!expected) {
    await api.sendMessage(msg.chat.id, "⛔ Tu solicitud de verificación expiró. Vuelve a tocar *Verificar* en el canal.");
    return;
  }
  if (String(msg.text).toUpperCase() === String(expected).toUpperCase()) {
    const rdb = createRedis(env);
    await rdb.setex(vkeyFlag(chatId, userId), VERIFIED_TTL_SEC, "ok");
    await rdb.del(vkeyCode(chatId, userId));
    await rdb.del(lastChannelKey(userId));
    await api.sendMessage(msg.chat.id, "✅ Verificación completada. ¡Gracias!");
  } else {
    const rdb = createRedis(env);
    await rdb.del(vkeyFlag(chatId, userId));
    const sent = await api.sendMessage(msg.chat.id, "❌ Código incorrecto. intentalo nuevamente, recuerda que solo tienes 15 segundos.");
    const sentAny = sent as any;
    const msgId = sentAny?.result?.message_id;
    const now = Math.floor(Date.now() / 1000);
    await addTask(env, { type: "ban", chatId, param: userId, runAt: now + 15 });
    if (msgId) {
      await api.editMessageText(msg.chat.id, Number(msgId), "❌ Código incorrecto. se acabo el tiempo de verificación, Baneado del canal.").catch(() => null);
    }
  }
}

async function onListVerified(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  if (!msg?.text) return;
  const input = String(msg.text).match(/^\/list_verified\s+([@%-\w_]+)$/)?.[1];
  if (!input) {
    await api.sendMessage(msg.chat.id, "⛔ Uso: /list_verified <channel_id_o_alias>");
    return;
  }
  let channelId = input;
  if (channelId.startsWith("@")) {
    const info = await api.getChat(Number(channelId));
    const id = (info as any)?.result?.id;
    if (id === undefined) {
      await api.sendMessage(msg.chat.id, "❌ No pude obtener el ID del canal.");
      return;
    }
    channelId = String(id);
  }
  const chatId = Number(channelId);
  const keys = await createRedis(env).keys(`chanver:${chatId}:*`);
  const lines: string[] = [];
  for (const key of keys) {
    const m = String(key).match(/^chanver:(-?\d+):(\d+)$/);
    if (!m) continue;
    const uid = Number(m[2]);
    const member = await api.getChatMember(chatId, uid);
    const memberAny = member as any;
    const user = memberAny?.result?.user;
    if (user) {
      const name = `${String(user.first_name ?? "")} ${user.last_name ?? ""}`.trim();
      const label = user.username ? `${name} (@${user.username})` : name;
      lines.push(label);
    } else {
      lines.push(String(uid));
    }
  }
  const text = lines.length ? `✅ Usuarios verificados en el canal:\n${lines.join("\n")}` : "ℹ️ No hay usuarios verificados en este canal.";
  await api.sendMessage(msg.chat.id, text);
}

export async function handleVerifyPublicChannel(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  if (!msg?.text) return;
  if (String(msg.text).match(/^\/post_verify\s+.+/)) {
    await onPostVerifyCommand(env, api, msg);
    return;
  }
  if (String(msg.text).match(/^\/list_verified\s+/)) {
    await onListVerified(env, api, msg);
    return;
  }
  if (String(msg.text).match(/^\/start\s+verify_channel_/)) {
    await onStartVerify(env, api, msg);
    return;
  }
  await onPrivateValidate(env, api, msg);
}
