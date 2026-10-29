/** Configuración de transporte del propietario; nunca procede de comandos del chat. */
import type { PerformanceEnv } from "./performance";
export interface TelegramConnectionEnv extends PerformanceEnv {
  BOT_TOKEN: string;
  TELEGRAM_API_BASE_URL?: string;
}

export const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";

export function telegramApiBaseUrl(value?: string): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_TELEGRAM_API_BASE_URL;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("TELEGRAM_API_BASE_URL debe ser una URL absoluta válida"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("La Bot API requiere HTTPS; HTTP solo se permite para localhost");
  }
  if (url.username || url.password || url.search || url.hash || /(?:^|\/)bot[^/]*:/i.test(url.pathname)) {
    throw new Error("TELEGRAM_API_BASE_URL no debe contener credenciales, token del bot, parámetros ni fragmentos");
  }
  return url.toString().replace(/\/+$/, "");
}
