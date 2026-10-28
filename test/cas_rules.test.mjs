import test from "node:test";
import assert from "node:assert/strict";
import { decodeCasCache, encodeCasCache, parseCasResponse } from "../src/lib/cas_rules.ts";

test("CAS listado devuelve ofensas", () => {
  assert.deepEqual(parseCasResponse({ ok: true, result: { offenses: 3 } }), { listed: true, offenses: 3 });
  assert.deepEqual(parseCasResponse({ ok: true, result: {} }), { listed: true, offenses: 1 });
});

test("CAS no listado o error se trata como limpio", () => {
  assert.deepEqual(parseCasResponse({ ok: false, error: "Not found" }), { listed: false, offenses: 0 });
  assert.deepEqual(parseCasResponse(null), { listed: false, offenses: 0 });
});

test("caché de CAS codifica y decodifica", () => {
  assert.equal(encodeCasCache({ listed: true, offenses: 2 }), "listed:2");
  assert.equal(encodeCasCache({ listed: false, offenses: 0 }), "clean");
  assert.deepEqual(decodeCasCache("listed:2"), { listed: true, offenses: 2 });
  assert.deepEqual(decodeCasCache("clean"), { listed: false, offenses: 0 });
  assert.equal(decodeCasCache("basura"), null);
  assert.equal(decodeCasCache(null), null);
});
