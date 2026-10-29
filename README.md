# 🤖 captcha-bot → Cloudflare Workers (migración desde Lua)

Bot de Telegram anti-spam/captcha migrado de **Lua 5.4 + telegram-bot-lua + copas** → **Cloudflare Workers**.

## Actualización de octubre de 2026

`/config` muestra nombres de grupos en páginas de hasta ocho candidatos y un menú por secciones con ayuda integrada. Cada página comprueba los permisos actuales sin consultar todos los grupos en la misma ejecución. En supergrupos con tópicos, las respuestas siguen el hilo del mensaje y el submenú **Tópicos** permite elegir dónde enviar los captchas. Los botones anteriores conservan sus identificadores.

Consulta [la auditoría y sus límites](AUDITORIA_2026-10-29.md) para ver las correcciones, la compatibilidad y las mejoras pendientes.

La conexión admite `TELEGRAM_API_BASE_URL` para una Bot API propia. Vacía conserva la API oficial. La ejecución conjunta por localhost está [preparada a nivel de transporte, pendiente de alojamiento compatible](docs/TELEGRAM_API_INTERNA.md); no se ha migrado el bot de producción.

- **Bot:** [@Antiubot](https://t.me/Antiubot)
- **Repositorios:** [GitHub](https://github.com/webr0m/captcha-bot) · [GitLab](https://gitlab.com/ridrogo/captcha-bot-workers)
- **Instancia:** https://captcha-bot.ridrogo.workers.dev
- **Webhook:** `POST /webhook` · **Health:** `GET /health` · **Turnstile:** `GET/POST /verify`
- **Verificación pública:** `https://verify.webrom.cc/verify?chat_id=...&user_id=...` (la sirve el propio Worker; sin túnel)
- **Base de datos:** Upstash Redis (REST)
- **CI:** GitHub Actions + GitLab CI (typecheck, tests y dry-run de Wrangler)

## Arquitectura

```
Telegram ──webhook──▶ Cloudflare Worker (fetch handler)
                          │
                          ├─ POST /webhook   → dispatcher de updates (message / callback_query / chat_join_request / my_chat_member)
                          │                        └─▶ motor de captchas (math / emoji / qr / image / turnstile / button / dice)
                          │                        └─▶ moderación (CAS / anti-flood / anti-enlaces)
                          │                        └─▶ onboarding y auto-salida si faltan permisos
                          │                                   └─▶ Telegram API (wrapper fetch) ─▶ kick/ban/edit/delete
                          │                                   └─▶ Upstash Redis (API REST)  ← estado (verify:*, math_*, qr_*, group:*, stats:*)
                          │
                          └─ POST /verify   → Turnstile siteverify → set estado "ok" → editar mensaje
                          │
                          └─ cron "* * * * *" → proceso cola de tareas (tasks set) → kicks / bans / salidas / limpiezas / lockdowns
```

## Decisiones de port

| Tema | Decisión |
|---|---|
| Librería Telegram | **Wrapper propio mínimo** (`src/lib/telegram.ts`) sobre REST API de Telegram con `fetch` (port directo de los métodos usados por `telegram-bot-lua`) |
| Base de datos | **Upstash Redis** (API REST) — compatible con todos los comandos usados por el bot |
| Timers / expiraciones | **Cola de tareas** en Redis Set (`tasks`) + **cron trigger** (reemplazo de `copas.sleep`) |
| Captcha por imagen (ImageMagick) | **Modo `image`** implementado sin ImageMagick: imagen generada por `placehold.co` con el código a escribir |
| Modo silencioso | **`silent_mode`**: el enlace de Turnstile se envía por privado; si el usuario no inició el bot, se deja un aviso mínimo en el grupo |
| Limpieza periódica | `cleaner` elimina tareas corruptas/antiguas y claves `known_users:tmp:*`; cron con guard de 1 hora y comando manual `/cleaner` |
| Webhook | Sí (recomendado por Telegram) → Worker expone `/webhook` |

## Puesta en marcha (pasos manuales)

```bash
npm install
cp .dev.vars.example .dev.vars   # completar BOT_TOKEN, UPSTASH_*, DEEPL_AUTH_KEY, TURNSTILE_SECRET
wrangler dev                      # desarrollo local

wrangler secret put BOT_TOKEN
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
wrangler secret put DEEPL_AUTH_KEY
wrangler secret put TURNSTILE_SECRET
wrangler secret put WEBHOOK_SECRET   # obligatorio: 1-256 chars [A-Za-z0-9_-]
wrangler secret put GEOCODE_API_KEY  # modo nocturno por ciudad
wrangler secret put CAS_API_KEY      # necesaria para activar CAS; sin ella queda fail-open

wrangler deploy                    # deploy a Cloudflare
```

1. Crear **Upstash Redis** (free tier) y obtener REST URL/Token.
2. `wrangler deploy`.
3. Registrar el webhook con `secret_token` (el mismo valor que `WEBHOOK_SECRET`):
   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<worker>.workers.dev/webhook" \
     -d "secret_token=<WEBHOOK_SECRET>" \
     -d "allowed_updates=[\"message\",\"edited_message\",\"callback_query\",\"chat_join_request\",\"my_chat_member\"]"
   ```
   `my_chat_member` es necesario para el onboarding y la auto-salida. Sin la cabecera `X-Telegram-Bot-Api-Secret-Token` correcta, `/webhook` responde `401`.
4. La página Turnstile se sirve con `GET /verify`; la ruta pública se define en `wrangler.jsonc` (`verify.<dominio>/*`) y el dominio debe estar autorizado en el widget de Turnstile.
5. (Opcional) `USERS_LOG_CHAT_ID` para el log de actividad.
6. `CAS_API_KEY` (necesaria para CAS): se obtiene en [combot.org/u/settings](https://combot.org/u/settings) tras iniciar sesión con Telegram. La API de CAS devuelve `401` sin clave.

## Seguridad

| Medida | Detalle |
|---|---|
| Secreto de webhook | `WEBHOOK_SECRET` valida `X-Telegram-Bot-Api-Secret-Token` con comparación en tiempo constante; si falta o no coincide → `401` |
| Resiliencia Telegram | Timeout de 12 s por petición, hasta 3 intentos en `429`/`5xx`, respetando `retry_after` (tope de espera de 8 s). Los `4xx` de validación no se reintentan |
| Turnstile endurecido | Se exige `success`, `action=verify`, `cdata=<chatId>_<userId>` y `hostname` permitido (`verify.webrom.cc`, `webrom.cc`, `captcha-bot.ridrogo.workers.dev`); se envía `remoteip` |
| Rate limit `/verify` | 30 intentos por IP cada 10 minutos (`rl:verify:<ip>`); al superarlo → `429` |
| Orden de expulsión | El kick solo se programa si el desafío se envió correctamente; si falla el envío se limpia el estado y no se expulsa a nadie |
| `cData` de Turnstile | Se usa `chatId_userId` (solo alfanuméricos, `_` y `-`); en JS el parámetro es `cData` con D mayúscula |

## Modos de captcha

| Modo | Funcionamiento |
|---|---|
| `button` | Botón «✅ Verificarme» (`simple:<uid>`) en el grupo |
| `math` | Operación con botones numéricos, 2 intentos y regeneración (límite 3) |
| `emoji` | El usuario escribe exactamente la secuencia de emojis |
| `qr` | QR + botones con tokens |
| `image` | Imagen con código de 5 caracteres (`placehold.co`) |
| `turnstile` | Enlace a `verify.webrom.cc`; validación real con Turnstile |
| `dice` | Reto con stickers de dados |

## Moderación automática

| Función | Comportamiento | Default |
|---|---|---|
| **CAS** | Consulta Combot Anti-Spam al entrar un usuario; si está listado lo banea y borra su mensaje de entrada. Si la API falla o no hay `CAS_API_KEY`, continúa con el captcha (fail-open) | ON |
| **Anti-flood** | Máximo 12 mensajes por usuario cada 10 s; al superarlo borra el mensaje y aplica mute temporal de 10 min | ON |
| **Anti-enlaces** | Borra enlaces de usuarios no administradores. Whitelist oficial (`webrom.cc`, `verify.webrom.cc`, canales del bot, repos) + dominios extra por grupo. Al tercer aviso en 1 h aplica mute de 10 min | ON |
| **Onboarding** | Protección ON y Turnstile por defecto, conservando ajustes explícitos. Sin permisos para borrar y restringir, avisa y sale a los 5 min si siguen faltando; cancela si se recuperan. También revisa grupos existentes por lotes. En canales solo permanece si es administrador | — |

Los defaults se aplican cuando la clave del grupo no existe todavía. Se pueden desactivar por grupo sin afectar al resto.

## Comandos de moderación y estadísticas

| Comando | Uso |
|---|---|
| `/stats` | En grupo: resumen del grupo (solo admins). En privado: grupos que administras o resumen global si eres el dev |
| `/cas <gid> [on\|off]` | Estado o activación de CAS |
| `/antiflood <gid> [on\|off\|limit 3-50\|mute 1-1440]` | Estado/configuración de anti-flood |
| `/antilink <gid> [on\|off]` | Estado/activación de anti-enlaces |
| `/allowlink <gid> <dominio>` | Añade un dominio a la whitelist del grupo |
| `/unallowlink <gid> <dominio>` | Quita un dominio extra (los oficiales no se pueden quitar) |

En grupos, `<gid>` se omite y se usa el grupo actual; en privado es obligatorio.

## Tests y CI

```bash
npm test          # 67 tests de reglas, menús, flujos y API configurable
npm run cf-typecheck
npm run deploy:dry
```

- GitHub Actions (`.github/workflows/ci.yml`) y GitLab CI (`.gitlab-ci.yml`) ejecutan typecheck, tests y dry-run con Node 24.
- Los tests cubren reglas de enlaces/whitelist, límites de flood, tareas, CAS, Turnstile, accesos, captchas y navegación de menús con tópicos. Se necesita Node 24 para el cargador de TypeScript de los tests de flujos.

## Supergrupos con tópicos

En privado: `/config` → nombre del grupo → **Tópicos · destino del captcha**. Elige Automático, General o uno de los tópicos detectados. Si falta un tópico, envía `/topico` dentro de él y actualiza el menú. Las respuestas a comandos y avisos de moderación permanecen en su hilo.

También se puede configurar desde el grupo:

```text
/topico                       Estado e instrucciones
/topico captcha aqui          Usar el tópico actual
/topico captcha general       Usar General
/topico captcha off           Volver al destino automático
```

La verificación y las sanciones se aplican al supergrupo completo. Mantén abierto el tópico elegido. Los desafíos ya emitidos conservan su mensaje original al cambiar el destino.

## Estado

- Motor de captchas: **portado y probado** (math / emoji / qr / image / turnstile / button / dice).
- Flujo real de captcha **button** probado en grupo: `pending` → callback → `verify = ok` → mensaje editado.
- Flujo real **Turnstile** probado: `GET /verify` 200, token inválido 403, verificación correcta 200.
- Pack de seguridad desplegado: `WEBHOOK_SECRET` obligatorio (401 sin cabecera), reintentos/timeout de Telegram, Turnstile con `action`/`cdata`/`hostname` y rate limit por IP (429).
- Kicks/bans por timeout: **portados** (task queue + cron; ban permanente con `until_date=0`).
- Moderación automática: **CAS, anti-flood y anti-enlaces** activos por defecto, con comandos por grupo y contadores en `/stats`.
- Onboarding: **`my_chat_member`** preconfigura el grupo con captcha ON y Turnstile si no había una elección guardada. El cron revisa dos grupos existentes por ciclo, con cursor persistente y margen de llamadas para Workers Free. La salida tras cinco minutos vuelve a comprobar los permisos y se cancela si se recuperan; los fallos temporales se reintentan.
- `/config`: cinco grupos administrados por página. Un índice de administradores, actualizado al registrar grupos y comprobar permisos, evita contar todos los grupos conocidos. La selección y cada cambio siguen verificando los permisos en vivo con Telegram.
- Validación local de esta revisión: **67/67 tests**, typecheck y dry-run correctos; pipelines de GitHub y GitLab incluidos.
- CAS **configurado y probado** con `CAS_API_KEY` en producción (detección de usuarios listados y caché `listed`/`clean`); sin clave queda en fail-open.
- Modo nocturno, lockdown, cleaner, broadcast, settings, known_users, donate, lang, block_lang, reportes: **portados**.
- Documentación de despliegue y pruebas: [DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md).
