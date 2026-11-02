/** Native /config controls backed by the same writes as the Mini App. */
import { createRedis } from "./redis";
import { TelegramApi } from "./telegram";
import { hasGroupAccessLive } from "./access";
import {
  saveSettings,
  MiniAppError,
  type MiniAppEnv,
  MINIAPP_URL,
} from "./miniapp";
import {
  parseFloodLimit,
  parseFloodMute,
  parseWhitelist,
  normalizeWhitelistEntry,
  DEFAULT_LINK_WHITELIST,
} from "./security_rules";

const pendingKey = (uid: number) => `config_input:v1:${uid}`;
const FIELDS = {
  timeout: {
    key: "kick_timeout",
    title: "Tiempo del captcha",
    prompt:
      "Escribe el tiempo exacto en segundos, entre 5 y 3600. Ejemplo: 90.",
    section: "captcha",
  },
  flood_limit: {
    key: "antiflood_limit",
    title: "Límite anti-flood",
    prompt:
      "Escribe cuántos mensajes se permiten cada 10 segundos, entre 3 y 50. Ejemplo: 15.",
    section: "flood",
  },
  flood_mute: {
    key: "antiflood_mute",
    title: "Duración del silencio",
    prompt:
      "Escribe la duración en minutos, entre 1 y 1440. También puedes usar 1,5 para 90 segundos.",
    section: "flood",
  },
  whitelist_add: {
    key: "link_whitelist",
    title: "Añadir enlaces permitidos",
    prompt:
      "Envía los dominios o enlaces que quieres añadir, uno por línea. Ejemplo: example.org o t.me/micanal.",
    section: "links",
  },
  whitelist_remove: {
    key: "link_whitelist",
    title: "Quitar enlaces permitidos",
    prompt:
      "Envía los dominios o enlaces que quieres quitar, uno por línea. Los oficiales del bot se conservan.",
    section: "links",
  },
  whitelist_replace: {
    key: "link_whitelist",
    title: "Editar lista completa",
    prompt:
      "Envía la nueva lista de enlaces extra, uno por línea. Reemplazará la lista extra actual. Los enlaces oficiales se conservan.",
    section: "links",
  },
} as const;
type Field = keyof typeof FIELDS;
const button = (text: string, callback_data: string) => ({
  text,
  callback_data,
});
function returnData(gid: number, section: string): string {
  return section === "captcha"
    ? `settings:section:${gid}:captcha`
    : section === "night"
      ? `nightmode_status:${gid}`
      : `cfg:${section}:${gid}`;
}
function returnKeyboard(gid: number, section: string) {
  return {
    inline_keyboard: [
      [button("⬅️ Volver", returnData(gid, section))],
      [
        {
          text: "📱 Abrir Mini App",
          web_app: { url: `${MINIAPP_URL}?gid=${gid}` },
        },
      ],
    ],
  };
}
async function groupName(api: TelegramApi, gid: number) {
  const chat = await api.getChat(gid).catch(() => null);
  return String(chat?.title || `Grupo ${gid}`).slice(0, 120);
}
async function showFlood(
  env: MiniAppEnv,
  api: TelegramApi,
  cb: any,
  gid: number,
) {
  const [[rawLimit, rawMute], name] = await Promise.all([
    createRedis(env).mget(
      `group:${gid}:antiflood_limit`,
      `group:${gid}:antiflood_mute`,
    ),
    groupName(api, gid),
  ]);
  const limit = parseFloodLimit(rawLimit),
    mute = parseFloodMute(rawMute);
  await api.editMessageText(
    cb.message.chat.id,
    cb.message.message_id,
    `🌊 Anti-flood · ${name}\n\nLímite: ${limit} mensajes cada 10 segundos.\nSilencio: ${mute / 60} minutos (${mute} segundos).\n\nElige un valor rápido o escribe uno exacto. Los cambios se guardan al pulsar.`,
    {
      reply_markup: {
        inline_keyboard: [
          [3, 6, 12, 20, 50].map((n) =>
            button(
              `${n === limit ? "✅ " : ""}${n} mensajes`,
              `cfg:set:${gid}:flood_limit:${n}`,
            ),
          ),
          [button("⌨️ Escribir límite", `cfg:input:${gid}:flood_limit`)],
          [1, 5, 10, 30, 60].map((n) =>
            button(
              `${n * 60 === mute ? "✅ " : ""}${n} min`,
              `cfg:set:${gid}:flood_mute:${n * 60}`,
            ),
          ),
          [button("⌨️ Escribir duración", `cfg:input:${gid}:flood_mute`)],
          [button("⬅️ Moderación", `settings:section:${gid}:moderation`)],
        ],
      },
    },
  );
}
async function showLinks(
  env: MiniAppEnv,
  api: TelegramApi,
  cb: any,
  gid: number,
  requestedPage = 0,
) {
  const [raw, name] = await Promise.all([
    createRedis(env).get(`group:${gid}:link_whitelist`),
    groupName(api, gid),
  ]);
  const entries = parseWhitelist(raw),
    pages = Math.max(1, Math.ceil(entries.length / 10));
  const page = Math.min(
    Math.max(0, Number.isSafeInteger(requestedPage) ? requestedPage : 0),
    pages - 1,
  );
  const visible = entries.slice(page * 10, (page + 1) * 10);
  const rows = [
    [
      button("➕ Añadir", `cfg:input:${gid}:whitelist_add`),
      button("➖ Quitar", `cfg:input:${gid}:whitelist_remove`),
    ],
    [button("📝 Editar lista completa", `cfg:input:${gid}:whitelist_replace`)],
  ];
  if (entries.length)
    rows.push([button("🧹 Vaciar lista extra", `cfg:clear_links:${gid}`)]);
  if (pages > 1) {
    const nav = [];
    if (page > 0)
      nav.push(button("◀️ Anterior", `cfg:links:${gid}:${page - 1}`));
    if (page + 1 < pages)
      nav.push(button("Siguiente ▶️", `cfg:links:${gid}:${page + 1}`));
    rows.push(nav);
  }
  rows.push([button("⬅️ Moderación", `settings:section:${gid}:moderation`)]);
  await api.editMessageText(
    cb.message.chat.id,
    cb.message.message_id,
    `🔗 Enlaces permitidos · ${name}\n\nExtras (${entries.length}):\n${visible.length ? visible.join("\n") : "Sin enlaces extra."}\n${pages > 1 ? `\nPágina ${page + 1} de ${pages}.\n` : ""}\nOficiales, siempre permitidos:\n${DEFAULT_LINK_WHITELIST.join(", ")}`,
    { reply_markup: { inline_keyboard: rows } },
  );
}
async function promptInput(
  env: MiniAppEnv,
  api: TelegramApi,
  cb: any,
  gid: number,
  field: Field,
) {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const name = await groupName(api, gid);
  await api.editMessageText(
    cb.message.chat.id,
    cb.message.message_id,
    `⌨️ ${FIELDS[field].title} · ${name}\n\n${FIELDS[field].prompt}\n\nPuedes cancelar con el botón o /cancel. La solicitud caduca en 15 minutos.`,
    {
      reply_markup: {
        inline_keyboard: [
          [button("✖️ Cancelar", `cfg:cancel:${gid}:${nonce}`)],
        ],
      },
    },
  );
  // A successfully delivered prompt becomes the only active settings conversation.
  await createRedis(env).transaction([
    [
      "SETEX",
      pendingKey(cb.from.id),
      900,
      JSON.stringify({ gid, field, nonce }),
    ],
    ["DEL", `nightmode_pending:${cb.from.id}`],
  ]);
}
export async function handleAdvancedSettingsCallback(
  env: MiniAppEnv,
  api: TelegramApi,
  cb: any,
): Promise<void> {
  const m = String(cb?.data || "").match(
    /^cfg:([a-z_]+):(-[1-9]\d*)(?::([^:]+))?(?::([^:]+))?$/,
  );
  if (!m || !Number.isSafeInteger(Number(m[2]))) {
    await api.answerCallbackQuery(cb.id, "Opción inválida.", true);
    return;
  }
  const [, action, rawGid, argument, value] = m,
    gid = Number(rawGid),
    uid = Number(cb.from?.id);
  if (cb.message?.chat?.type !== "private" || cb.message.chat.id !== uid) {
    await api.answerCallbackQuery(
      cb.id,
      "Abre /config en mi chat privado.",
      true,
    );
    return;
  }
  if (!(await hasGroupAccessLive(env, api, gid, uid, { cache: false }))) {
    await api.answerCallbackQuery(
      cb.id,
      "🚫 Solo los administradores actuales pueden cambiar esto.",
      true,
    );
    return;
  }
  await api.answerCallbackQuery(cb.id, "⚙️ Configuración.").catch(() => null);
  try {
    if (action === "flood") {
      await showFlood(env, api, cb, gid);
      return;
    }
    if (action === "links") {
      await showLinks(env, api, cb, gid, Number(argument || 0));
      return;
    }
    if (action === "input" && Object.hasOwn(FIELDS, argument || "")) {
      await promptInput(env, api, cb, gid, argument as Field);
      return;
    }
    if (action === "cancel") {
      const key = pendingKey(uid),
        raw = await createRedis(env).get(key);
      let pending: any;
      try {
        pending = JSON.parse(raw || "null");
      } catch {
        /* invalid */
      }
      if (pending?.gid !== gid || pending?.nonce !== argument) {
        await api.sendMessage(
          uid,
          "Esta solicitud ya no está activa. Usa /config para continuar.",
        );
        return;
      }
      await createRedis(env).compareDelete(key, raw!);
      await api.editMessageText(
        uid,
        cb.message.message_id,
        "✅ Entrada cancelada.",
        {
          reply_markup: returnKeyboard(
            gid,
            FIELDS[pending.field as Field]?.section || "flood",
          ),
        },
      );
      return;
    }
    if (
      action === "set" &&
      ["flood_limit", "flood_mute"].includes(argument) &&
      /^\d+$/.test(value || "")
    ) {
      const field = FIELDS[argument as "flood_limit" | "flood_mute"];
      await saveSettings(env, api, gid, uid, { [field.key]: Number(value) });
      await showFlood(env, api, cb, gid);
      return;
    }
    if (action === "clear_links") {
      await api.editMessageText(
        uid,
        cb.message.message_id,
        "¿Vaciar los enlaces extra permitidos? Los enlaces oficiales del bot seguirán permitidos.",
        {
          reply_markup: {
            inline_keyboard: [
              [button("🧹 Sí, vaciar extras", `cfg:confirm_clear:${gid}`)],
              [button("⬅️ Conservar lista", `cfg:links:${gid}`)],
            ],
          },
        },
      );
      return;
    }
    if (action === "confirm_clear") {
      await saveSettings(env, api, gid, uid, { link_whitelist: [] });
      await showLinks(env, api, cb, gid);
      return;
    }
    if (action === "night_off") {
      await saveSettings(env, api, gid, uid, { nightmode: { mode: "off" } });
      const rdb = createRedis(env),
        key = `nightmode_pending:${uid}`;
      try {
        if (Number(JSON.parse((await rdb.get(key)) || "null")?.chat_id) === gid)
          await rdb.del(key);
      } catch {
        /* no pending configuration */
      }
      await api.editMessageText(
        uid,
        cb.message.message_id,
        "⏸ Modo nocturno desactivado. Si el grupo estaba cerrado, el bot restaurará los permisos guardados en los próximos ciclos de tareas.",
        { reply_markup: returnKeyboard(gid, "night") },
      );
      return;
    }
    await api.sendMessage(uid, "Opción no válida. Abre /config otra vez.");
  } catch (error) {
    await api.sendMessage(
      uid,
      error instanceof MiniAppError
        ? error.message
        : "No se pudo completar el cambio. Actualiza el menú e inténtalo nuevamente.",
    );
  }
}

