/**
 * Notificaciones de entrada/salida de usuarios (admin + dev).
 * Portado desde `bot/modules/report_user_activity.lua`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import * as captcha from "./captcha";

const DEV_USER_ID = 180791241; // MY_DEV_ID (bot/main.lua)

function escapeHtml(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getAdmrReport(env: RedisEnv, chatId: number): Promise<boolean> {
  const v = await createRedis(env).get(`group:${chatId}:adm_report`);
  return v === "true";
}

export async function notifyJoinLeave(env: RedisEnv, api: TelegramApi, chatId: number, user: any, addedBy: any, isJoin: boolean): Promise<void> {
  const rdb = createRedis(env);
  const groupName = String((api as any)?.titleCache?.[chatId] ?? "Desconocido");
  const reporterId = DEV_USER_ID;
  const reportAdm = await getAdmrReport(env, chatId);

  const name = `${String(user?.first_name ?? "")} ${user?.last_name ?? ""}`.trim();
  const username = user?.username ? `@${user.username}` : "";
  const alias = `${name} ${username}`.trim();
  const addedByInfo = addedBy?.first_name ?? "Desconocido";
  const addedId = addedBy?.id ?? "?";
  const lang = (await rdb.get(`group:${chatId}:lang`)) ?? "es";

  const text = isJoin
    ? `📥 <b>Usuario ingresó al grupo:</b>\n\n👤 Usuario y Alias: ${escapeHtml(alias)}\n🆔 Usuario ID: <code>${user?.id}</code>\n📛 Grupo: ${escapeHtml(groupName)}\n📎 Grupo ID: ${chatId}\n${user?.id === addedBy?.id ? "" : `👮 Añadido por: ${escapeHtml(addedByInfo)} (${addedId})\n`}`
    : `📤 <b>Usuario salió del grupo:</b>\n\n👤 Usuario y Alias: ${escapeHtml(alias)}\n🆔 Usuario ID: <code>${user?.id}</code>\n📛 Grupo: ${escapeHtml(groupName)}\n📎 Grupo ID: ${chatId}`;

  try { await api.sendMessage(reporterId, text, { parse_mode: "HTML" }); } catch { /* ignore */ }
  if (reportAdm) {
    // broadcast a administradores conocidos
    const known = await rdb.smembers(`known_users:${chatId}`);
    const seen = new Set<string>();
    for (const uid of known) {
      const key = String(uid);
      if (seen.has(key)) continue;
      seen.add(key);
      const uidNum = Number(key);
      const status = await api.getChatMember(chatId, uidNum);
      const statusStr = (status as any)?.status;
      const member = (status as any)?.result;
      if (statusStr !== "administrator" && statusStr !== "creator") continue;
      if (statusStr === "left" || statusStr === "kicked") continue;
      const u = member?.user;
      if (!u || u.is_bot || !u.first_name) continue;
      try { await api.sendMessage(uidNum, text, { parse_mode: "HTML" }); } catch { /* ignore */ }
    }
  }
}

export async function handleJoinLeave(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const chatId = msg?.chat?.id;
  const newMember = msg?.new_chat_member;
  const leftMember = msg?.left_chat_member;
  if (!chatId) return;

  if (newMember) {
    const addedBy = msg?.from;
    await notifyJoinLeave(env, api, chatId, newMember, addedBy, true);
  }
  if (leftMember) {
    await notifyJoinLeave(env, api, chatId, leftMember, msg?.from, false);
  }
}
