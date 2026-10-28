/**
 * Módulo lang_command — /lang [código] para consultar/cambiar idioma del grupo.
 * Portado desde `bot/modules/lang_command.lua`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";

export const LANGS: Record<string, string> = {
  es: "Español 🇪🇸",
  en: "English 🇬🇧",
  fr: "Français 🇫🇷",
  pt: "Português 🇵🇹",
  zh: "中文 🇨🇳",
  ja: "日本語 🇯🇵",
  fa: "فارسی 🇮🇷",
  ar: "العربية 🇸🇦",
  de: "Deutsch 🇩🇪",
  ko: "한국어 🇰🇷",
  ru: "Русский 🇷🇺",
  it: "Italiano 🇮🇹",
};

export async function handleLangCommand(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const text = String(msg?.text ?? "");
  if (!text.startsWith("/lang")) return;
  const chat = msg?.chat;
  const chatId = Number(chat?.id);
  const userId = Number(msg?.from?.id);
  const isPrivate = chat?.type === "private";
  const langCode = (text.match(/^\/lang(?:@\S+)?\s+([A-Za-z]{2})/) ?? [])[1]?.toLowerCase();

  const lang = (await createRedis(env).get(`group:${chatId}:lang`)) ?? "es";
  const t = (key: string) => autoTranslate(env, lang, key);

  const isSpam = await createRedis(env).get(`cooldown:${userId}:lang`);
  const last = isSpam ? Number(isSpam) : 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (last && nowSec - last < 5) {
    const wait = 5 - (nowSec - last);
    await api.sendMessage(chatId, `⏳ Por favor espera ${wait}s antes de volver a usar este comando.`);
    return;
  }
  await createRedis(env).setex(`cooldown:${userId}:lang`, 5, String(nowSec));

  const onlyAdminMsg = await t("only_admin_can_change_lang");

  if (!langCode) {
    if (!isPrivate && !(await isAdminUser(env, api, chatId, userId))) {
      await api.sendMessage(chatId, onlyAdminMsg);
      return;
    }
    const lines = [await t("available_langs")];
    for (const [code, label] of Object.entries(LANGS)) {
      lines.push(`/${code} → ${label}`);
    }
    await api.sendMessage(chatId, lines.join("\n"));
    return;
  }

  if (!LANGS[langCode]) {
    await api.sendMessage(chatId, await t("invalid_lang_code"));
    return;
  }

  if (!isPrivate && !(await isAdminUser(env, api, chatId, userId))) {
    await api.sendMessage(chatId, onlyAdminMsg);
    return;
  }

  const rdb = createRedis(env);
  await rdb.set(`group:${chatId}:lang`, langCode);
  await api.sendMessage(chatId, `${await t("language_updated")} ${LANGS[langCode]}`);
}

async function isAdminUser(env: RedisEnv, api: TelegramApi, chatId: number, userId: number): Promise<boolean> {
  try {
    const me = await api.getMe();
    const myId = Number((me as any)?.id);
    const res = await api.getChatMember(chatId, userId);
    const status = (res as any)?.status;
    const member = (res as any)?.result;
    if (status === "administrator" || status === "creator") return true;
    if (status === "left" || status === "kicked") return false;
    void myId;
    return false;
  } catch {
    return false;
  }
}
