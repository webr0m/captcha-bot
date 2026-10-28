/**
 * Cola de tareas diferidas + sweep (reemplazo del patrón `copas.sleep` de Lua).
 * En Workers no hay timers arbitrarios, así que usamos:
 *  - Tareas en una Redis Set ("tasks") con timestamp de ejecución.
 *  - Cron trigger que procesa la cola.
 *
 * Importante: este módulo NO importa `captcha.ts` para evitar dependencias
 * circulares; lee directamente las claves de configuración que necesita.
 */

import { createRedis, RedisEnv } from "./redis";
import { autoTranslate } from "./translator";

export type TaskType = "del" | "kick" | "lockdown" | "unlock" | "decline" | "ban";

export interface Task {
  type: TaskType;
  chatId: number;
  param: number; // messageId para "del", userId para kick/ban/decline
  runAt: number; // unix seconds
}

const TASKS_KEY = "tasks";

function taskToString(task: Task): string {
  return `${task.type}|${task.chatId}|${task.param}|${task.runAt}`;
}

function parseTask(member: string): Task | null {
  const parts = String(member).split("|");
  if (parts.length < 4) return null;
  const type = parts[0];
  const chatId = Number(parts[1]);
  const param = Number(parts[2]);
  const runAt = Number(parts[3]);
  if (!Number.isFinite(chatId) || !Number.isFinite(param) || !Number.isFinite(runAt)) return null;
  const allowed: TaskType[] = ["del", "kick", "lockdown", "unlock", "decline", "ban"];
  if (!allowed.includes(type as TaskType)) return null;
  return { type: type as TaskType, chatId, param, runAt };
}

export async function addTask(env: RedisEnv, task: Task): Promise<void> {
  const rdb = createRedis(env);
  await rdb.sadd(TASKS_KEY, taskToString(task));
}

/**
 * Elimina tareas corruptas y tareas cuya fecha de ejecución quedó demasiado
 * atrás (p. ej. si el cron estuvo caído). Devuelve cuántas se borraron.
 */
export async function cleanupTasks(env: RedisEnv): Promise<number> {
  const rdb = createRedis(env);
  const tasks = await rdb.smembers(TASKS_KEY);
  const now = Math.floor(Date.now() / 1000);
  const maxAge = 7 * 24 * 3600;
  let removed = 0;
  for (const member of tasks) {
    const task = parseTask(member);
    if (!task || task.runAt < now - maxAge) {
      await rdb.srem(TASKS_KEY, String(member));
      removed++;
    }
  }
  return removed;
}

function boolDefaultTrue(value: string | null): boolean {
  return value === null || value === undefined || value === "true";
}

async function editChallengeResult(env: RedisEnv, api: any, chatId: number, userId: number, text: string): Promise<number> {
  const rdb = createRedis(env);
  const msgId = Number((await rdb.get(`ID_msgbot:${chatId}:${userId}`)) ?? 0);
  if (!msgId) return 0;
  const isPhoto = (await rdb.get(`msgtype:${chatId}:${userId}`)) === "photo";
  try {
    if (isPhoto) await api.editMessageCaption(chatId, msgId, text);
    else await api.editMessageText(chatId, msgId, text);
  } catch { /* mensaje borrado o sin permisos */ }
  return msgId;
}

async function cleanupUserState(env: RedisEnv, chatId: number, userId: number): Promise<void> {
  const rdb = createRedis(env);
  await rdb.del(
    `verify:${chatId}:${userId}`,
    `verify_deadline:${chatId}:${userId}`,
    `verify_attempt:${chatId}:${userId}`,
    `verify_intent:${chatId}:${userId}`,
    `verify:${chatId}:${userId}:msg_id`,
    `math_captcha:${chatId}:${userId}`,
    `math_pending:${chatId}:${userId}`,
    `emoji_captcha:${chatId}:${userId}`,
    `image_captcha:${chatId}:${userId}`,
    `qr_captcha:${chatId}:${userId}`,
    `qr_pending:${chatId}:${userId}`,
    `math_regen:${chatId}:${userId}`,
    `qr_regen:${chatId}:${userId}`,
    `dice_target:${chatId}:${userId}`,
  );
}

