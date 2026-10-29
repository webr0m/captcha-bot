/**
 * Módulo nightmode — detección de horario nocturno (auto por ciudad / manual por franja horaria).
 * Portado desde `bot/modules/nightmode.lua`.
 *
 * - Auto: geolocalización (geocode.maps.co) -> amanecer/atardecer (sunrise-sunset.org) -> noche.
 * - Manual: franja horaria local (HH:MM -> HH:MM) con offset de zona horaria (geonames).
 * - El check se ejecuta desde el cron cada minuto; las coordenadas y los horarios
 *   solares se cachean para no llamar a APIs externas en cada ejecución.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import { addTask } from "./tasks";
import * as captcha from "./captcha";

const GEONAMES_USER = "webrom";
const GEO_TTL_SEC = 30 * 24 * 3600;
const SUN_TTL_SEC = 6 * 3600;

function parseUtc(str: string): number {
  const m = String(str ?? "").match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Math.floor(ms / 1000);
}

function validCoords(lat: any, lon: any): { lat: number; lon: number } | null {
  const a = Number(lat);
  const b = Number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < -90 || a > 90 || b < -180 || b > 180) return null;
  return { lat: a, lon: b };
}

async function getCoordinates(env: RedisEnv, city: string): Promise<{ lat: number; lon: number } | null> {
  const rdb = createRedis(env);
  const cacheKey = `nightmode:geo:${String(city).trim().toLowerCase()}`;
  const cached = await rdb.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      const coords = validCoords(parsed?.lat, parsed?.lon);
      if (coords) return coords;
    } catch { /* cache corrupta */ }
  }

  try {
    const encoded = encodeURIComponent(String(city ?? "").trim());
    const apiKey = (env as RedisEnv & { GEOCODE_API_KEY?: string }).GEOCODE_API_KEY?.trim();
    if (!apiKey) return null;
    const url = `https://geocode.maps.co/search?q=${encoded}&api_key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const json = (await res.json().catch(() => null)) as any;
    // geocode.maps.co devuelve un array en la raíz; algunas variantes { results: [] }.
    const results = Array.isArray(json) ? json : json?.results;
    if (!Array.isArray(results)) return null;

    const allowed = ["city", "town", "municipality", "village", "country", "administrative"];
    for (const result of results) {
      const resultType = String(result?.type ?? "");
      if (!allowed.includes(resultType)) continue;
      const coords = validCoords(result?.lat, result?.lon);
      if (!coords) continue;
      await rdb.setex(cacheKey, GEO_TTL_SEC, JSON.stringify(coords));
      return coords;
    }
  } catch { /* ignore */ }
  return null;
}

async function getTimezoneOffset(lat: number, lon: number): Promise<{ offset: number; time: string } | null> {
  try {
    const url = `https://api.geonames.org/timezoneJSON?lat=${lat}&lng=${lon}&username=${GEONAMES_USER}`;
    const res = await fetch(url);
    const json = (await res.json().catch(() => null)) as any;
    if (json?.gmtOffset !== undefined && json?.gmtOffset !== null && json?.time) {
      return { offset: Number(json.gmtOffset), time: String(json.time) };
    }
  } catch { /* ignore */ }
  return null;
}

function utcDayKey(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 10);
}

async function getSunTimes(env: RedisEnv, lat: number, lon: number, nowSec: number): Promise<{ sunrise: number; sunset: number } | null> {
  const rdb = createRedis(env);
  const cacheKey = `nightmode:sun:${lat.toFixed(3)}:${lon.toFixed(3)}:${utcDayKey(nowSec)}`;
  const cached = await rdb.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed?.sunrise && parsed?.sunset) {
        return { sunrise: Number(parsed.sunrise), sunset: Number(parsed.sunset) };
      }
    } catch { /* cache corrupta */ }
  }

  try {
    const url = `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&formatted=0`;
    const res = await fetch(url);
    const json = (await res.json().catch(() => null)) as any;
    if (json?.status === "OK" && json?.results) {
      const sunrise = parseUtc(json.results.sunrise);
      const sunset = parseUtc(json.results.sunset);
      if (sunrise && sunset) {
        await rdb.setex(cacheKey, SUN_TTL_SEC, JSON.stringify({ sunrise, sunset }));
        return { sunrise, sunset };
      }
    }
  } catch { /* ignore */ }
  return null;
}

