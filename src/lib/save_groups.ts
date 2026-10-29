/**
 * Módulo save_groups — registra grupos conocidos y accesos de admins.
 * Portado desde `bot/modules/save_groups.lua`.
 *
 * El bot original guardaba `group_known:<gid>` y `group_access:<gid>:<uid>`
 * en cada mensaje de supergrupo. Aquí se hace lo mismo, pero refrescando la
 * lista de administradores como máximo una vez por hora para no llamar a la
 * API de Telegram en cada mensaje.
 */

import { createRedis, RedisEnv, type RedisCommand } from "./redis";
import { TelegramApi } from "./telegram";
import { adminCacheKey, ADMIN_CACHE_TTL_SEC } from "./access";
import { adminIndexCommands } from "./group_registry";

function adminList(admins: any): any[] {
  if (Array.isArray(admins)) return admins;
  const result = admins?.result;
  return Array.isArray(result) ? result : [];
}

function adminCommands(chatId: number, admins: any[]): RedisCommand[] {
  const commands: RedisCommand[] = [];
  for (const admin of admins) {
    const uid = admin?.user?.id;
    if (uid === undefined || uid === null) continue;
    commands.push(["SETEX", adminCacheKey(chatId, Number(uid)), ADMIN_CACHE_TTL_SEC, "true"], ["DEL", `group_access_neg:${chatId}:${uid}`]);
  }
  return commands;
}

export async function handleSaveGroups(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const chat = msg?.chat;
  if (!chat || (chat.type !== "supergroup" && chat.type !== "group")) return;
  const chatId = Number(chat.id);
  const rdb = createRedis(env);
  await rdb.set(`group_known:${chatId}`, "true");
  const admins = await api.getChatAdministrators(chatId);
  const list = adminList(admins);
  if (list.length) await rdb.pipeline([...adminCommands(chatId, list), ...await adminIndexCommands(env, chatId, list)]);
}

/** Mantiene el grupo y sus admins registrados (se llama en cada mensaje de grupo). */
export async function trackGroup(env: RedisEnv, api: TelegramApi, chatId: number): Promise<boolean> {
  const rdb = createRedis(env);
  const [, refreshed, pendingLeave] = await rdb.pipeline([["SET", `group_known:${chatId}`, "true"], ["GET", `group_access_refresh:${chatId}`], ["GET", `leave_scheduled:${chatId}`]]);
  if (pendingLeave) return false;
  if (refreshed) return true;

  const admins = await api.getChatAdministrators(chatId);
  const list = adminList(admins);
  if (!list.length) return true; // sin permisos o error: se reintenta en el próximo mensaje
  // Write the refresh marker only after every admin update succeeded. A partial
  // pipeline failure must be retried on the next message, as before.
  await rdb.pipeline([...adminCommands(chatId, list), ...await adminIndexCommands(env, chatId, list)]);
  await rdb.setex(`group_access_refresh:${chatId}`, 3600, "1");
  return true;
}
