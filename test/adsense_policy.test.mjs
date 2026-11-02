import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./helpers/ts_loader.mjs";
const { adsenseAllowedForRequest } = await import(
  "../src/lib/adsense_policy.ts"
);
const source = readFileSync(
  new URL("../src/miniapp_ads.txt", import.meta.url),
  "utf8",
);
const { canLoadGoogleAds, mountAdvertising } = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

test("AdSense necesita sitio aprobado, dominio correcto y país conocido sin consentimiento pendiente", () => {
  const approved = { ADSENSE_SITE_APPROVED: "true" };
  assert.equal(
    adsenseAllowedForRequest(approved, "CL", "verify.webrom.cc"),
    true,
  );
  for (const country of [
    undefined,
    "",
    "XX1",
    "XX",
    "EU",
    "UK",
    "ES",
    "DE",
    "FR",
    "GB",
    "CH",
    "NO",
    "IS",
    "LI",
  ])
    assert.equal(
      adsenseAllowedForRequest(approved, country, "verify.webrom.cc"),
      false,
    );
  assert.equal(adsenseAllowedForRequest({}, "CL", "verify.webrom.cc"), false);
  assert.equal(
    adsenseAllowedForRequest(approved, "CL", "captcha-bot.ridrogo.workers.dev"),
    false,
  );
  assert.equal(
    adsenseAllowedForRequest(approved, "CL", "other-webrom.cc"),
    false,
  );
});
test("AdSense se bloquea en Telegram, WebViews y páginas dentro de iframes", () => {
  const context = {
    approved: true,
    framed: false,
    telegram: false,
    webview: false,
  };
  assert.equal(canLoadGoogleAds(context), true);
  for (const key of ["framed", "telegram", "webview"])
    assert.equal(canLoadGoogleAds({ ...context, [key]: true }), false);
  assert.equal(canLoadGoogleAds({ ...context, approved: false }), false);
});

function fixture({
  framed = false,
  telegram = false,
  approved = true,
  webview = false,
} = {}) {
  const scripts = [],
    events = {},
    docEvents = {},
    observers = [];
  let frameRequests = 0;
  const banner = { dataset: { enabled: "true" }, hidden: true };
  const googleBanner = {
    dataset: { adsenseAllowed: String(approved) },
    hidden: true,
  };
  const slot = {
    status: null,
    getAttribute() {
      return this.status;
    },
  };
  const frame = {
    dataset: { src: "/miniapp/ad" },
    contentWindow: {},
    hasAttribute() {
      return frameRequests > 0;
    },
    set src(value) {
      assert.equal(value, "/miniapp/ad");
      frameRequests++;
    },
  };
  const nodes = {
    adBanner: banner,
    adFrame: frame,
    googleAdBanner: googleBanner,
    googleAdSlot: slot,
  };
  const document = {
    getElementById(id) {
      return nodes[id];
    },
    createElement(tag) {
      assert.equal(tag, "script");
      return {};
    },
    head: {
      appendChild(script) {
        scripts.push(script);
      },
    },
    addEventListener(name, fn) {
      docEvents[name] = fn;
    },
  };
  const window = {
    navigator: { userAgent: webview ? "Android; wv)" : "Chrome" },
    Telegram: { WebApp: { initData: telegram ? "test-data" : "" } },
    requestAnimationFrame(fn) {
      fn();
    },
    addEventListener(name, fn) {
      events[name] = fn;
    },
    MutationObserver: class {
      constructor(fn) {
        observers.push(fn);
      }
      observe() {}
    },
  };
  window.self = window;
  window.top = framed ? {} : window;
  const ads = mountAdvertising(document, window);
  return {
    ads,
    window,
    banner,
    googleBanner,
    slot,
    scripts,
    events,
    docEvents,
    observers,
    frame,
    get frameRequests() {
      return frameRequests;
    },
  };
}

test("cada anuncio se inicia una vez, sin refrescos ni rotación al guardar o cambiar de sección", (t) => {
  let timers = 0;
  t.mock.method(globalThis, "setInterval", () => {
    timers++;
  });
  const f = fixture();
  f.ads.start();
  f.ads.start();
  f.docEvents["miniapp-ads-show"]();
  assert.equal(f.frameRequests, 1);
  assert.equal(f.scripts.length, 1);
  assert.equal(f.window.adsbygoogle.length, 1);
  assert.equal(timers, 0);
  assert.match(f.scripts[0].src, /client=ca-pub-8258058186888619$/);
  assert.equal(f.scripts[0].crossOrigin, "anonymous");
});
test("un contexto no permitido no solicita el script ni un anuncio de Google", () => {
  for (const options of [
    { telegram: true },
    { framed: true },
    { webview: true },
    { approved: false },
  ]) {
    const f = fixture(options);
    f.ads.start();
    assert.equal(f.scripts.length, 0);
    assert.equal(f.window.adsbygoogle, undefined);
    assert.equal(f.googleBanner.hidden, true);
    assert.equal(f.frameRequests, 1);
  }
});
test("un anuncio sin relleno o con error no sustituye al otro ni afecta sus controles", () => {
  const f = fixture();
  f.slot.status = "unfilled";
  f.observers[0]();
  assert.equal(f.googleBanner.hidden, true);
  assert.equal(f.banner.hidden, false);
  f.scripts[0].onerror();
  assert.equal(f.scripts.length, 1);
  f.events.message({
    source: {},
    data: { type: "miniapp-ad-state", state: "unavailable" },
  });
  assert.equal(f.banner.hidden, false);
  f.events.message({
    source: f.frame.contentWindow,
    data: { type: "miniapp-ad-state", state: "unavailable" },
  });
  assert.equal(f.banner.hidden, true);
});
