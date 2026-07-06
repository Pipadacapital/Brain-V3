// SPEC: A.1.1 (WA-03 pixel build unification)
/**
 * pixel-asset-equivalence.wa03.test.ts — proves the BUILT @brain/pixel-sdk asset the collector
 * now serves is equivalent to the LAST hand-maintained IIFE (frozen at
 * tests/fixtures/legacy-pixel-iife.ts):
 *
 *   1. the route serves the BUILT artifact (literal build product of packages/pixel-sdk) with the
 *      same headers + the same dynamic-config templating pass (install token / ingest base url /
 *      consent default) as before;
 *   2. the served JS exposes the SAME window.brain public API surface as the legacy IIFE (evaled
 *      side-by-side in an identical fake-window harness);
 *   3. the served JS carries the SAME event set (every event_name string literal minted by the
 *      legacy asset exists in the built asset, and vice versa — no event silently gained/lost);
 *   4. behavior-critical wire markers match: same /collect endpoint, same CORS-simple
 *      text/plain;charset=UTF-8 content-type (preflight-free beacon), same localStorage keys,
 *      same first-POST wire shape (event fields + property fields), ONE event per POST (REC-5),
 *      consent fail-safe-absent.
 *
 * The behavioral golden suite (tests/pixel-asset.test.ts, 25 cases) ALSO runs against the built
 * asset — together these pin "same events, same fields, same consent bootstrap, same endpoints".
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import Fastify from 'fastify';
import { PIXEL_JS, PIXEL_VERSION, registerPixelAssetRoute } from '../src/interfaces/rest/pixel-asset.route.js';
import { LEGACY_PIXEL_JS, LEGACY_PIXEL_VERSION } from './fixtures/legacy-pixel-iife.js';

const TOKEN = 'a11a0011-0a11-4a11-8a11-000000000011';
const BRAND = 'a11a0001-0a00-4a00-8a00-000000000001';

interface RunResult {
  sent: Array<{ url: string; body: string; contentType: string }>;
  storeKeys: () => string[];
  win: Record<string, unknown>;
  listeners: Record<string, Array<(e?: unknown) => void>>;
}

/** Identical fake-window harness for BOTH assets (same shape as pixel-asset.test.ts). */
function runAsset(source: string): RunResult {
  const sent: RunResult['sent'] = [];
  const store = new Map<string, string>();
  const listeners: Record<string, Array<(e?: unknown) => void>> = {};
  const location = {
    protocol: 'https:',
    host: 'collect.example.com',
    pathname: '/products/widget',
    search: '',
  };
  const fakeFetch = (
    url: string,
    init: { body: string; headers?: Record<string, string> },
  ): Promise<{ ok: boolean }> => {
    sent.push({ url, body: init.body, contentType: init.headers?.['Content-Type'] ?? '' });
    return Promise.resolve({ ok: true });
  };
  const win: Record<string, unknown> = {
    __brain: { install_token: TOKEN, brand_id: BRAND },
    crypto: {
      randomUUID: () =>
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        }),
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
    },
    Uint8Array,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    location,
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: (ev: string, cb: (e?: unknown) => void) => {
      (listeners[ev] ??= []).push(cb);
    },
    fetch: fakeFetch,
    Blob: class {
      constructor(public parts: string[]) {}
    },
    console: { warn: () => undefined },
  };
  const navigator: Record<string, unknown> = { userAgent: 'Mozilla/5.0 (Macintosh)' };
  const document = {
    referrer: 'https://google.com/',
    cookie: '',
    visibilityState: 'visible',
    addEventListener: (ev: string, cb: (e?: unknown) => void) => {
      (listeners[ev] ??= []).push(cb);
    },
  };
  class FakeXHR {
    open(): void {}
    send(): void {}
  }
  const sandbox = {
    window: win,
    document,
    navigator,
    location,
    Blob: win.Blob,
    fetch: fakeFetch,
    XMLHttpRequest: FakeXHR,
    RegExp,
    decodeURIComponent,
    console: win.console,
    Date,
    Math,
    JSON,
    Object,
    setTimeout,
    Uint8Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sent, storeKeys: () => [...store.keys()].sort(), win, listeners };
}