function isNightAuto(now: number, sunrise: number, sunset: number): boolean {
  return now >= sunset || now < sunrise;
}

function parseTime(str: string): number | null {
  const m = String(str ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function isNightManual(nowLocalMins: number, startStr: string, stopStr: string): boolean {
  const start = parseTime(startStr);
  const stop = parseTime(stopStr);
  if (start === null || stop === null) return false;
  if (start < stop) return nowLocalMins >= start && nowLocalMins < stop;
  return nowLocalMins >= start || nowLocalMins < stop;
}

function newStateKey(chatId: number): string {
  return `nightmode:active:${chatId}`;
}
function configKey(chatId: number): string {
  return `nightmode:${chatId}`;
}

/** Guarda configuración sin TTL (antes expiraba a las 24h). */
async function saveConfig(env: RedisEnv, chatId: number, cfg: Record<string, any>): Promise<void> {
  await createRedis(env).set(configKey(chatId), JSON.stringify(cfg));
}

export async function checkNightMode(env: RedisEnv, api: TelegramApi, onlyChatId?: number): Promise<void> {
  const rdb = createRedis(env);
  const keys = onlyChatId ? [configKey(onlyChatId)] : await rdb.keys("nightmode:*");
  const nowUtc = Math.floor(Date.now() / 1000);

  for (const key of keys) {
    const m = String(key).match(/^nightmode:(-?\d+)$/);
    if (!m) continue;
    const chatId = Number(m[1]);
    const dataJson = await rdb.get(String(key));
    if (!dataJson) continue;
    let cfg: any = {};
    try { cfg = JSON.parse(dataJson); } catch { continue; }

    let active = false;
    if (cfg.mode === "auto" && cfg.city) {
      let coords = validCoords(cfg.lat, cfg.lon);
      if (!coords) {
        coords = await getCoordinates(env, String(cfg.city));
        if (coords) await saveConfig(env, chatId, { ...cfg, lat: coords.lat, lon: coords.lon });
      }
      if (coords) {
        const sun = await getSunTimes(env, coords.lat, coords.lon, nowUtc);
        if (sun) active = isNightAuto(nowUtc, sun.sunrise, sun.sunset);
      }
    } else if (cfg.mode === "manual" && cfg.start && cfg.stop) {
      const offset = Number(cfg.tz_offset ?? 0);
      if (Number.isFinite(offset)) {
        const local = new Date((nowUtc + offset * 3600) * 1000);
        const nowMins = local.getUTCHours() * 60 + local.getUTCMinutes();
        active = isNightManual(nowMins, String(cfg.start), String(cfg.stop));
      }
    }

    const stateKey = newStateKey(chatId);
    const current = await rdb.get(stateKey);
    if (active === (current === "1")) continue;

    // No tocar permisos si el bot no puede moderar el grupo.
    if (!(await captcha.botHasPermissions(env, api, chatId))) continue;

    if (active) {
      await rdb.set(stateKey, "1");
      // param 0 => lockdown persistente hasta que amanezca / se desactive.
      await addTask(env, { type: "lockdown", chatId, param: 0, runAt: nowUtc + 2 });
    } else {
      await rdb.set(stateKey, "0");
      await addTask(env, { type: "unlock", chatId, param: 0, runAt: nowUtc + 2 });
    }
  }
}

function buildStatusText(cfg: any, active: boolean): string {
  const status = active ? "🟢 ACTIVO" : "⚪️ INACTIVO";
  const offset = Number(cfg.tz_offset ?? 0);
  const gmt = `GMT ${offset >= 0 ? "+" : ""}${offset}`;
  let out = `🌙 Estado del modo nocturno:\nEstado: ${status}\nModo: ${cfg.mode ?? "desconocido"}`;
  if (cfg.city) out += `\nCiudad: ${cfg.city}`;
  if (cfg.mode === "manual" && cfg.start && cfg.stop) {
    out += `\nHorario: ${cfg.start} ➜ ${cfg.stop} (${gmt})`;
  } else if (cfg.mode === "auto") {
    out += "\nHorario: Amanecer / Anochecer real";
  }
  if (cfg.time) out += `\nHora de configuración: ${String(cfg.time)} (${gmt})`;
  return out;
}

function statusKeyboard(gid: number): any {
  return {
    inline_keyboard: [
      [{ text: "🌇 Automático por ciudad", callback_data: `nightmode_set_auto:${gid}` }],
      [{ text: "⏰ Horario manual", callback_data: `nightmode_set_manual:${gid}` }],
      [{ text: "🔄 Actualizar estado", callback_data: `nightmode_status:${gid}` }, { text: "❓ Ayuda", callback_data: `settings:section:${gid}:help_nightmode` }],
      [{ text: "⬅️ Volver", callback_data: `settings:${gid}` }],
    ],
  };
}

/** Consume only pending private replies, so /config and verification commands keep working. */
export async function handleNightmodeInput(env: RedisEnv, api: TelegramApi, msg: any): Promise<boolean> {
  if (msg?.chat?.type !== "private" || !msg.text) return false;
  const text = String(msg.text);
  if (text.startsWith("/") && !/^\/cancel(?:@\S+)?\s*$/i.test(text)) return false;
  const pendingKey = `nightmode_pending:${msg.from?.id ?? 0}`;
  const pending = await createRedis(env).get(pendingKey);
  if (!pending) return false;
  if (text.startsWith("/")) {
    await createRedis(env).del(pendingKey);
    await api.sendMessage(Number(msg.chat.id), "✅ Configuración nocturna cancelada. Usa /config para volver.");
  } else await handleNightmodeCommand(env, api, msg, pending);
  return true;
}

export async function handleNightmodeCommand(env: RedisEnv, api: TelegramApi, msg: any, pendingReply?: string): Promise<void> {
  const rdb = createRedis(env);
  const pendingKey = `nightmode_pending:${msg.from?.id ?? 0}`;
  const pending = pendingReply ?? null;

  if (pending) {
    let cfg: any = {};
    try { cfg = JSON.parse(pending); } catch { cfg = {}; }
    if (!cfg || !["auto", "manual"].includes(cfg.mode) || !Number.isSafeInteger(Number(cfg.chat_id)) || Number(cfg.chat_id) >= 0) {
      await rdb.del(pendingKey);
      await api.sendMessage(Number(msg.chat.id), "La configuración pendiente caducó. Abre /config otra vez.");
      return;
    }
    const chatId = Number(cfg.chat_id);
    const replyChatId = Number(msg.chat.id);
    if (!(await captcha.isAdmin(env, api, chatId, msg.from?.id ?? 0))) {
      await rdb.del(pendingKey);
      await api.sendMessage(replyChatId, "🚫 Solo administradores pueden cambiar esto.");
      return;
    }

    if (cfg.mode === "auto") {
      const city = String(msg.text ?? "").trim();
      const coords = await getCoordinates(env, city);
      if (!coords) {
        await api.sendMessage(replyChatId, "⚠️ Ciudad no válida. Intenta nuevamente o usa /cancel.");
        return;
      }
      const tz = await getTimezoneOffset(coords.lat, coords.lon);
      await saveConfig(env, chatId, {
        mode: "auto", city, lat: coords.lat, lon: coords.lon,
        tz_offset: tz?.offset, time: tz?.time,
      });
      await rdb.del(pendingKey);
      await checkNightMode(env, api, chatId);
      await api.sendMessage(replyChatId, `✅ Modo nocturno automático configurado para ${city}.\nSe aplica a todo el grupo y se revisa cada minuto.`, { reply_markup: statusKeyboard(chatId) });
      return;
    }

    if (cfg.mode === "manual") {
      const m = String(msg.text ?? "").match(/^(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/);
      if (!m || parseTime(m[1]) === null || parseTime(m[2]) === null) {
        await api.sendMessage(replyChatId, "❌ Formato incorrecto. Intenta con:\n22:00 06:00 Ciudad\nO usa /cancel.");
        return;
      }
      const start = m[1];
      const stop = m[2];
      const city = m[3].trim();
      const coords = await getCoordinates(env, city);
      if (!coords) {
        await api.sendMessage(replyChatId, "⚠️ Ciudad no válida. Intenta nuevamente o usa /cancel.");
        return;
      }
      const tz = await getTimezoneOffset(coords.lat, coords.lon);
      if (!tz) {
        await api.sendMessage(replyChatId, "⚠️ No se pudo obtener la zona horaria. Intenta nuevamente o usa /cancel.");
        return;
      }
      await saveConfig(env, chatId, {
        mode: "manual", city, lat: coords.lat, lon: coords.lon,
        tz_offset: tz.offset, start, stop, time: tz.time,
      });
      await rdb.del(pendingKey);
      await checkNightMode(env, api, chatId);
      await api.sendMessage(replyChatId, `✅ Modo nocturno manual configurado:\nDesde ${start} hasta ${stop} en ${city} (GMT ${tz.offset >= 0 ? "+" : ""}${tz.offset})\nSe aplica a todo el grupo y se revisa cada minuto.`, { reply_markup: statusKeyboard(chatId) });
      return;
    }
    return;
  }

  const chatId = Number(msg.chat?.id ?? 0);
  if (!chatId || !msg.text) return;
  if (!(await captcha.isAdmin(env, api, chatId, msg.from?.id ?? 0))) {
    await api.sendMessage(chatId, "🚫 Solo administradores pueden cambiar esto.");
    return;
  }

  const text = String(msg.text ?? "");
  const cmdMatch = text.match(/^\/nightmode(?:@\S+)?\s*(\S+)\s*([\s\S]*)$/);
  const cmd = cmdMatch?.[1]?.toLowerCase();
  const rest = cmdMatch?.[2] ?? "";

  if (!cmd) {
    await api.sendMessage(chatId, "🌙 Usa:\n/nightmode auto <ciudad>\n/nightmode manual <hora_on> <hora_off> <ciudad>\n/nightmode status\nEjemplo:\n/nightmode auto Lima\n/nightmode manual 22:00 06:00 Madrid");
    return;
  }

  if (cmd === "auto") {
    const city = rest.trim();
    if (!city) {
      await api.sendMessage(chatId, "🌆 Usa: /nightmode auto <ciudad>\nEjemplo: /nightmode auto Lima");
      return;
    }
    const coords = await getCoordinates(env, city);
    if (!coords) {
      await api.sendMessage(chatId, "⚠️ Ciudad no válida.");
      return;
    }
    const tz = await getTimezoneOffset(coords.lat, coords.lon);
    await saveConfig(env, chatId, {
      mode: "auto", city, lat: coords.lat, lon: coords.lon,
      tz_offset: tz?.offset, time: tz?.time,
    });
    await checkNightMode(env, api, chatId);
    await api.sendMessage(chatId, `✅ Modo nocturno automático activado para ${city}.`);
    return;
  }

  if (cmd === "manual") {
    const m = rest.match(/^(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/);
    if (!m || parseTime(m[1]) === null || parseTime(m[2]) === null) {
      await api.sendMessage(chatId, "🕒 Usa: /nightmode manual <hora_on> <hora_off> <ciudad>\nEjemplo: /nightmode manual 22:00 06:00 Madrid");
      return;
    }
    const start = m[1];
    const stop = m[2];
    const city = m[3].trim();
    const coords = await getCoordinates(env, city);
    if (!coords) {
      await api.sendMessage(chatId, "⚠️ Ciudad no válida.");
      return;
    }
    const tz = await getTimezoneOffset(coords.lat, coords.lon);
    if (!tz) {
      await api.sendMessage(chatId, "⚠️ No se pudo obtener la zona horaria de esa ciudad.");
      return;
    }
    await saveConfig(env, chatId, {
      mode: "manual", city, lat: coords.lat, lon: coords.lon,
      tz_offset: tz.offset, start, stop, time: tz.time,
    });
    await checkNightMode(env, api, chatId);
    await api.sendMessage(chatId, `✅ Modo nocturno manual activado:\nDesde ${start} hasta ${stop} en ${city} (GMT ${tz.offset >= 0 ? "+" : ""}${tz.offset})`);
    return;
  }

  if (cmd === "status") {
    const dataJson = await rdb.get(configKey(chatId));
    if (!dataJson) {
      await api.sendMessage(chatId, "ℹ️ El modo nocturno no está configurado en este grupo.");
      return;
    }
    let cfg: any = {};
    try { cfg = JSON.parse(dataJson); } catch { cfg = {}; }
    const active = (await rdb.get(newStateKey(chatId))) === "1";
    await api.sendMessage(chatId, buildStatusText(cfg, active), { reply_markup: statusKeyboard(chatId) });
    return;
  }

  await api.sendMessage(chatId, "❌ Opción no válida. Usa /nightmode auto, manual o status.");
}

export async function handleNightmodeCallback(env: RedisEnv, api: TelegramApi, cb: any): Promise<void> {
  const data = String(cb?.data ?? "");
  const rdb = createRedis(env);

  let m = data.match(/^nightmode_status:(-?\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    if (!(await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0))) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.", true).catch(() => null);
      return;
    }
    const dataJson = await rdb.get(configKey(gid));
    if (!dataJson) {
      await api.answerCallbackQuery(cb.id, "🌙 Configura el modo nocturno.").catch(() => null);
      await api.editMessageText(cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0,
        "🌙 Modo nocturno\n\nTodavía no está configurado.\n\n🌇 Automático: cierra al anochecer y abre al amanecer según la ciudad.\n⏰ Manual: elige las horas de cierre y apertura.\n\nSe aplica al grupo completo, incluidos todos sus tópicos. Elige una opción:", { reply_markup: statusKeyboard(gid) });
      return;
    }
    let cfg: any = {};
    try { cfg = JSON.parse(dataJson); } catch { cfg = {}; }
    const active = (await rdb.get(newStateKey(gid))) === "1";
    await api.answerCallbackQuery(cb.id, "🌙 Modo Nocturno.").catch(() => null);
    await api.editMessageText(cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, buildStatusText(cfg, active), { reply_markup: statusKeyboard(gid) } as any).catch(() => null);
    return;
  }

  m = data.match(/^nightmode_switch:(-?\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    if (!(await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0))) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.", true).catch(() => null);
      return;
    }
    const keyboard = {
      inline_keyboard: [
        [
          { text: "☀️ Automático", callback_data: `nightmode_set_auto:${gid}` },
          { text: "⏰ Manual", callback_data: `nightmode_set_manual:${gid}` },
        ],
        [{ text: "⬅️ Volver", callback_data: `nightmode_status:${gid}` }],
      ],
    };
    await api.answerCallbackQuery(cb.id, "🌙 Configura el Modo Nocturno.").catch(() => null);
    await api.editMessageText(cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, "Selecciona el nuevo modo:", { reply_markup: keyboard } as any).catch(() => null);
    return;
  }

  m = data.match(/^nightmode_set_auto:(-?\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    if (!(await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0))) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.", true).catch(() => null);
      return;
    }
    await api.answerCallbackQuery(cb.id, "🌙 Configura el Modo Nocturno Automático.").catch(() => null);
    await promptNightmode(env, api, cb, gid, "auto");
    return;
  }

  m = data.match(/^nightmode_set_manual:(-?\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    if (!(await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0))) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.", true).catch(() => null);
      return;
    }
    await api.answerCallbackQuery(cb.id, "🌙 Configura el Modo Nocturno Manual.").catch(() => null);
    await promptNightmode(env, api, cb, gid, "manual");
    return;
  }

  m = data.match(/^nightmode_cancel:(-?\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    if (!(await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0))) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.", true);
      return;
    }
    const key = `nightmode_pending:${cb.from?.id ?? 0}`;
    const raw = await rdb.get(key);
    try { if (Number(JSON.parse(raw ?? "null")?.chat_id) === gid) await rdb.del(key); } catch { /* invalid pending data */ }
    await handleNightmodeCallback(env, api, { ...cb, data: `nightmode_status:${gid}` });
  }
}

