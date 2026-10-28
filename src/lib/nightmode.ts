/**
 * Módulo nightmode — detección de horario nocturno (auto por ciudad / manual por franja horaria).
 * Portado desde `bot/modules/nightmode.lua`.
 *
 * - Auto: geolocalización (geocode.maps.co) -> amanecer/atardecer (sunrise-sunset.org) -> noche.
 * - Manual: franja horario local (HH:MM -> HH:MM) con offset de zona horaria (geonames).
 * - El check se ejecuta periódicamente (cron sweep) iterando las claves `nightmode:*`.
 */

import { createRedis, RedisEnv } from "./redis";
import { TelegramApi } from "./telegram";
import { autoTranslate } from "./translator";
import { addTask } from "./tasks";
import * as captcha from "./captcha";

const GEONAMES_USER = "webrom";
const API_KEY = "689403f89e8d1375697201xoa8000fe";

function parseUtc(str: string): number {
  const m = String(str ?? "").match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Math.floor(ms / 1000);
}

async function getCoordinates(env: RedisEnv, city: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const encoded = encodeURIComponent(String(city ?? ""));
    const url = `https://geocode.maps.co/search?q=${encoded}&api_key=${API_KEY}`;
    const res = await fetch(url);
    const json = (await res.json().catch(() => null)) as any;
    const results = json?.results;
    const result = Array.isArray(results) ? results[0] : null;
    const result_type = result?.type ?? "";
    const allowed = ["city", "town", "municipality", "country", "administrative"];
    const okType = allowed.includes(result_type);
    if (result && okType) {
      const lat = Number(result.lat);
      const lon = Number(result.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    }
  } catch { /* ignore */ }
  return null;
}

async function getTimezoneOffset(lat: number, lon: number): Promise<{ offset: number; time: string } | null> {
  try {
    const url = `https://api.geonames.org/timezoneJSON?lat=${lat}&lng=${lon}&username=${GEONAMES_USER}`;
    const res = await fetch(url);
    const json = (await res.json().catch(() => null)) as any;
    if (json?.gmtOffset && json?.time) {
      return { offset: Number(json.gmtOffset), time: String(json.time) };
    }
  } catch { /* ignore */ }
  return null;
}

async function getSunTimes(lat: number, lon: number): Promise<{ sunrise: number; sunset: number } | null> {
  try {
    const url = `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&formatted=0`;
    const res = await fetch(url);
    const json = (await res.json().catch(() => null)) as any;
    if (json?.status === "OK" && json?.results) {
      const sunrise = parseUtc(json.results.sunrise);
      const sunset = parseUtc(json.results.sunset);
      if (sunrise && sunset) return { sunrise, sunset };
    }
  } catch { /* ignore */ }
  return null;
}

function isNightAuto(now: number, sunrise: number, sunset: number): boolean {
  return now >= sunset || now < sunrise;
}

