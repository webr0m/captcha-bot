/**
 * Módulo config_summary — resumen de configuración del grupo (callback `summary:<gid>`).
 * Portado desde `bot/modules/config_summary.lua`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { DEFAULT_CAPTCHA_MODE, captchaEnabledByDefault } from "./group_defaults";
import { autoTranslate } from "./translator";
import * as captcha from "./captcha";

export async function handleSummaryCallback(env: RedisEnv, api: TelegramApi, cb: any): Promise<void> {
  const m = (cb?.data ?? "").match(/^summary:(-?\d+)$/);
  if (!m) return;
  const gid = Number(m[1]);
  const userId = Number(cb?.from?.id ?? 0);
  const lang = (await createRedis(env).get(`group:${gid}:lang`)) ?? "es";
  const t = (key: string) => autoTranslate(env, lang, key);

  if (!(await captcha.isAdmin(env, api, gid, userId))) {
    await api.answerCallbackQuery(cb.id, await t("⛔ No tienes permiso para ver esta configuración."), true).catch(() => null);
    return;
  }

  const timeout = Number((await createRedis(env).get(`group:${gid}:kick_timeout`)) ?? 60);
  const captchaEnabled = captchaEnabledByDefault(await createRedis(env).get(`group:${gid}:captcha_enabled`));
  const mode = (await createRedis(env).get(`group:${gid}:captcha_mode`)) || DEFAULT_CAPTCHA_MODE;
  const delBot = (await createRedis(env).get(`group:${gid}:delete_bot_messages`) ?? "true") === "true";
  const delSys = (await createRedis(env).get(`group:${gid}:delete_service_messages`) ?? "true") === "true";

  const text = `${await t("📊 Resumen de configuración del grupo:")}\n🆔 ID: \`${gid}\`\n⏱ Tiempo de verificación: \`${timeout}\` seg\n🧩 BOT activado: \`${await t(captchaEnabled ? "true" : "false")}\`\n🔢 Modo captcha: \`${mode}\`\n🗑 Borrar mensajes del bot: \`${delBot}\`\n🗑 Borrar mensajes de sistema: \`${delSys}\``;

  await api.answerCallbackQuery(cb.id, "📊 Resumen de configuración.").catch(() => null);
  await api.sendMessage(cb.message?.chat?.id ?? gid, text);
}