export async function handleAdvancedSettingsInput(
  env: MiniAppEnv,
  api: TelegramApi,
  msg: any,
): Promise<boolean> {
  if (
    msg?.chat?.type !== "private" ||
    Number(msg.chat.id) !== Number(msg.from?.id) ||
    typeof msg.text !== "string"
  )
    return false;
  if (msg.text.startsWith("/") && !/^\/cancel(?:@\S+)?\s*$/i.test(msg.text))
    return false;
  const uid = Number(msg.from.id),
    rdb = createRedis(env),
    key = pendingKey(uid),
    raw = await rdb.get(key);
  if (!raw) return false;
  let pending: any;
  try {
    pending = JSON.parse(raw);
  } catch {
    /* invalid legacy state */
  }
  if (
    !pending ||
    !Object.hasOwn(FIELDS, pending.field) ||
    !Number.isSafeInteger(pending.gid) ||
    pending.gid >= 0
  ) {
    await rdb.compareDelete(key, raw);
    return false;
  }
  const field = pending.field as Field,
    spec = FIELDS[field],
    gid = pending.gid;
  if (msg.text.startsWith("/")) {
    await rdb.compareDelete(key, raw);
    await api.sendMessage(uid, "✅ Entrada cancelada.", {
      reply_markup: returnKeyboard(gid, spec.section),
    });
    return true;
  }
  try {
    const text = msg.text.trim();
    let next: any;
    if (field.startsWith("whitelist_")) {
      if (!text || text.length > 26000)
        throw new MiniAppError(
          "Envía una lista de dominios válida, uno por línea.",
        );
      const lines = text
        .split(/[\n,]+/)
        .map((entry: string) => entry.trim())
        .filter(Boolean);
      const normalized = lines.map(normalizeWhitelistEntry);
      if (
        lines.length > 100 ||
        normalized.some((entry: string | null) => !entry)
      )
        throw new MiniAppError(
          "Hay enlaces inválidos. Usa dominios como example.org o enlaces como t.me/micanal; máximo 100.",
        );
      const entries = normalized as string[];
      const current = parseWhitelist(
        await rdb.get(`group:${gid}:link_whitelist`),
      );
      if (
        field === "whitelist_remove" &&
        entries.some((entry) =>
          DEFAULT_LINK_WHITELIST.some(
            (value) => normalizeWhitelistEntry(value) === entry,
          ),
        )
      )
        throw new MiniAppError(
          "Los enlaces oficiales del bot no se pueden quitar.",
        );
      next =
        field === "whitelist_replace"
          ? entries
          : field === "whitelist_add"
            ? [...new Set([...current, ...entries])]
            : current.filter((entry) => !entries.includes(entry));
    } else {
      if (!/^\d+(?:[.,]\d+)?$/.test(text))
        throw new MiniAppError("Escribe un número válido. " + spec.prompt);
      const n = Number(text.replace(",", "."));
      if (field === "flood_mute" && (n < 1 || n > 1440))
        throw new MiniAppError(
          "La duración debe estar entre 1 y 1440 minutos.",
        );
      next = field === "flood_mute" ? Math.round(n * 60) : n;
    }
    await saveSettings(env, api, gid, uid, { [spec.key]: next });
    await rdb.compareDelete(key, raw);
    await api.sendMessage(
      uid,
      `✅ ${spec.title}: ${Array.isArray(next) ? `${next.length} enlaces extra` : field === "flood_mute" ? `${next / 60} minutos` : next}.\nEl cambio también está disponible en la Mini App.`,
      { reply_markup: returnKeyboard(gid, spec.section) },
    );
  } catch (error) {
    if (error instanceof MiniAppError && error.status === 403)
      await rdb.compareDelete(key, raw);
    await api.sendMessage(
      uid,
      error instanceof MiniAppError
        ? error.message
        : "No se pudo guardar. Inténtalo nuevamente o usa /cancel.",
    );
  }
  return true;
}
