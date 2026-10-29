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
import { bumpStat } from "./stats";
import { hasRequiredAdminRights } from "./access";
import { parseTask, taskToString } from "./task_format";
import type { Task } from "./task_format";
import { ioRequestCount } from "./performance";

export type { Task, TaskType } from "./task_format";

const TASKS_KEY = "tasks";

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
    if (ioRequestCount(env) > 30) break;
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
  // No actuar sobre un desafío cancelado, fallido al enviarse o ya verificado.
  if (verified !== "pending" && verified !== "expiring") return;

  // Si el desafío se regeneró, la tarea antigua debe esperar al nuevo deadline.
  const deadline = Number((await rdb.get(`verify_deadline:${chatId}:${userId}`)) ?? 0);
  if (Number.isFinite(deadline) && deadline > now + 1) {
    await addTask(env, { type: "kick", chatId, param: userId, runAt: deadline + 5 });
    return;
  }

  // La transición atómica impide verificar al mismo tiempo que el cron expulsa.
  if (verified === "pending" && !(await rdb.compareSet(`verify:${chatId}:${userId}`, "pending", "expiring", 7 * 86400))) return;

  const action = (await rdb.get(`group:${chatId}:captcha_action`)) ?? "kick";
  const lang = (await rdb.get(`group:${chatId}:lang`)) ?? "es";
  const delBot = boolDefaultTrue(await rdb.get(`group:${chatId}:delete_bot_messages`));
  const delSys = boolDefaultTrue(await rdb.get(`group:${chatId}:delete_service_messages`));

  {
    if (action === "ban") {
      // until_date = 0 -> ban permanente (igual que el bot original).
      await api.banChatMember(chatId, userId, 0);
    } else {
      await api.kickChatMember(chatId, userId);
    }
    await bumpStat(env, chatId, action === "ban" ? "bans" : "kicks");
  }

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
    const rdb = createRedis(env);
    if ((await rdb.get(`jr:${task.chatId}:${task.param}`)) === "ok") return;
    const deadline = Number(await rdb.get(`jr:${task.chatId}:${task.param}:deadline`) ?? 0);
    if (deadline > task.runAt) return;
    try {
      await api.declineChatJoinRequest(task.chatId, task.param);
    } catch { /* best effort */ }
    return;
  }

  if (task.type === "ban") {
    // Un código corregido cancela la sanción diferida de una join request.
    if ((await createRedis(env).get(`jr:${task.chatId}:${task.param}`)) === "ok") return;
    // Ban permanente por defecto.
    await api.banChatMember(task.chatId, task.param, 0);
    await bumpStat(env, task.chatId, "bans");
    return;
  }

  if (task.type === "leave") {
    // Salida automática si el bot sigue sin los permisos necesarios.
    const rdb = createRedis(env);
    const scheduled = await rdb.get(`leave_scheduled:${task.chatId}`);
    if (!scheduled || Number(scheduled) > task.runAt) return;
    const botId = Number((await api.getMe())?.id ?? 0);
    if (!botId) throw new Error("Could not determine bot identity for leave task");
    const member = await api.getChatMember(task.chatId, botId);
    const status = member?.status;
    if (status === "left" || status === "kicked") {
      await rdb.del(`group_known:${task.chatId}`, `channel_known:${task.chatId}`, `leave_scheduled:${task.chatId}`);
      return;
    }
    const info = await api.getChat(task.chatId);
    const isChannel = info?.type === "channel" || info?.result?.type === "channel";
    const adminOk = isChannel
      ? status === "administrator" || status === "creator"
      : hasRequiredAdminRights(member);
    if (adminOk) { await rdb.del(`leave_scheduled:${task.chatId}`); return; }
    await api.leaveChat(task.chatId);
    await rdb.del(`group_known:${task.chatId}`, `channel_known:${task.chatId}`, `leave_scheduled:${task.chatId}`).catch(() => null);
    return;
  }

  if (task.type === "lockdown") {
    const rdb = createRedis(env);
    const snapshotKey = `lockdown:permissions:${task.chatId}`;
    if (!(await rdb.get(snapshotKey))) {
      const chat = await api.getChat(task.chatId);
      if (!chat?.permissions) throw new Error("No se pudieron obtener los permisos originales del grupo");
      await rdb.setnx(snapshotKey, JSON.stringify(chat.permissions));
    }
    await api.setChatPermissions(task.chatId, lockdownPermissions());
    // param > 0 => lockdown temporal; 0 => persistente (lo levanta nightmode).
    if (task.param > 0) {
      await addTask(env, { type: "unlock", chatId: task.chatId, param: 0, runAt: now + task.param });
    }
    return;
  }

  if (task.type === "unlock") {
    const rdb = createRedis(env);
    const key = `lockdown:permissions:${task.chatId}`;
    const snapshot = await rdb.get(key);
    if (!snapshot) {
      console.error(`No permission snapshot for chat ${task.chatId}; manual restore required`);
      return;
    }
    const permissions = JSON.parse(snapshot);
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new Error("Invalid permission snapshot");
    await api.setChatPermissions(task.chatId, permissions);
    await rdb.del(key);
  }
}

export async function processTasks(env: RedisEnv, api: any): Promise<void> {
  const rdb = createRedis(env);
  const tasks = await rdb.smembers(TASKS_KEY);
  const now = Math.floor(Date.now() / 1000);
  let claimed = 0;
  for (const member of tasks) {
    // Check before claiming: everything deferred stays durably in the set.
    // Reserve enough calls for a captcha sanction, cleanup and a retry enqueue.
    if (claimed >= 3 || ioRequestCount(env) > 15) break;
    const task = parseTask(member);
    if (!task) {
      // Limpia entradas corruptas para que no crezcan indefinidamente.
      await rdb.srem(TASKS_KEY, String(member));
      continue;
    }
    if (task.runAt > now) continue;
    // SREM actúa como reclamación atómica entre ejecuciones concurrentes.
    if (!(await rdb.srem(TASKS_KEY, String(member)))) continue;
    claimed++;
    try {
      await executeTask(env, api, task);
    } catch (err) {
      // Conservar fallos transitorios para el próximo cron; no perder sanciones.
      console.error(`Task failed: ${task.type}`, err);
      const retryAfter = Number((err as any)?.retryAfter ?? 0);
      if (!(Number((err as any)?.status) >= 400 && Number((err as any)?.status) < 500 && Number((err as any)?.status) !== 429)) {
        await addTask(env, { ...task, runAt: now + Math.max(60, Number.isFinite(retryAfter) ? retryAfter : 60) });
      }
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

export async function runSweep(env: RedisEnv, api: any): Promise<void> {
  await processTasks(env, api);
}
