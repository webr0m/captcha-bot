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
export function mathPendingKey(chatId: number, userId: number): string {
  return `math_pending:${chatId}:${userId}`;
}
export function qrPendingKey(chatId: number, userId: number): string {
  return `qr_pending:${chatId}:${userId}`;
}
export function emojiAnswerKey(chatId: number, userId: number): string {
  return `emoji_captcha:${chatId}:${userId}`;
}
export function imageAnswerKey(chatId: number, userId: number): string {
  return `image_captcha:${chatId}:${userId}`;
}
export function verifyDeadlineKey(chatId: number, userId: number): string {
  return `verify_deadline:${chatId}:${userId}`;
}
export function attemptKey(chatId: number, userId: number): string {
  return `verify_attempt:${chatId}:${userId}`;
}

export const PHOTO_MODES = new Set(["qr", "image"]);

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

const FALLBACK_EMOJIS = [
  "🍎", "🍌", "🍇", "🍓", "🍒", "🍑", "🍍", "🥝", "🥑", "🍉",
  "🐶", "🐱", "🐭", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁",
  "🚗", "🚕", "🚙", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚐",
  "⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🏉", "🎱", "🏓", "🏸",
];

export async function getRandomEmojis(env: RedisEnv): Promise<string[]> {
  const rdb = createRedis(env);
  const data = await rdb.get("emoji_list_json");
  if (!data) return pickRandom(FALLBACK_EMOJIS);
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(data);
  } catch {
    return pickRandom(FALLBACK_EMOJIS);
  }
  const values = Object.values(map);
  if (!values || values.length < 4) return pickRandom(FALLBACK_EMOJIS);
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

function pickRandom(values: string[]): string[] {
  const selected: string[] = [];
  const used = new Set<number>();
  while (selected.length < 4 && used.size < values.length) {
    const i = Math.floor(Math.random() * values.length);
    if (used.has(i)) continue;
    used.add(i);
    selected.push(values[i]);
  }
  while (selected.length < 4) selected.push("❌");
  return selected;
}

export async function botHasPermissions(env: RedisEnv, api: TelegramApi, chatId: number): Promise<boolean> {
  try {
    const me = await api.getMe();
    const myId = Number((me as any)?.id);
    if (!myId) return false;
    // TelegramApi ya devuelve el ChatMember (no el wrapper { result }).
    const member = await api.getChatMember(chatId, myId);
    const status = (member as any)?.status;
    if (status === "creator") return true;
    if (status !== "administrator") return false;
    // En ChatMemberAdministrator los permisos vienen en la raíz del objeto
    // (no en una propiedad `permissions`).
    const perms = (member as any)?.permissions ?? member;
    return !!(perms && perms.can_restrict_members && perms.can_delete_messages);
  } catch {
    return false;
  }
}

export async function isAdmin(env: RedisEnv, api: TelegramApi, chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await api.getChatMember(chatId, userId);
    const status = (member as any)?.status;
    return status === "administrator" || status === "creator";
  } catch {
    return false;
  }
}

