/**
 * Integración con CAS (Combot Anti-Spam).
 * Consulta la API pública al entrar un usuario y lo sanciona si está listado.
 * Si la API falla, se continúa con el captcha (fail-open).
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { addTask } from "./tasks";
import { bumpStat } from "./stats";
import { decodeCasCache, encodeCasCache, parseCasResponse, CasVerdict } from "./cas_rules";

const CAS_API = "https://api.cas.chat/check";
const CAS_TIMEOUT_MS = 5_000;
const CAS_CACHE_TTL_SEC = 3_600;
const DEV_USER_ID = 180791241;

export type CasEnv = RedisEnv & { CAS_API_KEY?: string };

/** CAS exige una API key de Combot desde 2026; sin clave se mantiene fail-open. */
export function casApiConfigured(env: CasEnv): boolean {
  return String(env.CAS_API_KEY ?? "").trim().length > 0;
}

export async function getCasEnabled(env: RedisEnv, chatId: number): Promise<boolean> {
  const value = await createRedis(env).get(`group:${chatId}:cas_enabled`);
  return value !== "false" && value !== "0";
}

export async function checkCasUser(env: CasEnv, userId: number): Promise<CasVerdict> {
  const rdb = createRedis(env);
  const cacheKey = `cas:user:${userId}`;
  const cached = decodeCasCache(await rdb.get(cacheKey).catch(() => null));
  if (cached) return cached;

  const apiKey = String(env.CAS_API_KEY ?? "").trim();
  if (!apiKey) return { listed: false, offenses: 0 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAS_TIMEOUT_MS);
  try {
    const res = await fetch(`${CAS_API}?user_id=${encodeURIComponent(String(userId))}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "captcha-bot/1.0",
      },
    });
    if (!res.ok) {
      console.error(`CAS check failed: HTTP ${res.status}`);
      return { listed: false, offenses: 0 };
    }
    const payload = (await res.json().catch(() => null)) as any;
    const verdict = parseCasResponse(payload);
    await rdb.setex(cacheKey, CAS_CACHE_TTL_SEC, encodeCasCache(verdict)).catch(() => null);
    return verdict;
  } catch {
    // Timeout/red caída: no bloquear la entrada; el captcha sigue aplicando.
    return { listed: false, offenses: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Si el usuario está en CAS, lo banea (o expulsa si el ban falla), borra su
 * mensaje de entrada y avisa al grupo. Devuelve true si ya se sancionó.
 */
export async function enforceCas(
  env: RedisEnv,
  api: TelegramApi,
  chatId: number,
  user: any,
  joinMessageId?: number,
): Promise<boolean> {
  const userId = Number(user?.id ?? 0);
  if (!userId || user?.is_bot) return false;
  if (!(await getCasEnabled(env, chatId))) return false;

  const verdict = await checkCasUser(env, userId);
  if (!verdict.listed) return false;

  let sanctioned = false;
  try {
    await api.banChatMember(chatId, userId, 0);
    sanctioned = true;
  } catch {
    try {
      await api.kickChatMember(chatId, userId);
      sanctioned = true;
    } catch { /* sin permisos para sancionar */ }
  }

  if (joinMessageId) {
    try { await api.deleteMessage(chatId, joinMessageId); } catch { /* best effort */ }
  }

  const name = String(user?.first_name ?? user?.username ?? userId);
  const offenses = verdict.offenses;
  const reason = offenses === 1 ? "1 ofensa" : `${offenses} ofensas`;
  const notice = sanctioned
    ? `🛡️ ${name} fue expulsado por la lista CAS (${reason}).`
    : `🛡️ ${name} está en la lista CAS (${reason}); no tengo permisos para expulsarlo.`;
  const sent = await api.sendMessage(chatId, notice).catch(() => null);
  const noticeId = Number((sent as any)?.message_id ?? 0);
  if (noticeId) {
    const delBot = await createRedis(env).get(`group:${chatId}:delete_bot_messages`).catch(() => null);
    if (delBot !== "false") {
      const now = Math.floor(Date.now() / 1000);
      await addTask(env, { type: "del", chatId, param: noticeId, runAt: now + 30 }).catch(() => null);
    }
  }

  await bumpStat(env, chatId, "cas");
  try {
    await api.sendMessage(
      DEV_USER_ID,
      `🛡️ CAS: ${sanctioned ? "sancionado" : "detectado sin permisos"} ${name} (${userId}) en ${chatId}.`,
    );
  } catch { /* log opcional */ }

  return true;
}
