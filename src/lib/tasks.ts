/**
 * Cola de tareas diferidas + sweep (reemplazo del patrón `copas.sleep` de Lua).
 * En Workers no hay timers arbitrarios, así que usamos:
 *  - Tareas en una Redis Set ("tasks") con timestamp de ejecución.
 *  - Cron trigger que procesa la cola.
 */

import { createRedis, RedisEnv } from "./redis";

export type TaskType = "del" | "kick" | "lockdown" | "unlock";

export interface Task {
  type: TaskType;
  chatId: number;
  param: number; // messageId para "del", segundos/length para los demás
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
  const allowed: TaskType[] = ["del", "kick", "lockdown", "unlock"];
  if (!allowed.includes(type as TaskType)) return null;
  return { type: type as TaskType, chatId, param, runAt };
}

export async function addTask(env: RedisEnv, task: Task): Promise<void> {
  const rdb = createRedis(env);
  await rdb.sadd(TASKS_KEY, taskToString(task));
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
    const rdb = createRedis(env);
    const verified = await rdb.get(`verify:${task.chatId}:${task.param}`);
    if (verified === "ok") return; // ya fue verificado, no expulsar
    const { getCaptchaAction } = await import("./captcha");
    const action = await getCaptchaAction(env, task.chatId);
    if (action === "ban") {
      await api.banChatMember(task.chatId, task.param, true, now + 86400);
    } else {
      await api.kickChatMember(task.chatId, task.param);
    }
    return;
  }
  if (task.type === "lockdown") {
    await api.setChatPermissions(task.chatId, lockdownPermissions());
    await addTask(env, { type: "unlock", chatId: task.chatId, param: task.param, runAt: now + (task.param || 60) });
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
    if (!task) continue;
    if (task.runAt > now) continue;
    await rdb.srem(TASKS_KEY, String(member));
    await executeTask(env, api, task);
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