function timeToMinutes(str: string): number {
  const m = String(str ?? "").match(/^(\d+):(\d+)$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isNightManual(nowLocalMins: number, startStr: string, stopStr: string): boolean {
  const start = timeToMinutes(startStr);
  const stop = timeToMinutes(stopStr);
  if (start < stop) return nowLocalMins >= start && nowLocalMins < stop;
  return nowLocalMins >= start || nowLocalMins < stop;
}

function newStateKey(chatId: number): string {
  return `nightmode:active:${chatId}`;
}
function configKey(chatId: number): string {
  return `nightmode:${chatId}`;
}

export async function checkNightMode(env: RedisEnv, api: TelegramApi): Promise<void> {
  const rdb = createRedis(env);
  const keys = await rdb.keys("nightmode:*");
  for (const key of keys) {
    const m = String(key).match(/^nightmode:(-?\d+)$/);
    if (!m) continue;
    const chatId = Number(m[1]);
    const dataJson = await rdb.get(String(key));
    if (!dataJson) continue;
    let cfg: any = {};
    try { cfg = JSON.parse(dataJson); } catch { continue; }
    const nowUtc = Math.floor(Date.now() / 1000);
    let active = false;
    if (cfg.mode === "auto" && cfg.city) {
      const coords = await getCoordinates(env, String(cfg.city));
      if (coords) {
        const sun = await getSunTimes(coords.lat, coords.lon);
        if (sun) active = isNightAuto(nowUtc, sun.sunrise, sun.sunset);
      }
    } else if (cfg.mode === "manual" && cfg.start && cfg.stop && cfg.tz_offset) {
      const nowLocal = new Date((nowUtc + Number(cfg.tz_offset) * 3600) * 1000);
      const nowMins = nowLocal.getHours() * 60 + nowLocal.getMinutes();
      active = isNightManual(nowMins, String(cfg.start), String(cfg.stop));
    }
    const stateKey = newStateKey(chatId);
    const current = await rdb.get(stateKey);
    if (active && current !== "1") {
      await rdb.setex(stateKey, 86400, "1");
      const now = Math.floor(Date.now() / 1000);
      await addTask(env, { type: "lockdown", chatId, param: 60, runAt: now + 5 });
    } else if (!active && current === "1") {
      await rdb.setex(stateKey, 86400, "0");
      const now = Math.floor(Date.now() / 1000);
      await addTask(env, { type: "unlock", chatId, param: 0, runAt: now + 5 });
    }
  }
}

export async function handleNightmodeCommand(env: RedisEnv, api: TelegramApi, msg: any): Promise<void> {
  const rdb = createRedis(env);
  const pendingKey = `nightmode_pending:${msg.from?.id ?? 0}`;
  const pending = await rdb.get(pendingKey);

  if (pending) {
    let cfg: any = {};
    try { cfg = JSON.parse(pending); } catch { cfg = {}; }
    if (!cfg || !cfg.mode || cfg.chat_id === undefined || cfg.chat_id === null) return;
    const chatId = Number(cfg.chat_id);

    if (cfg.mode === "auto") {
      const city = String(msg.text ?? "").trim();
      const coords = await getCoordinates(env, city);
      if (!coords) {
        await api.sendMessage(chatId, "⚠️ Ciudad no válida. Intenta nuevamente.");
        return;
      }
      const tz = await getTimezoneOffset(coords.lat, coords.lon);
      await rdb.setex(configKey(chatId), 86400, JSON.stringify({ mode: "auto", city, tz_offset: tz?.offset, time: tz?.time }));
      await rdb.setex(newStateKey(chatId), 86400, "0");
      await rdb.del(pendingKey);
      await checkNightMode(env, api);
      await api.sendMessage(chatId, `✅ Modo automático activado para *${city}*.`);
      return;
    }
    if (cfg.mode === "manual") {
      const m = String(msg.text ?? "").match(/^(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/);
      if (!m) {
        await api.sendMessage(chatId, "❌ Formato incorrecto. Intenta con:\n`22:00 06:00 Ciudad`");
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
        await api.sendMessage(chatId, "⚠️ No se pudo obtener zona horaria.");
        return;
      }
      await rdb.setex(configKey(chatId), 86400, JSON.stringify({ mode: "manual", city, tz_offset: tz.offset, start, stop, time: tz.time }));
      await rdb.setex(newStateKey(chatId), 86400, "0");
      await rdb.del(pendingKey);
      await checkNightMode(env, api);
      await api.sendMessage(chatId, `✅ Modo manual activado:\nDesde *${start}* hasta *${stop}* en *${city}* (GMT ${tz.offset >= 0 ? "+" : ""}${tz.offset})\nHora de configuración: *${tz.time}* (GMT ${tz.offset >= 0 ? "+" : ""}${tz.offset})`);
      return;
    }
    return;
  }

  const chatId = msg.chat?.id;
  if (!chatId) return;
  if (!msg.text) return;

  const admin = await captcha.isAdmin(env, api, chatId, msg.from?.id ?? 0);
  if (!admin) {
    await api.sendMessage(chatId, "🚫 Solo administradores pueden cambiar esto.");
    return;
  }

  const text = String(msg.text ?? "");
  const cmdMatch = text.match(/^\/nightmode\s*(\S+)\s*(.*)$/);
  const cmd = cmdMatch?.[1];
  const rest = cmdMatch?.[2] ?? "";

  if (!cmd) {
    await api.sendMessage(chatId, "🌙 Usa:\n/nightmode auto <ciudad>\n/nightmode manual <hora_on> <hora_off> <ciudad>\nEjemplo:\n/nightmode auto Lima\n/nightmode manual 22:00 06:00 Madrid");
    return;
  }

  const config = { mode: cmd };

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
    await rdb.setex(configKey(chatId), 86400, JSON.stringify({ mode: "auto", city, tz_offset: tz?.offset, time: tz?.time }));
    await rdb.setex(newStateKey(chatId), 86400, "0");
    await checkNightMode(env, api);
    await api.sendMessage(chatId, `✅ Modo nocturno automático activado para *${city}*.`);
  } else if (cmd === "manual") {
    const m = rest.match(/^(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/);
    if (!m) {
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
      await api.sendMessage(chatId, "⚠️ No se pudo obtener zona horaria de esa ciudad.");
      return;
    }
    await rdb.setex(configKey(chatId), 86400, JSON.stringify({ mode: "manual", city, tz_offset: tz.offset, start, stop, time: tz.time }));
    await rdb.setex(newStateKey(chatId), 86400, "0");
    await checkNightMode(env, api);
    await api.sendMessage(chatId, `✅ Modo nocturno manual activado:\nDesde *${start}* hasta *${stop}* en *${city}* (GMT ${tz.offset >= 0 ? "+" : ""}${tz.offset})\nHora de configuración: *${tz.time}* (GMT ${tz.offset >= 0 ? "+" : ""}${tz.offset})`);
  } else if (cmd === "status") {
    const dataJson = await rdb.get(configKey(chatId));
    if (!dataJson) {
      await api.sendMessage(chatId, "ℹ️ El modo nocturno no está configurado en este grupo.");
      return;
    }
    let cfg: any = {};
    try { cfg = JSON.parse(dataJson); } catch { cfg = {}; }
    const active = (await rdb.get(newStateKey(chatId))) === "1";
    const status = active ? "🟢 *ACTIVO*" : "⚪️ *INACTIVO*";
    let textOut = `🌙 *Estado del modo nocturno:*\nEstado: ${status}\nModo: \`${cfg.mode ?? "desconocido"}\``;
    if (cfg.city) textOut += `\nCiudad: \`${cfg.city}\``;
    if (cfg.mode === "manual" && cfg.start && cfg.stop) {
      textOut += `\nHorario: \`${cfg.start}\` ➜ \`${cfg.stop}\` (GMT ${Number(cfg.tz_offset || 0) >= 0 ? "+" : ""}${Number(cfg.tz_offset || 0)})\nHora de configuración: \`${String(cfg.time ?? "")}\` (GMT ${Number(cfg.tz_offset || 0) >= 0 ? "+" : ""}${Number(cfg.tz_offset || 0)})`;
    } else if (cfg.mode === "auto" && cfg.time) {
      textOut += `\nHorario: \`Amanecer / Anochecer real\`\nHora de configuración: \`${String(cfg.time)}\` GMT ${Number(cfg.tz_offset || 0)}`;
    }
    await api.sendMessage(chatId, textOut);
    return;
  }

  await rdb.setex(configKey(chatId), 86400, JSON.stringify(config));
  await rdb.setex(newStateKey(chatId), 86400, "0");
}

export async function handleNightmodeCallback(env: RedisEnv, api: TelegramApi, cb: any): Promise<void> {
  const data = cb?.data;
  if (!data) return;
  const rdb = createRedis(env);

  let m: RegExpMatchArray | null;

  // nightmode_status:<gid> -> mostrar estado
  m = data.match(/^nightmode_status:(-?\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    const admin = await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0);
    if (!admin) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.", true).catch(() => null);
      return;
    }
    const dataJson = await rdb.get(configKey(gid));
    if (!dataJson) {
      await api.answerCallbackQuery(cb.id, "Modo nocturno no configurado.", true).catch(() => null);
      return;
    }
    let cfg: any = {};
    try { cfg = JSON.parse(dataJson); } catch { cfg = {}; }
    const active = (await rdb.get(newStateKey(gid))) === "1";
    const statusText = active ? "🟢 *ACTIVO*" : "⚪️ *INACTIVO*";
    let textOut = `🌙 *Modo nocturno:*\nEstado: ${statusText}\nModo: \`${cfg.mode ?? "desconocido"}\``;
    if (cfg.city) textOut += `\nCiudad: \`${cfg.city}\``;
    if (cfg.mode === "manual" && cfg.start && cfg.stop) {
      textOut += `\nHorario: \`${cfg.start}\` ➜ \`${cfg.stop}\` (GMT ${Number(cfg.tz_offset || 0) >= 0 ? "+" : ""}${Number(cfg.tz_offset || 0)})\nHora de configuración: \`${String(cfg.time ?? "")}\` (GMT ${Number(cfg.tz_offset || 0) >= 0 ? "+" : ""}${Number(cfg.tz_offset || 0)})`;
    } else if (cfg.mode === "auto" && cfg.time) {
      textOut += `\nHorario: \`Amanecer / Anochecer real\`\nHora de configuración: \`${String(cfg.time)}\` GMT ${Number(cfg.tz_offset || 0)}`;
    }
    await api.answerCallbackQuery(cb.id, "🌙 Modo Nocturno.").catch(() => null);
    await api.editMessageText(cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, textOut, { parse_mode: "Markdown" } as any).catch(() => null);
    return;
  }

  // nightmode_st<status>:<gid>
  m = data.match(/^nightmode_st(.+):(-?\d+)$/);
  if (m) {
    const status = m[1];
    const gid = Number(m[2]);
    const admin = await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0);
    if (!admin) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.", true).catch(() => null);
      return;
    }
    const dataJson = await rdb.get(configKey(gid));
    if (!dataJson) {
      await api.answerCallbackQuery(cb.id, "Modo nocturno no configurado.", true).catch(() => null);
      return;
    }
    let cfg: any = {};
    try { cfg = JSON.parse(dataJson); } catch { cfg = {}; }
    const active = (await rdb.get(newStateKey(gid))) === "1";
    const statusText = active ? "🟢 *ACTIVO*" : "⚪️ *INACTIVO*";
    let textOut = `🌙 *Modo nocturno:*\nEstado: ${statusText}\nModo: \`${cfg.mode ?? "desconocido"}\``;
    if (cfg.city) textOut += `\nCiudad: \`${cfg.city}\``;
    if (cfg.mode === "manual" && cfg.start && cfg.stop) {
      textOut += `\nHorario: \`${cfg.start}\` ➜ \`${cfg.stop}\` (GMT ${Number(cfg.tz_offset || 0) >= 0 ? "+" : ""}${Number(cfg.tz_offset || 0)})\nHora de configuración: \`${String(cfg.time ?? "")}\` (GMT ${Number(cfg.tz_offset || 0) >= 0 ? "+" : ""}${Number(cfg.tz_offset || 0)})`;
    } else if (cfg.mode === "auto" && cfg.time) {
      textOut += `\nHorario: \`Amanecer / Anochecer real\`\nHora de configuración: \`${String(cfg.time)}\` GMT ${Number(cfg.tz_offset || 0)}`;
    }
    await api.answerCallbackQuery(cb.id, "🌙 Modo Nocturno.").catch(() => null);
    const keyboard = {
      inline_keyboard: [
        [{ text: "🔄 Cambiar modo", callback_data: `nightmode_switch:${gid}` }],
        [{ text: "⬅️ Volver", callback_data: `settings:${gid}` }],
      ],
    };
    if (cb.inline_message_id) {
      await api.editMessageText(cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, textOut, { parse_mode: "Markdown", inline_message_id: cb.inline_message_id } as any).catch(() => null);
    } else {
      await api.editMessageText(cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, textOut, { parse_mode: "Markdown", reply_markup: keyboard } as any).catch(() => null);
    }
    return;
  }

  // nightmode_switch:<gid>
  m = data.match(/^nightmode_sw(.+):(-?\d+)$/);
  if (m) {
    const gid = Number(m[2]);
    const admin = await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0);
    if (!admin) {
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
    if (cb.inline_message_id) {
      await api.editMessageText(cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, "Selecciona el nuevo modo:", { parse_mode: "Markdown", inline_message_id: cb.inline_message_id } as any).catch(() => null);
    } else {
      await api.editMessageText(cb.message?.chat?.id ?? gid, cb.message?.message_id ?? 0, "Selecciona el nuevo modo:", { parse_mode: "Markdown", reply_markup: keyboard } as any).catch(() => null);
    }
    return;
  }

  // nightmode_set_auto:<gid>
  m = data.match(/^nightmode_set_au(.+):(-?\d+)$/);
  if (m) {
    const gid = Number(m[2]);
    const admin = await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0);
    if (!admin) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.", true).catch(() => null);
      return;
    }
    const auto = m[1];
    if (auto !== "to") {
      await api.answerCallbackQuery(cb.id, "🌙 Configura el Modo Nocturno Automático.").catch(() => null);
      await rdb.setex(`nightmode_pending:${cb.from?.id ?? 0}`, 86400, JSON.stringify({ mode: "auto", chat_id: gid }));
      await api.sendMessage(cb.from?.id ?? 0, "🌆 Escribe el nombre de la ciudad para activar modo automático.\nEjemplo: `Lima`");
    }
    return;
  }

  // nightmode_set_manual:<gid>
  m = data.match(/^nightmode_set_ma(.+):(-?\d+)$/);
  if (m) {
    const gid = Number(m[2]);
    const admin = await captcha.isAdmin(env, api, gid, cb.from?.id ?? 0);
    if (!admin) {
      await api.answerCallbackQuery(cb.id, "🚫 Solo administradores pueden cambiar esto.", true).catch(() => null);
      return;
    }
    const manual = m[1];
    if (manual !== "nu") {
      await api.answerCallbackQuery(cb.id, "🌙 Configura el Modo Nocturno Manual.").catch(() => null);
      await rdb.setex(`nightmode_pending:${cb.from?.id ?? 0}`, 86400, JSON.stringify({ mode: "manual", chat_id: gid }));
      await api.sendMessage(cb.from?.id ?? 0, "🕒 Envía la configuración manual en el siguiente formato:\n\n`22:00 06:00 Ciudad`\n\nEjemplo:\n`21:30 07:00 Buenos Aires`");
    }
    return;
  }
}