async function promptNightmode(env: RedisEnv, api: TelegramApi, cb: any, gid: number, mode: "auto" | "manual"): Promise<void> {
  const text = mode === "auto"
    ? "🌇 Modo nocturno automático\n\nEscribe la ciudad y el país.\nEjemplo: Santiago, Chile\n\nEl grupo cerrará al anochecer y abrirá al amanecer.\nPuedes cancelar con el botón o /cancel."
    : "⏰ Modo nocturno manual\n\nEscribe la hora de cierre, la hora de apertura y la ciudad.\nEjemplo: 22:00 06:00 Santiago, Chile\n\nEl horario usa el desfase GMT obtenido al configurar; revísalo cuando cambie la hora local.\nPuedes cancelar con el botón o /cancel.";
  const extra = { reply_markup: { inline_keyboard: [[{ text: "✖️ Cancelar", callback_data: `nightmode_cancel:${gid}` }]] } };
  // Store only after the prompt was delivered; a failed DM must not leave a hidden conversation.
  if (cb.message?.chat?.type === "private" && Number(cb.message.chat.id) === Number(cb.from?.id)) {
    await api.editMessageText(Number(cb.message.chat.id), Number(cb.message.message_id), text, extra);
  } else await api.sendMessage(Number(cb.from?.id), text, extra);
  await createRedis(env).setex(`nightmode_pending:${cb.from?.id ?? 0}`, 900, JSON.stringify({ mode, chat_id: gid }));
}
