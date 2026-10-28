import test from "node:test";
import assert from "node:assert/strict";
import { renderInvalidVerifyPage, renderVerifyPage } from "../src/lib/verify_page.ts";

test("la página de verificación usa action y cData ligados a chat/usuario", () => {
  const html = renderVerifyPage("-1001054467436", "180791241");
  assert.match(html, /action: 'verify'/);
  assert.match(html, /cData: "-1001054467436_180791241"/);
  assert.match(html, /0x4AAAAAABmxPv1z60xyh-5g/);
  assert.doesNotMatch(html, /cdata: /);
});

test("respeta una sitekey personalizada", () => {
  const html = renderVerifyPage("1", "2", "mi-sitekey");
  assert.match(html, /sitekey: "mi-sitekey"/);
});

test("la página de enlace inválido no carga Turnstile", () => {
  const html = renderInvalidVerifyPage();
  assert.match(html, /Enlace inválido/);
  assert.doesNotMatch(html, /challenges\.cloudflare\.com\/turnstile/);
});
