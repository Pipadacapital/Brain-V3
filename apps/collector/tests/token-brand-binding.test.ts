/**
 * token-brand-binding.test.ts — install_token→brand_id binding admission gate (AUD-INFRA-025).
 *
 * Locks the tenant-isolation contract on the public ingest surface:
 *  - a PROVEN pairing violation (token registered to another brand / unknown token on a
 *    fully-presented pair) rejects 403 TOKEN_BRAND_MISMATCH before the spool;
 *  - unprovable pairs (missing/non-uuid token or brand_id) ADMIT (accept-before-validate);
 *  - oracle failure (PG down) ADMITS — fail-open, no event loss;
 *  - verdicts are TTL-cached (bounded) so the hot path stays off PG;
 *  - 'log' observes without rejecting; 'off' never touches the oracle.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { setCounterSink } from '@brain/observability';
import {
  TokenBrandBinding,
  extractBindingPair,
} from '../src/interfaces/rest/token-brand-binding.js';
import type { BrandConsentConfigReader } from '../src/interfaces/rest/pixel-identity-config.js';
import { EdgeRateLimiter, registerEdgeGuard, edgePostureWarnings } from '../src/interfaces/rest/edge-guard.js';

const TOKEN_A = 'a11a0011-0a11-4a11-8a11-000000000011';
const BRAND_A = 'aaaa0000-0a00-4a00-8a00-00000000000a';
const BRAND_B = 'bbbb0000-0b00-4b00-8b00-00000000000b';

const ROW = { identity_capture: 'off', consent_source: 'cmp_signal', region_code: 'IN' };

/** Oracle fake: returns a row ONLY for the registered (token, brand) pairs (0121 semantics). */
function readerFor(bound: Array<[string, string]>): BrandConsentConfigReader & { read: ReturnType<typeof vi.fn> } {
  const set = new Set(bound.map(([t, b]) => `${t}:${b}`));
  return {
    read: vi.fn(async (token: string, brand: string) => (set.has(`${token}:${brand}`) ? { ...ROW } : null)),
  };
}

function eventBody(token: string | undefined, brandId: string | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = { event_name: 'page.viewed', properties: {} };
  if (token !== undefined) body['properties'] = { install_token: token };
  if (brandId !== undefined) body['brand_id'] = brandId;
  return body;
}

describe('extractBindingPair — only a fully-presented uuid pair is provable', () => {
  it('extracts a complete uuid pair (brand_id top-level, install_token under properties)', () => {
    expect(extractBindingPair(eventBody(TOKEN_A, BRAND_A))).toEqual({ installToken: TOKEN_A, brandId: BRAND_A });
  });

  it('returns null for an incomplete or malformed pair (unprovable — never a rejection basis)', () => {
    expect(extractBindingPair(eventBody(undefined, BRAND_A))).toBeNull(); // token-less
    expect(extractBindingPair(eventBody(TOKEN_A, undefined))).toBeNull(); // brand-less
    expect(extractBindingPair(eventBody('not-a-uuid', BRAND_A))).toBeNull();
    expect(extractBindingPair(eventBody(TOKEN_A, 'not-a-uuid'))).toBeNull();
    expect(extractBindingPair({})).toBeNull();
    expect(extractBindingPair({ brand_id: BRAND_A, properties: 'nope' })).toBeNull(); // non-object properties
  });
});

describe('TokenBrandBinding.admits — enforce mode', () => {
  it('admits a registered pair', async () => {
    const reader = readerFor([[TOKEN_A, BRAND_A]]);
    const binding = new TokenBrandBinding({ reader, mode: 'enforce' });
    await expect(binding.admits([eventBody(TOKEN_A, BRAND_A)])).resolves.toEqual({ admit: true });
    expect(reader.read).toHaveBeenCalledTimes(1);
  });

  it("REJECTS a leaked token presenting another brand's id (the AUD-INFRA-025 attack)", async () => {
    const reader = readerFor([[TOKEN_A, BRAND_A]]);
    const binding = new TokenBrandBinding({ reader, mode: 'enforce' });
    const decision = await binding.admits([eventBody(TOKEN_A, BRAND_B)]);
    expect(decision.admit).toBe(false);
    expect(decision.brandId).toBe(BRAND_B);
  });

  it('admits an unprovable pair without touching the oracle (accept-before-validate posture)', async () => {
    const reader = readerFor([]);
    const binding = new TokenBrandBinding({ reader, mode: 'enforce' });
    await expect(binding.admits([eventBody(undefined, BRAND_B)])).resolves.toEqual({ admit: true });
    await expect(binding.admits([eventBody(TOKEN_A, undefined)])).resolves.toEqual({ admit: true });
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN: an oracle failure (PG down) admits — infrastructure failure never drops events', async () => {
    const reader = { read: vi.fn(async () => { throw new Error('pg down'); }) };
    const binding = new TokenBrandBinding({ reader, mode: 'enforce' });
    await expect(binding.admits([eventBody(TOKEN_A, BRAND_A)])).resolves.toEqual({ admit: true });
  });

  it('TTL-caches verdicts (one oracle call per pair per window) and re-checks after expiry', async () => {
    let t = 0;
    const reader = readerFor([[TOKEN_A, BRAND_A]]);
    const binding = new TokenBrandBinding({ reader, mode: 'enforce', ttlMs: 1_000, now: () => t });
    await binding.admits([eventBody(TOKEN_A, BRAND_A)]);
    await binding.admits([eventBody(TOKEN_A, BRAND_A)]);
    expect(reader.read).toHaveBeenCalledTimes(1); // cache hit
    t = 1_001;
    await binding.admits([eventBody(TOKEN_A, BRAND_A)]);
    expect(reader.read).toHaveBeenCalledTimes(2); // TTL expired → re-check
  });

  it('dedupes pairs within one batch (a legit batch spans one storefront → ~1 oracle call)', async () => {
    const reader = readerFor([[TOKEN_A, BRAND_A]]);
    const binding = new TokenBrandBinding({ reader, mode: 'enforce' });
    const batch = [eventBody(TOKEN_A, BRAND_A), eventBody(TOKEN_A, BRAND_A), eventBody(TOKEN_A, BRAND_A)];
    await expect(binding.admits(batch)).resolves.toEqual({ admit: true });
    expect(reader.read).toHaveBeenCalledTimes(1);
  });

  it('rejects the whole batch when ANY event carries a proven mismatch (atomic spool contract)', async () => {
    const reader = readerFor([[TOKEN_A, BRAND_A]]);
    const binding = new TokenBrandBinding({ reader, mode: 'enforce' });
    const batch = [eventBody(TOKEN_A, BRAND_A), eventBody(TOKEN_A, BRAND_B)];
    const decision = await binding.admits(batch);
    expect(decision.admit).toBe(false);
  });

  it('bounds the verdict cache under pair-fuzzing (maxEntries eviction — no unbounded growth)', async () => {
    const reader = readerFor([]);
    const binding = new TokenBrandBinding({ reader, mode: 'log', maxEntries: 10 });
    for (let i = 0; i < 100; i++) {
      const brand = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
      await binding.admits([eventBody(TOKEN_A, brand)]);
    }
    // No assertion on internals beyond "did not throw / unbounded" — the cap is the guarantee.
    await expect(binding.admits([eventBody(TOKEN_A, BRAND_A)])).resolves.toEqual({ admit: true });
  });
});

