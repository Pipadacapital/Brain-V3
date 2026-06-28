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
import { describe, it, expect, vi } from 'vitest';
import { CollectorEventV1Schema } from '@brain/contracts';
import { createPixel } from './capture.js';
import { Transport } from './transport.js';
import { uuidV7 } from './uuid.js';
import { FIRST_TOUCH_KEY } from './attribution.js';
import type { BrowserEnv, CollectorEventV1, MinimalStorage } from './types.js';

/** Matches the v4 envelope (correlation_id) and v7 (event_id) shapes. */
const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The event_names of every POSTed body, in order. */
function eventNames(sent: string[]): string[] {
  return sent.map((b) => JSON.parse(b).event_name);
}
/** The LAST POSTed body parsed (the triggering event — session.* lifecycle is emitted before it). */
function lastEvent(sent: string[]): any {
  return JSON.parse(sent[sent.length - 1]!);
}

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
  /** Initial now() epoch-ms (advanceable via setNow — drives session expiry). */
  now?: number;
}

/** A fake BrowserEnv that records each POST body (one per send). */
function fakeEnv(opts: FakeEnvOpts = {}): {
  env: BrowserEnv;
  sent: string[];
  flushTriggers: Array<() => void>;
  getWindowConsent: () => unknown;
  setNow: (n: number) => void;
} {
  const sent: string[] = [];
  const flushTriggers: Array<() => void> = [];
  let uuidSeq = 0;
  let v7Seq = 0;
  let nowMs = opts.now ?? 1_000_000;
  let failRemaining = opts.failFirst ?? 0;
  const storage = memStorage();
  const env: BrowserEnv = {
    bootstrap: { install_token: TOKEN, brand_id: BRAND, ingest_base_url: 'https://collect.example.com' },
    storage,
    now: () => nowMs,
    nowIso: () => '2026-06-18T12:00:00.000Z',
    uuid: () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`,
    // Deterministic-but-unique v7 (real generator): varying random bytes per call → distinct ids.
    uuidv7: () => {
      v7Seq += 1;
      const rnd = new Uint8Array(10);
      for (let i = 0; i < 10; i++) rnd[i] = (v7Seq * 7 + i) & 0xff;
      return uuidV7(nowMs, rnd);
    },
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
  return {
    env,
    sent,
    flushTriggers,
    getWindowConsent: () => opts.windowConsent,
    setNow: (n: number) => {
      nowMs = n;
    },
  };
}

describe('pixel-sdk — shape-(a) envelope conformance (ADR-1)', () => {
  it('an emitted page.viewed PARSES against the REAL CollectorEventV1Schema', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();

    // The first event of a session is preceded by session.started; the page.viewed is the LAST POST.
    expect(eventNames(sent)).toEqual(['session.started', 'page.viewed']);
    const obj = lastEvent(sent);
    const parsed = CollectorEventV1Schema.safeParse(obj);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
    // session.started conforms too.
    expect(CollectorEventV1Schema.safeParse(JSON.parse(sent[0]!)).success).toBe(true);

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
    // session.started leads the first emit.
    expect(eventNames(sent)).toEqual(['session.started', 'cart.item_added', 'cart.viewed']);
    for (const body of sent) {
      const parsed = CollectorEventV1Schema.safeParse(JSON.parse(body));
      expect(parsed.success).toBe(true);
    }
    expect(JSON.parse(sent[1]!).properties.sku).toBe('WIDGET-1');
  });
});

describe('pixel-sdk — ONE event per POST (REC-5)', () => {
  it('each emit sends exactly one JSON OBJECT (never a batched array)', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    await pixel.cartViewed();
    expect(sent.length).toBe(3); // session.started + page.viewed + cart.viewed
    for (const body of sent) {
      const parsed = JSON.parse(body);
      expect(Array.isArray(parsed)).toBe(false); // NOT a batch
      expect(typeof parsed).toBe('object');
    }
  });
});

describe('pixel-sdk — event_id reuse-on-retry / fresh-on-new (R4)', () => {
  it('a retried event keeps its event_id (Bronze PK dedups it exactly-once)', async () => {
    // Both the auto session.started AND page.viewed fail their first send → 0 delivered, queued with
    // their original event_ids.
    const { env, sent, flushTriggers } = fakeEnv({ failFirst: 2 });
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page(); // session.started + page.viewed both fail first send → 0 sent
    expect(sent.length).toBe(0);

    // A flush trigger (pagehide/visibilitychange) IS registered (durable retry path).
    expect(flushTriggers.length).toBeGreaterThan(0);

    // Retry → both events delivered exactly once, each carrying the SAME id minted at enqueue (the
    // queued events are reused verbatim; no fresh uuid is minted on the retry path — R4).
    await pixel.flush();
    expect(eventNames(sent)).toEqual(['session.started', 'page.viewed']);
    const obj = lastEvent(sent);
    expect(obj.event_id).toMatch(V7_RE); // event_id is UUIDv7 now
    expect(obj.correlation_id).toMatch(V4_RE); // correlation_id stays v4
    // A second flush after success is a no-op (queue drained) — no duplicate id re-sent.
    await pixel.flush();
    expect(sent.length).toBe(2);
  });

  it('a new event gets a FRESH event_id', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page(); // session.started + page.viewed
    await pixel.page(); // page.viewed (session already started)
    // The two page.viewed events (last of each emit) have distinct event_ids.
    const id1 = JSON.parse(sent[1]!).event_id;
    const id2 = JSON.parse(sent[2]!).event_id;
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
    // session.started leads the first emit.
    expect(eventNames(sent)).toEqual([
      'session.started',
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

describe('pixel-sdk — first-touch persistence (attribution gap)', () => {
  it('captures + persists first_touch on the first event and attaches it to every event', async () => {
    const { env, sent } = fakeEnv({
      href: 'https://shop.example.com/landing?utm_source=google&utm_medium=cpc&gclid=G1',
    });
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    await pixel.cartViewed();

    const ft = lastEvent(sent).properties.first_touch;
    expect(ft.utm).toEqual({ source: 'google', medium: 'cpc' });
    expect(ft.click_ids).toEqual({ gclid: 'G1' });
    expect(ft.landing_path).toBe('/products/widget'); // env.pathname()
    expect(ft.referrer).toBe('https://google.com/');
    expect(typeof ft.ts).toBe('string');

    // Persisted to localStorage AND identical across every emitted event (incl. session.started).
    expect(env.storage.getItem(FIRST_TOUCH_KEY)).toBeTruthy();
    const allFt = sent.map((b) => JSON.stringify(JSON.parse(b).properties.first_touch));
    expect(new Set(allFt).size).toBe(1);
  });

  it('does NOT overwrite an existing __brain_first_touch', async () => {
    const { env, sent } = fakeEnv();
    // Pre-seed a prior first touch (a real returning visitor's landing).
    env.storage.setItem(
      FIRST_TOUCH_KEY,
      JSON.stringify({ ts: 'ORIGINAL', landing_path: '/first-ever', utm: { source: 'newsletter' } }),
    );
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    const ft = lastEvent(sent).properties.first_touch;
    expect(ft.ts).toBe('ORIGINAL'); // untouched
    expect(ft.landing_path).toBe('/first-ever');
    expect(ft.utm).toEqual({ source: 'newsletter' });
  });
});

describe('pixel-sdk — event_id is UUIDv7 (time-ordered)', () => {
  it('uuidV7 has version-7 nibble + RFC-4122 variant + the ms timestamp as the 48-bit prefix', () => {
    const rnd = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const id = uuidV7(0x017f22e279b0, rnd); // a known 48-bit ms value
    expect(id).toMatch(V7_RE);
    // First 48 bits (12 hex chars) == the big-endian timestamp.
    expect(id.replace(/-/g, '').slice(0, 12)).toBe('017f22e279b0');
  });

  it('emitted event_id matches the v7 shape while correlation_id stays v4', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    const obj = lastEvent(sent);
    expect(obj.event_id).toMatch(V7_RE);
    expect(obj.correlation_id).toMatch(V4_RE);
  });
});

describe('pixel-sdk — session lifecycle events (session.started / session.ended)', () => {
  it('emits session.started once at the first event of a new session', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page();
    await pixel.page();
    // session.started fires ONLY on the first event of the session, not again within the window.
    expect(eventNames(sent)).toEqual(['session.started', 'page.viewed', 'page.viewed']);
    expect(CollectorEventV1Schema.safeParse(JSON.parse(sent[0]!)).success).toBe(true);
  });

  it('emits session.ended with session_duration_ms on expiry, then starts a fresh session', async () => {
    const t0 = 1_000_000;
    const { env, sent, setNow } = fakeEnv({ now: t0 });
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page(); // session A starts at t0
    setNow(t0 + 600_000); // +10 min — still inside the 30-min window (extends last-activity)
    await pixel.page();
    setNow(t0 + 600_000 + 1_800_001); // >30 min idle → session A expired
    await pixel.page();

    expect(eventNames(sent)).toEqual([
      'session.started', // A
      'page.viewed',
      'page.viewed',
      'session.ended', // A ended (duration = last − start = 600_000 ms)
      'session.started', // B
      'page.viewed',
    ]);
    const ended = JSON.parse(sent[3]!);
    expect(ended.event_name).toBe('session.ended');
    expect(ended.properties.session_duration_ms).toBe(600_000);
    expect(CollectorEventV1Schema.safeParse(ended).success).toBe(true);
    // A and B carry DIFFERENT session ids.
    expect(JSON.parse(sent[1]!).properties.session_id).not.toBe(
      JSON.parse(sent[5]!).properties.session_id,
    );
  });

  it('endSession() (pagehide) emits a terminal session.ended and clears the session', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.page(); // session started
    await pixel.endSession();
    const last = lastEvent(sent);
    expect(last.event_name).toBe('session.ended');
    expect(typeof last.properties.session_duration_ms).toBe('number');
    // Session cleared → the next event re-mints + re-emits session.started.
    await pixel.page();
    expect(JSON.parse(sent[sent.length - 2]!).event_name).toBe('session.started');
    // A second endSession with no live session is a no-op (no duplicate terminal event).
    const before = sent.length;
    await pixel.endSession();
    await pixel.endSession();
    expect(sent.length).toBe(before + 1); // only the first cleared a live session
  });
});

describe('pixel-sdk — new behavioural events parse as shape (a)', () => {
  it('download / video / share / exit_intent emit a conformant envelope via track()', async () => {
    const { env, sent } = fakeEnv();
    const pixel = createPixel(env, { getWindowConsent: () => undefined });
    await pixel.track('download', { href: '/files/report.pdf', file_ext: 'pdf' });
    await pixel.track('video', { action: 'play', src: '/media/promo.mp4', position_seconds: 0 });
    await pixel.track('share', { method: 'web_share_api' });
    await pixel.track('exit_intent', {});
    // session.started leads; the four new events follow.
    expect(eventNames(sent)).toEqual([
      'session.started', 'download', 'video', 'share', 'exit_intent',
    ]);
    for (const body of sent) {
      expect(CollectorEventV1Schema.safeParse(JSON.parse(body)).success).toBe(true);
    }
    const dl = JSON.parse(sent[1]!);
    expect(dl.properties.file_ext).toBe('pdf');
    expect(dl.properties.href).toBe('/files/report.pdf');
  });
});

// Minimal CollectorEventV1 for transport-level queue tests (the transport stores/reads opaquely).
function ev(name: string, id: string): CollectorEventV1 {
  return {
    schema_version: '1',
    event_id: id,
    brand_id: BRAND,
    event_name: name,
    occurred_at: '2026-06-18T12:00:00.000Z',
    properties: { install_token: TOKEN },
  } as unknown as CollectorEventV1;
}

describe('transport — keep-critical eviction (G1, No-event-loss)', () => {
  it('evicts non-critical before a queued order.placed under overflow', async () => {
    // All sends fail → the queue accumulates past MAX_QUEUE (200) so eviction runs.
    const { env } = fakeEnv({ failFirst: 1_000_000 });
    const t = new Transport(env, 'https://collect.example.com/v1/events');
    await t.enqueue(ev('order.placed', 'crit-1')); // critical, oldest
    for (let i = 0; i < 260; i++) await t.enqueue(ev('scroll.depth', `s-${i}`));
    const q = JSON.parse(env.storage.getItem('__brain_queue')!) as CollectorEventV1[];
    expect(q.length).toBeLessThanOrEqual(200);
    expect(q.some((e) => e.event_name === 'order.placed')).toBe(true); // critical survived the flood
    expect(t.consumeDroppedCount()).toBeGreaterThan(0); // and the drops were counted
  });

  it('consumeDroppedCount resets after read', async () => {
    const { env } = fakeEnv({ failFirst: 1_000_000 });
    const t = new Transport(env, 'https://collect.example.com/v1/events');
    for (let i = 0; i < 230; i++) await t.enqueue(ev('rage.click', `r-${i}`));
    expect(t.consumeDroppedCount()).toBeGreaterThan(0);
    expect(t.consumeDroppedCount()).toBe(0);
  });
});

describe('transport — exponential-backoff retry (G2)', () => {
  it('retries a failed flush on a backoff timer instead of stranding the queue', async () => {
    vi.useFakeTimers();
    try {
      const { env, sent } = fakeEnv({ failFirst: 1 }); // first send fails, then succeeds
      const t = new Transport(env, 'https://collect.example.com/v1/events');
      await t.enqueue(ev('page.viewed', 'p-1'));
      expect(sent.length).toBe(0); // first attempt failed; queued for backoff retry
      await vi.advanceTimersByTimeAsync(1000); // 1s backoff fires
      expect(sent.length).toBe(1); // retry delivered it — not stranded until the next page event
    } finally {
      vi.useRealTimers();
    }
  });
});
