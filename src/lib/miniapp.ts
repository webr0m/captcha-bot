/** Telegram Mini App: signed authentication and the bot's existing settings. */
import { createRedis, type RedisEnv, type RedisCommand } from "./redis";
import { TelegramApi } from "./telegram";
import { hasGroupAccessLive } from "./access";
import {
  parseWhitelist,
  DEFAULT_LINK_WHITELIST,
  isFeatureEnabled,
  parseFloodLimit,
  parseFloodMute,
} from "./security_rules";
import { getCoordinates, getTimezoneOffset } from "./nightmode";
import { LANG_LABELS, SUPPORTED_LANGS } from "./block_lang";
import { ADMIN_INDEX_READY, adminGroupsKey } from "./group_registry";
import {
  DEFAULT_CAPTCHA_MODE,
  captchaEnabledByDefault,
} from "./group_defaults";
import { MODES, ACTIONS, ACTIONS_2 } from "./settings_menu";
import { STAT_NAMES } from "./stats";
import { showGroupChooser } from "./settings_groups";
import { taskToString } from "./task_format";

export type MiniAppEnv = RedisEnv & {
  BOT_TOKEN: string;
  TELEGRAM_API_BASE_URL?: string;
};
export const MINIAPP_URL = "https://verify.webrom.cc/miniapp";
export const MINIAPP_PAGE_SIZE = 5;
export class MiniAppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export interface InitDataResult {
  ok: boolean;
  userId: number;
  firstName: string;
  username?: string;
}

export async function validateInitData(
  initData: string,
  botToken: string,
): Promise<InitDataResult> {
  const invalid = { ok: false, userId: 0, firstName: "" };
  try {
    if (!initData || initData.length > 16384 || !botToken) return invalid;
    const params = new URLSearchParams(initData);
    const entries: Array<[string, string]> = [];
    params.forEach((value, key) => entries.push([key, value]));
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      return invalid;
    const hash = params.get("hash") ?? "";
    if (!/^[a-f0-9]{64}$/i.test(hash)) return invalid;
    const authDate = Number(params.get("auth_date"));
    const now = Date.now() / 1000;
    if (
      !Number.isSafeInteger(authDate) ||
      authDate <= 0 ||
      now - authDate > 3600 ||
      authDate - now > 30
    )
      return invalid;
    // URLSearchParams already decoded the JSON once. Never decode it again.
    const data = entries
      .filter(([key]) => key !== "hash")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const encoder = new TextEncoder();
    const algorithm = { name: "HMAC", hash: "SHA-256" };
    const root = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      algorithm,
      false,
      ["sign"],
    );
    const secret = await crypto.subtle.sign(
      "HMAC",
      root,
      encoder.encode(botToken),
    );
    const key = await crypto.subtle.importKey("raw", secret, algorithm, false, [
      "verify",
    ]);
    const signature = Uint8Array.from(hash.match(/../g)!, (byte) =>
      parseInt(byte, 16),
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        encoder.encode(data),
      ))
    )
      return invalid;
    const user = JSON.parse(params.get("user") ?? "null");
    if (!Number.isSafeInteger(user?.id) || user.id <= 0) return invalid;
    return {
      ok: true,
      userId: user.id,
      firstName: String(user.first_name ?? ""),
      username: user.username ? String(user.username) : undefined,
    };
  } catch {
    return invalid;
  }
}