export async function unmuteUser(api: TelegramApi, chatId: number, userId: number): Promise<void> {
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

export async function muteUser(api: TelegramApi, chatId: number, userId: number, timeoutSeconds: number): Promise<void> {
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
  await rdb.setex(emojiAnswerKey(chatId, userId), timeout, target);
  let displayName = "usuario";
  try {
    const info = await api.getChat(userId);
    displayName = String(info?.first_name ?? info?.username ?? "usuario");
  } catch { /* ignore */ }
  const message = `${await autoTranslate(env, lang, "*Tip: puedes copiar el mensaje y pegarlo en el chat*")}\n\n${displayName}, ${await autoTranslate(env, lang, "escribe exactamente estos emojis para verificarte:")}\n\n\`\`\`${target}\`\`\``;
  const sent = await api.sendMessage(chatId, message, { parse_mode: "Markdown" });
  const msgBotId = Number((sent as any)?.message_id ?? 0);
  return { kind: "emoji" as const, prompt: message, msgBotId };
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
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(token)}`;
  const prompt = `${await autoTranslate(env, lang, "🔐 Verificación por QR")}\n${await autoTranslate(env, lang, "Escanea el código y pulsa el botón con el token que aparece. Tienes poco tiempo.")}`;
  return { kind: "qr" as const, prompt, keyboard, qrUrl, token };
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

function msgbotKey(chatId: number, userId: number): string {
  return `ID_msgbot:${chatId}:${userId}`;
}
function msgsysKey(chatId: number, userId: number): string {
  return `ID_msgsys:${chatId}:${userId}`;
}
function msgtypeKey(chatId: number, userId: number): string {
  return `msgtype:${chatId}:${userId}`;
}

async function rememberChallenge(
  env: RedisEnv,
  chatId: number,
  userId: number,
  timeout: number,
  msgBotId: number,
  msgSysId: number,
  isPhoto: boolean,
): Promise<void> {
  const rdb = createRedis(env);
  if (msgBotId > 0) await rdb.setex(msgbotKey(chatId, userId), 86400, String(msgBotId));
  if (msgSysId > 0) await rdb.setex(msgsysKey(chatId, userId), 86400, String(msgSysId));
  if (isPhoto) await rdb.setex(msgtypeKey(chatId, userId), timeout + 60, "photo");
  await rdb.setex(`verify:${chatId}:${userId}:msg_id`, timeout + 20, String(msgBotId));
}

export async function issueCaptcha(env: RedisEnv, api: TelegramApi, chatId: number, userId: number, user: any, msg: any): Promise<void> {
  const mode = await getCaptchaMode(env, chatId);
  const lang = await getGroupLang(env, chatId);
  const timeout = await getKickTimeout(env, chatId);
  const rdb = createRedis(env);
  const chatIdNum = Number(chatId);
  const userIdNum = Number(userId);
  const now = Math.floor(Date.now() / 1000);

  // Estado común: pendiente + deadline. La tarea de expulsión se programa
  // SOLO después de enviar el desafío correctamente: si Telegram falla, no
  // se debe expulsar a alguien que nunca llegó a ver el captcha.
  await rdb.setex(verifyKey(chatIdNum, userIdNum), timeout + 60, "pending");
  await rdb.setex(verifyDeadlineKey(chatIdNum, userIdNum), timeout + 120, String(now + timeout + 5));

  let kickScheduled = false;
  const scheduleKick = async (): Promise<void> => {
    if (kickScheduled) return;
    kickScheduled = true;
    try {
      await addTask(env, { type: "kick", chatId: chatIdNum, param: userIdNum, runAt: now + timeout + 5 });
    } catch (err) {
      // El desafío ya se envió; no se debe borrar el estado por un fallo de Redis.
      console.error("No se pudo programar el kick:", err);
    }
  };

  const finish = async (msgBotId: number, isPhoto: boolean): Promise<void> => {
    await scheduleKick();
    try {
      await rememberChallenge(env, chatIdNum, userIdNum, timeout, msgBotId, Number(msg?.message_id ?? 0), isPhoto);
    } catch (err) {
      // El usuario puede verificar igualmente (el estado pending ya existe).
      console.error("No se pudo guardar el mensaje del desafío:", err);
    }
  };

  const silent = await getSilentMode(env, chatIdNum);

  try {
    if (mode === "math") {
      const challenge = await buildMathChallenge(env, chatIdNum, userIdNum, lang, timeout);
      await rdb.setex(mathPendingKey(chatIdNum, userIdNum), timeout, "pending");
      const sent = await api.sendMessage(chatIdNum, challenge.prompt, { parse_mode: "Markdown", reply_markup: challenge.keyboard });
      await finish(Number((sent as any)?.message_id ?? 0), false);
      return;
    }

    if (mode === "emoji") {
      const challenge = await buildEmojiChallenge(env, api, chatIdNum, userIdNum, lang, timeout);
      await finish(challenge.msgBotId, false);
      return;
    }

    if (mode === "qr") {
      const challenge = await buildQrChallenge(env, api, chatIdNum, userIdNum, lang, timeout);
      await rdb.setex(qrPendingKey(chatIdNum, userIdNum), timeout, "pending");
      const mention = mentionMd(String(user?.first_name ?? user?.username ?? "usuario"), userIdNum);
      const sent = await api.sendPhoto(chatIdNum, challenge.qrUrl, `${mention}\n${challenge.prompt}`, {
        parse_mode: "Markdown",
        reply_markup: challenge.keyboard,
      });
      await finish(Number((sent as any)?.message_id ?? 0), true);
      return;
    }

    if (mode === "image") {
      const code = randToken(5).toUpperCase();
      await rdb.setex(imageAnswerKey(chatIdNum, userIdNum), timeout, code);
      const url = `https://placehold.co/300x100/png?text=${encodeURIComponent(code)}&font=roboto`;
      const mention = mentionMd(String(user?.first_name ?? user?.username ?? "usuario"), userIdNum);
      const caption = `${mention}\n${await autoTranslate(env, lang, "Escribe el texto que aparece en la imagen para verificarte.")}`;
      const sent = await api.sendPhoto(chatIdNum, url, caption, { parse_mode: "Markdown" });
      await finish(Number((sent as any)?.message_id ?? 0), true);
      return;
    }

    if (mode === "turnstile") {
      const verifyUrl = `https://verify.webrom.cc/verify?chat_id=${chatIdNum}&user_id=${userIdNum}`;
      const buttonText = await autoTranslate(env, lang, "✅ Verificar con Captcha");
      const text = `${await autoTranslate(env, lang, "🔐 Verifica que no eres un bot, pulsa el botón y completa el captcha en la web.")}`;

      if (silent) {
        // Modo silencioso: intenta verificar por privado; si el usuario no ha
        // iniciado el bot, deja un aviso mínimo en el grupo con el enlace.
        try {
          const dm = await api.sendMessage(userIdNum, text, {
            reply_markup: { inline_keyboard: [[{ text: buttonText, url: verifyUrl }]] },
          });
          await finish(0, false);
          void dm;
          return;
        } catch {
          // fallback al grupo
        }
      }

      const mention = mentionMd(String(user?.first_name ?? user?.username ?? "usuario"), userIdNum);
      const sent = await api.sendMessage(chatIdNum, `${mention} ${text}`, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: buttonText, url: verifyUrl }]] },
      });
      await finish(Number((sent as any)?.message_id ?? 0), false);
      return;
    }

    // mode === "button" (y cualquier modo legado desconocido)
    const text = `${await autoTranslate(env, lang, "👋 ")}${String(user?.first_name ?? user?.username ?? "usuario")} ${await autoTranslate(env, lang, ", pulsa el botón para verificarte.")}`;
    const keyboard = { inline_keyboard: [[{ text: await autoTranslate(env, lang, "✅ Verificarme"), callback_data: `simple:${userIdNum}` }]] };
    const sent = await api.sendMessage(chatIdNum, text, { reply_markup: keyboard });
    await finish(Number((sent as any)?.message_id ?? 0), false);
  } catch (err) {
    // No se pudo enviar el desafío: se limpia el estado y NO se programa kick.
    try { await clearChallengeState(env, chatIdNum, userIdNum); } catch { /* ignore */ }
    await rdb.del(verifyKey(chatIdNum, userIdNum), verifyDeadlineKey(chatIdNum, userIdNum)).catch(() => null);
    throw err;
  }
}

