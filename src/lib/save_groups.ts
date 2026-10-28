/**
 * Módulo save_groups — registra grupos conocidos y accesos de admins.
 * Portado desde `bot/modules/save_groups.lua`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

export async function handleSaveGroups(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const chat = msg?.chat;
  if (!chat || chat.type !== "supergroup") return;
  const chatId = Number(chat.id);
  const rdb = createRedis(env);
  await rdb.set(`group_known:${chatId}`, "true");
  const admins = await api.getChatAdministrators(chatId);
  const list = (admins as any)?.result ?? [];
  for (const admin of list) {
    const uid = admin?.user?.id;
    if (uid === undefined || uid === null) continue;
    await rdb.set(`group_access:${chatId}:${uid}`, "true");
  }
}
