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
const WRONG_CODE_BAN_SEC = 15;

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

function escapeHtml(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function isVerified(env: RedisEnv, chatId: number, userId: number): Promise<boolean> {
  const v = await createRedis(env).get(vkeyFlag(chatId, userId));
  return v === "ok";
}

/** Acepta tanto un ID numérico como un alias (@canal o canal). */
async function resolveChannelId(api: TelegramApi, input: string): Promise<number> {
  const raw = String(input ?? "").trim();
  if (!raw) return 0;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  const alias = raw.startsWith("@") ? raw : `@${raw}`;
  try {
    const chat = await api.getChat(alias);
    return Number((chat as any)?.id ?? 0);
  } catch {
    return 0;
  }
}

async function isChannelAdmin(api: TelegramApi, channelId: number, userId: number): Promise<boolean> {
  try {
    const member = await api.getChatMember(channelId, userId);
    const status = (member as any)?.status;
    return status === "administrator" || status === "creator";
  } catch {
    return false;
  }
}

async function postVerifyButton(env: RedisEnv, api: TelegramApi, channelId: number): Promise<void> {
  const botUsername = await getBotUsername(api);
  const text = await autoTranslate(env, "es", "🔐 Para participar en dinámicas del canal, toca el botón <b>Verificar</b> y completa un CAPTCHA en privado.");
  const kb = { inline_keyboard: [[{ text: "🔐 Verificar", url: `https://t.me/${botUsername}?start=verify_channel_${channelId}` }]] };
  await api.sendMessage(channelId, text, { parse_mode: "HTML", reply_markup: kb });
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
  const input = String(msg.text).match(/^\/post_verify(?:@\S+)?\s+(@?[\w-]+)/)?.[1];
  if (!input) {
    await api.sendMessage(msg.chat.id, "⛔ Uso: /post_verify <channel_id_o_alias>");
    return;
  }
  const channelId = await resolveChannelId(api, input);
  if (!channelId) {
    await api.sendMessage(msg.chat.id, "❌ No pude obtener el ID del canal.");
    return;
  }
  if (!(await isChannelAdmin(api, channelId, Number(msg.from?.id ?? 0)))) {
    await api.sendMessage(msg.chat.id, "🚫 Solo administradores del canal pueden publicar el botón.");
    return;
  }
  await postVerifyButton(env, api, channelId);
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
  const lang = (await rdb.get(`group:${channelId}:lang`)) ?? "es";
  const text = await autoTranslate(
    env,
    lang,
    `🔎 Verificación para el canal ${channelId}\n\nEnvía exactamente este código en este chat en ${CODE_TTL_SEC} s:\n\n<code>${escapeHtml(code)}</code>`,
  );
  await api.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
}

async function onPrivateValidate(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  if (msg?.chat?.type !== "private" || !msg?.text) return;
  const userId = Number(msg.from?.id);
  const lastC = await createRedis(env).get(lastChannelKey(userId));
  if (!lastC) return;
  const chatId = Number(lastC);
  const expected = await createRedis(env).get(vkeyCode(chatId, userId));
  if (!expected) {
    await api.sendMessage(msg.chat.id, "⛔ Tu solicitud de verificación expiró. Vuelve a tocar el botón Verificar en el canal.");
    return;
  }
  if (String(msg.text).trim().toUpperCase() === String(expected).toUpperCase()) {
    const rdb = createRedis(env);
    await rdb.setex(vkeyFlag(chatId, userId), VERIFIED_TTL_SEC, "ok");
    await rdb.del(vkeyCode(chatId, userId));
    await rdb.del(lastChannelKey(userId));
    await api.sendMessage(msg.chat.id, "✅ Verificación completada. ¡Gracias!");
  } else {
    const rdb = createRedis(env);
    await rdb.del(vkeyFlag(chatId, userId));
    const sent = await api.sendMessage(
      msg.chat.id,
      `❌ Código incorrecto. Inténtalo nuevamente; recuerda que solo tienes ${WRONG_CODE_BAN_SEC} segundos antes de ser baneado del canal.`,
    );
    const msgId = Number((sent as any)?.message_id ?? 0);
    const now = Math.floor(Date.now() / 1000);
    await addTask(env, { type: "ban", chatId, param: userId, runAt: now + WRONG_CODE_BAN_SEC });
    if (msgId) {
      // Deja el aviso visible; el cron lo eliminará junto con el ban.
      await addTask(env, { type: "del", chatId: msg.chat.id, param: msgId, runAt: now + WRONG_CODE_BAN_SEC + 5 });
    }
  }
}

async function onListVerified(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  if (!msg?.text) return;
  const input = String(msg.text).match(/^\/list_verified(?:@\S+)?\s+(@?[\w-]+)/)?.[1];
  if (!input) {
    await api.sendMessage(msg.chat.id, "⛔ Uso: /list_verified <channel_id_o_alias>");
    return;
  }
  const chatId = await resolveChannelId(api, input);
  if (!chatId) {
    await api.sendMessage(msg.chat.id, "❌ No pude obtener el ID del canal.");
    return;
  }
  if (!(await isChannelAdmin(api, chatId, Number(msg.from?.id ?? 0)))) {
    await api.sendMessage(msg.chat.id, "🚫 Solo administradores del canal pueden consultar esta lista.");
    return;
  }

  const keys = await createRedis(env).keys(`chanver:${chatId}:*`);
  const lines: string[] = [];
  for (const key of keys) {
    const m = String(key).match(/^chanver:(-?\d+):(\d+)$/);
    if (!m) continue;
    const uid = Number(m[2]);
    try {
      const member = await api.getChatMember(chatId, uid);
      const user = (member as any)?.user;
      if (user) {
        const name = `${String(user.first_name ?? "")} ${user.last_name ?? ""}`.trim();
        const label = user.username ? `${name} (@${user.username})` : name;
        lines.push(label || String(uid));
      } else {
        lines.push(String(uid));
      }
    } catch {
      lines.push(String(uid));
    }
  }
  const text = lines.length
    ? `✅ Usuarios verificados en el canal:\n${lines.join("\n")}`
    : "ℹ️ No hay usuarios verificados en este canal.";
  await api.sendMessage(msg.chat.id, text);
}

export async function handleVerifyPublicChannel(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  if (!msg?.text) return;
  if (String(msg.text).match(/^\/post_verify(?:@\S+)?\s+/)) {
    await onPostVerifyCommand(env, api, msg);
    return;
  }
  if (String(msg.text).match(/^\/list_verified(?:@\S+)?\s+/)) {
    await onListVerified(env, api, msg);
    return;
  }
  if (String(msg.text).match(/^\/start\s+verify_channel_/)) {
    await onStartVerify(env, api, msg);
    return;
  }
  await onPrivateValidate(env, api, msg);
}
