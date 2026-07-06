// SPEC: A.1.2 (WA-08 — per-brand consent model: config, cmp_signal/__tcfapi, bootstrap injection)
/**
 * pixel-consent.a12.test.ts — the WA-08 consent model end-to-end on the collector side:
 *
 *   A1.2 consent_state    — assume_granted ⇒ 'granted'; cmp_signal reads window.brainConsent
 *                           (generic boolean) + the __brainConsent object signal + IAB TCF
 *                           __tcfapi (purpose 1); NO signal ⇒ 'denied'. Explicit-API identifies
 *                           are still SENT carrying consent_state='denied' (the Silver AMD-04
 *                           gate is the enforcement chokepoint — a12_identify_consent_denied_test.py).
 *   A1.2 bootstrap config — createPixelIdentityConfigService: flag-gated (pixel.identify default
 *                           OFF), token-authorized brand config, whitelist-validated injection,
 *                           fail-closed-to-legacy on ANY failure; the /pixel.js templating pass
 *                           injects `identity:{…}` only when resolved.
 *   A1.1/A1.2 strict-SLA  — the collector /collect path accepts pixel.identify.v1 unchanged
 *                           (accept-before-validate: it is just another event_name).
 */
import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import Fastify from 'fastify';
import { createHash, webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { PIXEL_JS, registerPixelAssetRoute } from '../src/interfaces/rest/pixel-asset.route.js';
import {
  createPixelIdentityConfigService,
  serializeIdentityBootstrapField,
  type BrandConsentConfigReader,
  type PixelIdentityBootstrap,
} from '../src/interfaces/rest/pixel-identity-config.js';
import { registerCollectRoute } from '../src/interfaces/rest/collect.route.js';
import type { AcceptEventUseCase } from '../src/application/accept-event.usecase.js';
import type { FlagService } from '@brain/platform-flags';

const TOKEN = 'a12a0011-0a11-4a11-8a11-000000000012';
const BRAND = 'a12a0001-0a00-4a00-8a00-000000000002';
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ── Minimal vm harness (identify-focused subset of pixel-identify.a11.test.ts) ───────────────────
function runAsset(opts: {
  identity: Record<string, unknown>;
  brainConsent?: unknown;
  legacyConsentObject?: unknown;
  tcfPurpose1?: boolean;
  tcfGdprApplies?: boolean;
}): { sent: string[]; win: Record<string, unknown>; identifies: () => Array<Record<string, any>> } {
  const sent: string[] = [];
  const store = new Map<string, string>();
  const session = new Map<string, string>();
  const location = { protocol: 'https:', host: 'collect.example.com', pathname: '/', search: '' };
  const fakeFetch = (_u: string, init: { body: string }): Promise<{ ok: boolean }> => {
    sent.push(init.body);
    return Promise.resolve({ ok: true });
  };
  const win: Record<string, unknown> = {
    __brain: { install_token: TOKEN, brand_id: BRAND, identity: opts.identity },
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
      subtle: webcrypto.subtle,
    },
    TextEncoder,
    Uint8Array,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    sessionStorage: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    },
    location,
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => undefined,
    fetch: fakeFetch,
    Blob: class {
      constructor(public parts: string[]) {}
    },
    console: { warn: () => undefined },
  };
  if (opts.brainConsent !== undefined) win['brainConsent'] = opts.brainConsent;
  if (opts.legacyConsentObject !== undefined) win['__brainConsent'] = opts.legacyConsentObject;
  if (opts.tcfPurpose1 !== undefined || opts.tcfGdprApplies !== undefined) {
    win['__tcfapi'] = (_cmd: string, _v: number, cb: (t: unknown, s: boolean) => void) =>
      cb(
        {
          gdprApplies: opts.tcfGdprApplies ?? true,
          purpose: { consents: { 1: opts.tcfPurpose1 === true } },
        },
        true,
      );
  }
  const document = {
    referrer: '',
    cookie: '',
    visibilityState: 'visible',
    documentElement: {},
    addEventListener: () => undefined,
    querySelectorAll: () => [],
  };
  class FakeXHR {
    open(): void {}
    send(): void {}
  }
  const sandbox = {
    window: win,
    document,
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh)' },
    location,
    Blob: win['Blob'],
    fetch: fakeFetch,
    XMLHttpRequest: FakeXHR,
    RegExp,
    decodeURIComponent,
    console: win['console'],
    Date,
    Math,
    JSON,
    Object,
    setTimeout,
    Uint8Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(PIXEL_JS, sandbox);
  return {
    sent,
    win,
    identifies: () =>
      sent
        .map((b) => JSON.parse(b) as Record<string, any>)
        .filter((e) => e['event_name'] === 'pixel.identify.v1'),
  };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

const BASE_IDENTITY = {
  enabled: true,
  capture: 'explicit_only',
  consent_source: 'cmp_signal',
  autodetect: false,
  phone_country: 'IN',
};

