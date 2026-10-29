/**
 * Contadores de estadísticas por grupo y globales.
 * Los fallos de Redis nunca deben interrumpir el flujo principal.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";

export type StatName =
  | "messages"
  | "joins"
  | "verifications"
  | "kicks"
  | "bans"
  | "cas"
  | "flood"
  | "links";

export const STAT_NAMES: readonly StatName[] = [
  "messages",
  "joins",
  "verifications",
  "kicks",
  "bans",
  "cas",
  "flood",
  "links",
];

function groupKey(chatId: number, stat: StatName): string {
  return `stats:${chatId}:${stat}`;
}

function globalKey(stat: StatName): string {
  return `stats:global:${stat}`;
}

/**
 * Incrementa un contador del grupo. Los eventos de seguridad y las entradas
 * también se agregan al contador global; los mensajes solo por grupo para
 * no duplicar escrituras en cada mensaje.
 */
export async function bumpStat(env: RedisEnv, chatId: number, stat: StatName, amount = 1): Promise<void> {
  try {
    const rdb = createRedis(env);
    await rdb.incrby(groupKey(chatId, stat), amount);
    if (stat !== "messages") await rdb.incrby(globalKey(stat), amount);
  } catch (err) {
    console.error("stats error:", err);
  }
}

async function readStats(env: RedisEnv, chatId: number | "global"): Promise<Record<StatName, number>> {
  const rdb = createRedis(env);
  const values = await rdb.mget(...STAT_NAMES.map((stat) => chatId === "global" ? globalKey(stat) : groupKey(chatId, stat)));
  const out = {} as Record<StatName, number>;
  STAT_NAMES.forEach((stat, i) => {
    out[stat] = Number(values[i] ?? 0) || 0;
  });
  return out;
}

function status(value: string | null, fallbackOn: boolean): string {
  if (value === null || value === undefined) return fallbackOn ? "ON" : "OFF";
  return value === "false" || value === "0" ? "OFF" : "ON";
}

export async function buildGroupStatsText(env: RedisEnv, api: TelegramApi, gid: number): Promise<string> {
  const rdb = createRedis(env);
  const [stats, known, members, captchaRaw, modeRaw, casRaw, floodRaw, linkRaw] = await Promise.all([
    readStats(env, gid),
    rdb.scard(`known_users:${gid}`).catch(() => 0),
    api.getChatMemberCount(gid).catch(() => 0),
    rdb.get(`group:${gid}:captcha_enabled`).catch(() => null),
    rdb.get(`group:${gid}:captcha_mode`).catch(() => null),
    rdb.get(`group:${gid}:cas_enabled`).catch(() => null),
    rdb.get(`group:${gid}:antiflood_enabled`).catch(() => null),
    rdb.get(`group:${gid}:antilink_enabled`).catch(() => null),
  ]);

  const captchaOn = captchaRaw === "true";
  const mode = modeRaw || "button";
  return [
    "📊 Estadísticas del grupo",
    `🆔 ${gid}`,
    `👥 Miembros: ${members || "?"}`,
    `👤 Usuarios conocidos: ${known}`,
    "",
    `💬 Mensajes: ${stats.messages}`,
    `📥 Entradas: ${stats.joins}`,
    `✅ Verificaciones: ${stats.verifications}`,
    `👢 Expulsiones: ${stats.kicks}`,
    `🔨 Baneos: ${stats.bans}`,
    `🛡️ CAS: ${stats.cas}`,
    `🌊 Anti-flood: ${stats.flood}`,
    `🔗 Enlaces borrados: ${stats.links}`,
    "",
    `⚙️ Captcha: ${captchaOn ? `ON (${mode})` : "OFF"}`,
    `🛡️ CAS: ${status(casRaw, true)} · 🌊 Anti-flood: ${status(floodRaw, true)} · 🔗 Anti-enlaces: ${status(linkRaw, true)}`,
  ].join("\n");
}

export async function buildGlobalStatsText(env: RedisEnv): Promise<string> {
  const rdb = createRedis(env);
  const [stats, keys, users, tasks] = await Promise.all([
    readStats(env, "global"),
    rdb.keys("group_known:*").catch(() => []),
    rdb.scard("known_users:all").catch(() => 0),
    rdb.scard("tasks").catch(() => 0),
  ]);
  const groups = keys.filter((key) => {
    const id = key.replace(/^group_known:/, "");
    return /^-?\d+$/.test(id);
  }).length;

  return [
    "📊 Estadísticas globales",
    `🏘️ Grupos conocidos: ${groups}`,
    `👥 Usuarios conocidos: ${users}`,
    `⏳ Tareas pendientes: ${tasks}`,
    "",
    `📥 Entradas: ${stats.joins}`,
    `✅ Verificaciones: ${stats.verifications}`,
    `👢 Expulsiones: ${stats.kicks}`,
    `🔨 Baneos: ${stats.bans}`,
    `🛡️ CAS: ${stats.cas}`,
    `🌊 Anti-flood: ${stats.flood}`,
    `🔗 Enlaces borrados: ${stats.links}`,
  ].join("\n");
}
