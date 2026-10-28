/**
 * Módulo save_groups — registra grupos conocidos y accesos de admins.
 * Portado desde `bot/modules/save_groups.lua`.
 *
 * El bot original guardaba `group_known:<gid>` y `group_access:<gid>:<uid>`
 * en cada mensaje de supergrupo. Aquí se hace lo mismo, pero refrescando la
 * lista de administradores como máximo una vez por hora para no llamar a la
 * API de Telegram en cada mensaje.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

function adminList(admins: any): any[] {
  if (Array.isArray(admins)) return admins;
  const result = admins?.result;
  return Array.isArray(result) ? result : [];
}

export async function handleSaveGroups(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const chat = msg?.chat;
  if (!chat || (chat.type !== "supergroup" && chat.type !== "group")) return;
  const chatId = Number(chat.id);
  const rdb = createRedis(env);
  await rdb.set(`group_known:${chatId}`, "true");
  const admins = await api.getChatAdministrators(chatId);
  for (const admin of adminList(admins)) {
    const uid = admin?.user?.id;
    if (uid === undefined || uid === null) continue;
    await rdb.set(`group_access:${chatId}:${uid}`, "true");
    await rdb.del(`group_access_neg:${chatId}:${uid}`);
  }
}

/** Mantiene el grupo y sus admins registrados (se llama en cada mensaje de grupo). */
export async function trackGroup(env: RedisEnv, api: TelegramApi, chatId: number): Promise<void> {
  const rdb = createRedis(env);
  await rdb.set(`group_known:${chatId}`, "true");

  const refreshed = await rdb.get(`group_access_refresh:${chatId}`);
  if (refreshed) return;

  const admins = await api.getChatAdministrators(chatId);
  const list = adminList(admins);
  if (!list.length) return; // sin permisos o error: se reintenta en el próximo mensaje
  for (const admin of list) {
    const uid = admin?.user?.id;
    if (uid === undefined || uid === null) continue;
    await rdb.set(`group_access:${chatId}:${uid}`, "true");
    await rdb.del(`group_access_neg:${chatId}:${uid}`);
  }
  await rdb.setex(`group_access_refresh:${chatId}`, 3600, "1");
}