describe('A1.2 — consent_state resolution in the pixel', () => {
  it("A1.2: assume_granted ⇒ 'granted' (the AMD-04 grandfathered posture)", async () => {
    const h = runAsset({ identity: { ...BASE_IDENTITY, consent_source: 'assume_granted' } });
    (h.win['brain'] as any).identify({ email: 'a@b.com' });
    await drain();
    expect(h.identifies()[0]!['properties']['consent_state']).toBe('granted');
  });

  it("A1.2: cmp_signal with NO signal ⇒ explicit identify still emits, carrying consent_state='denied' (Silver drops it — server-side enforcement)", async () => {
    const h = runAsset({ identity: BASE_IDENTITY });
    (h.win['brain'] as any).identify({ email: 'a@b.com' });
    await drain();
    const ev = h.identifies()[0]!;
    expect(ev['properties']['consent_state']).toBe('denied');
    // Hash-only even when denied (no raw PII ever) — the payload carries no plaintext email.
    expect(JSON.stringify(ev)).not.toContain('a@b.com');
    expect(ev['properties']['identifiers']['email_sha256']).toBe(sha256('a@b.com'));
  });

  it('A1.2: cmp_signal reads the generic window.brainConsent boolean', async () => {
    const granted = runAsset({ identity: BASE_IDENTITY, brainConsent: true });
    (granted.win['brain'] as any).identify({ email: 'a@b.com' });
    await drain();
    expect(granted.identifies()[0]!['properties']['consent_state']).toBe('granted');

    const denied = runAsset({ identity: BASE_IDENTITY, brainConsent: false });
    (denied.win['brain'] as any).identify({ email: 'a@b.com' });
    await drain();
    expect(denied.identifies()[0]!['properties']['consent_state']).toBe('denied');
  });

  it('A1.2: cmp_signal reads the existing __brainConsent object (analytics boolean) as a real signal', async () => {
    const h = runAsset({ identity: BASE_IDENTITY, legacyConsentObject: { analytics: true } });
    (h.win['brain'] as any).identify({ email: 'a@b.com' });
    await drain();
    expect(h.identifies()[0]!['properties']['consent_state']).toBe('granted');
  });

  it('A1.2: cmp_signal reads IAB TCF __tcfapi — purpose-1 consent grants; refusal denies', async () => {
    const granted = runAsset({ identity: BASE_IDENTITY, tcfPurpose1: true });
    (granted.win['brain'] as any).identify({ email: 'a@b.com' });
    await drain();
    expect(granted.identifies()[0]!['properties']['consent_state']).toBe('granted');

    const denied = runAsset({ identity: BASE_IDENTITY, tcfPurpose1: false });
    (denied.win['brain'] as any).identify({ email: 'a@b.com' });
    await drain();
    expect(denied.identifies()[0]!['properties']['consent_state']).toBe('denied');
  });

  it('A1.2: TCF gdprApplies=false ⇒ granted (TCF present but GDPR out of scope)', async () => {
    const h = runAsset({ identity: BASE_IDENTITY, tcfPurpose1: false, tcfGdprApplies: false });
    (h.win['brain'] as any).identify({ email: 'a@b.com' });
    await drain();
    expect(h.identifies()[0]!['properties']['consent_state']).toBe('granted');
  });
});

// ── Bootstrap config service (flag-gated, fail-closed-to-legacy) ─────────────────────────────────
function fakeFlags(state: Record<string, boolean>): FlagService {
  return {
    isFlagEnabled: async (_brandId: string, flag: string) => state[flag] === true,
    setFlag: async () => undefined,
    listFlags: async () => [],
  } as unknown as FlagService;
}

const ROW = { identity_capture: 'autodetect', consent_source: 'assume_granted', region_code: 'IN' };
function fakeReader(row: typeof ROW | null | Error): BrandConsentConfigReader {
  return {
    read: async () => {
      if (row instanceof Error) throw row;
      return row;
    },
  };
}