/** Every event_name string literal the asset can mint (emit / emitRaw / build call sites). */
function eventLiterals(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\b(?:emit|emitRaw|build)\(\s*"([a-z0-9_.]+)"/g)) names.add(m[1]!);
  return [...names].sort();
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('WA-03 (A.1.1) — served /pixel.js is the BUILT @brain/pixel-sdk asset, equivalent to the legacy IIFE', () => {
  // ── (1) the route serves the built artifact with the same templating pass ──
  it('GET /pixel.js serves the BUILT artifact verbatim with the same headers (no Set-Cookie)', async () => {
    const app = Fastify();
    registerPixelAssetRoute(app);
    const res = await app.inject({ method: 'GET', url: '/pixel.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(PIXEL_JS);
    expect(res.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(res.headers['x-pixel-version']).toBe(PIXEL_VERSION);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['set-cookie']).toBeUndefined(); // REC-4
    await app.close();
  });

  it('keeps the dynamic-config templating pass: ?t=&b= prepends the window.__brain bootstrap + ingest origin', async () => {
    const app = Fastify();
    registerPixelAssetRoute(app);
    const res = await app.inject({
      method: 'GET',
      url: `/pixel.js?t=${TOKEN}&b=${BRAND}`,
      headers: { host: 'pixel.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(res.body.startsWith(
      `window.__brain={install_token:"${TOKEN}",brand_id:"${BRAND}",ingest_base_url:"https://pixel.example.com"`,
    )).toBe(true);
    expect(res.body.endsWith(PIXEL_JS)).toBe(true);
    // Non-UUID query values are NEVER templated (no JS injection through the asset).
    const evil = await app.inject({ method: 'GET', url: '/pixel.js?t=alert(1)&b=x' });
    expect(evil.body).toBe(PIXEL_JS);
    await app.close();
  });

  it('the served asset is the literal @brain/pixel-sdk build product, and the versioned alias serves it too', async () => {
    // Bundle provenance markers: esbuild module labels for the pixel-sdk source modules.
    for (const marker of ['src/asset/entry.ts', 'src/asset/runtime.ts', 'src/asset/auto-instrument.ts', 'src/asset/constants.ts']) {
      expect(PIXEL_JS.includes(marker), `built bundle should carry esbuild module label ${marker}`).toBe(true);
    }
    const app = Fastify();
    registerPixelAssetRoute(app);
    const res = await app.inject({ method: 'GET', url: '/pixel.v0.1.0.js' });
    expect(res.body).toBe(PIXEL_JS);
    await app.close();
  });

  // ── (2) same public API surface ─────────────────────────────────────────────
  it('exposes EXACTLY the same window.brain public API surface as the legacy IIFE', () => {
    const legacy = runAsset(LEGACY_PIXEL_JS);
    const built = runAsset(PIXEL_JS);
    const legacyApi = Object.keys(legacy.win.brain as object).sort();
    const builtApi = Object.keys(built.win.brain as object).sort();
    expect(builtApi).toEqual(legacyApi);
    // And the enumerated legacy surface, pinned explicitly (fails loudly if the fixture drifts).
    expect(legacyApi).toEqual(
      [
        'page', 'cartItemAdded', 'cartItemRemoved', 'cartUpdated', 'cartViewed',
        'checkoutStarted', 'checkoutStep', 'shippingSelected', 'paymentInitiated',
        'paymentSucceeded', 'paymentFailed', 'orderPlaced', 'couponApplied',
        'login', 'signup', 'identify', 'track', 'flush',
      ].sort(),
    );
    for (const m of builtApi) {
      expect(typeof (built.win.brain as Record<string, unknown>)[m], `window.brain.${m}`).toBe('function');
    }
  });

  // ── (3) same event set ──────────────────────────────────────────────────────
  it('mints EXACTLY the same event_name set as the legacy IIFE (none lost; only the declared WA-07 addition gained)', () => {
    // SPEC A.1.1 (WA-07): pixel.identify.v1 is the ONE sanctioned additive event since the freeze —
    // flag-gated per brand (default OFF: without the collector-injected identity bootstrap the
    // emit site is unreachable, so the flags-OFF wire behavior is unchanged; see
    // pixel-identify.a11.test.ts for the flag-ON behavior suite).
    const WA07_ADDITIVE_EVENTS = ['pixel.identify.v1'];
    const legacyEvents = eventLiterals(LEGACY_PIXEL_JS);
    const builtEvents = eventLiterals(PIXEL_JS);
    expect(builtEvents).toEqual([...legacyEvents, ...WA07_ADDITIVE_EVENTS].sort());
    // The full enumerated legacy event vocabulary, pinned explicitly.
    expect(legacyEvents).toEqual(
      [
        'page.viewed', 'product.viewed', 'collection.viewed', 'cart.viewed', 'search.submitted',
        'checkout.step_viewed', 'order.placed', 'session.started', 'session.ended', 'pixel.dropped',
        'cart.item_added', 'cart.item_removed', 'cart.updated', 'checkout.started',
        'checkout.shipping_selected', 'payment.initiated', 'payment.succeeded', 'payment.failed',
        'coupon.applied', 'user.logged_in', 'user.signed_up', 'identify', 'form.submitted',
        'exit_intent', 'video', 'share', 'download', 'element.clicked', 'rage.click', 'dead.click',
        'scroll.depth',
      ].sort(),
    );
  });

  // ── (4) behavior-critical markers ───────────────────────────────────────────
  it('POSTs ONE event to the SAME /collect endpoint with the SAME CORS-simple content-type', async () => {
    const legacy = runAsset(LEGACY_PIXEL_JS);
    const built = runAsset(PIXEL_JS);
    await drain();
    expect(built.sent[0]!.url).toBe(legacy.sent[0]!.url);
    expect(built.sent[0]!.url).toBe('https://collect.example.com/collect');
    // text/plain (NOT application/json) — a preflighted sendBeacon is silently dropped by browsers.
    expect(built.sent[0]!.contentType).toBe(legacy.sent[0]!.contentType);
    expect(built.sent[0]!.contentType).toBe('text/plain;charset=UTF-8');
    // ONE object per POST — never an array (REC-5).
    expect(Array.isArray(JSON.parse(built.sent[0]!.body))).toBe(false);
  });

  it('first-POST wire shape matches: same event fields, same property fields, same values where deterministic', async () => {
    const legacy = runAsset(LEGACY_PIXEL_JS);
    const built = runAsset(PIXEL_JS);
    await drain();
    const lev = JSON.parse(legacy.sent[0]!.body);
    const bev = JSON.parse(built.sent[0]!.body);
    expect(Object.keys(bev).sort()).toEqual(Object.keys(lev).sort());
    expect(Object.keys(bev.properties).sort()).toEqual(Object.keys(lev.properties).sort());
    expect(bev.event_name).toBe(lev.event_name); // page.viewed
    expect(bev.schema_version).toBe(lev.schema_version);
    expect(bev.brand_id).toBe(lev.brand_id);
    expect(bev.properties.install_token).toBe(lev.properties.install_token);
    expect(bev.properties.collector_version).toBe(lev.properties.collector_version);
    expect(LEGACY_PIXEL_VERSION).toBe(PIXEL_VERSION);
    expect(bev.properties.page_type).toBe(lev.properties.page_type);
    expect(bev.properties.device).toEqual(lev.properties.device);
    // Consent fail-safe-absent in BOTH (no CMP signal in the harness).
    expect(bev.consent_flags).toBeUndefined();
    expect(lev.consent_flags).toBeUndefined();
  });

  it('persists the SAME localStorage keys (anon id / session / queue / first-touch) — same consent bootstrap seams', async () => {
    const legacy = runAsset(LEGACY_PIXEL_JS);
    const built = runAsset(PIXEL_JS);
    await drain();
    expect(built.storeKeys()).toEqual(legacy.storeKeys());
    expect(legacy.storeKeys()).toEqual(
      ['__brain_anon_id', '__brain_first_touch', '__brain_queue', '__brain_session'],
    );
    // The consent bootstrap reads are structurally present in both (window.__brainConsent override,
    // Shopify Customer Privacy API, boot.consent_default fallback).
    for (const marker of ['__brainConsent', 'customerPrivacy', 'consent_default']) {
      expect(PIXEL_JS.includes(marker), `built asset must keep consent seam ${marker}`).toBe(true);
      expect(LEGACY_PIXEL_JS.includes(marker)).toBe(true);
    }
  });

  it('registers the same lifecycle listener set (pagehide / visibilitychange / mouseout / media / click / submit / scroll)', () => {
    const legacy = runAsset(LEGACY_PIXEL_JS);
    const built = runAsset(PIXEL_JS);
    const listenerSet = (r: RunResult): string[] => Object.keys(r.listeners).sort();
    expect(listenerSet(built)).toEqual(listenerSet(legacy));
    for (const ev of ['pagehide', 'visibilitychange', 'mouseout', 'play', 'pause', 'ended', 'click', 'submit', 'scroll', 'popstate']) {
      expect(built.listeners[ev]?.length ?? 0, `listener ${ev}`).toBe(legacy.listeners[ev]?.length ?? 0);
    }
  });
});
