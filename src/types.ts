/**
 * Tipos base de Telegram adaptados para el Worker (migración desde telegram-bot-lua).
 * Se usan tipos parciales/laxos donde el API de Telegram anida objetos.
 */

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat?: TelegramChat;
  from?: TelegramUser;
  new_chat_member?: TelegramUser;
  left_chat_member?: TelegramUser;
  text?: string;
  entities?: Array<{ type?: string; offset?: number; length?: number }>;
}

export interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  data?: string;
  message?: TelegramMessage;
  inline_message_id?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  inline_query?: unknown;
  chat_join_request?: unknown;
  my_chat_member?: unknown;
  chat_member?: unknown;
  message_reaction?: unknown;
}

export interface TelegramOkResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}
