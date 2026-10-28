/**
 * Traductor automático (DeepL primero, Google como fallback) con cache en Redis.
 * Portado desde `bot/utils/translator.lua`.
 */

import { createRedis } from "./redis";
import type { RedisEnv } from "./redis";

export const FALLBACK_LANG = "es";
const CACHE_TTL_SECONDS = 86400;

function hash32(s: string): string {
  let h = 5381;
  const str = s ?? "";
  for (let i = 0; i < str.length; i++) {
    h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

async function deeplTranslate(
  authKey: string,
  text: string,
  source: string,
  target: string,
): Promise<string | null> {
  if (!authKey) return null;
  if (!text) return "";
  let params = `text=${encodeURIComponent(text)}&target_lang=${encodeURIComponent(String(target || "EN").toUpperCase())}`;
  if (source) params = `${params}&source_lang=${encodeURIComponent(String(source).toUpperCase())}`;

  try {
    const res = await fetch("https://api-free.deepl.com/v2/translate", {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${authKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const json = (await res.json().catch(() => null)) as any;
    const translated = json?.translations?.[0]?.text;
    return typeof translated === "string" ? translated : null;
  } catch {
    return null;
  }
}

async function googleTranslate(text: string, source: string, target: string): Promise<string | null> {
  if (!text) return "";
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" +
    encodeURIComponent(source || "auto") +
    "&tl=" +
    encodeURIComponent(String(target || "en").toLowerCase()) +
    "&dt=t&q=" +
    encodeURIComponent(text);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const json = (await res.json().catch(() => null)) as any;
    const translated = json?.[0]?.[0]?.[0];
    return typeof translated === "string" ? translated : null;
  } catch {
    return null;
  }
}

export async function autoTranslate(
  env: RedisEnv & { DEEPL_AUTH_KEY?: string },
  lang: string,
  text: string,
): Promise<string> {
  const fallback = FALLBACK_LANG;
  const finalLang = lang || fallback;
  if (!text || text === "" || finalLang === fallback) return text;

  const key = `trans:${fallback}:${finalLang.toLowerCase()}:${hash32(text)}`;
  const rdb = createRedis(env);
  const cached = await rdb.get(key);
  if (cached) return cached;

  let out: string | null = null;
  if (env.DEEPL_AUTH_KEY) {
    out = await deeplTranslate(env.DEEPL_AUTH_KEY, text, fallback, finalLang);
  }
  if (!out) {
    out = await googleTranslate(text, fallback, finalLang);
  }
  if (out) {
    await rdb.setex(key, CACHE_TTL_SECONDS, out);
    return out;
  }
  return text;
}
