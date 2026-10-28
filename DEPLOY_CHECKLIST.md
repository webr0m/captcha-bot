# ✅ Checklist de puesta en producción — captcha-bot (Cloudflare Workers)

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
```

## 3. Base de datos
- Crear **Upstash Redis** (free tier) → REST URL + Token.
- Migrar/seed de keys existentes (mismos prefijos: `verify:*`, `group:*`, `math_*`, `qr_*`, `ID_msg*`, etc.).

## 4. Deploy
```bash
wrangler deploy
```

## 5. Webhook de Telegram
```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://captcha-bot.<account>.workers.dev/webhook"
```

## 6. Cron
- En `wrangler.jsonc`: `"schedule": "* * * * *"`.

## 7. Verificación Turnstile
- Frontend (verify.webrom.cc/verify) → POST al Worker `/verify` con `cf-turnstile-response`, `chat_id`, `user_id`.

## 8. Pruebas funcionales
- [ ] Join a grupo con captcha **math** → respuesta correcta/incorrecta → kick a timeout.
- [ ] Join con **emoji** → pegar emojis → ✅.
- [ ] Join con **qr** → callback `qr_answer` → ✅ / fail → intento 2 → kick.
- [ ] Join con **button** (`simple:<uid>`) → ✅.
- [ ] Join con **turnstile** → /verify → ✅.
- [ ] **Regeneración** (`math_regen` / `qr_regen`) → límite 3.
- [ ] **Timeout** → task `kick` ejecutada por cron → expulsión/baneo.
- [ ] **Limpieza** de mensajes bot/sistema (task `del`).
- [ ] **Mute** por texto entrante cuando `captcha_action_2 = mute`.
- [ ] Traducciones (es → otros) con cache.

## 9. Post-deploy
- Push a GitHub + GitLab (remotes).
