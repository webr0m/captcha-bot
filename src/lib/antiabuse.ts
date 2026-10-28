/**
 * Moderación automática: anti-flood, anti-enlaces y comandos de configuración.
 * Los castigos son best-effort: si el bot no es administrador, igualmente
 * intenta borrar el mensaje y avisar, pero nunca rompe el update.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { addTask } from "./tasks";
import { bumpStat } from "./stats";
import { hasGroupAccess, hasGroupAccessLive } from "./access";
import { casApiConfigured } from "./cas";
import { muteUser } from "./captcha";
import {
  DEFAULT_FLOOD_LIMIT,
  DEFAULT_FLOOD_MUTE_SEC,
  DEFAULT_LINK_WHITELIST,
  FLOOD_WINDOW_SEC,
  collectMessageLinks,
  floodExceeded,
  isFeatureEnabled,
  isLinkAllowed,
  normalizeWhitelistEntry,
  parseFloodLimit,
  parseFloodMute,
  parseWhitelist,
  serializeWhitelist,
} from "./security_rules";

type EnvWithBot = RedisEnv & { BOT_TOKEN: string };

const WARN_DELETE_SEC = 15;
const LINK_MUTE_SEC = 600;
const LINK_WARN_TTL_SEC = 3600;

function commandArgs(text: string): string[] {
  return String(text ?? "")
    .replace(/^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?\s*/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function commandName(text: string): string {
  return (String(text ?? "").match(/^\/([a-z_]+)/i) ?? [])[1]?.toLowerCase() ?? "";
}

interface Target {
  gid: number;
  args: string[];
}

function resolveTarget(msg: any): Target | null {
  const chat = msg?.chat;
  if (!chat) return null;
  const args = commandArgs(String(msg?.text ?? ""));
  if (chat.type !== "private") {
    const gid = Number(chat.id);
    return Number.isFinite(gid) && gid !== 0 ? { gid, args } : null;
  }
  if (!args.length || !/^-?\d+$/.test(args[0])) return null;
  const gid = Number(args[0]);
  if (!Number.isFinite(gid) || gid === 0) return null;
  return { gid, args: args.slice(1) };
}

async function reply(env: EnvWithBot, api: TelegramApi, msg: any, text: string): Promise<void> {
  const chatId = Number(msg?.chat?.id ?? 0);
  if (!chatId) return;
  const sent = await api.sendMessage(chatId, text).catch(() => null);
  if (msg?.chat?.type === "private") return;
  const msgId = Number((sent as any)?.message_id ?? 0);
  if (!msgId) return;
  const now = Math.floor(Date.now() / 1000);
  await addTask(env, { type: "del", chatId, param: msgId, runAt: now + WARN_DELETE_SEC });
}

async function requireAdmin(env: EnvWithBot, api: TelegramApi, msg: any, gid: number): Promise<boolean> {
  const userId = Number(msg?.from?.id ?? 0);
  if (await hasGroupAccessLive(env, api, gid, userId)) return true;
  await reply(env, api, msg, "🚫 Solo administradores pueden cambiar esta configuración.");
  return false;
}

async function notify(env: EnvWithBot, api: TelegramApi, chatId: number, text: string): Promise<void> {
  const sent = await api.sendMessage(chatId, text).catch(() => null);
  const msgId = Number((sent as any)?.message_id ?? 0);
  if (!msgId) return;
  const now = Math.floor(Date.now() / 1000);
  await addTask(env, { type: "del", chatId, param: msgId, runAt: now + WARN_DELETE_SEC });
}

// ---------- Comandos ----------

