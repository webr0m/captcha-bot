/** Presentación pura del menú: navegación breve y controles agrupados. */
export const MODES: Record<string, string> = {
  button: "Botón", turnstile: "Turnstile", math: "Matemáticas", emoji: "Emojis", image: "Imagen", qr: "QR", dice: "Dados",
};
export const ACTIONS: Record<string, string> = { kick: "Expulsar", ban: "Banear" };
export const ACTIONS_2: Record<string, string> = { mute: "Borrar mensajes", restrict: "Silenciar" };

export interface SettingsState {
  timeout: number; captcha: boolean; mode: string; action: string; admRep: boolean;
  action2: string; delBot: boolean; delSys: boolean; silentMode: boolean;
  cas: boolean; antiFlood: boolean; antiLink: boolean; isForum: boolean; groupName?: string;
}

export const SECTIONS = ["home", "captcha", "moderation", "messages", "language", "help", "help_captcha", "help_moderation", "help_topics", "help_troubleshoot"] as const;
export type SettingsSection = typeof SECTIONS[number];
type Button = { text: string; callback_data: string };

const HELP: Partial<Record<SettingsSection, { title: string; text: string }>> = {
  help_captcha: { title: "🔐 Ayuda · Captcha", text: "1. Activa Captcha en su submenú.\n2. Elige el desafío y el tiempo disponible.\n3. Elige Expulsar (puede volver) o Banear (bloqueo permanente).\n\nMientras verifica, puedes borrar sus mensajes o silenciarlo. Para desafíos que se responden escribiendo, se conserva la posibilidad de responder.\n\nTurnstile por privado intenta enviar el enlace por DM; si no puede, lo muestra en el grupo. Los demás modos publican el desafío en el grupo." },
  help_moderation: { title: "🛡️ Ayuda · Moderación", text: "CAS comprueba una lista externa al entrar; si el servicio falla, continúa con el captcha.\n\nAnti-flood limita los mensajes por usuario en todo el grupo: 12 cada 10 s, con mute de 10 min por defecto.\n\nAnti-enlaces elimina enlaces no permitidos, también en mensajes editados. Los administradores están exentos.\n\nComandos en el grupo:\n/antiflood limit 15\n/antiflood mute 10\n/allowlink example.com\n/unallowlink example.com\n/cas on · /antilink on\n\nEn privado, añade el ID del grupo después del comando." },
  help_topics: { title: "🧵 Ayuda · Tópicos", text: "En Tópicos elige el destino de los captchas: Automático, General o un tópico detectado. En automático se usa el hilo de la entrada; si no existe, General.\n\nSi falta un tópico, escribe /topico dentro de él y actualiza el listado. El bot aprende los tópicos cuando recibe mensajes; Telegram no ofrece una lista completa de tópicos.\n\nMantén abierto el tópico elegido. Los mensajes editados y los botones se identifican por su mensaje, por lo que la limpieza funciona dentro del foro.\n\nLa verificación, los filtros, el mute y los bans afectan al supergrupo completo." },
  help_troubleshoot: { title: "🔧 Ayuda · Resolver problemas", text: "• El bot debe ser administrador con permisos para borrar mensajes y restringir miembros.\n• Si no aparecen captchas, revisa que Captcha esté activado y que el tópico elegido esté abierto.\n• Si faltan tópicos, escribe /topico dentro de ellos y actualiza el menú.\n• Si un enlace permitido se borra, añádelo con /allowlink.\n• Los desafíos caducados no se pueden reutilizar; vuelve a entrar para recibir uno nuevo.\n• El cron revisa las tareas una vez por minuto: la expulsión y la limpieza pueden demorarse hasta el siguiente ciclo.\n• El modo nocturno requiere configurar la ciudad; si no la reconoce, el propietario debe revisar la clave de geocodificación.\n• Los cambios de configuración solo están disponibles para administradores actuales." },
};

