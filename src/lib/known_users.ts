/**
 * Módulo known_users — listado/exportación de usuarios conocidos (todos los chats) y grupos.
 * Portado desde `bot/modules/known_users.lua` (comandos /known, /groups + callbacks kun:*).
 */

import { createRedis, RedisEnv, type RedisCommand } from "./redis";
import { TelegramApi } from "./telegram";

const DEV_USER_ID = 180791241; // MY_DEV_ID
const PAGE_SIZE = 20;

function generateToken(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function isTmpOrAggKey(key: string): boolean {
  if (key === "known_users:all") return true;
  if (key.startsWith("known_users:tmp:")) return true;
  return false;
}

interface UserMeta { id: number; name: string; username: string; }

/** Guarda nombre/@usuario para enriquecer /known y /groups. */
function userMetaCommand(user: any): RedisCommand {
  const key = `user_meta:${Number(user.id)}`;
  return ["MSET", key, String(user.first_name ?? ""), `${key}:last`, String(user.last_name ?? ""), `${key}:username`, String(user.username ?? "")];
}

export async function saveUserMeta(env: RedisEnv, user: any): Promise<void> {
  const uid = Number(user?.id ?? 0);
  if (!uid || user?.is_bot) return;
  await createRedis(env).pipeline([userMetaCommand(user)]);
}

/** Same persistent keys, one HTTP request instead of five per user/message. */
export async function recordKnownUser(env: RedisEnv, chatId: number, user: any): Promise<void> {
  const uid = Number(user?.id ?? 0);
  if (!uid || user?.is_bot) return;
  await createRedis(env).pipeline([
    ["SADD", "known_users:all", String(uid)],
    ["SADD", `known_users:${chatId}`, String(uid)],
    userMetaCommand(user),
  ]);
}

async function getUserMeta(env: RedisEnv, api: TelegramApi, uid: number): Promise<UserMeta | null> {
  const rdb = createRedis(env);
  const key = `user_meta:${uid}`;
  const [first, last, user] = await rdb.mget(key, `${key}:last`, `${key}:username`);
  const firstName = first ?? "";
  const lastName = last ?? "";
  const username = user ?? "";
  const full = `${firstName} ${lastName}`.trim();
  const name = full !== "" ? full : username ? `@${username}` : String(uid);
  return { id: uid, name, username };
}

async function collectAllPairs(env: RedisEnv): Promise<Array<{ uid: string; owner: string }>> {
  const rdb = createRedis(env);
  const keys = await rdb.keys("known_users:*");
  const seen = new Set<string>();
  const pairs: Array<{ uid: string; owner: string }> = [];
  for (const key of keys) {
    if (isTmpOrAggKey(key)) continue;
    const owner = key.replace(/^known_users:/, "");
    if (!owner) continue;
    const members = await rdb.smembers(key);
    for (const uid of members) {
      const uidStr = String(uid);
      if (seen.has(uidStr)) continue;
      seen.add(uidStr);
      pairs.push({ uid: uidStr, owner });
    }
  }
  pairs.sort((a, b) => Number(b.uid) - Number(a.uid));
  return pairs;
}

async function saveSnapshot(env: RedisEnv, pairs: Array<{ uid: string; owner: string }>): Promise<string> {
  const rdb = createRedis(env);
  const token = generateToken(10);
  const parts: string[] = [];
  for (const p of pairs) parts.push(`${p.uid}|${p.owner}`);
  await rdb.setex(`kun:snap:${token}`, 900, parts.join(","));
  return token;
}

function makeKeyboard(token: string, page: number, pages: number) {
  const prev = Math.max(1, page - 1);
  const next = Math.min(pages, page + 1);
  return {
    inline_keyboard: [
      [
        { text: "◀️", callback_data: `kun:pg:${token}:${prev}` },
        { text: "▶️", callback_data: `kun:pg:${token}:${next}` },
        { text: "📤 Export", callback_data: `kun:export:${token}` },
        { text: "✖️", callback_data: `kun:close:${token}` },
      ],
    ],
  };
}

async function showPage(env: RedisEnv, api: TelegramApi, replyChatId: number, messageId: number, token: string, page: number, title?: string): Promise<void> {
  const rdb = createRedis(env);
  const blob = await rdb.get(`kun:snap:${token}`);
  if (!blob) return;
  const pairs: Array<{ uid: string; owner: string }> = [];
  for (const item of blob.split(",")) {
    const idx = item.indexOf("|");
    if (idx < 0) continue;
    pairs.push({ uid: item.slice(0, idx), owner: item.slice(idx + 1) });
  }
  const total = pairs.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.max(1, Math.min(page, pages));
  const slice = pairs.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const header = `👥 Usuarios únicos (todos los chats): ${total}\nPágina ${p}/${pages}\n\n`;
  const lines: string[] = [];
  for (const pair of slice) {
    const uid = Number(pair.uid);
    const meta = await getUserMeta(env, api, uid);
    if (meta) {
      const alias = meta.username ? `@${meta.username}` : "";
      lines.push(`${meta.name} | ${alias} | ${meta.id}`);
    }
  }
  const text = `${title ?? ""}${header}${lines.length ? lines.join("\n") : "(vacío)"}`;
  const keyboard = makeKeyboard(token, p, pages);
  const ok = await api.editMessageText(replyChatId, messageId, text, { reply_markup: keyboard } as any).then(() => true).catch(() => false);
  if (!ok) {
    await api.sendMessage(replyChatId, text, { reply_markup: keyboard });
  }
}

async function showPageExport(env: RedisEnv, api: TelegramApi, replyChatId: number, token: string): Promise<void> {
  const rdb = createRedis(env);
  const blob = await rdb.get(`kun:snap:${token}`);
  if (!blob) {
    await api.sendMessage(replyChatId, "⚠️ Snapshot expirado. Usa /known list de nuevo.");
    return;
  }
  const pairs: Array<{ uid: string; owner: string }> = [];
  for (const item of blob.split(",")) {
    const idx = item.indexOf("|");
    if (idx < 0) continue;
    pairs.push({ uid: item.slice(0, idx), owner: item.slice(idx + 1) });
  }
  const text = `📤 Export usuarios (todos los chats):\n\n${pairs.map((p) => `${p.uid} | ${p.owner}`).join("\n")}`;
  await api.sendMessage(replyChatId, text);
}

export async function handleKnownCommand(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const rdb = createRedis(env);
  const userId = Number(msg?.from?.id ?? 0);
  const replyChatId = Number(msg?.chat?.id);
  const txt = String(msg?.text ?? "");

  if (userId !== DEV_USER_ID) return;

  if (/^\/known\s+list/.test(txt)) {
    const pairs = await collectAllPairs(env);
    const token = await saveSnapshot(env, pairs);
    const pages = Math.max(1, Math.ceil(pairs.length / PAGE_SIZE));
    const page = 1;
    const text = `👥 Usuarios únicos (todos los chats): ${pairs.length}\nPágina ${page}/${pages}\n\n`;
    const keyboard = makeKeyboard(token, page, pages);
    await api.sendMessage(replyChatId, text, { reply_markup: keyboard });
    return;
  }
  if (/^\/known\s+export/.test(txt)) {
    const pairs = await collectAllPairs(env);
    const token = await saveSnapshot(env, pairs);
    await showPageExport(env, api, replyChatId, token);
    return;
  }
  if (/^\/known\s*$/.test(txt) || /^\/known\s+count/.test(txt)) {
    const pairs = await collectAllPairs(env);
    await api.sendMessage(replyChatId, `👥 Usuarios únicos (todos los chats): ${pairs.length}`);
    return;
  }
  if (/^\/groups\s+list/.test(txt)) {
    const keys = await rdb.keys("known_users:*");
    const groups: number[] = [];
    for (const key of keys) {
      const owner = key.replace(/^known_users:/, "");
      const n = Number(owner);
      if (Number.isFinite(n) && owner !== "all" && !key.startsWith("known_users:tmp:")) groups.push(n);
    }
    await api.sendMessage(replyChatId, `👥 Lista de grupos conocidos (${groups.length})\n\n${groups.join("\n")}`);
    return;
  }
  if (/^\/groups\s+export/.test(txt)) {
    const keys = await rdb.keys("known_users:*");
    const groups: number[] = [];
    for (const key of keys) {
      const owner = key.replace(/^known_users:/, "");
      const n = Number(owner);
      if (Number.isFinite(n) && owner !== "all" && !key.startsWith("known_users:tmp:")) groups.push(n);
    }
    await api.sendMessage(replyChatId, `👥 Export de grupos conocidos:\n\n${groups.join("\n")}`);
    return;
  }
  if (/^\/groups\s*$/.test(txt) || /^\/groups\s+count/.test(txt)) {
    const keys = await rdb.keys("known_users:*");
    const groups: number[] = [];
    for (const key of keys) {
      const owner = key.replace(/^known_users:/, "");
      const n = Number(owner);
      if (Number.isFinite(n) && owner !== "all" && !key.startsWith("known_users:tmp:")) groups.push(n);
    }
    await api.sendMessage(replyChatId, `👥 Grupos conocidos: ${groups.length}`);
  }
}

export async function handleKnownCallback(env: RedisEnv, api: TelegramApi, cb: any): Promise<void> {
  if (Number(cb?.from?.id ?? 0) !== DEV_USER_ID) {
    await api.answerCallbackQuery(cb?.id, "🚫 No autorizado.", true).catch(() => null);
    return;
  }
  const m = (cb?.data ?? "").match(/^kun:pg:([A-Za-z0-9_]+):(\d+)$/);
  if (m) {
    const token = m[1];
    const page = Number(m[2]);
    await api.answerCallbackQuery(cb.id, "📄 Cargando página...").catch(() => null);
    await showPage(env, api, Number(cb.message?.chat?.id ?? 0), Number(cb.message?.message_id ?? 0), token, page);
    return;
  }
  const e = (cb?.data ?? "").match(/^kun:export:([A-Za-z0-9_]+)$/);
  if (e) {
    const token = e[1];
    await api.answerCallbackQuery(cb.id, "Generando export...").catch(() => null);
    await showPageExport(env, api, Number(cb.message?.chat?.id ?? 0), token);
    return;
  }
  const c = (cb?.data ?? "").match(/^kun:close:([A-Za-z0-9_]+)$/);
  if (c) {
    await api.answerCallbackQuery(cb.id, "Cerrado").catch(() => null);
    await api.deleteMessage(Number(cb.message?.chat?.id ?? 0), Number(cb.message?.message_id ?? 0)).catch(() => null);
  }
}