export async function handleAntiFloodCommand(env: EnvWithBot, api: TelegramApi, msg: any): Promise<void> {
  const target = resolveTarget(msg);
  if (!target) {
    await reply(env, api, msg, "Uso: /antiflood <gid> on|off|limit <3-50>|mute <minutos>");
    return;
  }
  if (!(await requireAdmin(env, api, msg, target.gid))) return;

  const rdb = createRedis(env);
  const enabledRaw = await rdb.get(`group:${target.gid}:antiflood_enabled`);
  const limitRaw = await rdb.get(`group:${target.gid}:antiflood_limit`);
  const muteRaw = await rdb.get(`group:${target.gid}:antiflood_mute`);
  const enabled = isFeatureEnabled(enabledRaw);
  const limit = parseFloodLimit(limitRaw);
  const mute = parseFloodMute(muteRaw);
  const action = (target.args[0] ?? "").toLowerCase();

  if (!action) {
    await reply(
      env, api, msg,
      `📌 Grupo ${target.gid}\n🌊 Anti-flood: ${enabled ? "ON" : "OFF"}\n` +
      `• Límite: ${limit} mensajes/${FLOOD_WINDOW_SEC}s\n• Castigo: mute ${Math.round(mute / 60)} min\n\n` +
      "Uso: /antiflood on|off|limit <3-50>|mute <minutos>",
    );
    return;
  }

  if (action === "on" || action === "off") {
    await rdb.set(`group:${target.gid}:antiflood_enabled`, action === "on" ? "true" : "false");
    await reply(env, api, msg, `🌊 Anti-flood: ${action === "on" ? "✅ ON" : "❌ OFF"}.`);
    return;
  }

  if (action === "limit") {
    const value = Number(target.args[1]);
    if (!Number.isFinite(value) || value < 3 || value > 50) {
      await reply(env, api, msg, "❌ El límite debe estar entre 3 y 50 mensajes.");
      return;
    }
    await rdb.set(`group:${target.gid}:antiflood_limit`, String(Math.trunc(value)));
    await reply(env, api, msg, `🌊 Límite actualizado: ${Math.trunc(value)} mensajes/${FLOOD_WINDOW_SEC}s.`);
    return;
  }

  if (action === "mute") {
    const minutes = Number(target.args[1]);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      await reply(env, api, msg, "❌ El mute debe estar entre 1 y 1440 minutos.");
      return;
    }
    await rdb.set(`group:${target.gid}:antiflood_mute`, String(Math.trunc(minutes) * 60));
    await reply(env, api, msg, `🌊 Mute actualizado: ${Math.trunc(minutes)} min.`);
    return;
  }

  await reply(env, api, msg, "Uso: /antiflood on|off|limit <3-50>|mute <minutos>");
}

export async function handleAntiLinkCommand(env: EnvWithBot, api: TelegramApi, msg: any): Promise<void> {
  const target = resolveTarget(msg);
  if (!target) {
    await reply(env, api, msg, "Uso: /antilink <gid> on|off");
    return;
  }
  if (!(await requireAdmin(env, api, msg, target.gid))) return;

  const rdb = createRedis(env);
  const raw = await rdb.get(`group:${target.gid}:antilink_enabled`);
  const enabled = isFeatureEnabled(raw);
  const action = (target.args[0] ?? "").toLowerCase();

  if (!action) {
    const custom = parseWhitelist(await rdb.get(`group:${target.gid}:link_whitelist`));
    await reply(
      env, api, msg,
      `📌 Grupo ${target.gid}\n🔗 Anti-enlaces: ${enabled ? "ON" : "OFF"}\n` +
      `• Dominios oficiales: ${DEFAULT_LINK_WHITELIST.length}\n• Dominios extra: ${custom.length}\n\n` +
      "Uso: /antilink on|off · /allowlink <dominio> · /unallowlink <dominio>",
    );
    return;
  }

  if (action === "on" || action === "off") {
    await rdb.set(`group:${target.gid}:antilink_enabled`, action === "on" ? "true" : "false");
    await reply(env, api, msg, `🔗 Anti-enlaces: ${action === "on" ? "✅ ON" : "❌ OFF"}.`);
    return;
  }

  await reply(env, api, msg, "Uso: /antilink on|off");
}