export function buildSettingsView(s: SettingsState, gid: number, section: SettingsSection = "home"): { text: string; keyboard: { inline_keyboard: Button[][] } } {
  const rows: Button[][] = [];
  const button = (text: string, data: string): Button => ({ text, callback_data: data });
  const nav = (label: string, target: SettingsSection) => button(label, `settings:section:${gid}:${target}`);
  const toggle = (label: string, enabled: boolean, key: string) => button(`${enabled ? "✅" : "⬜"} ${label}`, `setup:toggle:${key}:${gid}`);
  const link = (label: string, data: string) => rows.push([button(label, data)]);
  let text = "";
  if (section === "home") {
    text = `⚙️ ${s.groupName ?? `Grupo ${gid}`}\n\n🔐 Captcha: ${s.captcha ? "activado" : "desactivado"} · ${MODES[s.mode] ?? s.mode} · ${s.timeout}s\n🛡️ CAS: ${s.cas ? "ON" : "OFF"} · Flood: ${s.antiFlood ? "ON" : "OFF"} · Enlaces: ${s.antiLink ? "ON" : "OFF"}\n\nElige una sección. Los cambios se guardan al pulsar.`;
    rows.push([nav("🔐 Captcha", "captcha"), nav("🛡️ Moderación", "moderation")]);
    rows.push([nav("🧹 Mensajes y avisos", "messages"), nav("🌐 Idioma y filtros", "language")]);
    if (s.isForum) link("🧵 Tópicos · destino del captcha", `topics:${gid}`);
    rows.push([button("🌙 Modo nocturno", `nightmode_status:${gid}`), button("📈 Estadísticas", `stats:${gid}`)]);
    rows.push([nav("❓ Ayuda", "help"), button("📋 Resumen", `summary:${gid}`)]);
    rows.push([button("⬅️ Mis grupos", `setup:back:back:${gid}`), button("✖️ Cerrar", `setup:close:close:${gid}`)]);
  } else if (section === "captcha") {
    text = `🔐 Captcha\n\nEstado: ${s.captcha ? "activado" : "desactivado"}\nDesafío: ${MODES[s.mode] ?? s.mode}\nTiempo: ${s.timeout}s\nAl caducar: ${ACTIONS[s.action] ?? s.action}\nMientras verifica: ${ACTIONS_2[s.action2] ?? s.action2}\n\nSelecciona el modo o ajusta una opción. ✅ indica la selección actual.`;
    rows.push([toggle("Captcha activado", s.captcha, "captcha")]);
    rows.push([button("−5 s", `setup:timeout:sub:${gid}`), button(`⏱ ${s.timeout}s`, `pop:timeout:${gid}`), button("+5 s", `setup:timeout:add:${gid}`)]);
    const modes = Object.entries(MODES);
    for (let i = 0; i < modes.length; i += 2) rows.push(modes.slice(i, i + 2).map(([id, label]) => button(`${s.mode === id ? "✅ " : ""}${label}`, `mode:set:${gid}:${id}`)));
    rows.push(Object.entries(ACTIONS).map(([id, label]) => button(`${s.action === id ? "✅ " : ""}${label} al caducar`, `action:set:${gid}:${id}`)));
    rows.push(Object.entries(ACTIONS_2).map(([id, label]) => button(`${s.action2 === id ? "✅ " : ""}${label}`, `action_2:set:${gid}:${id}`)));
    rows.push([toggle("Turnstile por privado", s.silentMode, "silent_mode")]);
    rows.push([nav("❓ Ayuda de captcha", "help_captcha")]);
  } else if (section === "moderation") {
    text = "🛡️ Moderación\n\nActiva o desactiva cada protección con un toque.\n\nCAS: comprueba la lista de Combot al entrar.\nAnti-flood: limita mensajes repetidos por usuario.\nAnti-enlaces: elimina enlaces no permitidos.\n\n✅ Activado · ⬜ Desactivado";
    rows.push([toggle("CAS · lista antispam", s.cas, "cas")], [toggle("Anti-flood", s.antiFlood, "antiflood")], [toggle("Anti-enlaces", s.antiLink, "antilink")], [nav("❓ Límites y enlaces permitidos", "help_moderation")]);
  } else if (section === "messages") {
    text = "🧹 Mensajes y avisos\n\nElige qué limpia el bot y si envía reportes por privado a los administradores.\n\n✅ Activado · ⬜ Desactivado";
    rows.push([toggle("Limpiar mensajes de captcha", s.delBot, "delbot")], [toggle("Limpiar entradas y salidas", s.delSys, "delsys")], [toggle("Reportar usuarios a administradores", s.admRep, "adm_rep")]);
  } else if (section === "language") {
    text = "🌐 Idioma y filtros\n\nIdioma del bot cambia sus mensajes. El filtro de idiomas controla qué usuarios pueden escribir según su idioma de Telegram.";
    link("🌐 Idioma del bot", `lang:${gid}`);
    link("🗣️ Filtro de idiomas", `langblock_menu:${gid}`);
  } else if (section === "help") {
    text = "❓ Ayuda\n\nPara comenzar: da al bot permisos para borrar y restringir, activa Captcha y elige un desafío. En foros, revisa también el destino de los captchas.\n\nElige un tema:";
    rows.push([nav("🔐 Configurar captcha", "help_captcha")], [nav("🛡️ Moderación y comandos", "help_moderation")], [nav("🧵 Supergrupos con tópicos", "help_topics")], [nav("🔧 Resolver problemas", "help_troubleshoot")]);
  } else {
    const help = HELP[section];
    text = help ? `${help.title}\n\n${help.text}` : "❓ Ayuda";
    rows.push([nav("⬅️ Ayuda", "help")]);
  }
  if (section !== "home") rows.push([button("⬅️ Configuración", `settings:${gid}`)]);
  return { text, keyboard: { inline_keyboard: rows } };
}