export async function listAdminGroups(
  env: MiniAppEnv,
  api: TelegramApi,
  userId: number,
  page = 0,
) {
  const rdb = createRedis(env);
  const [ready, indexed] = await rdb.pipeline([
    ["GET", ADMIN_INDEX_READY],
    ["SMEMBERS", adminGroupsKey(userId)],
  ]);
  const keys =
    ready === "1"
      ? (indexed as string[]).map((gid) => `group_known:${gid}`)
      : await rdb.keys("group_known:*");
  const alive = ready === "1" && keys.length ? await rdb.mget(...keys) : null;
  const ids = [
    ...new Set(
      keys
        .filter(
          (key, i) =>
            /^group_known:-[1-9]\d*$/.test(key) &&
            (!alive || alive[i] !== null),
        )
        .map((key) => Number(key.slice(12)))
        .filter(Number.isSafeInteger),
    ),
  ].sort((a, b) => b - a);
  const pages = Math.max(1, Math.ceil(ids.length / MINIAPP_PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const groups = (
    await Promise.all(
      ids
        .slice(page * MINIAPP_PAGE_SIZE, (page + 1) * MINIAPP_PAGE_SIZE)
        .map(async (id) => {
          if (
            !(await hasGroupAccessLive(env, api, id, userId, { cache: false }))
          )
            return null;
          const chat = await api.getChat(id).catch(() => null);
          return { id, title: String(chat?.title || `Grupo ${id}`) };
        }),
    )
  ).filter((group) => group !== null);
  return { groups, page, pages };
}

const SETTING_KEYS = [
  "captcha_enabled",
  "captcha_mode",
  "captcha_action",
  "captcha_action_2",
  "kick_timeout",
  "adm_report",
  "delete_bot_messages",
  "delete_service_messages",
  "silent_mode",
  "cas_enabled",
  "antiflood_enabled",
  "antiflood_limit",
  "antiflood_mute",
  "antilink_enabled",
  "link_whitelist",
  "lang",
] as const;
export async function readSettings(
  env: MiniAppEnv,
  gid: number,
): Promise<Record<string, any>> {
  const rdb = createRedis(env);
  const [values, blockedLangs] = await Promise.all([
    rdb.mget(
      ...SETTING_KEYS.map((key) => `group:${gid}:${key}`),
      `nightmode:${gid}`,
      `nightmode:active:${gid}`,
    ),
    rdb.smembers(`group:${gid}:blocked_langs`),
  ]);
  const raw = Object.fromEntries(
    SETTING_KEYS.map((key, i) => [key, values[i]]),
  );
  let night: any = {};
  try {
    night = JSON.parse(values[SETTING_KEYS.length] ?? "{}") || {};
  } catch {
    /* invalid legacy data */
  }
  return {
    captcha_enabled: captchaEnabledByDefault(raw.captcha_enabled),
    captcha_mode: raw.captcha_mode || DEFAULT_CAPTCHA_MODE,
    captcha_action: raw.captcha_action || "kick",
    captcha_action_2: raw.captcha_action_2 || "mute",
    kick_timeout: Math.max(5, Math.min(3600, Number(raw.kick_timeout) || 60)),
    adm_report: raw.adm_report === "true",
    delete_bot_messages:
      raw.delete_bot_messages == null || raw.delete_bot_messages === "true",
    delete_service_messages:
      raw.delete_service_messages == null ||
      raw.delete_service_messages === "true",
    silent_mode: raw.silent_mode === "true",
    cas_enabled: isFeatureEnabled(raw.cas_enabled),
    antiflood_enabled: isFeatureEnabled(raw.antiflood_enabled),
    antiflood_limit: parseFloodLimit(raw.antiflood_limit),
    antiflood_mute: parseFloodMute(raw.antiflood_mute),
    antilink_enabled: isFeatureEnabled(raw.antilink_enabled),
    link_whitelist: parseWhitelist(raw.link_whitelist),
    default_link_whitelist: DEFAULT_LINK_WHITELIST,
    lang: raw.lang || "es",
    blocked_langs: blockedLangs,
    supported_langs: SUPPORTED_LANGS,
    lang_labels: LANG_LABELS,
    nightmode: {
      mode: night.mode || "off",
      city: night.city || "",
      start: night.start || "",
      stop: night.stop || "",
      tz_offset: night.tz_offset ?? null,
      active: values[SETTING_KEYS.length + 1] === "1",
    },
  };
}

const BOOL_KEYS = [
  "captcha_enabled",
  "adm_report",
  "delete_bot_messages",
  "delete_service_messages",
  "silent_mode",
  "cas_enabled",
  "antiflood_enabled",
  "antilink_enabled",
];
function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export async function saveSettings(
  env: MiniAppEnv,
  api: TelegramApi,
  gid: number,
  userId: number,
  changes: Record<string, any>,
) {
  if (!(await hasGroupAccessLive(env, api, gid, userId, { cache: false })))
    throw new MiniAppError("No eres administrador del grupo.", 403);
  if (!object(changes))
    throw new MiniAppError("Los cambios deben ser un objeto.");
  const allowed = new Set([...SETTING_KEYS, "blocked_langs", "nightmode"]);
  if (Object.keys(changes).some((key) => !allowed.has(key as any)))
    throw new MiniAppError("Opción desconocida.");
  const rdb = createRedis(env);
  const values: Record<string, string> = {};
  const commands: RedisCommand[] = [];
  const assign = (key: string, value: string) => {
    values[`group:${gid}:${key}`] = value;
  };
  // Validate everything before changing any setting.
  for (const key of BOOL_KEYS)
    if (key in changes) {
      if (typeof changes[key] !== "boolean")
        throw new MiniAppError(`Valor inválido: ${key}.`);
      assign(key, String(changes[key]));
    }
  for (const [key, options] of Object.entries({
    captcha_mode: Object.keys(MODES),
    captcha_action: Object.keys(ACTIONS),
    captcha_action_2: Object.keys(ACTIONS_2),
    lang: SUPPORTED_LANGS,
  })) {
    if (key in changes) {
      if (!options.includes(changes[key]))
        throw new MiniAppError(`Valor inválido: ${key}.`);
      assign(key, changes[key]);
    }
  }
  for (const [key, [min, max]] of Object.entries({
    kick_timeout: [5, 3600],
    antiflood_limit: [3, 50],
    antiflood_mute: [60, 86400],
  })) {
    if (key in changes) {
      const n = changes[key];
      if (!Number.isSafeInteger(n) || n < min || n > max)
        throw new MiniAppError(`${key}: usa un entero entre ${min} y ${max}.`);
      assign(key, String(n));
    }
  }
  if ("link_whitelist" in changes) {
    const entries = changes.link_whitelist;
    if (
      !Array.isArray(entries) ||
      entries.length > 100 ||
      entries.some((entry) => typeof entry !== "string" || entry.length > 255)
    )
      throw new MiniAppError("Lista de enlaces inválida.");
    const cleaned = parseWhitelist(entries.join(","));
    // An empty extra whitelist is stored explicitly; defaults remain in runtime.
    assign("link_whitelist", cleaned.join(","));
  }
  if ("blocked_langs" in changes) {
    if (
      !Array.isArray(changes.blocked_langs) ||
      changes.blocked_langs.length > SUPPORTED_LANGS.length ||
      changes.blocked_langs.some((code: any) => !SUPPORTED_LANGS.includes(code))
    )
      throw new MiniAppError("Idiomas bloqueados inválidos.");
    commands.push(["DEL", `group:${gid}:blocked_langs`]);
    for (const code of new Set<string>(changes.blocked_langs))
      commands.push(["SADD", `group:${gid}:blocked_langs`, code]);
  }
  if ("nightmode" in changes) {
    const nm = changes.nightmode;
    if (!object(nm) || !["off", "auto", "manual"].includes(nm.mode))
      throw new MiniAppError("Modo nocturno inválido.");
    if (nm.mode === "off") {
      const [active, snapshot] = await rdb.mget(
        `nightmode:active:${gid}`,
        `lockdown:permissions:${gid}`,
      );
      if (active === "1" || snapshot) {
        commands.push([
          "SADD",
          "tasks",
          taskToString({
            type: "unlock",
            chatId: gid,
            param: 0,
            runAt: Math.floor(Date.now() / 1000) + 2,
          }),
        ]);
      }
      // The permission snapshot survives until the queued unlock succeeds.
      values[`nightmode:active:${gid}`] = "0";
      values[`nightmode:${gid}`] = JSON.stringify({ mode: "off" });
    } else {
      if (
        typeof nm.city !== "string" ||
        !nm.city.trim() ||
        nm.city.length > 200
      )
        throw new MiniAppError("Indica ciudad y país.");
      if (
        nm.mode === "manual" &&
        (![nm.start, nm.stop].every(
          (time) =>
            typeof time === "string" &&
            /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time),
        ) ||
          nm.start === nm.stop)
      )
        throw new MiniAppError("Usa horas HH:MM válidas y distintas.");
      const city = nm.city.trim();
      let previous: any = {};
      try {
        previous =
          JSON.parse((await rdb.get(`nightmode:${gid}`)) ?? "{}") || {};
      } catch {
        /* legacy */
      }
      const coords =
        previous.city === city &&
        Number.isFinite(previous.lat) &&
        Number.isFinite(previous.lon)
          ? { lat: previous.lat, lon: previous.lon }
          : await getCoordinates(env, city);
      if (!coords)
        throw new MiniAppError(
          "No se pudo localizar la ciudad. Revisa el nombre o inténtalo nuevamente.",
        );
      const tz =
        previous.city === city && Number.isFinite(previous.tz_offset)
          ? { offset: previous.tz_offset, time: previous.time }
          : await getTimezoneOffset(coords.lat, coords.lon);
      if (nm.mode === "manual" && !tz)
        throw new MiniAppError(
          "No se pudo obtener la zona horaria. Inténtalo nuevamente.",
        );
      values[`nightmode:${gid}`] = JSON.stringify({
        mode: nm.mode,
        city,
        ...coords,
        tz_offset: tz?.offset,
        time: tz?.time,
        ...(nm.mode === "manual" ? { start: nm.start, stop: nm.stop } : {}),
      });
    }
    // Let cron perform the existing permission transitions; never erase state or
    // snapshots here. A pending lockdown also checks the current nightmode state.
  }
  if (Object.keys(values).length)
    commands.unshift(["MSET", ...Object.entries(values).flat()]);
  await rdb.transaction(commands);
  return { ok: true };
}

export async function readStats(
  env: MiniAppEnv,
  api: TelegramApi,
  gid: number,
) {
  const rdb = createRedis(env);
  const [members, result] = await Promise.all([
    api.getChatMemberCount(gid).catch(() => null),
    rdb.pipeline([
      ["SCARD", `known_users:${gid}`],
      ["MGET", ...STAT_NAMES.map((stat) => `stats:${gid}:${stat}`)],
    ]),
  ]);
  return {
    members,
    known_users: Number(result[0]) || 0,
    ...Object.fromEntries(
      STAT_NAMES.map((name, i) => [name, Number(result[1][i]) || 0]),
    ),
  };
}

export async function handleMiniAppCallback(
  env: MiniAppEnv,
  api: TelegramApi,
  cb: any,
): Promise<void> {
  await api.answerCallbackQuery(cb.id, "").catch(() => null);
  if (cb.message?.chat?.type !== "private") return;
  await showGroupChooser(env, api, {
    chatId: Number(cb.message.chat.id),
    userId: Number(cb.from.id),
    messageId: Number(cb.message.message_id),
  });
}

export async function handleMiniAppCommand(
  env: MiniAppEnv,
  api: TelegramApi,
  msg: any,
  gid?: number,
): Promise<void> {
  const chatId = Number(msg?.chat?.id ?? 0);
  const userId = Number(msg?.from?.id ?? 0);
  if (msg?.chat?.type === "private") {
    if (
      gid &&
      !(await hasGroupAccessLive(env, api, gid, userId, { cache: false }))
    ) {
      await api.sendMessage(
        chatId,
        "🚫 Solo los administradores actuales pueden configurar este grupo.",
      );
      return;
    }
    await api.sendMessage(
      chatId,
      "📱 Abre la Mini App para configurar tus grupos.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "📱 Abrir Mini App",
                web_app: { url: MINIAPP_URL + (gid ? `?gid=${gid}` : "") },
              },
            ],
            [
              {
                text: "⚙️ Configurar por /config",
                callback_data: "config_open",
              },
            ],
          ],
        },
      },
    );
    return;
  }
  if (!(await hasGroupAccessLive(env, api, chatId, userId, { cache: false }))) {
    await api.sendMessage(
      chatId,
      "🚫 Solo administradores pueden configurar el grupo.",
    );
    return;
  }
  const me = await api.getMe();
  await api.sendMessage(
    chatId,
    "Abre el bot en privado y pulsa Abrir Mini App.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📱 Abrir en privado",
              url: `https://t.me/${me.username}?start=miniapp_${chatId}`,
            },
          ],
        ],
      },
    },
  );
}