export async function handleAllowLinkCommand(env: EnvWithBot, api: TelegramApi, msg: any): Promise<void> {
  const target = resolveTarget(msg);
  const removing = commandName(String(msg?.text ?? "")) === "unallowlink";
  if (!target) {
    await reply(env, api, msg, `Uso: /${removing ? "unallowlink" : "allowlink"} <gid> <dominio>`);
    return;
  }
  if (!(await requireAdmin(env, api, msg, target.gid))) return;

  const rdb = createRedis(env);
  const key = `group:${target.gid}:link_whitelist`;
  const custom = parseWhitelist(await rdb.get(key));
  const rawEntry = target.args[0];

  if (!rawEntry) {
    const all = [...DEFAULT_LINK_WHITELIST, ...custom];
    await reply(
      env, api, msg,
      `📌 Grupo ${target.gid}\n🔗 Enlaces permitidos (${all.length}):\n${all.join(", ")}\n\n` +
      `Uso: /${removing ? "unallowlink" : "allowlink"} <dominio o URL>`,
    );
    return;
  }

  const entry = normalizeWhitelistEntry(rawEntry);
  if (!entry) {
    await reply(env, api, msg, "❌ Dominio no válido. Ejemplo: example.com o t.me/micanal.");
    return;
  }

  const isDefault = DEFAULT_LINK_WHITELIST.some((d) => normalizeWhitelistEntry(d) === entry);
  if (removing) {
    if (isDefault) {
      await reply(env, api, msg, "ℹ️ Es un dominio oficial y no se puede quitar.");
      return;
    }
    const next = custom.filter((d) => d !== entry);
    if (next.length === custom.length) {
      await reply(env, api, msg, "ℹ️ Ese dominio no estaba en la lista extra.");
      return;
    }
    if (next.length) await rdb.set(key, serializeWhitelist(next));
    else await rdb.del(key);
    await reply(env, api, msg, `✅ Dominio eliminado: ${entry}`);
    return;
  }

  if (isDefault || custom.includes(entry)) {
    await reply(env, api, msg, `ℹ️ El dominio ya está permitido: ${entry}`);
    return;
  }
  await rdb.set(key, serializeWhitelist([...custom, entry]));
  await reply(env, api, msg, `✅ Dominio permitido: ${entry}`);
}

export async function handleCasCommand(env: EnvWithBot, api: TelegramApi, msg: any): Promise<void> {
  const target = resolveTarget(msg);
  if (!target) {
    await reply(env, api, msg, "Uso: /cas <gid> on|off");
    return;
  }
  if (!(await requireAdmin(env, api, msg, target.gid))) return;

  const rdb = createRedis(env);
  const raw = await rdb.get(`group:${target.gid}:cas_enabled`);
  const enabled = raw !== "false" && raw !== "0";
  const action = (target.args[0] ?? "").toLowerCase();

  if (!action) {
    await reply(
      env, api, msg,
      `📌 Grupo ${target.gid}\n🛡️ CAS (Combot Anti-Spam): ${enabled ? "ON" : "OFF"}\n` +
      `🔑 API key: ${casApiConfigured(env) ? "configurada" : "no configurada (fail-open)"}\n` +
      "Consulta la lista pública al entrar y banea a los usuarios listados.\n\nUso: /cas on|off",
    );
    return;
  }

  if (action === "on" || action === "off") {
    await rdb.set(`group:${target.gid}:cas_enabled`, action === "on" ? "true" : "false");
    await reply(env, api, msg, `🛡️ CAS: ${action === "on" ? "✅ ON" : "❌ OFF"}.`);
    return;
  }

  await reply(env, api, msg, "Uso: /cas on|off");
}

// ---------- Aplicación automática ----------

