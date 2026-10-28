/**
 * Detección de idioma + bloqueo de idiomas no autorizados.
 * Portado desde `bot/utils/lang_detect.lua`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import * as captcha from "./captcha";

export const LANG_LABELS: Record<string, string> = {
  es: "🇪🇸 Español",
  en: "🇬🇧 Inglés",
  fr: "🇫🇷 Francés",
  pt: "🇵🇹 Portugués",
  zh: "🇨🇳 Chino",
  ja: "🇯🇵 Japonés",
  fa: "🇮🇷 Persa",
  ar: "🇸🇦 Árabe",
  de: "🇩🇪 Alemán",
  ko: "🇰🇷 Coreano",
  ru: "🇷🇺 Ruso",
  it: "🇮🇹 Italiano",
};

const SUPPORTED_LANGS = ["es", "en", "fr", "pt", "zh", "ja", "fa", "ar", "de", "ko", "ru", "it"];

function detectCharset(text: string): string | null {
  const ranges: Array<[string, number, number]> = [
    ["ar", 0x0600, 0x06ff],
    ["fa", 0x0600, 0x06ff],
    ["zh", 0x4e00, 0x9fff],
    ["ja", 0x3040, 0x30ff],
    ["ko", 0xac00, 0xd7af],
    ["ru", 0x0400, 0x04ff],
  ];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    for (const [lang, min, max] of ranges) {
      if (cp >= min && cp <= max) return lang;
    }
    i += Math.max(0, (text.codePointAt(i)! > 0xffff ? 2 : 1) - 1);
  }
  return null;
}

export function detectLanguage(msg: any): string {
  const text = String(msg?.text ?? "");
  const charsetLang = detectCharset(text);
  const clientLang = msg?.from?.language_code ?? null;
  return charsetLang || clientLang || "unknown";
}

export async function blockIfUnauthorized(env: RedisEnv, api: TelegramApi, msg: any): Promise<boolean> {
  const lang = detectLanguage(msg);
  const gid = Number(msg?.chat?.id);
  if (!gid) return false;
  const rdb = createRedis(env);
  const blocked: string[] = await rdb.smembers(`group:${gid}:blocked_langs`);
  const isBlocked = blocked.includes(lang);
  if (isBlocked) {
    try { await api.deleteMessage(Number(msg?.chat?.id), Number(msg?.message_id)); } catch { /* ignore */ }
    const label = LANG_LABELS[lang] ?? lang;
    const sent = await api.sendMessage(Number(msg?.chat?.id), `⛔ Idioma bloqueado: ${label}`);
    const sentAny = sent as any;
    if (sentAny?.result?.message_id) {
      try { await api.deleteMessage(Number(msg?.chat?.id), Number(sentAny.result.message_id)); } catch { /* ignore */ }
    }
    return true;
  }
  return false;
}

export async function getBlockedList(env: RedisEnv, gid: number): Promise<string> {
  const rdb = createRedis(env);
  const blocked = await rdb.smembers(`group:${gid}:blocked_langs`);
  return blocked.map((c) => LANG_LABELS[c] ?? c).join(", ");
}

export async function generateLanguageToggleKeyboard(env: RedisEnv, gid: number, lang: string, api: TelegramApi, cb: any): Promise<void> {
  const rdb = createRedis(env);
  const blockedSet = new Set<string>(await rdb.smembers(`group:${gid}:blocked_langs`));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < SUPPORTED_LANGS.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    for (let j = i; j < Math.min(i + 1, SUPPORTED_LANGS.length); j++) {
      const code = SUPPORTED_LANGS[j];
      const label = LANG_LABELS[code] ?? code;
      const status = blockedSet.has(code) ? "❌ " : "✅ ";
      row.push({ text: status + label, callback_data: `langblock:${gid}:${code}` });
    }
    rows.push(row);
  }
  rows.push([{ text: await autoTranslate(env, lang, "🔙 Volver"), callback_data: `settings:${gid}` }]);
  const keyboard = { inline_keyboard: rows };
  const text = await autoTranslate(env, lang, "🌐 Configuración de idiomas bloqueados:");
  if (cb?.inline_message_id) {
    await api.editMessageText(cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, text, { reply_markup: keyboard, inline_message_id: cb.inline_message_id } as any).catch(() => null);
  } else {
    await api.editMessageText(cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, text, { reply_markup: keyboard } as any).catch(() => null);
  }
}

export async function toggleLanguage(env: RedisEnv, gid: number, langCode: string): Promise<boolean> {
  const rdb = createRedis(env);
  const key = `group:${gid}:blocked_langs`;
  const has = await rdb.sismember(key, langCode);
  if (has) {
    await rdb.srem(key, langCode);
    return false;
  }
  await rdb.sadd(key, langCode);
  return true;
}

export async function handleLanguageCallback(env: RedisEnv, api: TelegramApi, cb: any): Promise<void> {
  let m = (cb?.data ?? "").match(/^langblock:(-?\d+):([A-Za-z]{2})$/);
  if (m) {
    const gid = Number(m[1]);
    const langCode = m[2].toLowerCase();
    const access = await createRedis(env).get(`group_access:${gid}:${cb.from?.id ?? 0}`);
    if (access !== "true") {
      const lang = (await createRedis(env).get(`group:${gid}:lang`)) ?? "es";
      await api.answerCallbackQuery(cb.id, await autoTranslate(env, lang, "⛔ No tienes permiso para este grupo"), true).catch(() => null);
      return;
    }
    const enabled = await toggleLanguage(env, gid, langCode);
    const lang = (await createRedis(env).get(`group:${gid}:lang`)) ?? "es";
    const answerText = await autoTranslate(env, lang, enabled ? "❌ Bloqueado" : "✅ Permitido");
    await api.answerCallbackQuery(cb.id, `${answerText} ${LANG_LABELS[langCode] ?? langCode}`).catch(() => null);
    await generateLanguageToggleKeyboard(env, gid, lang, api, cb);
    return;
  }
  m = (cb?.data ?? "").match(/^langblock_menu:(-?\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    const admin = await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0);
    if (!admin) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.").catch(() => null);
      return;
    }
    const lang = (await createRedis(env).get(`group:${gid}:lang`)) ?? "es";
    await generateLanguageToggleKeyboard(env, gid, lang, api, cb);
    return;
  }
}
