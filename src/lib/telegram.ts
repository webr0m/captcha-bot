/**
 * Wrapper mínimo sobre la REST API de Telegram Bot API (fetch).
 * Portado desde `telegram-bot-lua` (que a su vez envuelve copas/luasocket).
 * Solo incluye los métodos que utiliza el captcha bot.
 */

import type { TelegramOkResponse } from "../types";
import { topicContext, topicParameters, type TopicContext } from "./forum";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 8_000;

export class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly retryAfter: number;

  constructor(method: string, status: number, retryAfter: number, description: string) {
    super(`Telegram API error ${method} (${status || "network"}): ${description}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramApi {
  private readonly token: string;
  private readonly topic?: TopicContext;

  constructor(token: string, topic?: TopicContext) {
    this.token = token;
    this.topic = topic;
  }

  /** Cliente por update: no comparte el tópico entre peticiones concurrentes. */
  forMessage(message: any): TelegramApi {
    return new TelegramApi(this.token, topicContext(message));
  }

  private async call<T = any>(method: string, body: Record<string, any> = {}): Promise<T> {
    if (["sendMessage", "sendPhoto", "sendVideo", "sendAnimation", "sendDocument", "sendVoice", "sendAudio", "sendSticker", "sendChatAction"].includes(method)) {
      body = { ...topicParameters(this.topic, body.chat_id), ...body };
    }
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    let lastError: TelegramApiError | null = null;
    let waited = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const reason = controller.signal.aborted
          ? `timeout after ${REQUEST_TIMEOUT_MS} ms`
          : err instanceof Error
            ? err.message
            : "network error";
        lastError = new TelegramApiError(method, 0, 0, reason);
        if (attempt === MAX_ATTEMPTS) break;
        const delay = 300 * attempt;
        if (waited + delay > MAX_RETRY_WAIT_MS) break;
        await sleep(delay);
        waited += delay;
        continue;
      }
      clearTimeout(timer);

      const json = (await res.json().catch(() => null)) as (TelegramOkResponse & { result?: T; parameters?: { retry_after?: number } }) | null;
      if (json?.ok === true) return json.result as T;

      const status = Number(res.status) || 0;
      const retryAfter = Number(json?.parameters?.retry_after ?? 0);
      const description = String(json?.description ?? (status ? `HTTP ${status}` : "unknown error"));
      lastError = new TelegramApiError(method, status, retryAfter, description);

      // Solo reintentamos errores transitorios (429 / 5xx). Los 4xx de
      // validación (usuario inexistente, sin permisos, etc.) no mejoran.
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) break;

      let delay = retryAfter > 0 ? retryAfter * 1000 : 500 * attempt;
      // No reintentar antes de retry_after si excede el presupuesto de espera.
      if (waited + delay > MAX_RETRY_WAIT_MS) break;
      if (delay <= 0) break;
      await sleep(delay);
      waited += delay;
    }

    throw lastError ?? new TelegramApiError(method, 0, 0, "unknown error");
  }

  async getMe(): Promise<any> {
    return this.call<any>("getMe");
  }

  async sendMessage(chatId: number, text: string, extra: Record<string, any> = {}): Promise<any> {
    return this.call<any>("sendMessage", { chat_id: chatId, text, ...extra });
  }

  async sendPhoto(chatId: number, photo: string, caption: string, extra: Record<string, any> = {}): Promise<any> {
    return this.call<any>("sendPhoto", { chat_id: chatId, photo, caption, ...extra });
  }

  async sendChatAction(chatId: number, action: string): Promise<any> {
    return this.call<any>("sendChatAction", { chat_id: chatId, action });
  }

  async sendSticker(chatId: number, fileId: string): Promise<any> {
    return this.call<any>("sendSticker", { chat_id: chatId, sticker: fileId });
  }

  async sendVideo(chatId: number, fileId: string, caption: string, extra: Record<string, any> = {}): Promise<any> {
    return this.call<any>("sendVideo", { chat_id: chatId, video: fileId, caption, ...extra });
  }

  async sendAnimation(chatId: number, fileId: string, caption: string, extra: Record<string, any> = {}): Promise<any> {
    return this.call<any>("sendAnimation", { chat_id: chatId, animation: fileId, caption, ...extra });
  }

  async sendDocument(chatId: number, fileId: string, caption: string, extra: Record<string, any> = {}): Promise<any> {
    return this.call<any>("sendDocument", { chat_id: chatId, document: fileId, caption, ...extra });
  }

  async sendVoice(chatId: number, fileId: string, extra: Record<string, any> = {}): Promise<any> {
    return this.call<any>("sendVoice", { chat_id: chatId, voice: fileId, ...extra });
  }

  async sendAudio(chatId: number, fileId: string, caption: string, extra: Record<string, any> = {}): Promise<any> {
    return this.call<any>("sendAudio", { chat_id: chatId, audio: fileId, caption, ...extra });
  }

  async editMessageText(chatId: number, messageId: number, text: string, extra: Record<string, any> = {}): Promise<any> {
    return this.call<any>("editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });
  }

  async editMessageCaption(chatId: number, messageId: number, caption: string, extra: Record<string, any> = {}): Promise<any> {
    return this.call<any>("editMessageCaption", { chat_id: chatId, message_id: messageId, caption, ...extra });
  }

  async editMessageMedia(
    chatId: number,
    messageId: number,
    media: any,
    caption: string,
    extra: Record<string, any> = {},
  ): Promise<any> {
    return this.call<any>("editMessageMedia", { chat_id: chatId, message_id: messageId, media, caption, ...extra });
  }

  async answerCallbackQuery(callbackId: string, text: string, showAlert?: boolean): Promise<any> {
    return this.call<any>("answerCallbackQuery", { callback_query_id: callbackId, text, show_alert: showAlert });
  }

  async deleteMessage(chatId: number, messageId: number): Promise<any> {
    return this.call<any>("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  async kickChatMember(chatId: number, userId: number): Promise<any> {
    // "Kick" = expulsión temporal (60 s); después el usuario puede volver.
    const untilDate = Math.floor(Date.now() / 1000) + 60;
    return this.call<any>("banChatMember", {
      chat_id: chatId,
      user_id: userId,
      until_date: untilDate,
      revoke_messages: true,
    });
  }

  async banChatMember(chatId: number, userId: number, untilDate = 0, revokeMessages = true): Promise<any> {
    return this.call<any>("banChatMember", {
      chat_id: chatId,
      user_id: userId,
      until_date: untilDate,
      revoke_messages: revokeMessages,
    });
  }

  async unbanChatMember(chatId: number, userId: number, onlyIfBanned = true): Promise<any> {
    return this.call<any>("unbanChatMember", {
      chat_id: chatId,
      user_id: userId,
      only_if_banned: onlyIfBanned,
    });
  }

  async restrictChatMember(chatId: number, userId: number, permissions: Record<string, any>, untilDate: number): Promise<any> {
    return this.call<any>("restrictChatMember", {
      chat_id: chatId,
      user_id: userId,
      permissions,
      until_date: untilDate,
    });
  }

  async setChatPermissions(chatId: number, permissions: Record<string, any>): Promise<any> {
    return this.call<any>("setChatPermissions", { chat_id: chatId, permissions });
  }

  async getChat(chatId: number | string): Promise<any> {
    return this.call<any>("getChat", { chat_id: chatId });
  }

  async getChatMember(chatId: number, userId: number): Promise<any> {
    return this.call<any>("getChatMember", { chat_id: chatId, user_id: userId });
  }

  async getChatAdministrators(chatId: number): Promise<any> {
    return this.call<any>("getChatAdministrators", { chat_id: chatId });
  }

  async approveChatJoinRequest(chatId: number, userId: number): Promise<any> {
    return this.call<any>("approveChatJoinRequest", { chat_id: chatId, user_id: userId });
  }

  async declineChatJoinRequest(chatId: number, userId: number): Promise<any> {
    return this.call<any>("declineChatJoinRequest", { chat_id: chatId, user_id: userId });
  }

  async leaveChat(chatId: number): Promise<any> {
    return this.call<any>("leaveChat", { chat_id: chatId });
  }

  async getChatMemberCount(chatId: number): Promise<number> {
    const result = await this.call<any>("getChatMemberCount", { chat_id: chatId });
    return Number(result) || 0;
  }
}
