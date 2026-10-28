/**
 * Comprobación de acceso a grupos con caché positiva y negativa.
 * Evita llamar a getChatMember en cada mensaje de cada usuario.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

const NEGATIVE_TTL_SEC = 1800;

function isAdminStatus(status: unknown): boolean {
  return status === "administrator" || status === "creator";
}

/**
 * Comprueba si un usuario administra el grupo.
 * - Caché positiva permanente (`group_access:*`).
 * - Caché negativa de 30 min (`group_access_neg:*`).
 * - Si no hay caché, consulta a Telegram.
 */
export async function hasGroupAccess(env: RedisEnv, api: TelegramApi, gid: number, userId: number): Promise<boolean> {
  if (!gid || !userId) return false;
  const rdb = createRedis(env);
  if ((await rdb.get(`group_access:${gid}:${userId}`)) === "true") return true;
  if ((await rdb.get(`group_access_neg:${gid}:${userId}`)) === "1") return false;

  try {
    const member = await api.getChatMember(gid, userId);
    const ok = isAdminStatus((member as any)?.status);
    if (ok) {
      await rdb.set(`group_access:${gid}:${userId}`, "true");
      await rdb.del(`group_access_neg:${gid}:${userId}`);
    } else {
      await rdb.setex(`group_access_neg:${gid}:${userId}`, NEGATIVE_TTL_SEC, "1");
    }
    return ok;
  } catch {
    return false;
  }
}

/** Igual que `hasGroupAccess` pero ignora la caché negativa (para comandos). */
export async function hasGroupAccessLive(env: RedisEnv, api: TelegramApi, gid: number, userId: number): Promise<boolean> {
  if (!gid || !userId) return false;
  const rdb = createRedis(env);
  if ((await rdb.get(`group_access:${gid}:${userId}`)) === "true") return true;
  try {
    const member = await api.getChatMember(gid, userId);
    const ok = isAdminStatus((member as any)?.status);
    if (ok) {
      await rdb.set(`group_access:${gid}:${userId}`, "true");
      await rdb.del(`group_access_neg:${gid}:${userId}`);
    }
    return ok;
  } catch {
    return false;
  }
}

/** El bot necesita borrar mensajes y restringir miembros para operar. */
export function hasRequiredAdminRights(member: any): boolean {
  const status = member?.status;
  if (status === "creator") return true;
  if (status !== "administrator") return false;
  const perms = member?.permissions ?? member;
  return !!(perms && perms.can_delete_messages && perms.can_restrict_members);
}
