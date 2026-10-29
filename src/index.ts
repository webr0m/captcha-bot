/**
 * Cloudflare Worker: captcha bot (migración desde Lua/telegram-bot-lua/copas).
 *
 * Rutas:
 *  - POST /webhook  -> recibe updates de Telegram (webhook mode)
 *  - POST /verify   -> validación de Turnstile (siteverify) + set de estado verificado
 *  - GET  /health   -> healthcheck
 *
 * Cron (scheduled): procesa tareas diferidas (kicks, limpiezas, lockdowns).
 */

import { TelegramApi } from "./lib/telegram";
import { handleUpdate, BotEnv } from "./lib/dispatcher";
import { runSweep } from "./lib/tasks";
import { checkNightMode } from "./lib/nightmode";
import { runCleaner } from "./lib/cleaner";
import { createRedis } from "./lib/redis";
import { markVerified } from "./lib/captcha";
import { handleUsersLog, handleUsersLogCallback } from "./lib/users";
import { renderVerifyPage, renderInvalidVerifyPage } from "./lib/verify_page";
import { startPerformance } from "./lib/performance";

export type Env = BotEnv & {
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  WEBHOOK_SECRET?: string;
  USERS_LOG_CHAT_ID?: string;
};

function parseFormBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pairs = body.split("&");
  for (const pair of pairs) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const rawKey = pair.slice(0, eq);
    const rawVal = pair.slice(eq + 1);
    const key = safeDecode(rawKey.replace(/\+/g, "%20"));
    const val = safeDecode(rawVal.replace(/\+/g, "%20"));
    out[key] = val;
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const TEXT_HEADERS = { "Content-Type": "text/plain; charset=utf-8" };
const VERIFY_RATE_LIMIT = 30;
const VERIFY_RATE_WINDOW_SEC = 600;
const ALLOWED_TURNSTILE_HOSTS = new Set([
  "verify.webrom.cc",
  "webrom.cc",
  "captcha-bot.ridrogo.workers.dev",
]);

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && (path === "/" || path === "/health")) {
      if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
        return new Response("OK (redis not configured)", { status: 200, headers: TEXT_HEADERS });
      }
      try {
        const pong = await createRedis(env).ping();
        return new Response(`OK (redis: ${pong})`, { status: 200, headers: TEXT_HEADERS });
      } catch (err) {
        return new Response(`Redis error: ${err instanceof Error ? err.message : String(err)}`, { status: 503, headers: TEXT_HEADERS });
      }
    }

    if (request.method === "POST" && path === "/webhook") {
      // Fallar cerrado: nunca aceptar updates sin autenticación.
      if (!env.WEBHOOK_SECRET?.trim()) {
        return new Response("Webhook not configured", { status: 503, headers: TEXT_HEADERS });
      }
      {
        const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEqual(header, env.WEBHOOK_SECRET)) {
          return new Response("Unauthorized", { status: 401, headers: TEXT_HEADERS });
        }
      }
      const update = (await request.json().catch(() => null)) as any;
      if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
        return new Response("Invalid update", { status: 400, headers: TEXT_HEADERS });
      }
      if (update) {
        const configuration = /^\/config(?:@\S+)?(?:\s|$)/i.test(update.message?.text ?? "") || /^(?:settings:|setup:|nightmode_)/.test(update.callback_query?.data ?? "");
        const performance = startPerformance(env, configuration ? "configuration" : "telegram_update", request.cf?.colo);
        env = performance.env;
        const api = TelegramApi.fromEnv(env);
        ctx.waitUntil(
          (async () => {
            // Log opcional de actividad (solo si se configura USERS_LOG_CHAT_ID).
            try {
              if (env.USERS_LOG_CHAT_ID) {
                if (update.message) await handleUsersLog(env, api, update.message);
                if (update.callback_query) await handleUsersLogCallback(env, api, update.callback_query);
              }
            } catch { /* el log nunca debe bloquear el update */ }
            await handleUpdate(env, api, update);
          })().catch((err) => console.error("handleUpdate error:", err)).finally(() => performance.finish()),
        );
      }
      return new Response("OK", { status: 200, headers: TEXT_HEADERS });
    }

    if (request.method === "GET" && path === "/verify") {
      const chatIdParam = url.searchParams.get("chat_id");
      const userIdParam = url.searchParams.get("user_id");
      const valid = !!chatIdParam && !!userIdParam && /^-?\d+$/.test(chatIdParam) && /^\d+$/.test(userIdParam);
      const htmlHeaders = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline' https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
          "style-src 'unsafe-inline'; frame-src https://challenges.cloudflare.com; connect-src 'self' https: data:; " +
          "img-src 'self' data: https:; font-src https://challenges.cloudflare.com data:; base-uri 'none'; form-action 'self'",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      };
      if (!valid) {
        return new Response(renderInvalidVerifyPage(), { status: 400, headers: htmlHeaders });
      }
      const siteKey = env.TURNSTILE_SITE_KEY?.trim() || undefined;
      return new Response(renderVerifyPage(chatIdParam!, userIdParam!, siteKey), { status: 200, headers: htmlHeaders });
    }

    if (request.method === "POST" && path === "/verify") {
      const form = parseFormBody(await request.text());
      const token = form["cf-turnstile-response"];
      const chatIdParam = form["chat_id"];
      const userIdParam = form["user_id"];
      if (!token || !chatIdParam || !userIdParam) {
        return new Response("Missing parameters", { status: 400, headers: TEXT_HEADERS });
      }
      if (!/^-?\d+$/.test(chatIdParam) || !/^\d+$/.test(userIdParam)) {
        return new Response("Invalid parameters", { status: 400, headers: TEXT_HEADERS });
      }

      const chatIdNum = Number(chatIdParam);
      const userIdNum = Number(userIdParam);
      const rdb = createRedis(env);

      // Rate limit por IP para /verify (evita fuerza bruta y abuso).
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const rlKey = `rl:verify:${ip}`;
      const attempts = await rdb.incr(rlKey);
      if (attempts === 1) await rdb.expire(rlKey, VERIFY_RATE_WINDOW_SEC);
      if (attempts > VERIFY_RATE_LIMIT) {
        return new Response("Demasiados intentos. Espera unos minutos.", { status: 429, headers: TEXT_HEADERS });
      }

      const turnstileSecret = env.TURNSTILE_SECRET?.trim();
      if (!turnstileSecret) {
        return new Response("Turnstile not configured", { status: 503, headers: TEXT_HEADERS });
      }

      const siteverifyParams = new URLSearchParams({ secret: turnstileSecret, response: token });
      if (ip !== "unknown") siteverifyParams.set("remoteip", ip);

      const siteverifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: siteverifyParams.toString(),
      });
      const siteverify = (await siteverifyRes.json().catch(() => null)) as any;

      // El widget se renderiza con action y cdata ligados a este chat/usuario.
      // Además se valida el hostname para que un token de otro sitio no sirva.
      const expectedCdata = `${chatIdNum}_${userIdNum}`;
      const hostname = String(siteverify?.hostname ?? "");
      const valid =
        siteverify?.success === true &&
        siteverify?.action === "verify" &&
        siteverify?.cdata === expectedCdata &&
        ALLOWED_TURNSTILE_HOSTS.has(hostname);
      if (!valid) {
        return new Response("❌ Verificación fallida.", { status: 403, headers: TEXT_HEADERS });
      }

      const state = await rdb.get(`verify:${chatIdNum}:${userIdNum}`);

      if (state === "ok") {
        return new Response("✅ Ya estabas verificado.", { status: 200, headers: TEXT_HEADERS });
      }
      if (state !== "pending") {
        return new Response("⛔ La verificación expiró o no está activa. Vuelve a entrar al grupo.", { status: 409, headers: TEXT_HEADERS });
      }

      const api = TelegramApi.fromEnv(env);
      let username: string | undefined;
      try {
        const info = await api.getChat(userIdNum);
        username = (info as any)?.username;
      } catch { /* sin username público */ }

      if (!(await markVerified(env, api, chatIdNum, userIdNum, username))) {
        return new Response("⛔ La verificación expiró o ya fue procesada.", { status: 409, headers: TEXT_HEADERS });
      }
      return new Response("✅ Verificado correctamente.", { status: 200, headers: TEXT_HEADERS });
    }

    return new Response("Not Found", { status: 404, headers: TEXT_HEADERS });
  },

  async scheduled(_event: any, env: Env, _ctx: ExecutionContext): Promise<void> {
    const performance = startPerformance(env, "cron");
    env = performance.env;
    const api = TelegramApi.fromEnv(env);
    // Procesa cola de tareas (kicks/limpiezas/lockdowns), modo nocturno y limpieza periódica.
    await Promise.allSettled([
      runSweep(env, api),
      checkNightMode(env, api),
      runCleaner(env, api),
    ]);
    performance.finish();
  },
};