describe('A1.2 — per-brand bootstrap config resolution (collector)', () => {
  it('A1.2: pixel.identify flag OFF (default) ⇒ null ⇒ legacy asset (§0.5 default-OFF)', async () => {
    const svc = createPixelIdentityConfigService({ reader: fakeReader(ROW), flags: fakeFlags({}) });
    expect(await svc.resolve(TOKEN, BRAND)).toBeNull();
  });

  it('A1.2: flag ON + brand config ⇒ the injected bootstrap mirrors tenancy.brand + the autodetect flag', async () => {
    const svc = createPixelIdentityConfigService({
      reader: fakeReader(ROW),
      flags: fakeFlags({ 'pixel.identify': true, 'pixel.autodetect.enabled': true }),
    });
    expect(await svc.resolve(TOKEN, BRAND)).toEqual({
      enabled: true,
      capture: 'autodetect',
      consent_source: 'assume_granted',
      autodetect: true,
      phone_country: 'IN',
    });
  });

  it('A1.2: autodetect flag OFF ⇒ autodetect:false even when the brand config says autodetect', async () => {
    const svc = createPixelIdentityConfigService({
      reader: fakeReader(ROW),
      flags: fakeFlags({ 'pixel.identify': true }),
    });
    const idc = await svc.resolve(TOKEN, BRAND);
    expect(idc?.capture).toBe('autodetect');
    expect(idc?.autodetect).toBe(false);
  });

  it('A1.2: unknown token↛brand pairing ⇒ null (token IS the authorization)', async () => {
    const svc = createPixelIdentityConfigService({
      reader: fakeReader(null),
      flags: fakeFlags({ 'pixel.identify': true }),
    });
    expect(await svc.resolve(TOKEN, BRAND)).toBeNull();
  });

  it('A1.2: PG failure ⇒ null + onError (fail-closed-to-legacy, never throws into the asset route)', async () => {
    const onError = vi.fn();
    const svc = createPixelIdentityConfigService({
      reader: fakeReader(new Error('pg down')),
      flags: fakeFlags({ 'pixel.identify': true }),
      onError,
    });
    expect(await svc.resolve(TOKEN, BRAND)).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('A1.2: garbage column values are whitelist-coerced (no injection surface into the templated JS)', async () => {
    const svc = createPixelIdentityConfigService({
      reader: fakeReader({
        identity_capture: '";alert(1);//',
        consent_source: 'evil',
        region_code: '<script>',
      } as typeof ROW),
      flags: fakeFlags({ 'pixel.identify': true }),
    });
    const idc = await svc.resolve(TOKEN, BRAND);
    expect(idc).toEqual({
      enabled: true,
      capture: 'off',
      consent_source: 'cmp_signal',
      autodetect: false,
      phone_country: 'IN',
    });
    expect(serializeIdentityBootstrapField(idc)).toBe(
      ',identity:{"enabled":true,"capture":"off","consent_source":"cmp_signal","autodetect":false,"phone_country":"IN"}',
    );
  });

  it('A1.2: GET /pixel.js?t=&b= injects the identity bootstrap when resolved (and nothing when null)', async () => {
    const idc: PixelIdentityBootstrap = {
      enabled: true,
      capture: 'explicit_only',
      consent_source: 'assume_granted',
      autodetect: false,
      phone_country: 'IN',
    };
    const withConfig = Fastify();
    registerPixelAssetRoute(withConfig, { resolve: async () => idc });
    const res = await withConfig.inject({ method: 'GET', url: `/pixel.js?t=${TOKEN}&b=${BRAND}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      ',identity:{"enabled":true,"capture":"explicit_only","consent_source":"assume_granted","autodetect":false,"phone_country":"IN"}};',
    );
    expect(res.body.endsWith(PIXEL_JS)).toBe(true);

    const without = Fastify();
    registerPixelAssetRoute(without, { resolve: async () => null });
    const res2 = await without.inject({ method: 'GET', url: `/pixel.js?t=${TOKEN}&b=${BRAND}` });
    expect(res2.body).not.toContain('identity:');
  });
});

// ── Collector strict-SLA path accepts the new event type unchanged ───────────────────────────────
describe('A1.1 — collector accepts pixel.identify.v1 through the unchanged accept-before-validate path', () => {
  it('A1.1: POST /collect with a pixel.identify.v1 envelope ⇒ 200 accepted + spooled once', async () => {
    const app = Fastify();
    let spooled: Record<string, unknown> | null = null;
    const execute = vi.fn(async (rawBody: Record<string, unknown>) => {
      spooled = rawBody;
      return { spoolId: BigInt(1), receivedAt: '2026-07-06T00:00:00.000Z' };
    });
    registerCollectRoute(app, { execute } as unknown as AcceptEventUseCase);
    const envelope = {
      schema_version: '1',
      event_id: 'e11a0011-0a11-7a11-8a11-000000000011',
      brand_id: BRAND,
      correlation_id: 'c11a0011-0a11-4a11-8a11-000000000011',
      event_name: 'pixel.identify.v1',
      occurred_at: '2026-07-06T00:00:00.000Z',
      consent_flags: { analytics: true, marketing: true, personalization: true, ai_processing: false },
      properties: {
        install_token: TOKEN,
        brain_anon_id: 'a11a0011-0a11-4a11-8a11-0000000000aa',
        session_id: 'a11a0011-0a11-4a11-8a11-0000000000bb',
        identifiers: { email_sha256: sha256('user@example.com') },
        source: 'explicit_api',
        consent_state: 'granted',
        hashed_customer_email: sha256('user@example.com'),
      },
    };
    const res = await app.inject({ method: 'POST', url: '/collect', payload: envelope });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true });
    expect(execute).toHaveBeenCalledOnce();
    expect((spooled as unknown as Record<string, unknown>)['event_name']).toBe('pixel.identify.v1');
  });
});