// ---------- Verificar éxito / fallo ----------

export async function clearChallengeState(env: RedisEnv, chatId: number, userId: number): Promise<void> {
  const rdb = createRedis(env);
  await rdb.del(
    mathAnswerKey(chatId, userId),
    emojiAnswerKey(chatId, userId),
    imageAnswerKey(chatId, userId),
    qrAnswerKey(chatId, userId),
    mathPendingKey(chatId, userId),
    qrPendingKey(chatId, userId),
    verifyDeadlineKey(chatId, userId),
    attemptKey(chatId, userId),
    intentKey(chatId, userId),
    `math_regen:${chatId}:${userId}`,
    `qr_regen:${chatId}:${userId}`,
    `verify:${chatId}:${userId}:msg_id`,
    `verify_attempt:${chatId}:${userId}`,
    `dice_target:${chatId}:${userId}`,
    `dice_token:${chatId}:${userId}`,
    `ID_msgspin:${chatId}:${userId}`,
  );
}

async function editChallengeResult(env: RedisEnv, api: TelegramApi, chatId: number, userId: number, text: string): Promise<void> {
  const rdb = createRedis(env);
  const msgId = Number((await rdb.get(msgbotKey(chatId, userId))) ?? 0);
  if (!msgId) return;
  const isPhoto = (await rdb.get(msgtypeKey(chatId, userId))) === "photo";
  try {
    if (isPhoto) await api.editMessageCaption(chatId, msgId, text);
    else await api.editMessageText(chatId, msgId, text);
  } catch { /* mensaje borrado o sin permisos */ }
}