describe('TokenBrandBinding.admits — log / off modes', () => {
  it("'log' counts + logs a mismatch but ADMITS (rollout / rollback posture)", async () => {
    const reader = readerFor([[TOKEN_A, BRAND_A]]);
    const binding = new TokenBrandBinding({ reader, mode: 'log' });
    const counted: string[] = [];
    const restore = setCounterSink({ add: (name) => counted.push(name) });
    try {
      await expect(binding.admits([eventBody(TOKEN_A, BRAND_B)])).resolves.toEqual({ admit: true });
    } finally {
      restore();
    }
    expect(counted).toContain('collector_edge_token_binding_mismatch_total');
  });

  it("'off' never touches the oracle (kill switch)", async () => {
    const reader = readerFor([]);
    const binding = new TokenBrandBinding({ reader, mode: 'off' });
    await expect(binding.admits([eventBody(TOKEN_A, BRAND_B)])).resolves.toEqual({ admit: true });
    expect(reader.read).not.toHaveBeenCalled();
  });
});

describe('registerEdgeGuard + binding — reject-before-spool over the ingest routes', () => {
  async function buildApp(binding: TokenBrandBinding) {
    const app = Fastify({ logger: false });
    const limiter = new EdgeRateLimiter({ maxPerWindow: 1_000, windowMs: 60_000, originAllowlist: [] });
    registerEdgeGuard(app, limiter, binding);
    const handler = vi.fn(async () => ({ accepted: true }));
    app.post('/collect', handler);
    app.post('/v1/events', handler);
    app.post('/batch', handler);
    await app.ready();
    return { app, handler };
  }

  it('403 TOKEN_BRAND_MISMATCH on /collect for a proven cross-brand pair — handler (spool) never runs', async () => {
    const binding = new TokenBrandBinding({ reader: readerFor([[TOKEN_A, BRAND_A]]), mode: 'enforce' });
    const { app, handler } = await buildApp(binding);
    const res = await app.inject({ method: 'POST', url: '/collect', payload: eventBody(TOKEN_A, BRAND_B) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TOKEN_BRAND_MISMATCH');
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('admits a registered pair on /collect and a token-less body on /v1/events', async () => {
    const binding = new TokenBrandBinding({ reader: readerFor([[TOKEN_A, BRAND_A]]), mode: 'enforce' });
    const { app } = await buildApp(binding);
    const ok = await app.inject({ method: 'POST', url: '/collect', payload: eventBody(TOKEN_A, BRAND_A) });
    expect(ok.statusCode).toBe(200);
    const tokenless = await app.inject({ method: 'POST', url: '/v1/events', payload: eventBody(undefined, BRAND_B) });
    expect(tokenless.statusCode).toBe(200);
    await app.close();
  });

  it('403 on /batch when any event carries a proven mismatch', async () => {
    const binding = new TokenBrandBinding({ reader: readerFor([[TOKEN_A, BRAND_A]]), mode: 'enforce' });
    const { app, handler } = await buildApp(binding);
    const res = await app.inject({
      method: 'POST',
      url: '/batch',
      payload: { events: [eventBody(TOKEN_A, BRAND_A), eventBody(TOKEN_A, BRAND_B)] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TOKEN_BRAND_MISMATCH');
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('edgePostureWarnings — insecure prod posture must be LOUD (AUD-INFRA-025)', () => {
  it('warns on an empty origin allowlist in production', () => {
    const warnings = edgePostureWarnings('production', [], 'enforce');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EDGE_ORIGIN_ALLOWLIST');
  });

  it('warns when token binding is not enforced in production', () => {
    const warnings = edgePostureWarnings('production', ['https://shop.example.com'], 'log');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EDGE_TOKEN_BINDING_MODE');
  });

  it('silent when prod posture is secure, and never warns outside production', () => {
    expect(edgePostureWarnings('production', ['https://shop.example.com'], 'enforce')).toHaveLength(0);
    expect(edgePostureWarnings('development', [], 'off')).toHaveLength(0);
  });
});
