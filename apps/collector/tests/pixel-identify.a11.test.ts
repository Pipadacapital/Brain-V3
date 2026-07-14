// SPEC: A.1.1 (WA-07 — pixel.identify.v1: explicit API, form auto-detect, session dedupe)
/**
 * pixel-identify.a11.test.ts — behavioral suite for the WA-07 identify system in the SERVED
 * /pixel.js asset (same vm-sandbox harness family as pixel-asset.test.ts, extended with
 * sessionStorage + WebCrypto (node webcrypto) + a minimal form/MutationObserver DOM so the
 * auto-detect path is exercised end-to-end).
 *
 * Coverage (spec-named):
 *   A1.1 explicit API      — brain.identify({email, phone}) emits ONE pixel.identify.v1 with the
 *                            spec envelope {identifiers:{email_sha256,phone_sha256}, source:
 *                            'explicit_api', consent_state} + interop aliases; hashes = plain
 *                            sha256 of the NORMALIZED identifiers (AMD-01 INTEROP space); the
 *                            event parses against the REAL CollectorEventV1Schema (the strict-SLA
 *                            /collect path accepts it as just another event_name).
 *   A1.1 flags-OFF         — no identity bootstrap ⇒ legacy identify ONLY (wire unchanged).
 *   A1.1 capture=off       — v2 governs but capture 'off' ⇒ NO identify at all (legacy bridge retired too).
 *   A1.1 dedupe            — one identify per identifier hash per session (sessionStorage-backed).
 *   A1.1 autodetect        — blur on a detected email/tel input fires source='form_autodetect';
 *                            NEVER inside password-adjacent forms; requires the autodetect flag
 *                            AND capture='autodetect' AND granted consent.
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { CollectorEventV1Schema } from '@brain/contracts';
import { PIXEL_JS } from '../src/interfaces/rest/pixel-asset.route.js';

const TOKEN = 'a11a0011-0a11-4a11-8a11-000000000011';
const BRAND = 'a11a0001-0a00-4a00-8a00-000000000001';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ── Minimal form/input fakes (enough DOM for identify-autodetect.ts) ─────────────────────────────
interface FakeForm {
  getAttribute(k: string): string | null;
  querySelector(sel: string): unknown;
}
interface FakeInput {
  tagName: string;
  type: string;
  value: string;
  form: FakeForm | null;
  getAttribute(k: string): string | null;
  addEventListener(ev: string, cb: () => void): void;
  blur(): void;
}

function makeForm(opts: { action?: string; hasPassword?: boolean } = {}): FakeForm {
  return {
    getAttribute: (k: string) => (k === 'action' ? (opts.action ?? '/subscribe') : null),
    querySelector: (sel: string) =>
      sel.includes('input[type=password]') && opts.hasPassword ? {} : null,
  };
}

function makeInput(opts: {
  type?: string;
  autocomplete?: string;
  value?: string;
  form?: FakeForm | null;
}): FakeInput {
  const handlers: Record<string, () => void> = {};
  return {
    tagName: 'INPUT',
    type: opts.type ?? 'text',
    value: opts.value ?? '',
    form: opts.form ?? null,
    getAttribute: (k: string) =>
      k === 'type' ? (opts.type ?? null) : k === 'autocomplete' ? (opts.autocomplete ?? null) : null,
    addEventListener: (ev: string, cb: () => void) => {
      handlers[ev] = cb;
    },
    blur: () => handlers['blur']?.(),
  };
}

interface Harness {
  sent: string[];
  win: Record<string, unknown>;
  sentByName: (name: string) => Array<Record<string, any>>;
}

/** pixel-asset.test.ts harness + sessionStorage/WebCrypto/forms/MutationObserver. */
function runAsset(
  opts: {
    identity?: Record<string, unknown>;
    inputs?: FakeInput[];
    brainConsent?: unknown;
    legacyConsentObject?: unknown;
    tcf?: (cb: (tcData: unknown, success: boolean) => void) => void;
    noSessionStorage?: boolean;
  } = {},
): Harness {
  const sent: string[] = [];
  const store = new Map<string, string>();
  const session = new Map<string, string>();

  const location = {
    protocol: 'https:',
    host: 'collect.example.com',
    pathname: '/products/widget',
    search: '',
  };
  const fakeFetch = (_url: string, init: { body: string }): Promise<{ ok: boolean }> => {
    sent.push(init.body);
    return Promise.resolve({ ok: true });
  };

  class FakeMutationObserver {
    constructor(public cb: (muts: unknown[]) => void) {}
    observe(): void {}
    disconnect(): void {}
  }

  const bootstrap: Record<string, unknown> = { install_token: TOKEN, brand_id: BRAND };
  if (opts.identity) bootstrap['identity'] = opts.identity;

  const win: Record<string, unknown> = {
    __brain: bootstrap,
    crypto: {
      randomUUID: () => randUuid(),
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
      subtle: webcrypto.subtle, // REAL WebCrypto — the asset hashes client-side with this
    },
    TextEncoder,
    Uint8Array,
    MutationObserver: FakeMutationObserver,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
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
  if (!opts.noSessionStorage) {
    win['sessionStorage'] = {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    };
  }
  if (opts.brainConsent !== undefined) win['brainConsent'] = opts.brainConsent;
  if (opts.legacyConsentObject !== undefined) win['__brainConsent'] = opts.legacyConsentObject;
  if (opts.tcf) win['__tcfapi'] = (_cmd: string, _v: number, cb: (t: unknown, s: boolean) => void) => opts.tcf!(cb);

  const inputs = opts.inputs ?? [];
  const navigator: Record<string, unknown> = { userAgent: 'Mozilla/5.0 (Macintosh)' };
  const document = {
    referrer: 'https://google.com/',
    cookie: '',
    visibilityState: 'visible',
    documentElement: {},
    addEventListener: () => undefined,
    querySelectorAll: (sel: string) =>
      sel.includes('input[type=email]') || sel.includes('input[autocomplete]') ? inputs : [],
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
    sentByName: (name: string) =>
      sent.map((b) => JSON.parse(b) as Record<string, any>).filter((e) => e['event_name'] === name),
  };
}

/** Real-async drain — the WebCrypto digest is a genuine promise, so poll with macrotasks. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

function randUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const IDENTITY_ON = {
  enabled: true,
  capture: 'explicit_only',
  consent_source: 'assume_granted',
  autodetect: false,
  phone_country: 'IN',
};
const IDENTITY_AUTODETECT = { ...IDENTITY_ON, capture: 'autodetect', autodetect: true };

describe('A1.1 — explicit API (brain.identify)', () => {
  it('A1.1: emits ONE pixel.identify.v1 with the spec envelope — normalized interop hashes, source, consent_state — and it PARSES against CollectorEventV1Schema', async () => {
    const h = runAsset({ identity: IDENTITY_ON });
    (h.win['brain'] as any).identify({ email: '  User@Example.COM ', phone: '098765 43210' });
    await drain();

    const identifies = h.sentByName('pixel.identify.v1');
    expect(identifies.length).toBe(1);
    const ev = identifies[0]!;

    // The collector strict-SLA path treats identify as just another event_name: the wire envelope
    // must parse against the REAL contract schema unchanged.
    const parsed = CollectorEventV1Schema.safeParse(ev);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);

    // Spec envelope mapping: brand_id (envelope) / anonymous_id (brain_anon_id) / session_id / ts.
    expect(ev['brand_id']).toBe(BRAND);
    expect(typeof ev['properties']['brain_anon_id']).toBe('string');
    expect(typeof ev['properties']['session_id']).toBe('string');
    expect(typeof ev['occurred_at']).toBe('string');

    // AMD-01 INTEROP hashes of the NORMALIZED values (email trim/lowercase/NFC; phone E.164 with '+').
    expect(ev['properties']['identifiers']).toEqual({
      email_sha256: sha256('user@example.com'),
      phone_sha256: sha256('+919876543210'),
    });
    expect(ev['properties']['source']).toBe('explicit_api');
    expect(ev['properties']['consent_state']).toBe('granted');
    // Interop back-compat aliases (the live extract-identifiers pre_hashed strong tier).
    expect(ev['properties']['hashed_customer_email']).toBe(sha256('user@example.com'));
    expect(ev['properties']['hashed_customer_phone']).toBe(sha256('+919876543210'));
  });

  it('A1.1: flags OFF (no identity bootstrap) ⇒ LEGACY identify only — wire behavior unchanged', async () => {
    const h = runAsset({});
    (h.win['brain'] as any).identify({ email: 'user@example.com', phone: '9876543210' });
    await drain();
    expect(h.sentByName('pixel.identify.v1').length).toBe(0);
    const legacy = h.sentByName('identify');
    expect(legacy.length).toBe(1);
    expect(legacy[0]!['properties']['hashed_customer_email']).toBe(sha256('user@example.com'));
    expect(legacy[0]!['properties']['identifiers']).toBeUndefined(); // legacy shape untouched
  });

  it("A1.1: capture='off' (v2 governs) ⇒ NO identify of any kind", async () => {
    const h = runAsset({ identity: { ...IDENTITY_ON, capture: 'off' } });
    (h.win['brain'] as any).identify({ email: 'user@example.com' });
    await drain();
    expect(h.sentByName('pixel.identify.v1').length).toBe(0);
    expect(h.sentByName('identify').length).toBe(0);
  });

  it('A1.1: invalid identifiers (junk email + junk phone) ⇒ NO event (fail-null, no junk hashes)', async () => {
    const h = runAsset({ identity: IDENTITY_ON });
    (h.win['brain'] as any).identify({ email: 'not-an-email', phone: 'call-me' });
    await drain();
    expect(h.sentByName('pixel.identify.v1').length).toBe(0);
  });
});

describe('A1.1 — session-scoped dedupe (one identify per identifier hash per session)', () => {
  it('A1.1: the same email twice in one session ⇒ ONE event; a new identifier still fires', async () => {
    const h = runAsset({ identity: IDENTITY_ON });
    const brain = h.win['brain'] as any;
    brain.identify({ email: 'user@example.com' });
    await drain();
    brain.identify({ email: 'USER@example.com ' }); // same normalized value ⇒ same hash ⇒ deduped
    await drain();
    expect(h.sentByName('pixel.identify.v1').length).toBe(1);

    brain.identify({ email: 'other@example.com' }); // different hash ⇒ fires
    await drain();
    const identifies = h.sentByName('pixel.identify.v1');
    expect(identifies.length).toBe(2);
    expect(identifies[1]!['properties']['identifiers']).toEqual({
      email_sha256: sha256('other@example.com'),
    });
  });

  it('A1.1: dedupe degrades safely without sessionStorage (page-scoped, still no spam)', async () => {
    const h = runAsset({ identity: IDENTITY_ON, noSessionStorage: true });
    const brain = h.win['brain'] as any;
    brain.identify({ email: 'user@example.com' });
    await drain();
    brain.identify({ email: 'user@example.com' });
    await drain();
    expect(h.sentByName('pixel.identify.v1').length).toBe(1);
  });
});

describe('A1.1 — form auto-detect (MutationObserver + blur)', () => {
  it("A1.1: blur on a detected email input fires source='form_autodetect' with the hash", async () => {
    const email = makeInput({ type: 'email', value: 'blur@example.com', form: makeForm() });
    const h = runAsset({ identity: IDENTITY_AUTODETECT, inputs: [email] });
    email.blur();
    await drain();
    const identifies = h.sentByName('pixel.identify.v1');
    expect(identifies.length).toBe(1);
    expect(identifies[0]!['properties']['source']).toBe('form_autodetect');
    expect(identifies[0]!['properties']['identifiers']).toEqual({
      email_sha256: sha256('blur@example.com'),
    });
  });

  it('A1.1: autocomplete="tel" inputs are detected and hashed as phone', async () => {
    const tel = makeInput({ autocomplete: 'tel', value: '098765 43210', form: makeForm() });
    const h = runAsset({ identity: IDENTITY_AUTODETECT, inputs: [tel] });
    tel.blur();
    await drain();
    const identifies = h.sentByName('pixel.identify.v1');
    expect(identifies.length).toBe(1);
    expect(identifies[0]!['properties']['identifiers']).toEqual({
      phone_sha256: sha256('+919876543210'),
    });
  });

  it('A1.1: NEVER captures inside a form containing input[type=password] (spec selector rule)', async () => {
    const email = makeInput({
      type: 'email',
      value: 'login@example.com',
      form: makeForm({ hasPassword: true }),
    });
    const h = runAsset({ identity: IDENTITY_AUTODETECT, inputs: [email] });
    email.blur();
    await drain();
    expect(h.sentByName('pixel.identify.v1').length).toBe(0);
  });

  it('A1.1: NEVER captures inside form[action*="password"] (reset forms without a visible password field)', async () => {
    const email = makeInput({
      type: 'email',
      value: 'reset@example.com',
      form: makeForm({ action: '/account/recover-password' }),
    });
    const h = runAsset({ identity: IDENTITY_AUTODETECT, inputs: [email] });
    email.blur();
    await drain();
    expect(h.sentByName('pixel.identify.v1').length).toBe(0);
  });

  it('A1.1: autodetect flag OFF (explicit_only capture) ⇒ blur captures NOTHING (explicit API still works)', async () => {
    const email = makeInput({ type: 'email', value: 'auto@example.com', form: makeForm() });
    const h = runAsset({ identity: IDENTITY_ON, inputs: [email] });
    email.blur();
    await drain();
    expect(h.sentByName('pixel.identify.v1').length).toBe(0);
    (h.win['brain'] as any).identify({ email: 'auto@example.com' });
    await drain();
    expect(h.sentByName('pixel.identify.v1').length).toBe(1);
  });

  it('A1.1: consent DENIED (cmp_signal, no signal) ⇒ autodetect NEVER captures', async () => {
    const email = makeInput({ type: 'email', value: 'denied@example.com', form: makeForm() });
    const h = runAsset({
      identity: { ...IDENTITY_AUTODETECT, consent_source: 'cmp_signal' }, // no signal in the page
      inputs: [email],
    });
    email.blur();
    await drain();
    expect(h.sentByName('pixel.identify.v1').length).toBe(0);
  });

  it('A1.1: the legacy raw-email submit-bridge is RETIRED whenever v2 governs (password-adjacency fix)', () => {
    // Static wire-shape guard: under v2 the ONLY field-capture path is the blur autodetect above.
    // The bundled source must gate the legacy submit-bridge on identityV2Active.
    expect(PIXEL_JS).toContain('identityV2Active');
    expect(PIXEL_JS).toMatch(/em\.value && !rt\.identityV2Active/);
  });
});
