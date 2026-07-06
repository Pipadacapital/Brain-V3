// SPEC: A.1.4
/**
 * A.1.4 (WA-09) — pixel checkout_session_id capture tests (the pixel side of the join key).
 *
 * Evals the BUILT served asset (PIXEL_ASSET_JS) in a minimal fake-DOM sandbox (same harness
 * shape as apps/collector/tests/pixel-asset.test.ts) and asserts:
 *   A1.4.4a a provider checkout global (GoKwik / Shopflo / Shopify token) present →
 *           checkout.* events carry properties.checkout_session_id;
 *   A1.4.4b no provider global → the field is honestly ABSENT (byte-identical legacy event);
 *   A1.4.4c a caller-supplied checkout_session_id is NEVER overridden;
 *   A1.4.4d non-checkout events never gain the field.
 */
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PIXEL_ASSET_JS } from './generated/pixel-asset.built.js';

const TOKEN = 'a11a0011-0a11-4a11-8a11-000000000011';
const BRAND = 'a11a0001-0a00-4a00-8a00-000000000001';

interface Harness {
  sent: string[];
  win: Record<string, unknown>;
}

function runAsset(extraWin: Record<string, unknown> = {}): Harness {
  const sent: string[] = [];
  const store = new Map<string, string>();
  const listeners: Record<string, Array<(e?: unknown) => void>> = {};

  const location = { protocol: 'https:', host: 'collect.example.com', pathname: '/products/widget', search: '' };
  const fakeFetch = (_url: string, init: { body: string }): Promise<{ ok: boolean }> => {
    sent.push(init.body);
    return Promise.resolve({ ok: true });
  };

  const win: Record<string, unknown> = {
    __brain: { install_token: TOKEN, brand_id: BRAND },
    crypto: {
      randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
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
    addEventListener: (ev: string, cb: (e?: unknown) => void) => void (listeners[ev] ??= []).push(cb),
    fetch: fakeFetch,
    Blob: class { constructor(public parts: string[]) {} },
    console: { warn: () => undefined },
    ...extraWin,
  };
  const navigator: Record<string, unknown> = { userAgent: 'Mozilla/5.0 (Macintosh)' };
  const document = {
    referrer: '',
    cookie: '',
    visibilityState: 'visible',
    addEventListener: (ev: string, cb: (e?: unknown) => void) => void (listeners[ev] ??= []).push(cb),
  };
  class FakeXHR { open(): void {} send(): void {} }

  const sandbox = {
    window: win, document, navigator, location,
    Blob: win.Blob, fetch: fakeFetch, XMLHttpRequest: FakeXHR,
    RegExp, decodeURIComponent, console: win.console,
    Date, Math, JSON, Object, setTimeout, Uint8Array,
  };
  win.fetch = fakeFetch;
  win.XMLHttpRequest = FakeXHR;
  vm.createContext(sandbox);
  vm.runInContext(PIXEL_ASSET_JS, sandbox);
  return { sent, win };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function eventsByName(sent: string[], name: string): Array<{ properties: Record<string, unknown> }> {
  return sent.map((b) => JSON.parse(b)).filter((e) => e.event_name === name);
}

describe('A.1.4 pixel checkout_session_id capture (WA-09)', () => {
  it('A1.4.4a GoKwik global present → checkout.started carries checkout_session_id', async () => {
    const { sent, win } = runAsset({ gokwik: { checkout_id: 'gk_sess_42' } });
    const brain = win.brain as Record<string, (x?: unknown) => void>;
    brain.checkoutStarted!({});
    await drain();
    const [ev] = eventsByName(sent, 'checkout.started');
    expect(ev).toBeTruthy();
    expect(ev!.properties.checkout_session_id).toBe('gk_sess_42');
  });

  it('A1.4.4a Shopflo + Shopify globals are probed too', async () => {
    const flo = runAsset({ shopflo: { checkout_session_id: 'flo_sess_7' } });
    (flo.win.brain as Record<string, (x?: unknown) => void>).checkoutStep!({ step: 'address' });
    await drain();
    expect(eventsByName(flo.sent, 'checkout.step_viewed')[0]!.properties.checkout_session_id).toBe('flo_sess_7');

    const shopify = runAsset({ Shopify: { checkout: { token: 'shp_tok_1' } } });
    (shopify.win.brain as Record<string, (x?: unknown) => void>).checkoutStarted!({});
    await drain();
    expect(eventsByName(shopify.sent, 'checkout.started')[0]!.properties.checkout_session_id).toBe('shp_tok_1');
  });

  it('A1.4.4b no provider global → field honestly ABSENT (legacy event unchanged)', async () => {
    const { sent, win } = runAsset();
    (win.brain as Record<string, (x?: unknown) => void>).checkoutStarted!({});
    await drain();
    const [ev] = eventsByName(sent, 'checkout.started');
    expect(ev).toBeTruthy();
    expect('checkout_session_id' in ev!.properties).toBe(false);
  });

  it('A1.4.4c caller-supplied checkout_session_id is never overridden', async () => {
    const { sent, win } = runAsset({ gokwik: { checkout_id: 'gk_sess_42' } });
    (win.brain as Record<string, (x?: unknown) => void>).checkoutStarted!({ checkout_session_id: 'explicit_1' });
    await drain();
    expect(eventsByName(sent, 'checkout.started')[0]!.properties.checkout_session_id).toBe('explicit_1');
  });

  it('A1.4.4d non-checkout events never gain the field', async () => {
    const { sent, win } = runAsset({ gokwik: { checkout_id: 'gk_sess_42' } });
    (win.brain as Record<string, (x?: unknown) => void>).cartViewed!({});
    await drain();
    const [ev] = eventsByName(sent, 'cart.viewed');
    expect(ev).toBeTruthy();
    expect('checkout_session_id' in ev!.properties).toBe(false);
  });
});
