import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LINK_WHITELIST,
  extractLinks,
  collectMessageLinks,
  findDisallowedLink,
  floodExceeded,
  isFeatureEnabled,
  isLinkAllowed,
  normalizeWhitelistEntry,
  parseFloodLimit,
  parseFloodMute,
  parseWhitelist,
  serializeWhitelist,
} from "../src/lib/security_rules.ts";

test("extractLinks detecta http, www y t.me, sin duplicados ni puntuación final", () => {
  const links = extractLinks(
    "Mira https://example.com/a?x=1, www.foo.org y t.me/micanal. También https://example.com/a?x=1",
  );
  assert.deepEqual(links, ["https://example.com/a?x=1", "www.foo.org", "t.me/micanal"]);
  assert.deepEqual(extractLinks("sin enlaces"), []);
});

test("extractLinks detecta dominios sin esquema y correos, pero no nombres de archivo", () => {
  assert.deepEqual(
    extractLinks("visita spam.com o escribe a user@evil.net; adjunto informe.pdf y foto.jpg"),
    ["spam.com", "evil.net"],
  );
  assert.deepEqual(extractLinks("https://example.com/x"), ["https://example.com/x"]);
  assert.deepEqual(extractLinks("webrom.cc y t.me/Antiubot"), ["t.me/Antiubot", "webrom.cc"]);
});

test("isLinkAllowed permite dominios oficiales sin esquema", () => {
  assert.equal(isLinkAllowed("webrom.cc", DEFAULT_LINK_WHITELIST), true);
  assert.equal(isLinkAllowed("spam.com", DEFAULT_LINK_WHITELIST), false);
  assert.equal(findDisallowedLink("spam.com", DEFAULT_LINK_WHITELIST), "spam.com");
});

test("isLinkAllowed permite oficiales, subdominios y rutas exactas", () => {
  const list = DEFAULT_LINK_WHITELIST;
  assert.equal(isLinkAllowed("https://webrom.cc/noticias", list), true);
  assert.equal(isLinkAllowed("https://verify.webrom.cc/verify?chat_id=1", list), true);
  assert.equal(isLinkAllowed("https://sub.webrom.cc/x", list), true);
  assert.equal(isLinkAllowed("https://t.me/Antiubot?start=config_-100", list), true);
  assert.equal(isLinkAllowed("https://t.me/AntiubotNews", list), true);
});

test("isLinkAllowed bloquea dominios ajenos y trucos de URL", () => {
  const list = DEFAULT_LINK_WHITELIST;
  assert.equal(isLinkAllowed("https://evil.example/phish", list), false);
  assert.equal(isLinkAllowed("https://evil.example/?next=https://webrom.cc", list), false);
  assert.equal(isLinkAllowed("https://t.me.evil.example/Antiubot", list), false);
  assert.equal(isLinkAllowed("https://webrom.cc.evil.example/", list), false);
  assert.equal(isLinkAllowed("https://t.me/AntiubotEvil", list), false);
  assert.equal(isLinkAllowed("texto sin url", list), false);
});

test("findDisallowedLink devuelve el primer enlace no permitido", () => {
  assert.equal(findDisallowedLink("webrom.cc y https://t.me/Antiubot", DEFAULT_LINK_WHITELIST), null);
  assert.equal(findDisallowedLink("mira https://spam.example", DEFAULT_LINK_WHITELIST), "https://spam.example");
});

test("collectMessageLinks incluye enlaces ocultos text_link", () => {
  const links = collectMessageLinks("pincha aquí", [
    { type: "text_link", url: "https://spam.example/x" },
    { type: "bold" },
  ]);
  assert.deepEqual(links, ["https://spam.example/x"]);
});

test("límites de flood y mute se recortan a rangos seguros", () => {
  assert.equal(parseFloodLimit(null), 12);
  assert.equal(parseFloodLimit("1"), 3);
  assert.equal(parseFloodLimit("999"), 50);
  assert.equal(parseFloodLimit("abc"), 12);
  assert.equal(parseFloodMute(null), 600);
  assert.equal(parseFloodMute("1"), 60);
  assert.equal(parseFloodMute("999999"), 86400);
  assert.equal(floodExceeded(12, 12), false);
  assert.equal(floodExceeded(13, 12), true);
});

test("whitelist: normalización, parseo y serialización", () => {
  assert.equal(normalizeWhitelistEntry("https://WWW.Example.com/"), "example.com");
  assert.equal(normalizeWhitelistEntry("t.me/MiCanal/"), "t.me/micanal");
  assert.equal(normalizeWhitelistEntry("no vale con espacios"), "");
  assert.deepEqual(parseWhitelist("example.com, t.me/x\nexample.com"), ["example.com", "t.me/x"]);
  assert.equal(serializeWhitelist(["https://Example.com/", "t.me/X"]), "example.com,t.me/x");
});

test("isFeatureEnabled solo desactiva con false/0", () => {
  assert.equal(isFeatureEnabled(null), true);
  assert.equal(isFeatureEnabled("true"), true);
  assert.equal(isFeatureEnabled("false"), false);
  assert.equal(isFeatureEnabled("0"), false);
});
