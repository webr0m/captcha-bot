/** Enrutamiento de respuestas de foros. Nunca reutilizar un hilo en otro chat. */
export interface TopicContext {
  chatId: number;
  threadId: number;
}

export function topicContext(message: any): TopicContext | undefined {
  if (message?.chat?.type !== "supergroup" || message?.is_topic_message !== true) return;
  const chatId = Number(message.chat.id);
  const threadId = Number(message.message_thread_id);
  if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(threadId) || threadId < 1) return;
  return { chatId, threadId };
}

export function topicParameters(context: TopicContext | undefined, chatId: unknown): Record<string, number> {
  // General se envía sin message_thread_id (1 es su identificador reservado).
  return context && context.chatId === Number(chatId) && context.threadId !== 1
    ? { message_thread_id: context.threadId }
    : {};
}

export function parseTopicId(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