async function runKick(env: RedisEnv, api: any, task: Task): Promise<void> {
  const rdb = createRedis(env);
  const now = Math.floor(Date.now() / 1000);
  const chatId = task.chatId;
  const userId = task.param;

  const verified = await rdb.get(`verify:${chatId}:${userId}`);
  if (verified === "ok") {
    await cleanupUserState(env, chatId, userId);
    return;
  }

  // Si el desafío se regeneró, la tarea antigua debe esperar al nuevo deadline.
  const deadline = Number((await rdb.get(`verify_deadline:${chatId}:${userId}`)) ?? 0);
  if (Number.isFinite(deadline) && deadline > now + 1) {
    await addTask(env, { type: "kick", chatId, param: userId, runAt: deadline + 5 });
    return;
  }

  const action = (await rdb.get(`group:${chatId}:captcha_action`)) ?? "kick";
  const lang = (await rdb.get(`group:${chatId}:lang`)) ?? "es";
  const delBot = boolDefaultTrue(await rdb.get(`group:${chatId}:delete_bot_messages`));
  const delSys = boolDefaultTrue(await rdb.get(`group:${chatId}:delete_service_messages`));

  try {
    if (action === "ban") {
      // until_date = 0 -> ban permanente (igual que el bot original).
      await api.banChatMember(chatId, userId, 0);
    } else {
      await api.kickChatMember(chatId, userId);
    }
  } catch { /* el usuario pudo salir o ya no existe */ }

  const text = await autoTranslate(env, lang, "❌ fue expulsado por no verificar a tiempo.");
  const msgBotId = await editChallengeResult(env, api, chatId, userId, text);
  const msgSysId = Number((await rdb.get(`ID_msgsys:${chatId}:${userId}`)) ?? 0);

  if (delBot && msgBotId) {
    await addTask(env, { type: "del", chatId, param: msgBotId, runAt: now + 5 });
  }
  if (delSys && msgSysId) {
    await addTask(env, { type: "del", chatId, param: msgSysId, runAt: now + 5 });
  }

  await cleanupUserState(env, chatId, userId);
  await rdb.del(`ID_msgbot:${chatId}:${userId}`, `ID_msgsys:${chatId}:${userId}`, `msgtype:${chatId}:${userId}`);
}

async function executeTask(env: RedisEnv, api: any, task: Task): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  if (task.type === "del") {
    try {
      await api.deleteMessage(task.chatId, task.param);
    } catch {
      // best effort: el mensaje puede ya no existir
    }
    return;
  }

  if (task.type === "kick") {
    await runKick(env, api, task);
    return;
  }

  if (task.type === "decline") {
    try {
      await api.declineChatJoinRequest(task.chatId, task.param);
    } catch { /* best effort */ }
    return;
  }

  if (task.type === "ban") {
    // Ban permanente por defecto.
    await api.banChatMember(task.chatId, task.param, 0);
    return;
  }

  if (task.type === "lockdown") {
    await api.setChatPermissions(task.chatId, lockdownPermissions());
    // param > 0 => lockdown temporal; 0 => persistente (lo levanta nightmode).
    if (task.param > 0) {
      await addTask(env, { type: "unlock", chatId: task.chatId, param: 0, runAt: now + task.param });
    }
    return;
  }

  if (task.type === "unlock") {
    await api.setChatPermissions(task.chatId, unlockPermissions());
  }
}

export async function processTasks(env: RedisEnv, api: any): Promise<void> {
  const rdb = createRedis(env);
  const tasks = await rdb.smembers(TASKS_KEY);
  const now = Math.floor(Date.now() / 1000);
  for (const member of tasks) {
    const task = parseTask(member);
    if (!task) {
      // Limpia entradas corruptas para que no crezcan indefinidamente.
      await rdb.srem(TASKS_KEY, String(member));
      continue;
    }
    if (task.runAt > now) continue;
    await rdb.srem(TASKS_KEY, String(member));
    try {
      await executeTask(env, api, task);
    } catch {
      // Una tarea fallida no debe detener el resto de la cola.
    }
  }
}

function lockdownPermissions(): Record<string, any> {
  return {
    can_send_messages: false,
    can_send_media_messages: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_change_info: false,
    can_invite_users: false,
    can_pin_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_use_inline_bots: false,
    can_use_chat_reactions: false,
  };
}

function unlockPermissions(): Record<string, any> {
  return {
    can_send_messages: true,
    can_send_media_messages: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
    can_change_info: false,
    can_invite_users: true,
    can_pin_messages: false,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_use_inline_bots: true,
    can_use_chat_reactions: true,
  };
}

export async function runSweep(env: RedisEnv, api: any): Promise<void> {
  await processTasks(env, api);
}
