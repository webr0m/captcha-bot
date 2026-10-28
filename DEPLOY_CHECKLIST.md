# ✅ Checklist de puesta en producción — captcha-bot (Cloudflare Workers)

## 0. Estado de esta instalación
- Worker desplegado: https://captcha-bot.ridrogo.workers.dev → `/health` responde `200 OK (redis: PONG)`.
- Bot: **@Antiubot** (id `822926313`).
- Webhook de Telegram: `https://captcha-bot.ridrogo.workers.dev/webhook` (0 updates pendientes, `allowed_updates`: `message`, `callback_query`, `chat_join_request`).
- Secrets cargados: `BOT_TOKEN`, `TURNSTILE_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- Opcionales: `WEBHOOK_SECRET` (validación de cabecera) y `USERS_LOG_CHAT_ID` (log de actividad); no configurados.
- Redis: Upstash `captcha-bot` (free tier, us-east-1).
- Turnstile: widget **GBOT** con dominios `webrom.cc` y `verify.webrom.cc`.
- Página de verificación: la sirve el propio Worker en `https://verify.webrom.cc/verify?chat_id=...&user_id=...` mediante la ruta `verify.webrom.cc/*` (sin túnel).
- Probado en producción: `/start`, `/config`, `/donate`, `/cleaner`, botones `setup:*` y `langblock_menu:*`, flujo Turnstile real y captcha `button` completo (`pending` → callback → `ok`).

## 1. Setup local
```bash
cd D:\Descargas\portar antiubot
npm install
cp .dev.vars.example .dev.vars   # BOT_TOKEN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, DEEPL_AUTH_KEY, TURNSTILE_SECRET
npm run cf-typecheck              # tsc --noEmit
npm run dev                       # wrangler dev -> http://localhost:8787
```

## 2. Secrets / vars en Cloudflare
```bash
wrangler secret put BOT_TOKEN
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
wrangler secret put DEEPL_AUTH_KEY
wrangler secret put TURNSTILE_SECRET
# opcionales
wrangler secret put WEBHOOK_SECRET
wrangler secret put USERS_LOG_CHAT_ID
```
> `wrangler secret put` es interactivo; para automatizar usar `wrangler deploy --secrets-file <archivo.env>`.

## 3. Base de datos
- Crear **Upstash Redis** (free tier) → REST URL + Token.
- Migrar/seed de keys existentes (mismos prefijos: `verify:*`, `group:*`, `math_*`, `qr_*`, `ID_msg*`, etc.).
- Los grupos y administradores se registran automáticamente al recibir mensajes (`group_known`, `group_access`); el refresco de admins es como máximo cada hora.

## 4. Deploy
```bash
wrangler deploy
```

## 5. Webhook de Telegram
```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://captcha-bot.<account>.workers.dev/webhook" \
  -d "allowed_updates=[\"message\",\"callback_query\",\"chat_join_request\"]"
```

## 6. Cron
- En `wrangler.jsonc`: `"triggers": { "crons": ["* * * * *"] }` (cada minuto).
- Procesa la cola `tasks`, el modo nocturno y el cleaner.

## 7. Verificación Turnstile
- Frontend (verify.webrom.cc/verify) → POST al Worker `/verify` con `cf-turnstile-response`, `chat_id`, `user_id`.
- El Worker valida contra `https://challenges.cloudflare.com/turnstile/v0/siteverify` y exige que el estado siga en `pending`.

## 8. Pruebas funcionales
- [x] `/start` en privado → bienvenida + botones (probado vía webhook).
- [x] `/start config_<gid>` → botón `settings:<gid>` (probado vía webhook).
- [x] `/config` en privado → lista de grupos (`group_known` / `group_access`).
- [x] Botones `setup:*` del menú (ON/OFF, ±5s, volver, cerrar).
- [x] Menú de filtro de idiomas (`langblock_menu`).
- [x] `/donate` y callback `crypto` (HTML seguro).
- [x] `/cleaner` manual (admin/dev) y limpieza periódica desde cron.
- [x] `GET /verify` válido → 200 con Turnstile; inválido → 400.
- [x] `POST /verify` con token falso → 403.
- [x] Flujo Turnstile real → `✅ Verificado correctamente.` y `verify:* = ok`.
- [x] Captcha **button** real en grupo: `pending` → callback `simple:<uid>` → `ok`, mensaje editado y claves limpiadas.
- [ ] Join con captcha **math** → respuesta correcta/incorrecta → kick a timeout.
- [ ] Join con **emoji** → pegar emojis → ✅.
- [ ] Join con **qr** → callback `qr_answer` → ✅ / fail → intento 2 → kick.
- [ ] Join con **image** → escribir el código de la imagen.
- [ ] Join con **turnstile** desde un grupo real (modo `turnstile`).
- [ ] **Regeneración** (`math_regen` / `qr_regen`) → límite 3.
- [ ] **Timeout** → task `kick` ejecutada por cron → expulsión (60 s) o ban permanente según `captcha_action`.
- [ ] **Limpieza** de mensajes bot/sistema (task `del`).
- [ ] **Mute** por texto entrante cuando `captcha_action_2 = mute`.
- [ ] Traducciones (es → otros) con cache.

## 9. Post-deploy
- Push a GitHub (`webr0m/captcha-bot`).
- Push a GitLab (pendiente de autorización del CLI).

## Notas
- El grupo principal `-1001054467436` tiene el bot como administrador con `can_delete_messages` y `can_restrict_members`, pero `captcha_enabled` está desactivado.
- El grupo `-1001206300197` («Autobots spam») tiene el bot solo como miembro: no puede restringir ni borrar mensajes, por lo que el captcha completo debe probarse en un grupo donde sea administrador.
