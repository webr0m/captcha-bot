/**
 * Motor de captchas + flujos de verificación (migración desde bot/modules/captcha.lua,
 * captcha_turnstile.lua, math_captcha.lua, qr_captcha.lua, verify_button.lua).
 *
 * NOTA DE PORTABILIDAD: en Workers no hay timers arbitrarios; los "kicks" y
 * limpiezas se programan via cola de tareas (Redis Set "tasks") procesada por cron.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import { addTask } from "./tasks";

export const FALLBACK_LANG = "es";

// ---------- Keys ----------
export function verifyKey(chatId: number, userId: number): string {
  return `verify:${chatId}:${userId}`;
}
export function mathAnswerKey(chatId: number, userId: number): string {
  return `math_captcha:${chatId}:${userId}`;
}
export function mathTokenKey(chatId: number, userId: number, token: string): string {
  return `math_token:${chatId}:${userId}:${token}`;
}
export function qrAnswerKey(chatId: number, userId: number): string {
  return `qr_captcha:${chatId}:${userId}`;
}
export function qrTokenKey(chatId: number, userId: number, choice: string): string {
  return `qr_token:${chatId}:${userId}:${choice}`;
}
export function intentKey(chatId: number, userId: number): string {
  return `verify_intent:${chatId}:${userId}`;
}

// ---------- Helpers ----------
function mdEscape(s: any): string {
  return String(s ?? "").replace(/([_*\[\]()~`>#+.!-=|{}.])/g, "\\$1");
}
function mentionMd(name: string, userId: number): string {
  return `[${mdEscape(name)}](tg://user?id=${userId})`;
}
function toEmojiNumber(n: any): string {
  const str = String(n ?? "");
  return str.replace(/[0-9]/g, (d) => `${d}⃣`);
}
function randToken(n: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(chars[Math.floor(Math.random() * chars.length)]);
  }
  return out.join("");
}

export async function getCaptchaEnabled(env: RedisEnv, chatId: number): Promise<boolean> {
  const v = await createRedis(env).get(`group:${chatId}:captcha_enabled`);
  return v === "true";
}
export async function getCaptchaMode(env: RedisEnv, chatId: number): Promise<string> {
  const v = await createRedis(env).get(`group:${chatId}:captcha_mode`);
  return v || "button";
}
export async function getKickTimeout(env: RedisEnv, chatId: number): Promise<number> {
  const v = await createRedis(env).get(`group:${chatId}:kick_timeout`);
  const n = v ? Number(v) : 60;
  const val = Number.isFinite(n) ? n : 60;
  return Math.max(5, Math.min(val, 3600));
}
export async function getCaptchaAction(env: RedisEnv, chatId: number): Promise<string> {
  const v = await createRedis(env).get(`group:${chatId}:captcha_action`);
  return v || "kick";
}
export async function getCaptchaAction2(env: RedisEnv, chatId: number): Promise<string> {
  const v = await createRedis(env).get(`group:${chatId}:captcha_action_2`);
  return v || "mute";
}
export async function getSilentMode(env: RedisEnv, chatId: number): Promise<boolean> {
  const v = await createRedis(env).get(`group:${chatId}:silent_mode`);
  return v === "true";
}
export async function getGroupLang(env: RedisEnv, chatId: number): Promise<string> {
  const v = await createRedis(env).get(`group:${chatId}:lang`);
  return v || FALLBACK_LANG;
}
export async function getDeleteBotMessages(env: RedisEnv, chatId: number): Promise<boolean> {
  const v = await createRedis(env).get(`group:${chatId}:delete_bot_messages`);
  return v === undefined || v === null || v === "true";
}
export async function getDeleteServiceMessages(env: RedisEnv, chatId: number): Promise<boolean> {
  const v = await createRedis(env).get(`group:${chatId}:delete_service_messages`);
  return v === undefined || v === null || v === "true";
}

export async function getRandomEmojis(env: RedisEnv): Promise<string[]> {
  const rdb = createRedis(env);
  const data = await rdb.get("emoji_list_json");
  if (!data) return ["❌", "❌", "❌", "❌"];
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(data);
  } catch {
    return ["❌", "❌", "❌", "❌"];
  }
  const values = Object.values(map);
  if (!values || values.length < 4) return ["❌", "❌", "❌", "❌"];
  const selected: string[] = [];
  const used = new Set<number>();
  while (selected.length < 4) {
    const i = Math.floor(Math.random() * values.length);
    if (used.has(i)) continue;
    used.add(i);
    selected.push(values[i]);
  }
  return selected;
}

async function botHasPermissions(env: RedisEnv, api: TelegramApi, chatId: number): Promise<boolean> {
  try {
    const me = await api.getMe();
    const myId = me?.id;
    if (!myId) return false;
    const res = await api.getChatMember(chatId, myId);
    const status = res?.status;
    const member = res?.result;
    if (status !== "administrator" && status !== "creator") return false;
    const perms = member?.permissions;
    return !!(perms && perms.can_restrict_members && perms.can_delete_messages);
  } catch {
    return false;
  }
}

async function isAdmin(env: RedisEnv, api: TelegramApi, chatId: number, userId: number): Promise<boolean> {
  try {
    const res = await api.getChatMember(chatId, userId);
    const status = res?.status;
    const member = res?.result;
    if (status === "administrator" || status === "creator") return true;
    if (status === "left" || status === "kicked") return false;
    return false;
  } catch {
    return false;
  }
}

async function unmuteUser(api: TelegramApi, chatId: number, userId: number): Promise<void> {
  const permissions: Record<string, any> = {
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
  await api.restrictChatMember(chatId, userId, permissions, 0);
}

async function muteUser(api: TelegramApi, chatId: number, userId: number, timeoutSeconds: number): Promise<void> {
  const permissions: Record<string, any> = {
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
  const untilDate = Math.floor(Date.now() / 1000) + (typeof timeoutSeconds === "number" ? timeoutSeconds : 60);
  await api.restrictChatMember(chatId, userId, permissions, untilDate);
}

// ---------- Challenges ----------

export async function buildMathChallenge(env: RedisEnv, chatId: number, userId: number, lang: string, timeout: number) {
  const rdb = createRedis(env);
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const usePlus = Math.random() < 0.5;
  const op = usePlus ? "+" : "-";
  const result = usePlus ? a + b : Math.abs(a - b);
  const opEmoji = usePlus ? "➕" : "➖";
  await rdb.setex(mathAnswerKey(chatId, userId), timeout, String(result));

  const prompt = `${await autoTranslate(env, lang, "🧠 Para verificar que eres humano, responde: ¿Cuánto es")} ${toEmojiNumber(a)} ${opEmoji} ${toEmojiNumber(b)}`;

  const options: number[] = [result];
  const seen = new Set<string>([String(result)]);
  while (options.length < 4) {
    const d = result + Math.floor(Math.random() * 11) - 5;
    const ds = String(d);
    if (d >= 0 && !seen.has(ds)) { seen.add(ds); options.push(d); }
  }
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = options[i]; options[i] = options[j]; options[j] = tmp;
  }
  const rows: any[] = [];
  for (let i = 0; i < options.length; i += 2) {
    const row: any[] = [];
    for (let j = i; j < Math.min(i + 2, options.length); j++) {
      const val = String(options[j]);
      const token = randToken(10);
      await rdb.setex(mathTokenKey(chatId, userId, token), timeout, val);
      row.push({ text: toEmojiNumber(options[j]), callback_data: `math_answer:${userId}:${token}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "🔄 " + (await autoTranslate(env, lang, "Nuevo desafío")), callback_data: `math_regen:${userId}` }]);
  const keyboard = { inline_keyboard: rows };
  return { prompt, keyboard, kind: "math" };
}

export async function buildEmojiChallenge(env: RedisEnv, api: TelegramApi, chatId: number, userId: number, lang: string, timeout: number) {
  const emojis = await getRandomEmojis(env);
  const target = emojis.join("");
  const rdb = createRedis(env);
  await rdb.setex(verifyKey(chatId, userId), timeout, target);
  const userInfo = await api.getChat(userId);
  const userObj = (userInfo as any)?.result ?? userInfo;
  const displayName = userObj?.first_name || userObj?.username || "usuario";
  const message = `${await autoTranslate(env, lang, "🤩 Para verificar que eres humano, escribe exactamente estos emojis:")}\n\n\`\`\`${target}\`\`\``;
  const sent = await api.sendMessage(chatId, message, { parse_mode: "Markdown" });
  const sentAny = sent as any;
  const msgBotId = sentAny?.result?.message_id;
  await rdb.setex(`ID_msgbot:${chatId}:${userId}`, 86400, msgBotId);
  await rdb.setex(`ID_msgsys:${chatId}:${userId}`, 86400, msgBotId - 1);
  await rdb.setex(`verify:${chatId}:${userId}:msg_id`, timeout + 20, msgBotId);
  return { kind: "emoji" as const, prompt: message, keyboard: undefined };
}

export async function buildQrChallenge(env: RedisEnv, api: TelegramApi, chatId: number, userId: number, lang: string, timeout: number) {
  const token = randToken(6);
  const rdb = createRedis(env);
  await rdb.setex(qrAnswerKey(chatId, userId), timeout, token);
  const choices: string[] = [token];
  const seen = new Set<string>([token]);
  let guard = 0;
  while (choices.length < 4 && guard++ < 100) {
    const mutated = mutateToken(token);
    if (!seen.has(mutated)) { seen.add(mutated); choices.push(mutated); }
  }
  for (let i = choices.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const tmp = choices[i]; choices[i] = choices[j]; choices[j] = tmp; }
  const rows: any[] = [];
  for (let i = 0; i < choices.length; i += 2) {
    const row: any[] = [];
    for (let j = i; j < Math.min(i + 2, choices.length); j++) {
      const val = choices[j];
      await rdb.setex(qrTokenKey(chatId, userId, val), timeout, val);
      row.push({ text: val, callback_data: `qr_answer:${userId}:${val}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "🔄 " + (await autoTranslate(env, lang, "Nuevo desafío")), callback_data: `qr_regen:${userId}` }]);
  const keyboard = { inline_keyboard: rows };
  const verifyUrl = `https://verify.webrom.lat/verify?&chat_id=${chatId}&user_id=${userId}`;
  return { kind: "qr" as const, prompt: await autoTranslate(env, lang, "🔐 Verificación por QR"), keyboard, verifyUrl, answerKey: qrAnswerKey(chatId, userId) };
}

function mutateToken(base: string): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const arr = Array.from(base);
  const flips = Math.random() < 0.5 ? 1 : 2;
  for (let k = 0; k < flips; k++) {
    const p = Math.floor(Math.random() * arr.length);
    arr[p] = chars[Math.floor(Math.random() * chars.length)];
  }
  return arr.join("");
}

// ---------- Issue captcha (por modo) ----------

export async function issueCaptcha(env: RedisEnv, api: TelegramApi, chatId: number, userId: number, user: any, msg: any): Promise<void> {
  const mode = await getCaptchaMode(env, chatId);
  const lang = await getGroupLang(env, chatId);
  const timeout = await getKickTimeout(env, chatId);
  const rdb = createRedis(env);
  const chatIdNum = Number(chatId);
  const userIdNum = Number(userId);

  if (mode === "math") {
    const challenge = await buildMathChallenge(env, chatIdNum, userIdNum, lang, timeout);
    await rdb.setex(mathPendingKey(chatIdNum, userIdNum), timeout, "pending");
    const sent = await api.sendMessage(chatIdNum, challenge.prompt, { parse_mode: "Markdown", reply_markup: challenge.keyboard });
    const sentAny = sent as any;
    const msgBotId = sentAny?.result?.message_id;
    await rdb.setex(`ID_msgbot:${chatIdNum}:${userIdNum}`, 86400, msgBotId);
    await rdb.setex(`ID_msgsys:${chatIdNum}:${userIdNum}`, 86400, msgBotId - 1);
    await rdb.setex(`verify:${chatIdNum}:${userIdNum}:msg_id`, timeout + 20, msgBotId);
    await addTask(env, { type: "kick", chatId: chatIdNum, param: userIdNum, runAt: Math.floor(Date.now() / 1000) + timeout + 5 });
    return;
  }

  if (mode === "emoji") {
    const challenge = await buildEmojiChallenge(env, api, chatIdNum, userIdNum, lang, timeout);
    await addTask(env, { type: "kick", chatId: chatIdNum, param: userIdNum, runAt: Math.floor(Date.now() / 1000) + timeout + 5 });
    return;
  }

  if (mode === "qr") {
    const challenge = await buildQrChallenge(env, api, chatIdNum, userIdNum, lang, timeout);
    await rdb.setex(qrPendingKey(chatIdNum, userIdNum), timeout, "pending");
    await addTask(env, { type: "kick", chatId: chatIdNum, param: userIdNum, runAt: Math.floor(Date.now() / 1000) + timeout + 5 });
    return;
  }

  if (mode === "turnstile") {
    const rdbLocal = createRedis(env);
    await rdbLocal.setex(verifyKey(chatIdNum, userIdNum), timeout + 60, "pending");
    const verifyUrl = `https://verify.webrom.lat/verify?&chat_id=${chatIdNum}&user_id=${userIdNum}`;
    const text = `${await autoTranslate(env, lang, "🔐 ")} ${await autoTranslate(env, lang, "verifica que no eres un bot, Presiona el botón y completa el captcha en la web.")}`;
    const keyboard = { inline_keyboard: [[{ text: await autoTranslate(env, lang, "✅ Verificar con Captcha"), url: verifyUrl }]] };
    const sent = await api.sendMessage(chatIdNum, text, { parse_mode: "HTML", reply_markup: keyboard });
    const sentAny = sent as any;
    const msgBotId = sentAny?.result?.message_id;
    await rdbLocal.setex(`ID_msgbot:${chatIdNum}:${userIdNum}`, 86400, msgBotId);
    await rdbLocal.setex(`ID_msgsys:${chatIdNum}:${userIdNum}`, 86400, msgBotId - 1);
    const nowTurnstile = Math.floor(Date.now() / 1000);
    await addTask(env, { type: "kick", chatId: chatIdNum, param: userIdNum, runAt: nowTurnstile + timeout + 5 });
    return;
  }

  // mode === "button"
  const text = `${await autoTranslate(env, lang, "👋 ")}${String(user?.first_name ?? user?.username ?? "usuario")} ${await autoTranslate(env, lang, ", pulsa el botón para verificarte.")}`;
  const keyboard = { inline_keyboard: [[{ text: await autoTranslate(env, lang, "✅ Verificarme"), callback_data: `simple:${userIdNum}` }]] };
  const sent = await api.sendMessage(chatIdNum, text, { reply_markup: keyboard });
  const sentAny = sent as any;
  const msgBotId = sentAny?.result?.message_id;
  await rdb.setex(`ID_msgbot:${chatIdNum}:${userIdNum}`, 86400, msgBotId);
  await rdb.setex(`ID_msgsys:${chatIdNum}:${userIdNum}`, 86400, msgBotId - 1);
  const nowButton = Math.floor(Date.now() / 1000);
  await addTask(env, { type: "kick", chatId: chatIdNum, param: userIdNum, runAt: nowButton + timeout + 5 });
}

// ---------- Verificar éxito / fallo ----------

export async function markVerified(env: RedisEnv, api: TelegramApi, chatId: number, userId: number, userName?: string): Promise<void> {
  const rdb = createRedis(env);
  const key = verifyKey(chatId, userId);
  const timeout = await getKickTimeout(env, chatId);
  await rdb.setex(key, 86400, "ok");
  const action2 = await getCaptchaAction2(env, chatId);
  const canUnmute = action2 !== "mute" && (await botHasPermissions(env, api, chatId));
  if (canUnmute) {
    try { await unmuteUser(api, chatId, userId); } catch { /* ignore */ }
  }
  const msgBotId = await rdb.get(`ID_msgbot:${chatId}:${userId}`);
  const msgSysId = await rdb.get(`ID_msgsys:${chatId}:${userId}`);
  const delBot = await getDeleteBotMessages(env, chatId);
  const delSys = await getDeleteServiceMessages(env, chatId);
  if (msgBotId) {
    const text = await autoTranslate(env, await getGroupLang(env, chatId), `✅ @${userName ?? "usuario"} fue verificado correctamente.`);
    await api.editMessageText(chatId, Number(msgBotId), text);
  }
  const now = Math.floor(Date.now() / 1000);
  if (msgBotId) await addTask(env, { type: "del", chatId, param: Number(msgBotId), runAt: now + 5 });
  if (msgSysId) await addTask(env, { type: "del", chatId, param: Number(msgSysId), runAt: now + 5 });
}

export async function markFailed(env: RedisEnv, api: TelegramApi, chatId: number, userId: number, callbackId?: string): Promise<void> {
  const rdb = createRedis(env);
  const key = intentKey(chatId, userId);
  const current = await rdb.get(key);
  if (current === "ok") {
    // segundo intento fallido -> expulsión
    const action = await getCaptchaAction(env, chatId);
    const now = Math.floor(Date.now() / 1000);
    await addTask(env, { type: "kick", chatId, param: userId, runAt: now + 5 });
    const msgBotId = await rdb.get(`ID_msgbot:${chatId}:${userId}`);
    if (msgBotId) {
      await api.editMessageText(chatId, Number(msgBotId), await autoTranslate(env, await getGroupLang(env, chatId), "❌ fue expulsado por fallar la verificación."));
    }
    return;
  }
  await rdb.setex(key, await getKickTimeout(env, chatId), "ok");
  if (callbackId) {
    await api.answerCallbackQuery(callbackId, await autoTranslate(env, await getGroupLang(env, chatId) || "es", "❌ Incorrecto, tienes un intento más"), true).catch(() => null);
  }
}
