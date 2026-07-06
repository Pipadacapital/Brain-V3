// SPEC: 0.5
/**
 * flags.test.ts — §0.5 platform-flags (tests are specification; named after spec sections).
 *
 * Proves the four load-bearing semantics:
 *   1. DEFAULT OFF   — unset flag reads disabled.
 *   2. FAIL-CLOSED   — store error → false (pre-wave behavior), never a throw.
 *   3. TENANT-FIRST  — `{brand_id}:flag:{name}` keys; brand A never affects brand B.
 *   4. LOCAL TTL     — ~10s in-process memo; setFlag updates this instance immediately.
 */

import { describe, it, expect, vi } from 'vitest';
import { flagKey } from '@brain/tenant-context';
import { createFlagService, type FlagStorePort } from './domain/flag-service.js';
import { RedisFlagStoreAdapter } from './infrastructure/redis-flag-store.js';
import { PLATFORM_FLAGS, ALL_PLATFORM_FLAGS, isKnownFlag, type PlatformFlag } from './registry.js';

const BRAND_A = 'aaaa1111-0000-4000-8000-aaaaaaaaaaaa';
const BRAND_B = 'bbbb2222-0000-4000-8000-bbbbbbbbbbbb';

/** In-memory FlagStorePort recording every key touched. */
function makeFakeStore(): FlagStorePort & { data: Map<string, string>; keysRead: string[] } {
  const data = new Map<string, string>();
  const keysRead: string[] = [];
  return {
    data,
    keysRead,
    async get(key) {
      keysRead.push(key);
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}

/** A store whose every op rejects — the "Redis is down" world. */
function makeDownStore(): FlagStorePort {
  return {
    get: async () => {
      throw new Error('ECONNREFUSED');
    },
    set: async () => {
      throw new Error('ECONNREFUSED');
    },
  };
}

describe('SPEC 0.5 — typed flag registry', () => {
  it('carries the full Wave-A flag set', () => {
    for (const f of [
      'pixel.identify',
      'pixel.autodetect.enabled',
      'connector.identity_fields',
      'stitch.v2',
      'identity.probabilistic',
      'identity.tp_cache',
    ]) {
      expect(isKnownFlag(f), `missing Wave-A flag ${f}`).toBe(true);
      expect(PLATFORM_FLAGS[f as PlatformFlag].wave).toBe('A');
    }
  });

  it('has room for B/C/D flags (flag matrix)', () => {
    expect(isKnownFlag('journey.engine')).toBe(true);
    expect(isKnownFlag('measurement.marts_migration')).toBe(true);
    expect(isKnownFlag('semantic.serving')).toBe(true);
  });

  it('rejects unregistered names', () => {
    expect(isKnownFlag('not.a.flag')).toBe(false);
    expect(ALL_PLATFORM_FLAGS).not.toContain('not.a.flag');
  });

  it('flag names never contain ":" (would break the brand-first key)', () => {
    for (const f of ALL_PLATFORM_FLAGS) expect(f).not.toContain(':');
  });
});

describe('SPEC 0.5 — key shape {brand_id}:flag:{flag_name} (brand_id-FIRST)', () => {
  it('builds brand-first keys via the sanctioned flagKey()', () => {
    expect(flagKey({ brandId: BRAND_A, flag: 'stitch.v2' })).toBe(`${BRAND_A}:flag:stitch.v2`);
  });

  it('reads go through flagKey-built keys (store sees brand-first keys only)', async () => {
    const store = makeFakeStore();
    const svc = createFlagService({ store, localTtlMs: 0 });
    await svc.isFlagEnabled(BRAND_A, 'pixel.identify');
    expect(store.keysRead).toEqual([`${BRAND_A}:flag:pixel.identify`]);
  });

  it('flagKey rejects separator injection', () => {
    expect(() => flagKey({ brandId: 'a:b', flag: 'stitch.v2' })).toThrow();
    expect(() => flagKey({ brandId: BRAND_A, flag: 'x:y' })).toThrow();
  });
});

describe('SPEC 0.5 — DEFAULT OFF', () => {
  it('an unset flag reads disabled', async () => {
    const svc = createFlagService({ store: makeFakeStore(), localTtlMs: 0 });
    for (const f of ALL_PLATFORM_FLAGS) {
      expect(await svc.isFlagEnabled(BRAND_A, f)).toBe(false);
    }
  });

  it("only the literal stored 'true' enables — 'false'/garbage stay disabled", async () => {
    const store = makeFakeStore();
    const svc = createFlagService({ store, localTtlMs: 0 });
    store.data.set(`${BRAND_A}:flag:stitch.v2`, 'false');
    expect(await svc.isFlagEnabled(BRAND_A, 'stitch.v2')).toBe(false);
    store.data.set(`${BRAND_A}:flag:stitch.v2`, '1'); // not the sanctioned encoding
    expect(await svc.isFlagEnabled(BRAND_A, 'stitch.v2')).toBe(false);
    store.data.set(`${BRAND_A}:flag:stitch.v2`, 'true');
    expect(await svc.isFlagEnabled(BRAND_A, 'stitch.v2')).toBe(true);
  });

  it('an unknown flag name always reads disabled (never throws)', async () => {
    const svc = createFlagService({ store: makeFakeStore(), localTtlMs: 0 });
    expect(await svc.isFlagEnabled(BRAND_A, 'not.a.flag' as PlatformFlag)).toBe(false);
  });
});

describe('SPEC 0.5 — FAIL-CLOSED (Redis down → false → pre-wave behavior)', () => {
  it('a store error reads as disabled, never propagates', async () => {
    const svc = createFlagService({ store: makeDownStore(), localTtlMs: 0 });
    await expect(svc.isFlagEnabled(BRAND_A, 'stitch.v2')).resolves.toBe(false);
  });

  it('a previously-enabled flag also fails CLOSED once the store is down (no stale-open beyond TTL)', async () => {
    let t = 0;
    const store = makeFakeStore();
    const svc = createFlagService({ store, localTtlMs: 10_000, now: () => t });
    await svc.setFlag(BRAND_A, 'stitch.v2', true);
    expect(await svc.isFlagEnabled(BRAND_A, 'stitch.v2')).toBe(true);
    // Redis dies; local cache expires → next read is CLOSED.
    store.get = async () => {
      throw new Error('ECONNREFUSED');
    };
    t = 10_001;
    expect(await svc.isFlagEnabled(BRAND_A, 'stitch.v2')).toBe(false);
  });

  it('setFlag on a down store throws loudly (admin writes must not fail silently)', async () => {
    const svc = createFlagService({ store: makeDownStore(), localTtlMs: 0 });
    await expect(svc.setFlag(BRAND_A, 'stitch.v2', true)).rejects.toThrow();
  });
});

describe('SPEC 0.5 — tenant isolation (brand_id first everywhere)', () => {
  it("brand A's flag NEVER affects brand B", async () => {
    const store = makeFakeStore();
    const svc = createFlagService({ store, localTtlMs: 0 });
    await svc.setFlag(BRAND_A, 'pixel.identify', true);
    expect(await svc.isFlagEnabled(BRAND_A, 'pixel.identify')).toBe(true);
    expect(await svc.isFlagEnabled(BRAND_B, 'pixel.identify')).toBe(false);
    // And the reverse direction: disabling A does not disturb an enabled B.
    await svc.setFlag(BRAND_B, 'pixel.identify', true);
    await svc.setFlag(BRAND_A, 'pixel.identify', false);
    expect(await svc.isFlagEnabled(BRAND_B, 'pixel.identify')).toBe(true);
  });

  it('every stored key is brand_id-leading', async () => {
    const store = makeFakeStore();
    const svc = createFlagService({ store, localTtlMs: 0 });
    await svc.setFlag(BRAND_A, 'identity.tp_cache', true);
    for (const key of store.data.keys()) expect(key.startsWith(`${BRAND_A}:`)).toBe(true);
  });

  it('a missing brandId reads disabled (fail-closed, no cross-tenant fallback)', async () => {
    const svc = createFlagService({ store: makeFakeStore(), localTtlMs: 0 });
    expect(await svc.isFlagEnabled('', 'stitch.v2')).toBe(false);
  });
});

describe('SPEC 0.5 — local TTL cache (~10s)', () => {
  it('memoizes reads within the TTL (one store hit)', async () => {
    let t = 0;
    const store = makeFakeStore();
    const spy = vi.spyOn(store, 'get');
    const svc = createFlagService({ store, localTtlMs: 10_000, now: () => t });
    await svc.isFlagEnabled(BRAND_A, 'stitch.v2');
    t = 5_000;
    await svc.isFlagEnabled(BRAND_A, 'stitch.v2');
    expect(spy).toHaveBeenCalledTimes(1);
    t = 10_001; // expired → re-read
    await svc.isFlagEnabled(BRAND_A, 'stitch.v2');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('setFlag updates the local cache immediately (no 10s lag on THIS instance)', async () => {
    let t = 0;
    const store = makeFakeStore();
    const svc = createFlagService({ store, localTtlMs: 10_000, now: () => t });
    expect(await svc.isFlagEnabled(BRAND_A, 'stitch.v2')).toBe(false); // cached false
    await svc.setFlag(BRAND_A, 'stitch.v2', true);
    expect(await svc.isFlagEnabled(BRAND_A, 'stitch.v2')).toBe(true); // not the stale cached false
  });

  it('caches per (brand, flag) — brand B is not served brand A’s cached value', async () => {
    let t = 0;
    const store = makeFakeStore();
    store.data.set(`${BRAND_A}:flag:stitch.v2`, 'true');
    const svc = createFlagService({ store, localTtlMs: 10_000, now: () => t });
    expect(await svc.isFlagEnabled(BRAND_A, 'stitch.v2')).toBe(true);
    expect(await svc.isFlagEnabled(BRAND_B, 'stitch.v2')).toBe(false);
  });
});

describe('SPEC 0.5 — admin surface primitives (setFlag / listFlags)', () => {
  it('setFlag rejects unknown flags (registry is the write allowlist)', async () => {
    const svc = createFlagService({ store: makeFakeStore(), localTtlMs: 0 });
    await expect(svc.setFlag(BRAND_A, 'not.a.flag' as PlatformFlag, true)).rejects.toThrow(/unknown flag/);
  });

  it('listFlags returns every registered flag with per-brand state', async () => {
    const svc = createFlagService({ store: makeFakeStore(), localTtlMs: 0 });
    await svc.setFlag(BRAND_A, 'pixel.identify', true);
    const list = await svc.listFlags(BRAND_A);
    expect(list.map((f) => f.flag).sort()).toEqual([...ALL_PLATFORM_FLAGS].sort());
    const byFlag = new Map(list.map((f) => [f.flag, f]));
    expect(byFlag.get('pixel.identify')?.enabled).toBe(true);
    expect(byFlag.get('stitch.v2')?.enabled).toBe(false);
    expect(byFlag.get('pixel.identify')?.spec).toBe('A.1.1');
  });
});

describe('SPEC 0.5 — RedisFlagStoreAdapter (the only Redis-touching module)', () => {
  it('delegates get/set to the injected structural client and propagates errors', async () => {
    const calls: string[][] = [];
    const client = {
      get: async (key: string) => {
        calls.push(['get', key]);
        return 'true';
      },
      set: async (key: string, value: string) => {
        calls.push(['set', key, value]);
        return 'OK';
      },
    };
    const adapter = new RedisFlagStoreAdapter(client);
    const key = flagKey({ brandId: BRAND_A, flag: 'stitch.v2' });
    expect(await adapter.get(key)).toBe('true');
    await adapter.set(key, 'false');
    expect(calls).toEqual([
      ['get', key],
      ['set', key, 'false'],
    ]);

    const down = new RedisFlagStoreAdapter({
      get: async () => {
        throw new Error('down');
      },
      set: async () => {
        throw new Error('down');
      },
    });
    await expect(down.get(key)).rejects.toThrow('down'); // fail-closed lives in the SERVICE, not here
  });
});
