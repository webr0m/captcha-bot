/**
 * Comandos y callbacks de estadísticas (/stats y stats:<gid>).
 * Se separa de `stats.ts` para que los contadores no dependan de la cola de tareas.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { addTask } from "./tasks";
import { hasGroupAccessLive } from "./access";
import { buildGlobalStatsText, buildGroupStatsText } from "./stats";

type EnvWithBot = RedisEnv & { BOT_TOKEN: string };

const DEV_USER_ID = 180791241;

async function sendTemporary(env: EnvWithBot, api: TelegramApi, chatId: number, text: string, seconds: number): Promise<void> {
  const sent = await api.sendMessage(chatId, text).catch(() => null);
  const msgId = Number((sent as any)?.message_id ?? 0);
  if (!msgId) return;
  const now = Math.floor(Date.now() / 1000);
  await addTask(env, { type: "del", chatId, param: msgId, runAt: now + seconds });
}

async function listAccessibleGroups(env: EnvWithBot, api: TelegramApi, userId: number): Promise<number[]> {
  const rdb = createRedis(env);
  const keys = await rdb.keys("group_known:*").catch(() => []);
  const groups: number[] = [];
  for (const key of keys) {
    const raw = key.replace(/^group_known:/, "");
    if (!/^-?\d+$/.test(raw)) continue;
    const gid = Number(raw);
    if (await hasGroupAccessLive(env, api, gid, userId)) groups.push(gid);
    if (groups.length >= 8) break;
  }
  return groups;
}

export async function handleStatsCommand(env: EnvWithBot, api: TelegramApi, msg: any): Promise<void> {
  const chatId = Number(msg?.chat?.id ?? 0);
  const userId = Number(msg?.from?.id ?? 0);
  const chatType = msg?.chat?.type;
  if (!chatId || !userId) return;

  if (chatType === "group" || chatType === "supergroup") {
    if (!(await hasGroupAccessLive(env, api, chatId, userId))) {
      await sendTemporary(env, api, chatId, "🚫 Solo administradores pueden ver las estadísticas.", 10);
      return;
    }
    const text = await buildGroupStatsText(env, api, chatId);
    const rdb = createRedis(env);
    const delRaw = await rdb.get(`group:${chatId}:delete_bot_messages`);
    const seconds = delRaw === "false" ? 0 : 90;
    if (seconds > 0) await sendTemporary(env, api, chatId, text, seconds);
    else await api.sendMessage(chatId, text);
    return;
  }

  if (chatType !== "private") return;

  if (userId === DEV_USER_ID) {
    await api.sendMessage(chatId, await buildGlobalStatsText(env));
    return;
  }

  const groups = await listAccessibleGroups(env, api, userId);
  if (!groups.length) {
    await api.sendMessage(chatId, "📊 No administras ningún grupo conocido. Usa /config para ver tus grupos.");
    return;
  }
  const kb = { inline_keyboard: groups.map((gid) => [{ text: `📊 ${gid}`, callback_data: `stats:${gid}` }]) };
  await api.sendMessage(chatId, "📊 Elige un grupo para ver sus estadísticas:", { reply_markup: kb });
}

export async function handleStatsCallback(env: EnvWithBot, api: TelegramApi, cb: any): Promise<void> {
  const data = String(cb?.data ?? "");
  const m = data.match(/^stats:(-?\d+)$/);
  if (!m) return;
  const gid = Number(m[1]);
  const userId = Number(cb?.from?.id ?? 0);
  const targetChatId = Number(cb?.message?.chat?.id ?? 0);
  if (!targetChatId) return;

  if (!(await hasGroupAccessLive(env, api, gid, userId))) {
    await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden ver estas estadísticas.", true).catch(() => null);
    return;
  }

  const text = await buildGroupStatsText(env, api, gid);
  await api.sendMessage(targetChatId, text).catch(() => null);
  await api.answerCallbackQuery(cb.id, "📊 Estadísticas enviadas.").catch(() => null);
}
