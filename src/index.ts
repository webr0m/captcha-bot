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
import { createRedis } from "./lib/redis";
import { getKickTimeout, getCaptchaAction2, botHasPermissions, getGroupLang } from "./lib/captcha";
import { autoTranslate } from "./lib/translator";

export type Env = BotEnv;

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    if (request.method === "POST" && path === "/webhook") {
      const update = await request.json().catch(() => null);
      if (update) {
        const api = new TelegramApi(env.BOT_TOKEN);
        ctx.waitUntil(handleUpdate(env, api, update));
      }
      return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    if (request.method === "POST" && path === "/verify") {
      const form = parseFormBody(await request.text());
      const token = form["cf-turnstile-response"];
      const chatId = form["chat_id"];
      const userId = form["user_id"];
      if (!token || !chatId || !userId) {
        return new Response("Missing parameters", { status: 400, headers: { "Content-Type": "text/plain" } });
      }
      const secret = await getTurnstileSecret(env);
      const turnstileSecret = secret;
      const siteverifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `secret=${turnstileSecret}&response=${token}`,
      });
      const siteverify = (await siteverifyRes.json().catch(() => null)) as any;
      if (siteverify?.success) {
        const api = new TelegramApi(env.BOT_TOKEN);
        const chatIdNum = Number(chatId);
        const userIdNum = Number(userId);
        const rdb = createRedis(env);
        const stateKey = `verify:${chatIdNum}:${userIdNum}`;
        const timeout = await getKickTimeout(env, chatIdNum);
        await rdb.setex(stateKey, 3600, "ok");
        const action2 = await getCaptchaAction2(env, chatIdNum);
        const canUnmute = action2 !== "mute" && (await botHasPermissions(env, api, chatIdNum));
        if (canUnmute) {
          try {
            await api.restrictChatMember(chatIdNum, userIdNum, {
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
            }, 0);
          } catch { /* ignore */ }
        }
        const msgBotId = await rdb.get(`ID_msgbot:${chatIdNum}:${userIdNum}`);
        if (msgBotId) {
          const text = await autoTranslate(env, await getGroupLang(env, chatIdNum) || "es", `✅ @${(await api.getChat(userIdNum))?.result?.username ?? "usuario"} fue verificado correctamente.`);
          await api.editMessageText(chatIdNum, Number(msgBotId), text);
        }
        return new Response("✅ Verificado correctamente.", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("❌ Verificación fallida.", { status: 403, headers: { "Content-Type": "text/plain" } });
    }

    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },

  async scheduled(event: any, env: Env, ctx: ExecutionContext): Promise<void> {
    const api = new TelegramApi(env.BOT_TOKEN);
    // procesa cola de tareas (kicks/limpites/lockdowns) y checks periodicos (nightmode)
    await Promise.allSettled([
      runSweep(env, api),
      checkNightMode(env, api),
    ]);
  },
};

async function getTurnstileSecret(env: Env): Promise<string> {
  // En produccion se usa el Worker secret TURNSTILE_SECRET
  const secret = (env as any).TURNSTILE_SECRET as string | undefined;
  return secret ?? "0x4AAAAAABmxPmb4D8C5YEj4X7tPkoLOP28";
}
