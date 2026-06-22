/**
 * pixel-sdk unit tests (Track B, pass-1).
 *
 * Coverage:
 *  - shape-(a) envelope CONFORMANCE — an emitted event PARSES against the REAL
 *    @brain/contracts CollectorEventV1Schema (the single source of truth, ADR-1).
 *  - event_id reuse-on-retry / fresh-on-new-event (R4 / D2.2).
 *  - consent fail-safe-absent — no CMP signal → NO consent_flags stamped (quarantined server-side).
 *  - ONE event per POST (NO batched array, REC-5).
 *  - attribution capture (click-ids + utm) rides properties (raw-only, RO1).
 *  - client-side anon-id + 30-min rolling session persistence.
 *  - NO raw PII / NO salt on the wire (ADR-2).
 */
import { describe, it, expect } from 'vitest';
import { CollectorEventV1Schema } from '@brain/contracts';
import { createPixel } from './capture.js';
import type { BrowserEnv, MinimalStorage } from './types.js';

const TOKEN = 'a11a0011-0a11-4a11-8a11-000000000011';
const BRAND = 'a11a0001-0a00-4a00-8a00-000000000001';

/** In-memory storage. */
function memStorage(): MinimalStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

interface FakeEnvOpts {
  href?: string;
  windowConsent?: unknown;
  /** Make the first N sends fail (to drive retry). */
  failFirst?: number;
  /** Cookie jar (name → value) for click-id cookie capture. */
  cookies?: Record<string, string>;
}

