/** Configuración del destino de captchas en supergrupos con tópicos. */
import { createRedis, type RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { hasGroupAccessLive } from "./access";
import { parseTopicId, topicContext } from "./forum";

interface TopicRecord { id: number; name: string; closed: boolean; }

/** Telegram no ofrece una lista de tópicos: se registran al recibir actividad. */
export async function trackTopic(env: RedisEnv, msg: any): Promise<void> {
  const context = topicContext(msg);
  if (!context) return;
  const rdb = createRedis(env);
  const key = `forum:topic:${context.chatId}:${context.threadId}`;
  const created = msg.forum_topic_created;
  const edited = msg.forum_topic_edited;
  if (!created && !edited && !msg.forum_topic_closed && !msg.forum_topic_reopened && await rdb.sismember(`forum:topics:${context.chatId}`, String(context.threadId))) return;
  let previous: Partial<TopicRecord> = {};
  try { previous = JSON.parse(await rdb.get(key) ?? "{}"); } catch { /* metadata corruptos */ }
  const name = String(edited?.name ?? created?.name ?? previous?.name ?? `Tópico ${context.threadId}`).slice(0, 128);
  const closed = msg.forum_topic_closed ? true : msg.forum_topic_reopened ? false : previous?.closed === true;
  await rdb.set(key, JSON.stringify({ id: context.threadId, name, closed }));
  await rdb.sadd(`forum:topics:${context.chatId}`, String(context.threadId));
}

async function knownTopicIds(env: RedisEnv, gid: number): Promise<number[]> {
  const rdb = createRedis(env);
  return (await rdb.smembers(`forum:topics:${gid}`)).map(parseTopicId).filter((id): id is number => !!id && id !== 1).sort((a, b) => a - b);
}

async function readTopic(env: RedisEnv, gid: number, id: number): Promise<TopicRecord> {
  const data = await createRedis(env).get(`forum:topic:${gid}:${id}`);
  let record: any;
  try { record = JSON.parse(data ?? "null"); } catch { /* metadata corruptos */ }
  return { id, name: String(record?.name ?? `Tópico ${id}`), closed: record?.closed === true };
}

async function showTopicMenu(env: RedisEnv, api: TelegramApi, cb: any, gid: number, page: number): Promise<void> {
  const selected = parseTopicId(await createRedis(env).get(captchaTopicKey(gid)));
  const ids = await knownTopicIds(env, gid);
  const pages = Math.max(1, Math.ceil(ids.length / 8));
  page = Math.max(0, Math.min(Number.isSafeInteger(page) ? page : 0, pages - 1));
  const topics = await Promise.all(ids.slice(page * 8, page * 8 + 8).map((id) => readTopic(env, gid, id)));
  const button = (id: string, label: string) => ({ text: `${String(selected ?? "auto") === id ? "✅ " : ""}${label}`, callback_data: `topic:set:${gid}:${id}:${page}` });
  const rows = [[button("auto", "Automático (tópico de la entrada)")], [button("1", "General")]];
  for (const topic of topics) {
    rows.push([button(String(topic.id), `${topic.closed ? "🔒 " : "🧵 "}${topic.name.slice(0, 48)}`)]);
  }
  if (pages > 1) rows.push([
    { text: "◀️", callback_data: `topics:${gid}:${Math.max(0, page - 1)}` },
    { text: `${page + 1}/${pages}`, callback_data: `topics:${gid}:${page}` },
    { text: "▶️", callback_data: `topics:${gid}:${Math.min(pages - 1, page + 1)}` },
  ]);
  rows.push([{ text: "🔄 Actualizar tópicos", callback_data: `topics:${gid}:${page}` }]);
  rows.push([{ text: "⬅️ Volver a configuración", callback_data: `settings:${gid}` }]);
  const topic = topics.find((item) => item.id === selected) ?? (selected && selected !== 1 ? await readTopic(env, gid, selected) : undefined);
  const label = selected ? (selected === 1 ? "General" : topic?.name ?? `Tópico ${selected}`) : "Automático";
  const text = `🧵 Tópicos · destino del captcha\nGrupo: ${gid}\nDestino actual: ${label}${topic?.closed ? " (cerrado)" : ""}\n\nElige dónde enviar los nuevos desafíos. En automático se usa el hilo de la entrada, o General si no hay hilo.\n\nSi falta un tópico, envía /topico dentro de él y pulsa Actualizar. Los tópicos cerrados deben abrirse antes de seleccionarlos. La configuración y las sanciones afectan al supergrupo completo.`;
  await api.editMessageText(Number(cb.message.chat.id), Number(cb.message.message_id), text, { reply_markup: { inline_keyboard: rows } });
}

export async function handleTopicCallback(env: RedisEnv, api: TelegramApi, cb: any): Promise<void> {
  const data = String(cb?.data ?? "");
  const open = data.match(/^topics:(-?\d+)(?::(\d+))?$/);
  const set = data.match(/^topic:set:(-?\d+):(auto|\d+):(\d+)$/);
  const match = open ?? set;
  if (!match || !cb?.message?.chat?.id) return;
  const gid = Number(match[1]);
  if (!(await hasGroupAccessLive(env, api, gid, Number(cb?.from?.id)))) {
    await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden configurar los tópicos.", true);
    return;
  }
  if (!(await api.getChat(gid))?.is_forum) {
    await api.answerCallbackQuery(cb.id, "ℹ️ Este supergrupo no tiene tópicos activados.", true);
    return;
  }
  if (set) {
    const id = set[2] === "auto" ? undefined : parseTopicId(set[2]);
    if (set[2] !== "auto" && !id) {
      await api.answerCallbackQuery(cb.id, "Tópico inválido.", true);
      return;
    }
    if (id && id !== 1) {
      const registered = await createRedis(env).sismember(`forum:topics:${gid}`, String(id));
      const topic = registered ? await readTopic(env, gid, id) : undefined;
      if (!topic || topic.closed) {
        await api.answerCallbackQuery(cb.id, "El tópico no está registrado o está cerrado. Envía /topico dentro del tópico abierto y actualiza el menú.", true);
        return;
      }
    }
    const rdb = createRedis(env);
    if (id) await rdb.set(captchaTopicKey(gid), String(id));
    else await rdb.del(captchaTopicKey(gid));
  }
  await api.answerCallbackQuery(cb.id, set ? "✅ Destino actualizado." : "🧵 Tópicos del supergrupo.").catch(() => null);
  await showTopicMenu(env, api, cb, gid, Number(set?.[3] ?? open?.[2] ?? 0));
}

export function captchaTopicKey(chatId: number): string {
  return `group:${chatId}:captcha_topic`;
}

export async function captchaTopicApi(env: RedisEnv, api: TelegramApi, chatId: number, message: any): Promise<TelegramApi> {
  const configured = parseTopicId(await createRedis(env).get(captchaTopicKey(chatId)));
  if (!configured) return api.forMessage(message?.message ?? message);
  return api.forMessage({ chat: { id: chatId, type: "supergroup" }, is_topic_message: true, message_thread_id: configured });
}

export async function handleTopicCommand(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const chatId = Number(msg?.chat?.id);
  if (msg?.chat?.type !== "supergroup") {
    await api.sendMessage(chatId, "ℹ️ Usa /topico dentro de un supergrupo con tópicos.");
    return;
  }
  if (!(await hasGroupAccessLive(env, api, chatId, Number(msg?.from?.id)))) {
    await api.sendMessage(chatId, "🚫 Solo administradores pueden configurar los tópicos.");
    return;
  }
  const chat = await api.getChat(chatId);
  if (!chat?.is_forum) {
    await api.sendMessage(chatId, "ℹ️ Primero activa los tópicos en la configuración del supergrupo.");
    return;
  }
  const args = String(msg?.text ?? "").trim().split(/\s+/).slice(1);
  const rdb = createRedis(env);
  const key = captchaTopicKey(chatId);
  if (!args.length) {
    const id = parseTopicId(await rdb.get(key));
    await api.sendMessage(chatId, `🧵 Captchas: ${id ? (id === 1 ? "tópico General" : `tópico ${id}`) : "tópico de la entrada; General si no hay hilo"}.\n\n/topico captcha aqui — usar este tópico\n/topico captcha general — usar General\n/topico captcha off — destino automático\n\nLa moderación y la verificación se aplican a todo el supergrupo.`);
    return;
  }
  if (args[0]?.toLowerCase() !== "captcha" || args.length !== 2) {
    await api.sendMessage(chatId, "Uso: /topico [captcha aqui|general|off]");
    return;
  }
  const action = args[1].toLowerCase();
  if (action === "off") {
    await rdb.del(key);
    await api.sendMessage(chatId, "✅ Captchas en el tópico de la entrada; General si no hay hilo.");
  } else if (action === "general" || action === "aqui" || action === "aquí") {
    const id = action === "general" ? 1 : topicContext(msg)?.threadId;
    if (!id) {
      await api.sendMessage(chatId, "ℹ️ Ejecuta el comando dentro del tópico deseado o usa /topico captcha general.");
      return;
    }
    await rdb.set(key, String(id));
    await api.sendMessage(chatId, `✅ Los nuevos captchas se enviarán a ${id === 1 ? "General" : `este tópico (${id})`}. Mantén el tópico abierto para que el bot pueda enviar los desafíos.`);
  } else {
    await api.sendMessage(chatId, "Uso: /topico captcha aqui|general|off");
  }
}
