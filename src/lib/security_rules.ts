/**
 * Reglas puras de moderación (anti-flood y anti-enlaces).
 * Sin dependencias de Redis/Telegram para poder testearlas de forma aislada.
 */

export const FLOOD_WINDOW_SEC = 10;
export const DEFAULT_FLOOD_LIMIT = 12;
export const DEFAULT_FLOOD_MUTE_SEC = 600;

/** Dominios/enlaces oficiales permitidos incluso con anti-enlaces activo. */
export const DEFAULT_LINK_WHITELIST: readonly string[] = [
  "webrom.cc",
  "verify.webrom.cc",
  "t.me/Antiubot",
  "t.me/antiubot",
  "t.me/AntiubotNews",
  "t.me/GroupAntiubot",
  "t.me/webrom_bot",
  "github.com/webr0m/captcha-bot",
  "gitlab.com/ridrogo/captcha-bot-workers",
];

/** Las funciones de seguridad están activas salvo que se desactiven explícitamente. */
export function isFeatureEnabled(value: string | null | undefined): boolean {
  return value !== "false" && value !== "0";
}

export function parseFloodLimit(value: string | null | undefined): number {
  if (value === null || value === undefined || String(value).trim() === "") return DEFAULT_FLOOD_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_FLOOD_LIMIT;
  return Math.max(3, Math.min(Math.trunc(n), 50));
}

export function parseFloodMute(value: string | null | undefined): number {
  if (value === null || value === undefined || String(value).trim() === "") return DEFAULT_FLOOD_MUTE_SEC;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_FLOOD_MUTE_SEC;
  return Math.max(60, Math.min(Math.trunc(n), 86_400));
}

export function floodExceeded(count: number, limit: number): boolean {
  return count > limit;
}

const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:t\.me|telegram\.(?:me|dog))\/[^\s<>"'`]+/gi;

/**
 * Dominios sin esquema (`spam.com`, `webrom.cc`). Se limita a TLDs reales
 * habituales para no confundir nombres de archivo (`informe.pdf`) con enlaces.
 */
const BARE_DOMAIN_RE =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|info|biz|xyz|top|club|site|online|shop|store|app|dev|io|me|co|cc|tv|link|live|pro|icu|vip|work|click|space|website|fun|pw|su|ru|cn|br|es|mx|ar|cl|pe|uk|de|fr|it|nl|pl|in|us|ca|au|jp|kr|id|tr|ir)\b/gi;

/** Extrae URLs de un texto y limpia puntuación final habitual. */
export function extractLinks(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of String(text).matchAll(LINK_RE)) {
    const raw = match[0].replace(/[.,;:!?)\]}]+$/g, "");
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  const lower = out.map((link) => link.toLowerCase());
  for (const match of String(text).matchAll(BARE_DOMAIN_RE)) {
    const raw = match[0].replace(/[.,;:!?)\]}]+$/g, "");
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    // Evita duplicar el dominio cuando ya forma parte de una URL extraída.
    if (lower.some((link) => link.includes(key))) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/** Añade URLs de entidades `text_link` (enlaces ocultos detrás de texto). */
export function collectMessageLinks(
  text: string | null | undefined,
  entities?: Array<{ type?: string; url?: string }> | null,
): string[] {
  const out = extractLinks(text);
  const seen = new Set(out.map((l) => l.toLowerCase()));
  for (const entity of entities ?? []) {
    if (entity?.type !== "text_link" || !entity.url) continue;
    const url = String(entity.url).trim();
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export function normalizeLink(link: string): string {
  const trimmed = String(link ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/** Normaliza una entrada de whitelist: sin esquema, sin `www.`, sin barra final. */
export function normalizeWhitelistEntry(entry: string | null | undefined): string {
  let value = String(entry ?? "").trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").replace(/^www\./, "");
  value = value.replace(/\/+$/, "");
  if (!value) return "";
  if (!/^[a-z0-9][a-z0-9.-]*(?::\d+)?(?:\/[a-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(value)) return "";
  return value;
}

export function parseWhitelist(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(value).split(/[,\n]/)) {
    const entry = normalizeWhitelistEntry(part);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

export function serializeWhitelist(entries: string[]): string {
  return parseWhitelist(entries.join(",")).join(",");
}

/**
 * Un enlace está permitido si su host coincide con una entrada de dominio
 * (`webrom.cc`) o si host+ruta empieza por una entrada con ruta
 * (`t.me/Antiubot`). No se permite que una URL ajena incluya el dominio
 * permitido como parámetro.
 */
export function isLinkAllowed(link: string, whitelist: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(normalizeLink(link));
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = (url.pathname || "/").replace(/\/+$/, "");
  const full = `${host}${path === "/" ? "" : path}`.toLowerCase();

  for (const raw of whitelist) {
    const entry = normalizeWhitelistEntry(raw);
    if (!entry) continue;
    if (entry.includes("/")) {
      if (full === entry || full.startsWith(`${entry}/`)) return true;
    } else if (host === entry || host.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}

/** Devuelve el primer enlace no permitido, o null si todos son válidos. */
export function findDisallowedLink(text: string | null | undefined, whitelist: readonly string[]): string | null {
  for (const link of extractLinks(text)) {
    if (!isLinkAllowed(link, whitelist)) return link;
  }
  return null;
}
