/**
 * Módulo users — log de actividad hacia el chat privado de logs del bot.
 * Portado desde `bot/modules/users.lua`.
 */

import { RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

const LOG_CHAT_ID = -1001095887694; // chat id del canal/log del bot

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

export async function handleUsersLog(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const text = String(msg?.text ?? "");
  const chatId = msg?.chat?.id;
  const chatType = msg?.chat?.type ?? "?";
  const userStr = getFrom(msg);
  void env;
  await api.sendMessage(LOG_CHAT_ID, `${nowIso()} ${text} ${userStr} -> [${chatId}] [${chatType}]`);
}

export async function handleUsersLogCallback(api: TelegramApi, cb: any): Promise<void> {
  const data = String(cb?.data ?? "");
  const chatId = cb?.message?.chat?.id;
  const userStr = getFrom(cb);
  await api.sendMessage(LOG_CHAT_ID, `${nowIso()} ###cb:${data} ${userStr} -> [${chatId}]`);
}
