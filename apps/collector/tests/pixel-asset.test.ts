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
  listeners: Record<string, Array<() => void>>;
  win: Record<string, unknown>;
}

/** Build a minimal fake-DOM sandbox + eval the asset in it. Returns captured POST bodies. */
function runAsset(opts: {
  search?: string;
  consent?: unknown;
  fetchOk?: boolean;
  cookie?: string;
  pathname?: string;
} = {}): Harness {
  const sent: string[] = [];
  const store = new Map<string, string>();
  const listeners: Record<string, Array<() => void>> = {};

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
    crypto: { randomUUID: () => randUuid() },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    location,
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: (ev: string, cb: () => void) => {
      (listeners[ev] ??= []).push(cb);
    },
    fetch: fakeFetch,
    Blob: class {
      constructor(public parts: string[]) {}
    },
    console: { warn: () => undefined },
  };
  // sendBeacon intentionally absent → forces the fetch path (deterministic capture).
  const navigator = { userAgent: 'Mozilla/5.0 (Macintosh)', /* no sendBeacon */ };
  const document = {
    referrer: 'https://google.com/',
    cookie: opts.cookie ?? '',
    visibilityState: 'visible',
    addEventListener: (ev: string, cb: (e?: unknown) => void) => {
      (listeners[ev] ??= []).push(cb as () => void);
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
  };
  win.fetch = fakeFetch;
  win.XMLHttpRequest = FakeXHR;
  vm.createContext(sandbox);
  vm.runInContext(PIXEL_JS, sandbox);
  return { sent, listeners, win };
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
});
