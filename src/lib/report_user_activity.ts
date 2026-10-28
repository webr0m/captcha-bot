/**
 * Notificaciones de entrada/salida de usuarios (admin + dev).
 * Portado desde `bot/modules/report_user_activity.lua`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

const DEV_USER_ID = 180791241; // MY_DEV_ID (bot/main.lua)

function escapeHtml(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getAdmrReport(env: RedisEnv, chatId: number): Promise<boolean> {
  const v = await createRedis(env).get(`group:${chatId}:adm_report`);
  return v === "true";
}

function adminList(admins: any): any[] {
  if (Array.isArray(admins)) return admins;
  const result = admins?.result;
  return Array.isArray(result) ? result : [];
}

export async function notifyJoinLeave(
  env: RedisEnv,
  api: TelegramApi,
  chatId: number,
  groupName: string,
  user: any,
  addedBy: any,
  isJoin: boolean,
): Promise<void> {
  const rdb = createRedis(env);
  const reporterId = DEV_USER_ID;
  const reportAdm = await getAdmrReport(env, chatId);

  const name = `${String(user?.first_name ?? "")} ${user?.last_name ?? ""}`.trim();
  const username = user?.username ? `(@${user.username})` : "";
  const alias = `${name} ${username}`.trim();
  const addedByInfo = addedBy?.first_name ?? "Desconocido";
  const addedId = addedBy?.id ?? "?";

  const text = isJoin
    ? `📥 <b>Usuario ingresó al grupo:</b>\n\n👤 Usuario y Alias: ${escapeHtml(alias)}\n🆔 Usuario ID: <code>${user?.id}</code>\n📛 Grupo: ${escapeHtml(groupName)}\n📎 Grupo ID: ${chatId}\n${user?.id === addedBy?.id ? "" : `👮 Añadido por: ${escapeHtml(addedByInfo)} (${addedId})\n`}`
    : `📤 <b>Usuario salió del grupo:</b>\n\n👤 Usuario y Alias: ${escapeHtml(alias)}\n🆔 Usuario ID: <code>${user?.id}</code>\n📛 Grupo: ${escapeHtml(groupName)}\n📎 Grupo ID: ${chatId}`;

  try { await api.sendMessage(reporterId, text, { parse_mode: "HTML" }); } catch { /* ignore */ }

  if (!reportAdm) return;

  // Una sola llamada para obtener todos los administradores y avisarles.
  // (Evita `getChatMember` por cada usuario conocido, que era muy lento.)
  try {
    const admins = await api.getChatAdministrators(chatId);
    const seen = new Set<number>();
    for (const admin of adminList(admins)) {
      const u = admin?.user;
      const uid = Number(u?.id ?? 0);
      if (!uid || uid === Number(user?.id) || u?.is_bot) continue;
      if (seen.has(uid)) continue;
      seen.add(uid);
      try { await api.sendMessage(uid, text, { parse_mode: "HTML" }); } catch { /* ignore */ }
    }
  } catch { /* sin permisos para listar admins */ }
}

export async function handleJoinLeave(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const chat = msg?.chat;
  const chatId = chat?.id;
  const newMember = msg?.new_chat_member;
  const leftMember = msg?.left_chat_member;
  if (!chatId) return;
  const groupName = String(chat?.title ?? "Desconocido");

  if (newMember) {
    await notifyJoinLeave(env, api, chatId, groupName, newMember, msg?.from, true);
  }
  if (leftMember) {
    await notifyJoinLeave(env, api, chatId, groupName, leftMember, msg?.from, false);
  }
}