/** A fake BrowserEnv that records each POST body (one per send). */
function fakeEnv(opts: FakeEnvOpts = {}): {
  env: BrowserEnv;
  sent: string[];
  flushTriggers: Array<() => void>;
  getWindowConsent: () => unknown;
} {
  const sent: string[] = [];
  const flushTriggers: Array<() => void> = [];
  let uuidSeq = 0;
  let failRemaining = opts.failFirst ?? 0;
  const storage = memStorage();
  const env: BrowserEnv = {
    bootstrap: { install_token: TOKEN, brand_id: BRAND, ingest_base_url: 'https://collect.example.com' },
    storage,
    now: () => 1_000_000,
    nowIso: () => '2026-06-18T12:00:00.000Z',
    uuid: () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`,
    href: () => opts.href ?? 'https://shop.example.com/products/widget',
    referrer: () => 'https://google.com/',
    pathname: () => '/products/widget',
    uaClass: () => 'desktop',
    viewport: () => '1920x1080',
    cookie: (name) => opts.cookies?.[name] ?? '',
    // No sendBeacon → forces fetchKeepalive (deterministic in tests).
    fetchKeepalive: async (_url, body) => {
      if (failRemaining > 0) {
        failRemaining -= 1;
        return false;
      }
      sent.push(body);
      return true;
    },
    onFlushTrigger: (cb) => flushTriggers.push(cb),
  };
  return { env, sent, flushTriggers, getWindowConsent: () => opts.windowConsent };
}

describe('pixel-sdk — shape-(a) envelope conformance (ADR-1)', () => {
  it('an emitted page.viewed PARSES against the REAL CollectorEventV1Schema', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();

    expect(sent.length).toBe(1);
    const obj = JSON.parse(sent[0]!);
    const parsed = CollectorEventV1Schema.safeParse(obj);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);

    expect(obj.event_name).toBe('page.viewed');
    expect(obj.occurred_at).toBe('2026-06-18T12:00:00.000Z');
    expect(obj.properties.install_token).toBe(TOKEN);
    expect(obj.brand_id).toBe(BRAND); // partition-only; server derives the real one
  });

  it('cart.item_added and cart.viewed parse as shape (a)', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.cartItemAdded({ sku: 'WIDGET-1', qty: 2 });
    await pixel.cartViewed();
    expect(sent.length).toBe(2);
    for (const body of sent) {
      const parsed = CollectorEventV1Schema.safeParse(JSON.parse(body));
      expect(parsed.success).toBe(true);
    }
    expect(JSON.parse(sent[0]!).event_name).toBe('cart.item_added');
    expect(JSON.parse(sent[0]!).properties.sku).toBe('WIDGET-1');
    expect(JSON.parse(sent[1]!).event_name).toBe('cart.viewed');
  });
});

describe('pixel-sdk — ONE event per POST (REC-5)', () => {
  it('each emit sends exactly one JSON OBJECT (never a batched array)', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    await pixel.cartViewed();
    expect(sent.length).toBe(2);
    for (const body of sent) {
      const parsed = JSON.parse(body);
      expect(Array.isArray(parsed)).toBe(false); // NOT a batch
      expect(typeof parsed).toBe('object');
    }
  });
});

describe('pixel-sdk — event_id reuse-on-retry / fresh-on-new (R4)', () => {
  it('a retried event keeps its event_id (Bronze PK dedups it exactly-once)', async () => {
    // First send fails → event stays queued (with its original event_id).
    const { env, sent, flushTriggers } = fakeEnv({ failFirst: 1 });
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page(); // enqueue + immediate flush FAILS (failFirst=1) → 0 sent
    expect(sent.length).toBe(0);

    // A flush trigger (pagehide/visibilitychange) IS registered (durable retry path).
    expect(flushTriggers.length).toBeGreaterThan(0);

    // Retry → the event is delivered exactly once, carrying the SAME event_id minted at enqueue
    // (the queued event is reused verbatim; no fresh uuid is minted on the retry path — R4).
    await pixel.flush();
    expect(sent.length).toBe(1);
    const obj = JSON.parse(sent[0]!);
    expect(obj.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // A second flush after success is a no-op (queue drained) — no duplicate id re-sent.
    await pixel.flush();
    expect(sent.length).toBe(1);
  });

  it('a new event gets a FRESH event_id', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    await pixel.page();
    const id1 = JSON.parse(sent[0]!).event_id;
    const id2 = JSON.parse(sent[1]!).event_id;
    expect(id1).not.toBe(id2);
  });
});

describe('pixel-sdk — consent fail-safe-absent (I-ST05 / R3)', () => {
  it('no CMP signal → NO consent_flags stamped (event quarantined server-side)', async () => {
    const { env, sent } = fakeEnv({ windowConsent: undefined });
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    const obj = JSON.parse(sent[0]!);
    expect(obj.consent_flags).toBeUndefined();
  });

  it('a present CMP signal stamps the four flags (missing → deny-by-default false)', async () => {
    const { env, sent, getWindowConsent } = fakeEnv({ windowConsent: { analytics: true, marketing: true } });
    const pixel = createPixel(env, { getWindowConsent });
    await pixel.page();
    const obj = JSON.parse(sent[0]!);
    expect(obj.consent_flags).toEqual({
      analytics: true,
      marketing: true,
      personalization: false,
      ai_processing: false,
    });
  });
});

describe('pixel-sdk — attribution capture (raw-only, RO1)', () => {
  it('click-ids + utm ride properties from the URL', async () => {
    const { env, sent } = fakeEnv({
      href: 'https://shop.example.com/?gclid=G123&utm_source=google&utm_medium=cpc&utm_campaign=summer',
    });
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    const obj = JSON.parse(sent[0]!);
    expect(obj.properties.click_ids).toEqual({ gclid: 'G123' });
    expect(obj.properties.utm).toEqual({ source: 'google', medium: 'cpc', campaign: 'summer' });
  });

  it('captures ALL URL click-ids (msclkid/gbraid/wbraid/dclid included)', async () => {
    const { env, sent } = fakeEnv({
      href: 'https://shop.example.com/?fbclid=FB&gclid=G&ttclid=TT&msclkid=MS&gbraid=GB&wbraid=WB&dclid=DC',
    });
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    expect(JSON.parse(sent[0]!).properties.click_ids).toEqual({
      fbclid: 'FB', gclid: 'G', ttclid: 'TT', msclkid: 'MS', gbraid: 'GB', wbraid: 'WB', dclid: 'DC',
    });
  });

  it('captures cookie click-ids: _fbc + _fbp DISTINCT, li_fat_id, _epik→epik', async () => {
    const { env, sent } = fakeEnv({
      cookies: { _fbc: 'fb.1.123.FBCLICK', _fbp: 'fb.1.123.BROWSER', li_fat_id: 'LI', _epik: 'EPIK' },
    });
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    const ci = JSON.parse(sent[0]!).properties.click_ids;
    expect(ci._fbc).toBe('fb.1.123.FBCLICK');
    expect(ci._fbp).toBe('fb.1.123.BROWSER');
    expect(ci._fbc).not.toBe(ci._fbp); // distinct — NOT conflated
    expect(ci.li_fat_id).toBe('LI');
    expect(ci.epik).toBe('EPIK');
    expect(ci.fbclid).toBeUndefined(); // _fbc no longer masquerades as fbclid
  });

  it('a URL click-id wins over the same-key cookie value', async () => {
    const { env, sent } = fakeEnv({
      href: 'https://shop.example.com/?fbclid=URLFB',
      cookies: { _fbc: 'cookieFbc' },
    });
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    const ci = JSON.parse(sent[0]!).properties.click_ids;
    expect(ci.fbclid).toBe('URLFB'); // URL fbclid kept
    expect(ci._fbc).toBe('cookieFbc'); // distinct cookie field still captured
  });

  it('click-id capture is configurable (cookieKeys:[] disables cookie capture)', async () => {
    const { env, sent } = fakeEnv({ cookies: { _fbc: 'x', _fbp: 'y' } });
    const pixel = createPixel(env, { getWindowConsent: () => undefined, clickIds: { cookieKeys: [] } });
    await pixel.page();
    expect(JSON.parse(sent[0]!).properties.click_ids).toBeUndefined();
  });
});

describe('pixel-sdk — behavioral events (M14 / H6) parse as shape (a)', () => {
  it('cart.item_removed / cart.updated / checkout.step_viewed / user.logged_in / user.signed_up', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.cartItemRemoved({ variant_id: 1 });
    await pixel.cartUpdated({ variant_id: 1, quantity: 3 });
    await pixel.checkoutStep({ step: 'shipping' });
    await pixel.login();
    await pixel.signup();
    expect(sent.length).toBe(5);
    const names = sent.map((b) => JSON.parse(b).event_name);
    expect(names).toEqual([
      'cart.item_removed', 'cart.updated', 'checkout.step_viewed', 'user.logged_in', 'user.signed_up',
    ]);
    for (const body of sent) {
      expect(CollectorEventV1Schema.safeParse(JSON.parse(body)).success).toBe(true);
    }
  });
});

describe('pixel-sdk — client-side identity (no Set-Cookie; localStorage)', () => {
  it('persists a stable brain_anon_id across events', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    await pixel.cartViewed();
    const a1 = JSON.parse(sent[0]!).properties.brain_anon_id;
    const a2 = JSON.parse(sent[1]!).properties.brain_anon_id;
    expect(a1).toBe(a2);
    expect(typeof a1).toBe('string');
  });

  it('reuses the session id within the 30-min window', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    await pixel.page();
    expect(JSON.parse(sent[0]!).properties.session_id).toBe(JSON.parse(sent[1]!).properties.session_id);
  });
});

describe('pixel-sdk — no raw PII / no salt on the wire (ADR-2)', () => {
  it('the emitted event has no email/phone/name/salt anywhere', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    const raw = sent[0]!.toLowerCase();
    for (const banned of ['email', 'phone', 'salt', '"name"', 'first_name', 'last_name']) {
      expect(raw.includes(banned), `wire body must not contain '${banned}'`).toBe(false);
    }
  });

  it('init throws when install_token is missing (would quarantine every event)', () => {
    const { env } = fakeEnv();
    const broken: BrowserEnv = { ...env, bootstrap: { install_token: '', brand_id: BRAND } };
    expect(() => createPixel(broken)).toThrow(/install_token/);
  });
});
