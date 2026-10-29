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
import { DEFAULT_GROUP_SETTINGS } from "./group_defaults";
import { handleSaveGroups } from "./save_groups";
import { ADMIN_INDEX_READY } from "./group_registry";
import { ioRequestCount } from "./performance";

type EnvWithBot = RedisEnv & { BOT_TOKEN: string };

const GRACE_SECONDS = 300;
const NEED_ADMIN_NOTICE_TTL = 3600;

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
  await rdb.pipeline(Object.entries(DEFAULT_GROUP_SETTINGS).map(([key, value]) => ["SET", `group:${chatId}:${key}`, value, "NX"]));
  await rdb.mset({ [`group:${chatId}:onboarded`]: "true", [`group:${chatId}:defaults_v2`]: "true" });
}

/** Rellena defaults sin sobrescribir configuración existente. */
export async function ensureGroupConfigured(env: EnvWithBot, chatId: number): Promise<void> {
  await preconfigure(env, chatId);
}

async function scheduleLeave(env: EnvWithBot, chatId: number): Promise<void> {
  const rdb = createRedis(env);
  const key = `leave_scheduled:${chatId}`;
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + GRACE_SECONDS;
  if (!(await rdb.setnx(key, String(deadline), GRACE_SECONDS + 3600))) return;
  try { await addTask(env, { type: "leave", chatId, param: 0, runAt: deadline }); }
  catch (error) { await rdb.del(key).catch(() => null); throw error; }
}

async function sendNeedAdmin(env: EnvWithBot, api: TelegramApi, chatId: number, username: string): Promise<void> {
  const rdb = createRedis(env);
  if (!(await rdb.setnx(`onboard_notice:${chatId}`, "1", NEED_ADMIN_NOTICE_TTL))) return;

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
    "✅ Gracias por añadirme. Ya tengo los permisos necesarios para proteger el grupo.\n\n" +
    "La configuración inicial usa captcha Turnstile, CAS (Combot Anti-Spam), anti-flood y anti-enlaces activados. Se conservan los ajustes que ya hubiera elegido un administrador. " +
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
  await handleSaveGroups(env, api, { chat }).catch(() => null);
  const promoted = oldStatus !== "administrator" && oldStatus !== "creator";
  if (firstTime || promoted) {
    await sendWelcome(env, api, chatId, username);
  }
}

/** Check existing groups too, in small resumable batches that fit Workers Free. */
export async function auditKnownGroups(env: EnvWithBot, api: TelegramApi): Promise<{ total: number; cursor: number; checked: number; pending: number; ready: number; unknown: number; complete: boolean }> {
  const result = { total: 0, cursor: 0, checked: 0, pending: 0, ready: 0, unknown: 0, complete: false };
  if (ioRequestCount(env) > 20) return result;
  const rdb = createRedis(env);
  const [cursorRaw, inventoryRaw] = await rdb.mget("group_audit:v1:cursor", "group_audit:v1:inventory");
  let cursor = Number(cursorRaw ?? 0);
  let groups: number[] = [];
  try { groups = JSON.parse(inventoryRaw ?? "[]"); } catch { /* rebuild below */ }
  if (!Array.isArray(groups) || !groups.every((id) => Number.isSafeInteger(id) && id < 0) || !groups.length || !Number.isSafeInteger(cursor) || cursor <= 0 || cursor >= groups.length) {
    groups = (await rdb.keys("group_known:*")).map((key) => Number(key.slice("group_known:".length))).filter((id) => Number.isSafeInteger(id) && id < 0).sort((a, b) => b - a);
    cursor = 0;
    await rdb.set("group_audit:v1:inventory", JSON.stringify(groups));
  }
  result.total = groups.length;
  if (!groups.length) { await rdb.set(ADMIN_INDEX_READY, "1"); result.complete = true; return result; }
  const botId = Number((await api.getMe())?.id);
  if (!botId) return result;
  for (const gid of groups.slice(cursor, cursor + 2)) {
    if (ioRequestCount(env) > 20) break;
    try {
      const member = await api.getChatMember(gid, botId);
      if (member?.status === "left" || member?.status === "kicked") {
        await rdb.del(`group_known:${gid}`, `leave_scheduled:${gid}`);
      } else if (!hasRequiredAdminRights(member)) {
        await scheduleLeave(env, gid);
        await sendNeedAdmin(env, api, gid, await botUsername(api));
        result.pending++;
      } else {
        const [configured, pending] = await rdb.mget(`group:${gid}:defaults_v2`, `leave_scheduled:${gid}`);
        if (!configured) await preconfigure(env, gid);
        if (pending) await rdb.del(`leave_scheduled:${gid}`);
        await handleSaveGroups(env, api, { chat: { id: gid, type: "supergroup" } });
        result.ready++;
      }
    } catch {
      // A Telegram/API outage is not evidence of missing permissions. Retry on
      // the next sweep instead of leaving a group or granting access.
      result.unknown++;
    }
    result.checked++;
    cursor++;
  }
  result.complete = cursor >= groups.length;
  result.cursor = result.complete ? 0 : cursor;
  await rdb.set("group_audit:v1:cursor", String(result.cursor));
  if (result.complete) await rdb.set(ADMIN_INDEX_READY, "1");
  console.info("group_audit", result);
  return result;
}
