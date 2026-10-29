/**
 * Comprobación de acceso a grupos con caché positiva y negativa.
 * Evita llamar a getChatMember en cada mensaje de cada usuario.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

const NEGATIVE_TTL_SEC = 60;
export const ADMIN_CACHE_TTL_SEC = 60;

// Nueva clave: las autorizaciones permanentes de versiones anteriores no son fiables.
export function adminCacheKey(gid: number, userId: number): string {
  return `admin_access:v2:${gid}:${userId}`;
}

function isAdminStatus(status: unknown): boolean {
  return status === "administrator" || status === "creator";
}

/**
 * Comprueba si un usuario administra el grupo.
 * - Cachés positiva y negativa limitadas a 60 segundos.
 * - Si no hay caché, consulta a Telegram.
 */
export async function hasGroupAccess(env: RedisEnv, api: TelegramApi, gid: number, userId: number): Promise<boolean> {
  if (!gid || !userId) return false;
  const rdb = createRedis(env);
  if ((await rdb.get(adminCacheKey(gid, userId))) === "true") return true;
  if ((await rdb.get(`group_access_neg:${gid}:${userId}`)) === "1") return false;

  try {
    const member = await api.getChatMember(gid, userId);
    const ok = isAdminStatus((member as any)?.status);
    if (ok) {
      await rdb.setex(adminCacheKey(gid, userId), ADMIN_CACHE_TTL_SEC, "true");
      await rdb.del(`group_access_neg:${gid}:${userId}`);
    } else {
      await rdb.del(adminCacheKey(gid, userId), `group_access:${gid}:${userId}`);
      await rdb.setex(`group_access_neg:${gid}:${userId}`, NEGATIVE_TTL_SEC, "1");
    }
    return ok;
  } catch {
    return false;
  }
}

/** Comprueba siempre Telegram antes de autorizar comandos o cambios. */
export async function hasGroupAccessLive(env: RedisEnv, api: TelegramApi, gid: number, userId: number): Promise<boolean> {
  if (!gid || !userId) return false;
  const rdb = createRedis(env);
  try {
    const member = await api.getChatMember(gid, userId);
    const ok = isAdminStatus((member as any)?.status);
    if (ok) {
      await rdb.setex(adminCacheKey(gid, userId), ADMIN_CACHE_TTL_SEC, "true");
      await rdb.del(`group_access_neg:${gid}:${userId}`);
    } else {
      await rdb.del(adminCacheKey(gid, userId), `group_access:${gid}:${userId}`);
      await rdb.setex(`group_access_neg:${gid}:${userId}`, NEGATIVE_TTL_SEC, "1");
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
