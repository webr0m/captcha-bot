/**
 * Módulo cleaner — mantenimiento periódico.
 * Portado desde `bot/modules/cleaner.lua`.
 *
 * - Elimina tareas corruptas o demasiado antiguas de la cola `tasks`.
 * - Elimina claves temporales de listados (`known_users:tmp:*`).
 * - Se ejecuta desde el cron con un guard de 1 hora.
 * - También puede invocarse manualmente con /cleaner (solo admins).
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { cleanupTasks } from "./tasks";
import { isAdmin } from "./captcha";

const GUARD_KEY = "cleaner:last_run";
const GUARD_SEC = 3600;
const DEV_USER_ID = 180791241;

export async function runCleaner(env: RedisEnv, api: TelegramApi, msg?: any): Promise<void> {
  const rdb = createRedis(env);
  const now = Math.floor(Date.now() / 1000);

  let chatId = 0;
  let userId = 0;
  let manual = false;

  if (msg) {
    chatId = Number(msg?.chat?.id ?? 0);
    userId = Number(msg?.from?.id ?? 0);
    // En grupo: solo administradores. En privado: solo el dev.
    if (chatId < 0) {
      if (!(await isAdmin(env, api, chatId, userId))) return;
    } else if (userId !== DEV_USER_ID) {
      return;
    }
    manual = true;
  }

  const lastRun = Number((await rdb.get(GUARD_KEY)) ?? 0);
  const recently = Number.isFinite(lastRun) && lastRun > 0 && now - lastRun < GUARD_SEC;

  // El cron no repite la limpieza si ya se ejecutó en la última hora.
  if (!manual && recently) return;

  // El comando manual puede ejecutarse como máximo una vez por minuto (salvo dev).
  if (manual && recently && now - lastRun < 60 && userId !== DEV_USER_ID) {
    await api.sendMessage(chatId, "🧹 La limpieza se ejecutó hace menos de un minuto. Intenta de nuevo más tarde.").catch(() => null);
    return;
  }

  await rdb.set(GUARD_KEY, String(now));

  const removedTasks = await cleanupTasks(env);

  let removedTmp = 0;
  try {
    const tmpKeys = await rdb.keys("known_users:tmp:*");
    if (tmpKeys.length) {
      await rdb.del(...tmpKeys);
      removedTmp = tmpKeys.length;
    }
  } catch { /* KEYS no disponible o sin permisos */ }

  if (manual && chatId) {
    await api
      .sendMessage(chatId, `🧹 Limpieza completada.\n• Tareas eliminadas: ${removedTasks}\n• Temporales eliminados: ${removedTmp}`)
      .catch(() => null);
  }
}
