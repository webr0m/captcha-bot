/**
 * Detector de adición de bots sin administración (alertas a admins).
 * Portado desde `bot/modules/bot_detector.lua`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import * as captcha from "./captcha";

function mdEscape(s: any): string {
  return String(s ?? "").replace(/([_*\[\]()~`>#+.!-=|{}.])/g, "\\$1");
}

export async function handleBotAddedAlert(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const newUser = msg?.new_chat_member;
  const chatId = msg?.chat?.id;
  const adderId = msg?.from?.id;
  if (!newUser || !newUser.is_bot || !chatId || !adderId) return;

  let myBotId = 0;
  try {
    const me = await api.getMe();
    myBotId = Number((me as any)?.id ?? 0);
  } catch { /* ignore */ }

  const adderStatus = await api.getChatMember(chatId, adderId);
  const adderMember = (adderStatus as any)?.result;
  const adderStatusStr = (adderStatus as any)?.status;
  const adderIsAdmin = adderStatusStr === "administrator" || adderStatusStr === "creator";

  const botUsername = newUser.username ? `@${newUser.username}` : String(newUser.first_name ?? "bot");
  const lang = await captcha.getGroupLang(env, chatId);

  if (!adderIsAdmin) {
    const admins = await api.getChatAdministrators(chatId);
    const list = (admins as any)?.result ?? [];
    for (const admin of list) {
      const aid = admin?.user?.id;
      if (aid === undefined || aid === null) continue;
      const granted = await createRedis(env).get(`group_access:${chatId}:${aid}`);
      if (granted !== "true") continue;
      const text = await autoTranslate(env, lang, `⚠️ El usuario [${String((admin?.user as any)?.first_name ?? "")}](tg://user?id=${aid}) ha agregado el bot ${botUsername} al grupo sin ser administrador.`);
      try { await api.sendMessage(aid, mdEscape(text)); } catch { /* ignore */ }
    }
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
    const sentAny = sent as any;
    const msgBotId = sentAny?.result?.message_id;
    const rdb = createRedis(env);
    await rdb.setex(`perms_bot:${chatId}`, 3600, String(msgBotId));
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
