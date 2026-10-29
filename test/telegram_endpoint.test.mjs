import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/ts_loader.mjs";

const { telegramApiBaseUrl } = await import("../src/lib/telegram_endpoint.ts");
const { TelegramApi } = await import("../src/lib/telegram.ts");

test("sin configuración se conserva la API oficial", () => {
  assert.equal(telegramApiBaseUrl(), "https://api.telegram.org");
  assert.equal(telegramApiBaseUrl("  "), "https://api.telegram.org");
});

test("permite HTTP de loopback para Bot API en el mismo servidor", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) assert.equal(telegramApiBaseUrl(`http://${host}:8081/`), `http://${host}:8081`);
  assert.equal(telegramApiBaseUrl(" https://bot-api.example.com/internal/ "), "https://bot-api.example.com/internal");
});

test("rechaza credenciales, rutas con token y HTTP remoto sin mostrar secretos", () => {
  for (const value of ["ftp://example.com", "http://example.com", "http://127.0.0.1.evil.com", "https://user:secret@example.com", "https://example.com?token=secret", "https://example.com/#secret", "https://example.com/bot123:secret", "secret"]) {
    assert.throws(() => telegramApiBaseUrl(value), (error) => !error.message.includes("secret"));
  }
});

test("el cliente y sus tópicos usan la misma API configurable", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: { id: 1 } });
  });
  const api = TelegramApi.fromEnv({ BOT_TOKEN: "test", TELEGRAM_API_BASE_URL: "http://127.0.0.1:8081" });
  await api.getMe();
  await api.forMessage({ chat: { id: -1001, type: "supergroup" }, is_topic_message: true, message_thread_id: 55 }).sendMessage(-1001, "prueba");
  assert.deepEqual(calls.map((call) => call.url), ["http://127.0.0.1:8081/bottest/getMe", "http://127.0.0.1:8081/bottest/sendMessage"]);
  assert.equal(calls[1].body.message_thread_id, 55);
});

test("sin variable el cliente sigue llamando a api.telegram.org", async (t) => {
  let seen;
  t.mock.method(globalThis, "fetch", async (url) => { seen = String(url); return Response.json({ ok: true, result: { id: 1 } }); });
  await TelegramApi.fromEnv({ BOT_TOKEN: "test" }).getMe();
  assert.equal(seen, "https://api.telegram.org/bottest/getMe");
});
