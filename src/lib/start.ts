/**
 * Módulo start — /start en privado y en grupos.
 * Portado desde `bot/modules/settings_menu.lua` (líneas 587-705):
 * - Grupo (admin): botón para abrir el bot en privado con `start=config_<gid>`.
 * - Grupo (no admin): aviso de menú solo para administradores.
 * - Privado `config_<gid>`: botón para abrir la configuración del grupo.
 * - Privado sin parámetro: mensaje de bienvenida + enlaces útiles.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import * as captcha from "./captcha";
import { addTask } from "./tasks";

type EnvWithBot = RedisEnv & { BOT_TOKEN: string };

const WELCOME_TEXT = `👋 ¡Bienvenido a AntiUBot!

Este bot te ayuda a proteger tu grupo de Telegram contra bots no deseados y usuarios automatizados.

🔐 Funciones principales:
• Verificación por botón o captcha emoji
• Expulsión automática de userbots
• Configuración dinámica por grupo
• Control total desde el chat privado

💡 Para comenzar, añade el bot a tu grupo como administrador y luego usa /config en el chat privado del bot o de manera inline:
@Antiubot config.

👇 Usa los botones para más información:`;

const START_RE = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?\s*$/;

function parseStartParam(text: string): { param: string | null } | null {
  const m = text.match(START_RE);
  if (!m) return null;
  return { param: m[1] ? m[1].trim() : null };
}

async function botUsername(api: TelegramApi): Promise<string> {
  try {
    const me = await api.getMe();
    const username = String((me as any)?.username ?? "");
    if (username) return username;
  } catch { /* ignore */ }
  return "Antiubot";
}

async function sendTemporary(
  env: EnvWithBot,
  api: TelegramApi,
  chatId: number,
  text: string,
  delaySeconds: number,
  replyMarkup?: any,
): Promise<void> {
  const sent = await api.sendMessage(chatId, text, replyMarkup ? { reply_markup: replyMarkup } : {});
  const messageId = Number(sent?.message_id ?? sent?.result?.message_id ?? 0);
  if (!messageId) return;
  const now = Math.floor(Date.now() / 1000);
  await addTask(env, { type: "del", chatId, param: messageId, runAt: now + delaySeconds });
}

export async function handleStartCommand(env: EnvWithBot, api: TelegramApi, msg: any): Promise<void> {
  const parsed = parseStartParam(String(msg?.text ?? ""));
  if (!parsed) return;

  const chatId = Number(msg?.chat?.id);
  const userId = Number(msg?.from?.id);
  if (!chatId || !userId) return;

  const rdb = createRedis(env);
  const lang = (await rdb.get(`group:${chatId}:lang`)) ?? "es";

  // /start dentro de un grupo: solo los administradores pueden configurar.
  if (msg?.chat?.type !== "private") {
    if (!(await captcha.isAdmin(env, api, chatId, userId))) {
      await sendTemporary(env, api, chatId, await autoTranslate(env, lang, "🤖 Menu Solo para administradores."), 5);
      return;
    }
    const username = await botUsername(api);
    const kb = {
      inline_keyboard: [[{
        text: await autoTranslate(env, lang, "🔐 Abrir bot en privado"),
        url: `https://t.me/${username}?start=config_${chatId}`,
      }]],
    };
    await sendTemporary(
      env, api, chatId,
      await autoTranslate(env, lang, "Necesitas configurar esto en privado:"),
      15, kb,
    );
    return;
  }

  // Chat privado: deep-link `/start config_<gid>`.
  if (parsed.param) {
    const m = parsed.param.match(/^config_(-?\d+)$/);
    if (!m) return; // verify_* lo maneja channel_verify; otros parámetros se ignoran
    const gid = Number(m[1]);
    const groupLang = (await rdb.get(`group:${gid}:lang`)) ?? "es";
    let title = `Grupo ${gid}`;
    try {
      const info = await api.getChat(gid);
      title = String((info as any)?.title ?? (info as any)?.result?.title ?? title);
    } catch { /* sin título accesible */ }
    const kb = { inline_keyboard: [[{ text: title, callback_data: `settings:${gid}` }]] };
    await api.sendMessage(
      chatId,
      await autoTranslate(env, groupLang, "⚙️ Configura tu grupo:"),
      { reply_markup: kb },
    );
    return;
  }

  // Chat privado: bienvenida y enlaces.
  const kb = {
    inline_keyboard: [
      [
        { text: await autoTranslate(env, lang, "👤 Contactar al creador"), url: "https://t.me/webrom_bot" },
        { text: await autoTranslate(env, lang, "🤖 Agrégame a tu grupo!!"), url: "https://t.me/antiubot?startgroup=true" },
      ],
      [{ text: await autoTranslate(env, lang, "🌐 Grupo público del bot"), url: "https://t.me/GroupAntiubot" }],
      [{ text: await autoTranslate(env, lang, "📢 Canal público"), url: "https://t.me/AntiubotNews" }],
    ],
  };
  await sendTemporary(env, api, chatId, await autoTranslate(env, lang, WELCOME_TEXT), 60, kb);
}
