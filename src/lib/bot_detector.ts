/**
 * Detector de adición de bots sin administración (alertas a admins).
 * Portado desde `bot/modules/bot_detector.lua`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import * as captcha from "./captcha";

function escapeHtml(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function adminList(admins: any): any[] {
  if (Array.isArray(admins)) return admins;
  const result = admins?.result;
  return Array.isArray(result) ? result : [];
}

export async function handleBotAddedAlert(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const newUser = msg?.new_chat_member;
  const chatId = msg?.chat?.id;
  const adder = msg?.from;
  const adderId = adder?.id;
  if (!newUser || !newUser.is_bot || !chatId || !adderId) return;

  let myBotId = 0;
  try {
    const me = await api.getMe();
    myBotId = Number((me as any)?.id ?? 0);
  } catch { /* ignore */ }

  // TelegramApi ya devuelve el ChatMember directo (no el wrapper { result }).
  let adderIsAdmin = false;
  try {
    const member = await api.getChatMember(chatId, adderId);
    const status = (member as any)?.status;
    adderIsAdmin = status === "administrator" || status === "creator";
  } catch { /* ignore */ }

  const botUsername = newUser.username ? `@${newUser.username}` : String(newUser.first_name ?? "bot");
  const lang = await captcha.getGroupLang(env, chatId);

  if (!adderIsAdmin) {
    // Avisar a todos los administradores del grupo usando HTML (sin Markdown).
    try {
      const admins = await api.getChatAdministrators(chatId);
      const seen = new Set<number>();
      for (const admin of adminList(admins)) {
        const u = admin?.user;
        const aid = Number(u?.id ?? 0);
        if (!aid || u?.is_bot || seen.has(aid) || aid === adderId) continue;
        seen.add(aid);
        const adderName = escapeHtml(String(adder?.first_name ?? "Un usuario"));
        const template = await autoTranslate(
          env,
          lang,
          "⚠️ El usuario {user} ha agregado el bot {bot} al grupo sin ser administrador.",
        );
        const text = template
          .replace("{user}", `<a href="tg://user?id=${adderId}">${adderName}</a>`)
          .replace("{bot}", escapeHtml(botUsername));
        try { await api.sendMessage(aid, text, { parse_mode: "HTML" }); } catch { /* ignore */ }
      }
    } catch { /* sin permisos para listar admins */ }
    return;
  }

  // El bot fue agregado por un admin -> preconfigurar grupo
  if (newUser.id === myBotId) {
    const canPreconfig = await captcha.botHasPermissions(env, api, chatId);
    if (canPreconfig) {
      const rdb = createRedis(env);
      await rdb.set(`group:${chatId}:captcha_enabled`, "true");
      await rdb.set(`group:${chatId}:adm_report`, "true");
      await rdb.set(`group:${chatId}:delete_bot_messages`, "true");
      await rdb.set(`group:${chatId}:delete_service_messages`, "true");
      await api.sendMessage(chatId, await autoTranslate(env, lang, "El bot quedó preconfigurado, ahora puedes personalizar su configuración en tu grupo con el comando /config en el privado del bot"));
      return;
    }
    const kb = { inline_keyboard: [[{ text: await autoTranslate(env, lang, "🔐 Abrir bot en privado para configurar"), url: `https://t.me/${await captchaBotUsername(api)}?start=config_${chatId}` }]] };
    const sent = await api.sendMessage(chatId, await autoTranslate(env, lang, "Para que el bot pueda funcionar en tu grupo debes activarlo y darle administración incluyendo los permisos de borrar mensajes y restringir usuarios"), { reply_markup: kb });
    const msgBotId = Number((sent as any)?.message_id ?? 0);
    if (msgBotId) {
      const rdb = createRedis(env);
      await rdb.setex(`perms_bot:${chatId}`, 3600, String(msgBotId));
    }
  }
}

async function captchaBotUsername(api: TelegramApi): Promise<string> {
  try {
    const me = await api.getMe();
    const username = (me as any)?.username;
    return username ?? "";
  } catch {
    return "";
  }
}
