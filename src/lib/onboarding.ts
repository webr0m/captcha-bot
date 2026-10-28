/**
 * Onboarding del bot vía `my_chat_member`:
 * - Al añadirlo como administrador: preconfigura defaults y muestra el enlace de /config.
 * - Al añadirlo sin permisos: pide administración y programa una salida automática a los 5 min.
 * - Canales: solo permanece si es administrador.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { addTask } from "./tasks";
import { hasRequiredAdminRights } from "./access";

type EnvWithBot = RedisEnv & { BOT_TOKEN: string };

const GRACE_SECONDS = 300;
const NEED_ADMIN_NOTICE_TTL = 3600;

const DEFAULT_GROUP_SETTINGS: Record<string, string> = {
  captcha_enabled: "true",
  adm_report: "true",
  delete_bot_messages: "true",
  delete_service_messages: "true",
  cas_enabled: "true",
  antiflood_enabled: "true",
  antilink_enabled: "true",
};

async function botUsername(api: TelegramApi): Promise<string> {
  try {
    const me = await api.getMe();
    return String((me as any)?.username ?? "");
  } catch {
    return "";
  }
}

async function preconfigure(env: EnvWithBot, chatId: number): Promise<void> {
  const rdb = createRedis(env);
  for (const [key, value] of Object.entries(DEFAULT_GROUP_SETTINGS)) {
    await rdb.setnx(`group:${chatId}:${key}`, value);
  }
  await rdb.set(`group:${chatId}:onboarded`, "true");
}

/** Rellena defaults sin sobrescribir configuración existente. */
export async function ensureGroupConfigured(env: EnvWithBot, chatId: number): Promise<void> {
  await preconfigure(env, chatId);
}

async function scheduleLeave(env: EnvWithBot, chatId: number): Promise<void> {
  const rdb = createRedis(env);
  const key = `leave_scheduled:${chatId}`;
  if (!(await rdb.setnx(key, "1"))) return;
  await rdb.expire(key, GRACE_SECONDS + 60);
  const now = Math.floor(Date.now() / 1000);
  await addTask(env, { type: "leave", chatId, param: 0, runAt: now + GRACE_SECONDS });
}

async function sendNeedAdmin(env: EnvWithBot, api: TelegramApi, chatId: number, username: string): Promise<void> {
  const rdb = createRedis(env);
  if (!(await rdb.setnx(`onboard_notice:${chatId}`, "1"))) return;
  await rdb.expire(`onboard_notice:${chatId}`, NEED_ADMIN_NOTICE_TTL);

  const kb = {
    inline_keyboard: [
      [{ text: "🔐 Abrir configuración", url: `https://t.me/${username || "Antiubot"}?start=config_${chatId}` }],
      [{ text: "✅ Comprobar permisos", callback_data: `checkadmin:${chatId}` }],
    ],
  };
  const text =
    "⚠️ Para funcionar necesito ser administrador del grupo, con los permisos " +
    "de borrar mensajes y restringir usuarios.\n\n" +
    "Si no recibo esos permisos en 5 minutos, saldré del grupo automáticamente.";
  const sent = await api.sendMessage(chatId, text, { reply_markup: kb }).catch(() => null);
  const msgId = Number((sent as any)?.message_id ?? 0);
  if (msgId) await rdb.setex(`perms_bot:${chatId}`, NEED_ADMIN_NOTICE_TTL, String(msgId));
}

async function sendWelcome(env: EnvWithBot, api: TelegramApi, chatId: number, username: string): Promise<void> {
  const kb = {
    inline_keyboard: [[
      { text: "🔐 Abrir configuración", url: `https://t.me/${username || "Antiubot"}?start=config_${chatId}` },
    ]],
  };
  const text =
    "✅ Gracias por añadirme. Ya tengo los permisos necesarios y el grupo quedó protegido.\n\n" +
    "Por defecto activé captcha, CAS (Combot Anti-Spam), anti-flood y anti-enlaces. " +
    "Puedes revisar o cambiar todo con /config.";
  await api.sendMessage(chatId, text, { reply_markup: kb }).catch(() => null);
}

export async function handleMyChatMember(env: EnvWithBot, api: TelegramApi, cm: any): Promise<void> {
  const chat = cm?.chat;
  const newMember = cm?.new_chat_member;
  if (!chat || !newMember) return;
  if (chat.type === "private") return;

  const botUser = newMember.user;
  const botId = Number(botUser?.id ?? 0);
  let myId = 0;
  try {
    myId = Number((await api.getMe())?.id ?? 0);
  } catch { /* seguimos con el update */ }
  if (myId && botId && botId !== myId) return;

  const rdb = createRedis(env);
  const chatId = Number(chat.id);
  const status = String(newMember.status ?? "");
  const oldStatus = String(cm?.old_chat_member?.status ?? "");

  if (status === "left" || status === "kicked") {
    await rdb.del(`group_known:${chatId}`, `channel_known:${chatId}`, `leave_scheduled:${chatId}`).catch(() => null);
    return;
  }

  const username = await botUsername(api);

  if (chat.type === "channel") {
    if (status === "administrator" || status === "creator") {
      await rdb.set(`channel_known:${chatId}`, "true");
      await rdb.del(`leave_scheduled:${chatId}`).catch(() => null);
      return;
    }
    await scheduleLeave(env, chatId);
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") return;

  await rdb.set(`group_known:${chatId}`, "true");
  const adminOk = (status === "administrator" || status === "creator") && hasRequiredAdminRights(newMember);

  if (!adminOk) {
    await scheduleLeave(env, chatId);
    await sendNeedAdmin(env, api, chatId, username);
    return;
  }

  await rdb.del(`leave_scheduled:${chatId}`).catch(() => null);
  const firstTime = !(await rdb.get(`group:${chatId}:onboarded`));
  await preconfigure(env, chatId);
  const promoted = oldStatus !== "administrator" && oldStatus !== "creator";
  if (firstTime || promoted) {
    await sendWelcome(env, api, chatId, username);
  }
}