export async function markVerified(env: RedisEnv, api: TelegramApi, chatId: number, userId: number, userName?: string): Promise<void> {
  const rdb = createRedis(env);
  await rdb.setex(verifyKey(chatId, userId), 86400, "ok");

  const action2 = await getCaptchaAction2(env, chatId);
  const canUnmute = action2 !== "mute" && (await botHasPermissions(env, api, chatId));
  if (canUnmute) {
    try { await unmuteUser(api, chatId, userId); } catch { /* ignore */ }
  }

  const display = userName ? `@${userName}` : "usuario";
  const text = await autoTranslate(env, await getGroupLang(env, chatId), `✅ ${display} fue verificado correctamente.`);
  await editChallengeResult(env, api, chatId, userId, text);

  const msgBotId = Number((await rdb.get(msgbotKey(chatId, userId))) ?? 0);
  const msgSysId = Number((await rdb.get(msgsysKey(chatId, userId))) ?? 0);
  const delBot = await getDeleteBotMessages(env, chatId);
  const delSys = await getDeleteServiceMessages(env, chatId);
  const now = Math.floor(Date.now() / 1000);
  if (delBot && msgBotId) await addTask(env, { type: "del", chatId, param: msgBotId, runAt: now + 5 });
  if (delSys && msgSysId) await addTask(env, { type: "del", chatId, param: msgSysId, runAt: now + 5 });

  await clearChallengeState(env, chatId, userId);
  await rdb.del(msgbotKey(chatId, userId), msgsysKey(chatId, userId), msgtypeKey(chatId, userId));
}

export async function markFailed(env: RedisEnv, api: TelegramApi, chatId: number, userId: number, callbackId?: string): Promise<void> {
  const rdb = createRedis(env);
  const lang = await getGroupLang(env, chatId);
  const current = await rdb.get(attemptKey(chatId, userId));

  if (current === "1") {
    // Segundo fallo: expulsión inmediata (la tarea respeta el estado ok).
    const now = Math.floor(Date.now() / 1000);
    await addTask(env, { type: "kick", chatId, param: userId, runAt: now + 3 });
    await editChallengeResult(env, api, chatId, userId, await autoTranslate(env, lang, "❌ fue expulsado por fallar la verificación."));
    if (callbackId) {
      await api.answerCallbackQuery(callbackId, await autoTranslate(env, lang, "❌ Incorrecto. Has agotado tus intentos."), true).catch(() => null);
    }
    await clearChallengeState(env, chatId, userId);
    return;
  }

  await rdb.setex(attemptKey(chatId, userId), await getKickTimeout(env, chatId), "1");
  if (callbackId) {
    await api.answerCallbackQuery(callbackId, await autoTranslate(env, lang, "❌ Incorrecto, tienes un intento más"), true).catch(() => null);
  } else {
    const sent = await api.sendMessage(chatId, await autoTranslate(env, lang, "❌ Incorrecto, tienes un intento más")).catch(() => null);
    const msgId = Number((sent as any)?.message_id ?? 0);
    if (msgId) {
      const now = Math.floor(Date.now() / 1000);
      await addTask(env, { type: "del", chatId, param: msgId, runAt: now + 5 });
    }
  }
}
