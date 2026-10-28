# 🤖 captcha-bot → Cloudflare Workers (migración desde Lua)

Bot de Telegram anti-spam/captcha migrado de **Lua 5.4 + telegram-bot-lua + copas** → **Cloudflare Workers**.

- **Bot:** [@Antiubot](https://t.me/Antiubot)
- **Instancia:** https://captcha-bot.ridrogo.workers.dev
- **Webhook:** `POST /webhook` · **Health:** `GET /health` · **Turnstile:** `GET/POST /verify`
- **Verificación pública:** `https://verify.webrom.cc/verify?chat_id=...&user_id=...` (la sirve el propio Worker; sin túnel)
- **Base de datos:** Upstash Redis (REST)

## Arquitectura

```
Telegram ──webhook──▶ Cloudflare Worker (fetch handler)
                          │
                          ├─ POST /webhook   → dispatcher de updates (message / callback_query / chat_join_request)
                          │                        └─▶ motor de captchas (math / emoji / qr / turnstile / button)
                          │                                   └─▶ Telegram API (wrapper fetch) ─▶ kick/ban/edit/delete
                          │                                   └─▶ Upstash Redis (API REST)  ← estado (verify:*, math_*, qr_*, group:*, ...)
                          │
                          └─ POST /verify   → Turnstile siteverify → set estado "ok" → editar mensaje
                          │
                          └─ cron "* * * * *" → proceso cola de tareas (tasks set) → kicks / limpiezas / lockdowns
```

## Decisiones de port

| Tema | Decisión |
|---|---|
| Librería Telegram | **Wrapper propio mínimo** (`src/lib/telegram.ts`) sobre REST API de Telegram con `fetch` (port directo de los métodos usados por `telegram-bot-lua`) |
| Base de datos | **Upstash Redis** (API REST) — compatible con todos los comandos usados por el bot |
| Timers / expiraciones | **Cola de tareas** en Redis Set (`tasks`) + **cron trigger** (reemplazo de `copas.sleep`) |
| captcha por imagen (ImageMagick) | **No soportado en Workers** → se migra a math/QR/turnstile/emoji (todos ya portados) |
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

## Estado

- Motor de captchas: **portado** (math / emoji / qr / turnstile / button).
- Kicks por timeout: **portado** (task queue + cron).
- Verificaciones: **portado** (callback queries, deep links, turnstile).
- Traducción: **portado** (DeepL + Google + cache).
- Módulos restantes (settings, nightmode, dice, broadcast, known_users, donate, lang, block_lang, etc.): **portados**.
