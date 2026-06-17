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
} = {}): Harness {
  const sent: string[] = [];
  const store = new Map<string, string>();
  const listeners: Record<string, Array<() => void>> = {};

  const location = {
    protocol: 'https:',
    host: 'collect.example.com',
    pathname: '/products/widget',
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
    cookie: '',
    visibilityState: 'visible',
    addEventListener: (ev: string, cb: () => void) => {
      (listeners[ev] ??= []).push(cb);
    },
  };

  const sandbox = {
    window: win,
    document,
    navigator,
    location,
    Blob: win.Blob,
    fetch: fakeFetch,
    console: win.console,
    Date,
    Math,
    JSON,
    Object,
    setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(PIXEL_JS, sandbox);
  return { sent, listeners, win };
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

  it('exposes window.brain with page/cart/track/flush + registers flush triggers', () => {
    const { win, listeners } = runAsset();
    const brain = win.brain as Record<string, unknown>;
    expect(typeof brain.page).toBe('function');
    expect(typeof brain.cartItemAdded).toBe('function');
    expect(typeof brain.cartViewed).toBe('function');
    expect(typeof brain.flush).toBe('function');
    expect(listeners['pagehide']?.length ?? 0).toBeGreaterThan(0);
    expect(listeners['visibilitychange']?.length ?? 0).toBeGreaterThan(0);
  });

  it('no raw PII / no salt on the wire (ADR-2)', () => {
    const { sent } = runAsset();
    const raw = sent[0]!.toLowerCase();
    for (const banned of ['email', 'phone', 'salt', '"name"', 'first_name']) {
      expect(raw.includes(banned), `wire body must not contain '${banned}'`).toBe(false);
    }
  });
});
