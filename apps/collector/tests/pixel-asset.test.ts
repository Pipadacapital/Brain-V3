/**
 * pixel-asset.test.ts — served /pixel.js parity with the shape-(a) contract (Track B).
 *
 * Evals the served PIXEL_JS asset against a fake window/document/navigator/localStorage and
 * a captured fetch, then asserts the emitted event PARSES against the REAL
 * @brain/contracts CollectorEventV1Schema (ADR-1). This pins the served production asset to
 * the same wire contract the tested SDK core enforces.
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { CollectorEventV1Schema } from '@brain/contracts';
import { PIXEL_JS, PIXEL_VERSION } from '../src/interfaces/rest/pixel-asset.route.js';

const TOKEN = 'a11a0011-0a11-4a11-8a11-000000000011';
const BRAND = 'a11a0001-0a00-4a00-8a00-000000000001';

interface Harness {
  sent: string[];
  listeners: Record<string, Array<(e?: unknown) => void>>;
  win: Record<string, unknown>;
  nav: Record<string, unknown>;
}

/** Build a minimal fake-DOM sandbox + eval the asset in it. Returns captured POST bodies. */
function runAsset(opts: {
  search?: string;
  consent?: unknown;
  fetchOk?: boolean;
  cookie?: string;
  pathname?: string;
  userAgent?: string;
  withShare?: boolean;
} = {}): Harness {
  const sent: string[] = [];
  const store = new Map<string, string>();
  const listeners: Record<string, Array<(e?: unknown) => void>> = {};

  const location = {
    protocol: 'https:',
    host: 'collect.example.com',
    pathname: opts.pathname ?? '/products/widget',
    search: opts.search ?? '',
  };

  const fakeFetch = (_url: string, init: { body: string }): Promise<{ ok: boolean }> => {
    sent.push(init.body);
    return Promise.resolve({ ok: opts.fetchOk !== false });
  };

  const win: Record<string, unknown> = {
    __brain: { install_token: TOKEN, brand_id: BRAND },
    __brainConsent: opts.consent,
    crypto: {
      randomUUID: () => randUuid(),
      // Real getRandomValues so the asset's UUIDv7 path is exercised (not the v4 fallback).
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
  // sendBeacon intentionally absent → forces the fetch path (deterministic capture).
  const navigator: Record<string, unknown> = {
    userAgent: opts.userAgent ?? 'Mozilla/5.0 (Macintosh)', /* no sendBeacon */
  };
  if (opts.withShare) navigator.share = () => Promise.resolve();
  const document = {
    referrer: 'https://google.com/',
    cookie: opts.cookie ?? '',
    visibilityState: 'visible',
    addEventListener: (ev: string, cb: (e?: unknown) => void) => {
      (listeners[ev] ??= []).push(cb);
    },
  };

  // Minimal XMLHttpRequest so the asset's cart-mutation XHR hook installs without throwing.
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
  win.fetch = fakeFetch;
  win.XMLHttpRequest = FakeXHR;
  vm.createContext(sandbox);
  vm.runInContext(PIXEL_JS, sandbox);
  return { sent, listeners, win, nav: navigator };
}

/** Let the asset's promise-chained flush (sendOne → .then → step) drain queued events. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function randUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

describe('served /pixel.js — shape-(a) parity (ADR-1)', () => {
  it('auto-fires page.viewed that PARSES against the REAL CollectorEventV1Schema', () => {
    const { sent } = runAsset();
    expect(sent.length).toBe(1); // auto page view, ONE event per POST
    const obj = JSON.parse(sent[0]!);
    const parsed = CollectorEventV1Schema.safeParse(obj);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(obj.event_name).toBe('page.viewed');
    expect(obj.properties.install_token).toBe(TOKEN);
    expect(obj.properties.collector_version).toBe(PIXEL_VERSION);
    expect(Array.isArray(obj)).toBe(false); // never a batch (REC-5)
  });

  it('captures click-ids + utm from the URL (raw-only, RO1)', () => {
    const { sent } = runAsset({ search: '?gclid=G1&utm_source=google&utm_campaign=summer' });
    const obj = JSON.parse(sent[0]!);
    expect(obj.properties.click_ids).toEqual({ gclid: 'G1' });
    expect(obj.properties.utm).toEqual({ source: 'google', campaign: 'summer' });
  });

  it('captures ALL URL click-ids (msclkid/gbraid/wbraid/dclid)', () => {
    const { sent } = runAsset({ search: '?fbclid=FB&gclid=G&ttclid=TT&msclkid=MS&gbraid=GB&wbraid=WB&dclid=DC' });
    expect(JSON.parse(sent[0]!).properties.click_ids).toEqual({
      fbclid: 'FB', gclid: 'G', ttclid: 'TT', msclkid: 'MS', gbraid: 'GB', wbraid: 'WB', dclid: 'DC',
    });
  });

  it('captures cookie click-ids (_fbc + _fbp DISTINCT, li_fat_id, _epik→epik)', () => {
    const { sent } = runAsset({ cookie: '_fbc=fb.1.123.CLICK; _fbp=fb.1.123.BROWSER; li_fat_id=LI; _epik=EPIK' });
    const ci = JSON.parse(sent[0]!).properties.click_ids;
    expect(ci._fbc).toBe('fb.1.123.CLICK');
    expect(ci._fbp).toBe('fb.1.123.BROWSER');
    expect(ci._fbc).not.toBe(ci._fbp);
    expect(ci.li_fat_id).toBe('LI');
    expect(ci.epik).toBe('EPIK');
    expect(ci.fbclid).toBeUndefined();
  });

  it('consent fail-safe-absent — no CMP signal → NO consent_flags stamped', () => {
    const { sent } = runAsset({ consent: undefined });
    expect(JSON.parse(sent[0]!).consent_flags).toBeUndefined();
  });

  it('stamps the four consent flags when a CMP signal is present', () => {
    const { sent } = runAsset({ consent: { analytics: true, marketing: true } });
    expect(JSON.parse(sent[0]!).consent_flags).toEqual({
      analytics: true,
      marketing: true,
      personalization: false,
      ai_processing: false,
    });
  });

  it('exposes window.brain with page/cart/track/flush + the new behavioral methods', () => {
    const { win, listeners } = runAsset();
    const brain = win.brain as Record<string, unknown>;
    for (const m of [
      'page', 'cartItemAdded', 'cartItemRemoved', 'cartUpdated', 'cartViewed',
      'checkoutStarted', 'checkoutStep', 'login', 'signup', 'flush',
    ]) {
      expect(typeof brain[m], `window.brain.${m}`).toBe('function');
    }
    expect(listeners['pagehide']?.length ?? 0).toBeGreaterThan(0);
    expect(listeners['visibilitychange']?.length ?? 0).toBeGreaterThan(0);
  });

  it('window.brain behavioral events parse against the REAL schema (M14 / H6)', async () => {
    const { win, sent } = runAsset();
    const brain = win.brain as Record<string, (x?: unknown) => void>;
    brain.cartItemRemoved!({ variant_id: 1 });
    brain.cartUpdated!({ quantity: 3 });
    brain.checkoutStep!({ step: 'shipping' });
    brain.login!();
    brain.signup!();
    await drain(); // let the auto-fire flush chain finish
    brain.flush!(); // re-read the queue for events enqueued after the in-flight flush captured it
    await drain();
    const names = sent.map((b) => JSON.parse(b).event_name);
    expect(names).toContain('cart.item_removed');
    expect(names).toContain('cart.updated');
    expect(names).toContain('checkout.step_viewed');
    expect(names).toContain('user.logged_in');
    expect(names).toContain('user.signed_up');
    for (const body of sent) {
      expect(CollectorEventV1Schema.safeParse(JSON.parse(body)).success).toBe(true);
    }
  });

  it('classifies the account page-type into page.viewed props', () => {
    expect(JSON.parse(runAsset({ pathname: '/account' }).sent[0]!).properties.page_type).toBe('account');
    expect(JSON.parse(runAsset({ pathname: '/account/login' }).sent[0]!).properties.page_type).toBe('account_login');
    expect(JSON.parse(runAsset({ pathname: '/account/register' }).sent[0]!).properties.page_type).toBe('account_register');
  });

  it('fires checkout.step_viewed on a checkout page', async () => {
    const { sent } = runAsset({ pathname: '/checkout', search: '?step=shipping' });
    await drain();
    const names = sent.map((b) => JSON.parse(b).event_name);
    expect(names).toContain('checkout.step_viewed');
    const step = sent.map((b) => JSON.parse(b)).find((e) => e.event_name === 'checkout.step_viewed');
    expect(step.properties.step).toBe('shipping');
  });

  it('fires a BEHAVIORAL order.placed on the order-confirmation page (not revenue)', async () => {
    const { sent } = runAsset({ pathname: '/checkout/order-received/12345' });
    await drain();
    const events = sent.map((b) => JSON.parse(b));
    const order = events.find((e) => e.event_name === 'order.placed');
    expect(order, 'order.placed should fire on the thank-you page').toBeTruthy();
    expect(order.properties.order_id).toBe('12345');
    for (const e of events) expect(CollectorEventV1Schema.safeParse(e).success).toBe(true);
  });

  it('new checkout/payment-funnel helpers emit schema-valid events (H-universal)', async () => {
    const { win, sent } = runAsset();
    const brain = win.brain as Record<string, (x?: unknown) => void>;
    brain.shippingSelected!({ method: 'standard' });
    brain.paymentInitiated!({ method: 'card' });
    brain.paymentSucceeded!({ method: 'card' });
    brain.paymentFailed!({ reason: 'declined' });
    brain.orderPlaced!({ order_id: 'A1' });
    brain.couponApplied!({ code: 'SAVE10' });
    await drain();
    brain.flush!();
    await drain();
    const names = sent.map((b) => JSON.parse(b).event_name);
    for (const n of ['checkout.shipping_selected', 'payment.initiated', 'payment.succeeded', 'payment.failed', 'order.placed', 'coupon.applied']) {
      expect(names, `expected ${n}`).toContain(n);
    }
    for (const body of sent) expect(CollectorEventV1Schema.safeParse(JSON.parse(body)).success).toBe(true);
  });

  it('no raw PII / no salt on the wire (ADR-2)', () => {
    const { sent } = runAsset();
    const raw = sent[0]!.toLowerCase();
    for (const banned of ['email', 'phone', 'salt', '"name"', 'first_name']) {
      expect(raw.includes(banned), `wire body must not contain '${banned}'`).toBe(false);
    }
  });

  // ── event_id = UUIDv7 ────────────────────────────────────────────────────────
  const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it('mints event_id as a UUIDv7 (version 7 + RFC-4122 variant) that PARSES against the schema', () => {
    const { sent } = runAsset();
    const obj = JSON.parse(sent[0]!);
    expect(obj.event_id, `event_id ${obj.event_id} should be UUIDv7`).toMatch(UUID_V7_RE);
    // correlation_id stays a v4 (version nibble 4).
    expect(obj.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(CollectorEventV1Schema.safeParse(obj).success).toBe(true);
  });

  it('UUIDv7 event_ids embed a non-decreasing 48-bit ms timestamp (time-ordered)', async () => {
    const { win, sent } = runAsset();
    (win.brain as Record<string, () => void>).flush!();
    await drain();
    // First 12 hex chars (48 bits) = the big-endian Unix-ms timestamp. Date.now() is monotonic
    // non-decreasing, so the prefix is non-decreasing across mints (random bits order within a ms).
    const tsOf = (id: string): number => parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    const ids = sent.map((b) => JSON.parse(b).event_id as string);
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) expect(id).toMatch(UUID_V7_RE);
    const stamps = ids.map(tsOf);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]! >= stamps[i - 1]!).toBe(true);
    // The embedded timestamp tracks real wall-clock ms (within a generous skew window).
    expect(Math.abs(stamps[0]! - Date.now())).toBeLessThan(60000);
  });

  // ── first-touch persistence ──────────────────────────────────────────────────
  it('captures + persists first_touch on the first event and attaches it to every event', async () => {
    const { win, sent } = runAsset({ search: '?utm_source=google&utm_campaign=spring&gclid=G1' });
    const first = JSON.parse(sent[0]!).properties.first_touch;
    expect(first.landing_path).toBe('/products/widget');
    expect(first.referrer).toBe('https://google.com/');
    expect(typeof first.ts).toBe('string');
    expect(first.utm).toEqual({ source: 'google', campaign: 'spring' });
    expect(first.click_ids).toEqual({ gclid: 'G1' });
    // A later event carries the SAME persisted first-touch object (survives past the landing page).
    (win.brain as Record<string, (x?: unknown) => void>).page!({});
    await drain();
    (win.brain as Record<string, () => void>).flush!();
    await drain();
    for (const body of sent) {
      expect(JSON.parse(body).properties.first_touch).toEqual(first);
      expect(CollectorEventV1Schema.safeParse(JSON.parse(body)).success).toBe(true);
    }
  });

  it('does NOT overwrite an existing first_touch (first acquisition wins)', async () => {
    // Pre-seed a first-touch as if a PRIOR landing on another page already happened.
    const { win, sent } = runAsset({ search: '?utm_source=newsletter' });
    const ft = JSON.parse(sent[0]!).properties.first_touch;
    expect(ft.utm).toEqual({ source: 'newsletter' });
    (win.brain as Record<string, (x?: unknown) => void>).track!('custom.event', {});
    await drain();
    (win.brain as Record<string, () => void>).flush!();
    await drain();
    for (const body of sent) expect(JSON.parse(body).properties.first_touch.utm).toEqual({ source: 'newsletter' });
  });

  // ── session lifecycle ────────────────────────────────────────────────────────
  it('fires session.started exactly once at the first event of a new session', async () => {
    const { win, sent } = runAsset();
    await drain();
    (win.brain as Record<string, () => void>).flush!();
    await drain();
    const events = sent.map((b) => JSON.parse(b));
    const started = events.filter((e) => e.event_name === 'session.started');
    expect(started.length).toBe(1);
    expect(typeof started[0].properties.session_id).toBe('string');
    for (const e of events) expect(CollectorEventV1Schema.safeParse(e).success).toBe(true);
  });

  it('fires session.ended with a numeric session_duration_ms on pagehide', async () => {
    const { listeners, sent } = runAsset();
    await drain();
    listeners['pagehide']!.forEach((cb) => cb());
    await drain();
    const ended = sent.map((b) => JSON.parse(b)).find((e) => e.event_name === 'session.ended');
    expect(ended, 'session.ended should fire on pagehide').toBeTruthy();
    expect(typeof ended.properties.session_duration_ms).toBe('number');
    expect(CollectorEventV1Schema.safeParse(ended).success).toBe(true);
  });

  // ── exit intent (desktop only) ───────────────────────────────────────────────
  it('fires exit_intent when the cursor leaves through the top of the viewport (desktop)', async () => {
    const { listeners, sent } = runAsset();
    await drain();
    expect((listeners['mouseout']?.length ?? 0)).toBeGreaterThan(0);
    listeners['mouseout']![0]!({ clientY: 0, relatedTarget: null });
    await drain();
    const exit = sent.map((b) => JSON.parse(b)).find((e) => e.event_name === 'exit_intent');
    expect(exit, 'exit_intent should fire on top-edge mouseout').toBeTruthy();
    expect(CollectorEventV1Schema.safeParse(exit).success).toBe(true);
  });

  it('does NOT register the exit_intent listener on mobile', () => {
    const { listeners } = runAsset({ userAgent: 'Mozilla/5.0 (iPhone)' });
    expect(listeners['mouseout']?.length ?? 0).toBe(0);
  });

  // ── file download ────────────────────────────────────────────────────────────
  it('fires a download event on a click of a link to a downloadable asset', async () => {
    const { listeners, sent } = runAsset();
    await drain();
    const anchor: Record<string, unknown> = {
      tagName: 'A', id: 'dl', textContent: 'Get the report',
      getAttribute: (k: string) => (k === 'href' ? '/files/report.pdf?v=2' : null),
    };
    anchor.closest = () => anchor;
    listeners['click']![0]!({ target: anchor, clientX: 5, clientY: 5 });
    await drain();
    const dl = sent.map((b) => JSON.parse(b)).find((e) => e.event_name === 'download');
    expect(dl, 'download should fire').toBeTruthy();
    expect(dl.properties.file_ext).toBe('pdf');
    expect(dl.properties.href).toBe('/files/report.pdf?v=2');
    expect(CollectorEventV1Schema.safeParse(dl).success).toBe(true);
  });

  // ── native media ─────────────────────────────────────────────────────────────
  it('fires a video event with action/src/position_seconds on media play', async () => {
    const { listeners, sent } = runAsset();
    await drain();
    expect((listeners['play']?.length ?? 0)).toBeGreaterThan(0);
    listeners['play']![0]!({ target: { tagName: 'VIDEO', currentSrc: 'https://cdn.example.com/v.mp4', currentTime: 12.7 } });
    await drain();
    const vid = sent.map((b) => JSON.parse(b)).find((e) => e.event_name === 'video');
    expect(vid, 'video should fire on play').toBeTruthy();
    expect(vid.properties.action).toBe('play');
    expect(vid.properties.src).toBe('https://cdn.example.com/v.mp4');
    expect(vid.properties.position_seconds).toBe(13);
    expect(CollectorEventV1Schema.safeParse(vid).success).toBe(true);
  });

  // ── social share ─────────────────────────────────────────────────────────────
  it('fires a share event on a click of a known social-share link', async () => {
    const { listeners, sent } = runAsset();
    await drain();
    const anchor: Record<string, unknown> = {
      tagName: 'A', id: 'fb', textContent: 'Share',
      getAttribute: (k: string) => (k === 'href' ? 'https://www.facebook.com/sharer/sharer.php?u=x' : null),
    };
    anchor.closest = () => anchor;
    listeners['click']![0]!({ target: anchor, clientX: 5, clientY: 5 });
    await drain();
    const sh = sent.map((b) => JSON.parse(b)).find((e) => e.event_name === 'share');
    expect(sh, 'share should fire on a sharer link').toBeTruthy();
    expect(sh.properties.method).toBe('facebook');
    expect(CollectorEventV1Schema.safeParse(sh).success).toBe(true);
  });

  it('fires a share event (method=web_share) when navigator.share() is invoked', async () => {
    const { nav, sent } = runAsset({ withShare: true });
    await drain();
    await (nav.share as () => Promise<void>)();
    await drain();
    const sh = sent.map((b) => JSON.parse(b)).find((e) => e.event_name === 'share' && e.properties.method === 'web_share');
    expect(sh, 'web-share monkey-patch should emit share').toBeTruthy();
    expect(CollectorEventV1Schema.safeParse(sh).success).toBe(true);
  });
});
