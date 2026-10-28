/**
 * Módulo test_message — verificación de eventos.
 * Portado desde `bot/modules/test_message.lua`.
 */

import { TelegramApi } from "./telegram";

export async function handleTestMessage(api: TelegramApi, msg: any): Promise<void> {
  const text = String(msg?.text ?? "");
  if (text === "/test") {
    await api.sendMessage(msg.chat.id, "✅ Sistema de eventos funcionando (registrado).");
  }
}
