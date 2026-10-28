/**
 * Página pública de verificación Turnstile.
 * Se sirve desde GET /verify y reemplaza el antiguo túnel (verify.webrom.lat).
 */

const DEFAULT_SITE_KEY = "0x4AAAAAABmxPv1z60xyh-5g";

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e2e8f0;
    background: radial-gradient(circle at 50% 0%, #1e293b 0%, #0f172a 55%, #020617 100%);
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 420px; text-align: center; padding: 34px 30px;
    background: rgba(15, 23, 42, .88); border: 1px solid #334155; border-radius: 20px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, .5);
  }
  .logo { font-size: 44px; line-height: 1; margin-bottom: 14px; }
  h1 { font-size: 22px; margin: 0 0 10px; }
  p { color: #94a3b8; font-size: 14px; line-height: 1.55; margin: 0 0 24px; }
  .turnstile { display: flex; justify-content: center; margin-bottom: 20px; min-height: 65px; }
  button {
    width: 100%; padding: 14px; border: 0; border-radius: 12px; font-size: 15px; font-weight: 700;
    background: #22c55e; color: #052e16; cursor: pointer; transition: background .15s, opacity .15s;
  }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button:not(:disabled):hover { background: #4ade80; }
  #msg { margin-top: 18px; min-height: 20px; font-size: 14px; line-height: 1.45; }
  .ok { color: #4ade80; }
  .err { color: #f87171; }
  .footer { margin-top: 22px; font-size: 11px; color: #64748b; }
</style>
</head>
<body>
<main class="card">
${body}
</main>
</body>
</html>`;
}

export function renderVerifyPage(chatId: string, userId: string, siteKey?: string): string {
  const key = siteKey || DEFAULT_SITE_KEY;
  const cdata = `${chatId}_${userId}`;
  const body = `  <div class="logo">🛡️</div>
  <h1>Verificación anti-spam</h1>
  <p>Resuelve el captcha para desbloquear tu acceso al grupo.</p>
  <form id="verify-form" method="POST" action="/verify">
    <input type="hidden" name="chat_id" value="${chatId}">
    <input type="hidden" name="user_id" value="${userId}">
    <div class="turnstile" id="turnstile-container"></div>
    <button id="submit" type="submit" disabled>Verificar</button>
  </form>
  <div id="msg" role="status" aria-live="polite"></div>
  <div class="footer">Protegido por Cloudflare Turnstile</div>
  <script>
    (function () {
      var form = document.getElementById('verify-form');
      var btn = document.getElementById('submit');
      var msg = document.getElementById('msg');
      function setMsg(text, cls) { msg.textContent = text || ''; msg.className = cls || ''; }
      window.__turnstileOk = function () { btn.disabled = false; setMsg(''); };
      window.__turnstileExpired = function () { btn.disabled = true; setMsg('El captcha expiró. Resuélvelo de nuevo.', 'err'); };
      window.__turnstileError = function () { btn.disabled = true; setMsg('No se pudo cargar el captcha. Recarga la página.', 'err'); };
      window.__initTurnstile = function () {
        if (!window.turnstile) { window.__turnstileError(); return; }
        window.turnstile.render('#turnstile-container', {
          sitekey: ${JSON.stringify(key)},
          theme: 'dark',
          action: 'verify',
          cData: ${JSON.stringify(cdata)},
          callback: window.__turnstileOk,
          'expired-callback': window.__turnstileExpired,
          'error-callback': window.__turnstileError
        });
      };
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        btn.disabled = true;
        setMsg('Verificando…');
        fetch('/verify', { method: 'POST', body: new URLSearchParams(new FormData(form)) })
          .then(function (res) { return res.text().then(function (text) { return { ok: res.ok, text: text }; }); })
          .then(function (r) {
            if (r.ok) {
              setMsg(r.text || '✅ Verificado correctamente.', 'ok');
              form.style.display = 'none';
            } else {
              setMsg(r.text || '❌ Verificación fallida.', 'err');
              if (window.turnstile) window.turnstile.reset();
              btn.disabled = true;
              btn.style.display = 'block';
            }
          })
          .catch(function () {
            setMsg('Error de red. Inténtalo de nuevo.', 'err');
            btn.disabled = false;
          });
      });
    })();
  </script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__initTurnstile" async defer></script>`;
  return shell("Verificación anti-spam", body);
}

export function renderInvalidVerifyPage(): string {
  const body = `  <div class="logo">⚠️</div>
  <h1>Enlace inválido</h1>
  <p>Este enlace de verificación no es válido o está incompleto. Vuelve al grupo y solicita uno nuevo.</p>`;
  return shell("Enlace inválido", body);
}