export async function enforceAntiFlood(env: EnvWithBot, api: TelegramApi, msg: any): Promise<boolean> {
  const chatId = Number(msg?.chat?.id ?? 0);
  const userId = Number(msg?.from?.id ?? 0);
  if (!chatId || !userId || msg?.from?.is_bot) return false;
  if (msg?.chat?.type !== "group" && msg?.chat?.type !== "supergroup") return false;

  const rdb = createRedis(env);
  if (!isFeatureEnabled(await rdb.get(`group:${chatId}:antiflood_enabled`).catch(() => null))) return false;
  if (await hasGroupAccess(env, api, chatId, userId)) return false;

  const limit = parseFloodLimit(await rdb.get(`group:${chatId}:antiflood_limit`).catch(() => null));
  const muteSec = parseFloodMute(await rdb.get(`group:${chatId}:antiflood_mute`).catch(() => null));
  const floodKey = `flood:${chatId}:${userId}`;
  const count = await rdb.incr(floodKey);
  if (count === 1) await rdb.expire(floodKey, FLOOD_WINDOW_SEC);
  if (!floodExceeded(count, limit)) return false;

  const msgId = Number(msg?.message_id ?? 0);
  if (msgId) {
    try { await api.deleteMessage(chatId, msgId); } catch { /* sin permisos */ }
  }

  const mutedKey = `flood_muted:${chatId}:${userId}`;
  if (!(await rdb.get(mutedKey).catch(() => null))) {
    await rdb.setex(mutedKey, muteSec, "1").catch(() => null);
    try { await muteUser(api, chatId, userId, muteSec); } catch { /* sin permisos */ }
    const name = String(msg?.from?.first_name ?? msg?.from?.username ?? userId);
    await notify(
      env, api, chatId,
      `🌊 ${name}, has enviado demasiados mensajes seguidos. Silenciado ${Math.round(muteSec / 60)} min.`,
    );
    await bumpStat(env, chatId, "flood");
  }
  return true;
}

export async function enforceAntiLink(env: EnvWithBot, api: TelegramApi, msg: any): Promise<boolean> {
  const chatId = Number(msg?.chat?.id ?? 0);
  const userId = Number(msg?.from?.id ?? 0);
  if (!chatId || !userId || msg?.from?.is_bot) return false;
  if (msg?.chat?.type !== "group" && msg?.chat?.type !== "supergroup") return false;
  if (String(msg?.text ?? "").startsWith("/")) return false;

  const text = String(msg?.text ?? msg?.caption ?? "");
  const entities = msg?.entities ?? msg?.caption_entities;
  const links = collectMessageLinks(text, entities);
  if (!links.length) return false;

  const rdb = createRedis(env);
  if (!isFeatureEnabled(await rdb.get(`group:${chatId}:antilink_enabled`).catch(() => null))) return false;
  if (await hasGroupAccess(env, api, chatId, userId)) return false;

  const custom = parseWhitelist(await rdb.get(`group:${chatId}:link_whitelist`).catch(() => null));
  const whitelist = [...DEFAULT_LINK_WHITELIST, ...custom];
  if (!links.some((link) => !isLinkAllowed(link, whitelist))) return false;

  const msgId = Number(msg?.message_id ?? 0);
  if (msgId) {
    try { await api.deleteMessage(chatId, msgId); } catch { /* sin permisos */ }
  }

  const warnKey = `link_warn:${chatId}:${userId}`;
  const warnings = await rdb.incr(warnKey);
  if (warnings === 1) await rdb.expire(warnKey, LINK_WARN_TTL_SEC);
  const name = String(msg?.from?.first_name ?? msg?.from?.username ?? userId);
  if (warnings >= 3) {
    await rdb.setex(`link_muted:${chatId}:${userId}`, LINK_MUTE_SEC, "1").catch(() => null);
    try { await muteUser(api, chatId, userId, LINK_MUTE_SEC); } catch { /* sin permisos */ }
    await notify(env, api, chatId, `🔗 ${name}, los enlaces no están permitidos. Silenciado ${LINK_MUTE_SEC / 60} min.`);
  } else {
    await notify(env, api, chatId, `🔗 ${name}, los enlaces no están permitidos en este grupo.`);
  }
  await bumpStat(env, chatId, "links");
  return true;
}
