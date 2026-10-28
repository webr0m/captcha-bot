/**
 * Verificación por canal (join requests) — portado desde `bot/modules/channel_verify.lua`
 * y `bot/modules/verifi_public_channel.lua` (deep-link /start verify_...).
 *
 * - Un usuario intenta unirse a un canal con join request -> se le pide código.
 * - /start verify_<chat>_<user> -> el usuario pide el código en privado.
 * - El usuario envía el código en privado -> se aprueba o se rechaza.
 * - Expiración -> decline automático.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import { addTask } from "./tasks";

const DEFAULT_TIMEOUT = 60;
const CODE_LEN = 5;
const VERIFIED_TTL_SEC = 30 * 24 * 3600;

function jrKey(chatId: number, userId: number): string {
  return `jr:${chatId}:${userId}`;
}
function jrCodeKey(chatId: number, userId: number): string {
  return `jr:${chatId}:${userId}:code`;
}
function enableKey(chatId: number): string {
  return `channel_verify:${chatId}:enabled`;
}
function timeoutKey(chatId: number): string {
  return `channel_verify:${chatId}:timeout`;
}
function lastChannelKey(userId: number): string {
  return `jr:last_channel:${userId}`;
}

export async function getChannelVerifyTimeout(env: RedisEnv, chatId: number): Promise<number> {
  const v = await createRedis(env).get(timeoutKey(chatId));
  const n = v ? Number(v) : DEFAULT_TIMEOUT;
  const val = Number.isFinite(n) ? n : DEFAULT_TIMEOUT;
  if (val < 15) return 15;
  if (val > 1800) return 1800;
  return val;
}

export async function isChannelVerifyEnabled(env: RedisEnv, chatId: number): Promise<boolean> {
  const v = await createRedis(env).get(enableKey(chatId));
  return v === undefined || v === null || v === "true";
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

async function storeRequest(env: RedisEnv, chatId: number, userId: number, code: string, ttl: number): Promise<void> {
  const rdb = createRedis(env);
  await rdb.setex(jrKey(chatId, userId), ttl, "pending");
  await rdb.setex(jrCodeKey(chatId, userId), ttl, code);
  await rdb.setex(lastChannelKey(userId), ttl, String(chatId));
}

async function clearRequest(env: RedisEnv, chatId: number, userId: number): Promise<void> {
  const rdb = createRedis(env);
  await rdb.del(jrKey(chatId, userId));
  await rdb.del(jrCodeKey(chatId, userId));
  await rdb.del(lastChannelKey(userId));
}

// ---------- Handlers ----------

export async function handleChannelJoinRequest(env: RedisEnv, api: TelegramApi, req: any): Promise<void> {
  const chat = req?.chat;
  if (!chat || chat.type !== "channel") return;
  const chatId = Number(chat.id);
  if (!(await isChannelVerifyEnabled(env, chatId))) return;

  const user = req?.from;
  const userId = Number(user?.id);
  const timeout = await getChannelVerifyTimeout(env, chatId);
  const lang = await createRedis(env).get(`group:${chatId}:lang`) ?? "es";
  const code = randomCode(CODE_LEN);

  await storeRequest(env, chatId, userId, code, timeout);

  const intro = `🔐 ${await autoTranslate(env, lang, "Verificación para unirte al canal")}`;
  const body = await autoTranslate(env, lang, `Envía este código **exactamente** en este chat dentro de ${timeout} s:\n\n\`${code}\``);
  try { await api.sendMessage(userId, `${intro}\n\n${body}`); } catch { /* ignore: user may not have started the bot */ }

  const now = Math.floor(Date.now() / 1000);
  await addTask(env, { type: "decline", chatId, param: userId, runAt: now + timeout });
}

export async function handleStartVerify(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  if (msg?.chat?.type !== "private" || !msg?.text) return;
  const m = String(msg.text).match(/^\/start\s+verify_(-?\d+)_(\d+)$/);
  if (!m) return;
  const chatId = Number(m[1]);
  const userId = Number(m[2]);
  if (userId !== Number(msg.from?.id)) {
    await api.sendMessage(msg.chat.id, "Esta solicitud no te pertenece.");
    return;
  }
  const code = await createRedis(env).get(jrCodeKey(chatId, userId));
  if (!code) {
    await api.sendMessage(msg.chat.id, "No hay una verificación pendiente o ya expiró.");
    return;
  }
  const lang = await createRedis(env).get(`group:${chatId}:lang`) ?? "es";
  const text = await autoTranslate(env, lang, `📩 Envía este código exactamente:\n\n\`${code}\``);
  await api.sendMessage(msg.chat.id, text);
  return;
}

export async function handlePrivateCheck(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  if (msg?.chat?.type !== "private" || !msg?.text) return;
  const userId = Number(msg.from?.id);
  const lastC = await createRedis(env).get(lastChannelKey(userId));
  if (!lastC) return;
  const chatId = Number(lastC);
  const expected = await createRedis(env).get(jrCodeKey(chatId, userId));
  if (!expected) {
    await api.sendMessage(msg.chat.id, "⛔ Tu solicitud de verificación expiró. Vuelve a tocar *Verificar* en el canal.");
    return;
  }
  if (String(msg.text).toUpperCase() === String(expected).toUpperCase()) {
    await createRedis(env).setex(jrKey(chatId, userId), VERIFIED_TTL_SEC, "ok");
    await createRedis(env).del(jrCodeKey(chatId, userId));
    await createRedis(env).del(lastChannelKey(userId));
    await api.sendMessage(msg.chat.id, "✅ Verificación correcta. Te hemos aprobado en el canal.");
  } else {
    const sent = await api.sendMessage(msg.chat.id, "❌ Código incorrecto. Revisa y vuelve a intentarlo.");
    const sentAny = sent as any;
    const msgId = sentAny?.result?.message_id;
    const now = Math.floor(Date.now() / 1000);
    await addTask(env, { type: "ban", chatId, param: userId, runAt: now + 15 });
    if (msgId) {
      await api.editMessageText(msg.chat.id, Number(msgId), "❌ Código incorrecto. se acabo el tiempo de verificación, Baneado del canal.").catch(() => null);
    }
  }
}
