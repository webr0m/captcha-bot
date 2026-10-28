# 🤖 captcha-bot → Cloudflare Workers (migración desde Lua)

Bot de Telegram anti-spam/captcha migrado de **Lua 5.4 + telegram-bot-lua + copas** → **Cloudflare Workers**.

- **Bot:** [@Antiubot](https://t.me/Antiubot)
- **Repositorios:** [GitHub](https://github.com/webr0m/captcha-bot) · [GitLab](https://gitlab.com/ridrogo/captcha-bot-workers)
- **Instancia:** https://captcha-bot.ridrogo.workers.dev
- **Webhook:** `POST /webhook` · **Health:** `GET /health` · **Turnstile:** `GET/POST /verify`
- **Verificación pública:** `https://verify.webrom.cc/verify?chat_id=...&user_id=...` (la sirve el propio Worker; sin túnel)
- **Base de datos:** Upstash Redis (REST)

## Arquitectura

```
Telegram ──webhook──▶ Cloudflare Worker (fetch handler)
                          │
                          ├─ POST /webhook   → dispatcher de updates (message / callback_query / chat_join_request)
                          │                        └─▶ motor de captchas (math / emoji / qr / image / turnstile / button / dice)
                          │                                   └─▶ Telegram API (wrapper fetch) ─▶ kick/ban/edit/delete
                          │                                   └─▶ Upstash Redis (API REST)  ← estado (verify:*, math_*, qr_*, group:*, ...)
                          │
                          └─ POST /verify   → Turnstile siteverify → set estado "ok" → editar mensaje
                          │
                          └─ cron "* * * * *" → proceso cola de tareas (tasks set) → kicks / bans / limpiezas / lockdowns
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

wrangler deploy                    # deploy a Cloudflare
```

1. Crear **Upstash Redis** (free tier) y obtener REST URL/Token.
2. `wrangler deploy`.
3. `curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://<worker>.workers.dev/webhook"`.
4. La página Turnstile se sirve con `GET /verify`; la ruta pública se define en `wrangler.jsonc` (`verify.<dominio>/*`) y el dominio debe estar autorizado en el widget de Turnstile.
5. (Opcional) `WEBHOOK_SECRET` para validar `X-Telegram-Bot-Api-Secret-Token` y `USERS_LOG_CHAT_ID` para el log de actividad.

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

## Estado

- Motor de captchas: **portado y probado** (math / emoji / qr / image / turnstile / button / dice).
- Flujo real de captcha **button** probado en grupo: `pending` → callback → `verify = ok` → mensaje editado.
- Flujo real **Turnstile** probado: `GET /verify` 200, token inválido 403, verificación correcta 200.
- Kicks/bans por timeout: **portados** (task queue + cron; ban permanente con `until_date=0`).
- Modo nocturno, lockdown, cleaner, broadcast, settings, known_users, donate, lang, block_lang, reportes: **portados**.
- Documentación de despliegue y pruebas: [DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md).
