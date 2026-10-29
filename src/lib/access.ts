/**
 * Comprobación de acceso a grupos con caché positiva y negativa.
 * Evita llamar a getChatMember en cada mensaje de cada usuario.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { adminGroupsKey } from "./group_registry";

const NEGATIVE_TTL_SEC = 60;
export const ADMIN_CACHE_TTL_SEC = 60;

// Nueva clave: las autorizaciones permanentes de versiones anteriores no son fiables.
export function adminCacheKey(gid: number, userId: number): string {
  return `admin_access:v2:${gid}:${userId}`;
}

function isAdminStatus(status: unknown): boolean {
  return status === "administrator" || status === "creator";
}

async function cacheAccess(env: RedisEnv, gid: number, userId: number, allowed: boolean): Promise<void> {
  await createRedis(env).pipeline(allowed ? [
    ["SETEX", adminCacheKey(gid, userId), ADMIN_CACHE_TTL_SEC, "true"],
    ["DEL", `group_access_neg:${gid}:${userId}`],
    ["SADD", adminGroupsKey(userId), String(gid)],
  ] : [
    ["DEL", adminCacheKey(gid, userId), `group_access:${gid}:${userId}`],
    ["SETEX", `group_access_neg:${gid}:${userId}`, NEGATIVE_TTL_SEC, "1"],
    ["SREM", adminGroupsKey(userId), String(gid)],
  ]);
}

/**
 * Comprueba si un usuario administra el grupo.
 * - Cachés positiva y negativa limitadas a 60 segundos.
 * - Si no hay caché, consulta a Telegram.
 */
export async function hasGroupAccess(env: RedisEnv, api: TelegramApi, gid: number, userId: number): Promise<boolean> {
  if (!gid || !userId) return false;
  const rdb = createRedis(env);
  const [positive, negative] = await rdb.mget(adminCacheKey(gid, userId), `group_access_neg:${gid}:${userId}`);
  if (positive === "true") return true;
  if (negative === "1") return false;

  try {
    const member = await api.getChatMember(gid, userId);
    const ok = isAdminStatus((member as any)?.status);
    await cacheAccess(env, gid, userId, ok);
    return ok;
  } catch {
    return false;
  }
}

/** Comprueba siempre Telegram antes de autorizar comandos o cambios. */
export async function hasGroupAccessLive(env: RedisEnv, api: TelegramApi, gid: number, userId: number, options: { cache?: boolean } = {}): Promise<boolean> {
  if (!gid || !userId) return false;
  try {
    const member = await api.getChatMember(gid, userId);
    const ok = isAdminStatus((member as any)?.status);
    // Un listado solo necesita comprobar acceso: evita escrituras por cada fila.
    if (options.cache === false) return ok;
    await cacheAccess(env, gid, userId, ok);
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
