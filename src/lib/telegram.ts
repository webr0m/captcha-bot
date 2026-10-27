/**
 * Wrapper mínimo sobre la REST API de Telegram Bot API (fetch).
 * Portado desde `telegram-bot-lua` (que a su vez envuelve copas/luasocket).
 * Solo incluye los métodos que utiliza el captcha bot.
 */

import type { TelegramOkResponse } from "../types";

export class TelegramApi {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async call<T = any>(method: string, body: Record<string, any> = {}): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as TelegramOkResponse & { result?: T };
    if (!json || json.ok !== true) {
      throw new Error(`Telegram API error ${method}: ${json?.description ?? "unknown error"}`);
    }
    return json.result as T;
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

  async answerCallbackQuery(callbackId: string, text: string, showAlert: boolean): Promise<any> {
    return this.call<any>("answerCallbackQuery", { callback_query_id: callbackId, text, show_alert: showAlert });
  }

  async deleteMessage(chatId: number, messageId: number): Promise<any> {
    return this.call<any>("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  async kickChatMember(chatId: number, userId: number): Promise<any> {
    return this.call<any>("kickChatMember", { chat_id: chatId, user_id: userId });
  }

  async banChatMember(chatId: number, userId: number, restricted: boolean, untilDate: number): Promise<any> {
    return this.call<any>("banChatMember", {
      chat_id: chatId,
      user_id: userId,
      restricted,
      until_date: untilDate,
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

  async getChat(chatId: number): Promise<any> {
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
}
