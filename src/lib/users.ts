/**
 * Módulo users — log opcional de actividad hacia un chat de logs.
 * Portado desde `bot/modules/users.lua`.
 *
 * Se activa configurando el secreto/variable `USERS_LOG_CHAT_ID` (por ejemplo
 * -1001095887694). Si no está configurado, no hace nada: nunca bloquea updates.
 */

import { RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

function logChatId(env: RedisEnv & { USERS_LOG_CHAT_ID?: string }): number {
  const raw = Number(env.USERS_LOG_CHAT_ID ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

function nowIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function getFrom(msg: any): string {
  const u = msg?.from;
  if (!u) return "[desconocido]";
  let s = `[${String(u.first_name ?? "")}`;
  if (u.last_name) s += ` ${u.last_name}`;
  s += "]";
  if (u.username) s += ` [@${u.username}]`;
  s += ` [${u.id ?? "?"}]`;
  return s;
}

export async function handleUsersLog(env: RedisEnv & { USERS_LOG_CHAT_ID?: string }, api: TelegramApi, msg: any): Promise<void> {
  const target = logChatId(env);
  if (!target) return;
  const text = String(msg?.text ?? "");
  const chatId = msg?.chat?.id;
  const chatType = msg?.chat?.type ?? "?";
  const userStr = getFrom(msg);
  await api.sendMessage(target, `${nowIso()} ${text} ${userStr} -> [${chatId}] [${chatType}]`);
}

export async function handleUsersLogCallback(
  env: RedisEnv & { USERS_LOG_CHAT_ID?: string },
  api: TelegramApi,
  cb: any,
): Promise<void> {
  const target = logChatId(env);
  if (!target) return;
  const data = String(cb?.data ?? "");
  const chatId = cb?.message?.chat?.id;
  const userStr = getFrom(cb);
  await api.sendMessage(target, `${nowIso()} ###cb:${data} ${userStr} -> [${chatId}]`);
}
