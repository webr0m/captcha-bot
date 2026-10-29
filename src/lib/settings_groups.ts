/** Lista paginada: el coste de cada update no depende del total de grupos. */
import { createRedis, type RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { hasGroupAccessLive } from "./access";
import { autoTranslate } from "./translator";
import { ADMIN_INDEX_READY, adminGroupsKey } from "./group_registry";

export const GROUPS_PAGE_SIZE = 5;

export async function showGroupChooser(
  env: RedisEnv,
  api: TelegramApi,
  target: { chatId: number; userId: number; messageId?: number },
  requestedPage = 0,
): Promise<void> {
  const rdb = createRedis(env);
  const indexed = await rdb.get(ADMIN_INDEX_READY) === "1";
  const keys = indexed
    ? (await rdb.smembers(adminGroupsKey(target.userId))).map((gid) => `group_known:${gid}`)
    : await rdb.keys("group_known:*");
  // Remove groups the bot has already left, even if an old index entry remains.
  const alive = indexed && keys.length ? await rdb.mget(...keys) : undefined;
  const groups = [...new Set(keys
    .filter((_, index) => !alive || alive[index] !== null)
    .filter((key) => /^group_known:-[1-9]\d*$/.test(key))
    .map((key) => Number(key.slice("group_known:".length)))
    .filter(Number.isSafeInteger))].sort((a, b) => b - a);
  const pages = Math.max(1, Math.ceil(groups.length / GROUPS_PAGE_SIZE));
  const page = Math.min(Math.max(0, Number.isSafeInteger(requestedPage) ? requestedPage : 0), pages - 1);
  const candidates = groups.slice(page * GROUPS_PAGE_SIZE, (page + 1) * GROUPS_PAGE_SIZE);

  // Máximo 5 getChatMember y 5 getChat. Las autorizaciones de cambios siguen
  // comprobándose en vivo al abrir o modificar la configuración de cada grupo.
  const rows = (await Promise.all(candidates.map(async (gid) => {
    if (!(await hasGroupAccessLive(env, api, gid, target.userId, { cache: false }))) return null;
    let title = `Grupo ${gid}`;
    try {
      const chat = await api.getChat(gid);
      const name = String(chat?.title ?? chat?.result?.title ?? "").trim();
      if (name) title = name;
    } catch { /* El título es opcional; no impide abrir la configuración. */ }
    return [{ text: `⚙️ ${Array.from(title).slice(0, 60).join("")}`, callback_data: `settings:${gid}` }];
  }))).filter((row): row is Array<{ text: string; callback_data: string }> => row !== null);
  const accessible = rows.length;

  if (pages > 1) {
    const navigation = [];
    if (page > 0) navigation.push({ text: "◀️ Anterior", callback_data: `settings:groups:${page - 1}` });
    navigation.push({ text: `🔄 ${page + 1}/${pages}`, callback_data: `settings:groups:${page}` });
    if (page + 1 < pages) navigation.push({ text: "Siguiente ▶️", callback_data: `settings:groups:${page + 1}` });
    rows.push(navigation);
  } else {
    rows.push([{ text: "🔄 Actualizar grupos", callback_data: "settings:groups:0" }]);
  }

  const lang = await rdb.get(`group:${target.userId}:lang`) ?? "es";
  const message = accessible
    ? "⚙️ Elige un grupo para configurar:"
    : groups.length && pages > 1
      ? "ℹ️ No encontré grupos que puedas configurar en esta página. Usa las flechas para revisar las demás."
      : "🤖 No encontré grupos que puedas configurar. Añade el bot como administrador a tu grupo, envía un mensaje allí y pulsa Actualizar grupos.";
  const text = await autoTranslate(env, lang, message) + (pages > 1 ? `\n\nPágina ${page + 1} de ${pages}` : "");
  const extra = { reply_markup: { inline_keyboard: rows } };
  if (target.messageId) await api.editMessageText(target.chatId, target.messageId, text, extra);
  else await api.sendMessage(target.chatId, text, extra);
  console.info("config_groups_response", { page: page + 1, pages, checked: candidates.length, visible: accessible, delivery: target.messageId ? "edit" : "send" });
}
