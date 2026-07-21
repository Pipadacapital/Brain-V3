/**
 * batch-identity-chunk-side-effects.unit.test.ts — M2: side effects commit with the SAME
 * granularity as the graph writes.
 *
 * THE BUG CLASS: BatchResolveIdentityUseCase commits Neo4j per internal chunk (batchSize), but
 * the silver-identity job used to apply applyResolveSideEffects only after the WHOLE page
 * resolved. A mid-page throw left earlier chunks committed in the graph with their side effects
 * (scoped-recompute, restitch/journey dirty rows, cache primes/eviction, tp merge-invalidation)
 * never applied — and the re-run re-resolves those events as linked/skipped (never merged/minted
 * again), so the side effects were silently lost FOREVER.
 *
 * PROVES (per task spec):
 *   1. executeWithOutcomes(events, now, onChunkCommitted) fires the hook once per COMMITTED
 *      chunk; a chunk-write failure means the hook has already run for chunks 1..N and the call
 *      rejects (watermark-held semantics belong to the caller).
 *   2. Chunk-1 side effects (cache primes here) are durably applied even though the page failed.
 *   3. The re-run applies the remainder WITHOUT duplicating: no duplicate graph links, the merge
 *      scoped-recompute upserts exactly once (deterministic event_id keyed), cache primes stay
 *      exact (idempotent Map-set semantics = the repos' ON CONFLICT upserts).
 *
 * NO live infrastructure — in-memory bulk-capable IdentityStore fake (same contract shape as
 * batch-identity-parity.test.ts, radically reduced) + in-memory side-effect repos.
 */
import { describe, it, expect } from 'vitest';
import { SaltProvider, LocalSecretsProvider } from '../infrastructure/secrets/SaltProvider.js';
import { BatchResolveIdentityUseCase } from '../application/BatchResolveIdentityUseCase.js';
import { applyResolveSideEffects } from '../jobs/silver-identity/side-effects.js';
import type {
  IdentityStore,
  IdentityReadState,
  IdentityBatchReadState,
  BatchOutcomeItem,
} from '../domain/identity/IdentityStore.js';
import type {
  ExistingLink,
  ExtractedIdentifier,
  ResolveOutcome,
  BrandPhoneGuardConfig,
} from '../domain/identity/IdentityResolver.js';
import type { RestitchDirtyEntry } from '../domain/identity/RestitchDirty.js';
import type { JourneyDirtyEntry } from '../domain/journey/JourneyReversionDirty.js';
import type { ScopedRecompute } from '../domain/identity/ScopedRecompute.js';

const BRAND = '11111111-2222-3333-4444-555555555555';
const SALT_HEX = 'ab'.repeat(32);
const NOW_ISO = '2026-07-17T00:00:00.000Z';
const CFG: BrandPhoneGuardConfig = { phone_guard_threshold: 3, suppression_window_days: 30 };

const ev = (i: number, props: Record<string, string>): Buffer =>
  Buffer.from(
    JSON.stringify({
      brand_id: BRAND,
      event_id: `evt-${String(i).padStart(4, '0')}`,
      payload: { properties: props },
    }),
    'utf8',
  );

/** Minimal Neo4j-faithful bulk-capable store: alias-resolved link reads, idempotent link writes. */
class ChunkFakeStore implements IdentityStore {
  readonly links: Array<{ brain_id: string; type: string; hash: string; is_active: boolean }> = [];
  readonly mergedInto = new Map<string, string>();
  writeCalls = 0;
  /** 1-based writeOutcomesBatch call number to fail on (once); null = never fail. */
  failOnWriteCall: number | null = null;

  private canonicalOf(brainId: string): string {
    let cur = brainId;
    const seen = new Set<string>();
    while (this.mergedInto.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.mergedInto.get(cur)!;
    }
    return cur;
  }

  async readState(): Promise<IdentityReadState> {
    throw new Error('per-event readState is not on the batch path');
  }

  async readStateBatch(
    _brandId: string,
    identifierHashes: Array<{ type: string; hash: string }>,
  ): Promise<IdentityBatchReadState> {
    const wanted = new Set(identifierHashes.map((i) => `${i.type}:${i.hash}`));
    const existingLinks: ExistingLink[] = this.links
      .filter((l) => l.is_active && wanted.has(`${l.type}:${l.hash}`))
      .map((l) => ({
        brain_id: this.canonicalOf(l.brain_id),
        identifier_type: l.type,
        identifier_value: l.hash,
        is_active: true,
      }));
    return {
      existingLinks,
      sharedUtilityMap: new Map(),
      phoneCount: new Map(),
      aliasChain: new Set(this.mergedInto.keys()),
      brandConfig: CFG,
      strongOwnedBrainIds: new Set(),
      phoneBrainIdsInWindow: new Map(),
    };
  }

  async writeOutcome(
    _brandId: string,
    outcome: ResolveOutcome,
    _identifiers: ExtractedIdentifier[],
  ): Promise<{ written: boolean }> {
    for (const nl of outcome.newLinks) {
      const existing = this.links.find(
        (l) => l.brain_id === outcome.brainId && l.type === nl.type && l.hash === nl.hash,
      );
      if (!existing) {
        this.links.push({ brain_id: outcome.brainId, type: nl.type, hash: nl.hash, is_active: true });
      }
    }
    if (outcome.action === 'merged' && outcome.merge) {
      this.mergedInto.set(outcome.merge.mergedBrainId, outcome.merge.canonicalBrainId);
    }
    return { written: true };
  }

  async writeOutcomesBatch(brandId: string, items: BatchOutcomeItem[]): Promise<{ written: number }> {
    this.writeCalls += 1;
    if (this.failOnWriteCall === this.writeCalls) {
      this.failOnWriteCall = null; // fail exactly once — the re-run succeeds
      throw new Error('neo4j write failed (injected, chunk boundary)');
    }
    for (const item of items) await this.writeOutcome(brandId, item.outcome, item.identifiers);
    return { written: items.length };
  }
}

/** In-memory idempotent side-effect repos (Map-set = the PG ON CONFLICT upsert semantics). */
function makeSideEffectHarness() {
  const scopedRecomputes = new Map<string, ScopedRecompute>();
  const restitch = new Map<string, RestitchDirtyEntry>();
  const journey = new Map<string, JourneyDirtyEntry>();
  const cache = new Map<string, string>();
  const deps = {
    flags: { isFlagEnabled: async () => false }, // stitch/journey OFF — default posture
    scopedRecomputeRepo: {
      upsert: async (r: ScopedRecompute) => {
        scopedRecomputes.set(r.request_id, r);
      },
    },
    restitchRepo: {
      markDirty: async (entries: RestitchDirtyEntry[]) => {
        for (const e of entries) restitch.set(JSON.stringify(e), e);
      },
    },
    journeyReversionRepo: {
      markDirty: async (entries: JourneyDirtyEntry[]) => {
        for (const e of entries) journey.set(JSON.stringify(e), e);
      },
    },
    identifierCache: {
      primeMany: async (
        brandId: string,
        entries: Array<{ type: string; hash: string; brainId: string }>,
      ) => {
        // In-memory Map STUB of the identifier cache — not Redis; the brand id is part of the fake
        // key on purpose (mirrors the adapter's brand-scoped shape the assertions read back).
        // eslint-disable-next-line brain-redis/no-raw-redis-key
        for (const e of entries) cache.set(`${brandId}|${e.type}|${e.hash}`, e.brainId);
      },
    },
    now: NOW_ISO,
  };
  return { deps, scopedRecomputes, restitch, journey, cache };
}

const saltProvider = new SaltProvider(new LocalSecretsProvider(), () => SALT_HEX);

// e1/e2 mint (chunk 1) · e3 bridges e1+e2 → MERGE, e4 mints (chunk 2) · e5 links (chunk 3)
const EVENTS = [
  ev(1, { email: 'a@example.com' }),
  ev(2, { phone: '+919876543210' }),
  ev(3, { email: 'a@example.com', phone: '+919876543210' }),
  ev(4, { email: 'c@example.com' }),
  ev(5, { email: 'c@example.com', anon_id: 'anon-1' }),
];

describe('M2 — per-chunk side effects match graph-write granularity', () => {
  it('mid-page failure after chunk N: chunks 1..N side effects applied; re-run completes without dupes', async () => {
    const store = new ChunkFakeStore();
    const harness = makeSideEffectHarness();
    const chunkSizes: number[] = [];

    const onChunk = async (chunk: { results: unknown[]; outcomes: BatchOutcomeItem[] }) => {
      chunkSizes.push(chunk.outcomes.length);
      await applyResolveSideEffects(BRAND, chunk.outcomes, harness.deps);
    };

    // ── Run 1: chunk 2's graph write fails mid-page ──────────────────────────
    store.failOnWriteCall = 2;
    const run1 = new BatchResolveIdentityUseCase(saltProvider, store, BRAND, { batchSize: 2 });
    await expect(run1.executeWithOutcomes(EVENTS, NOW_ISO, onChunk)).rejects.toThrow(
      'neo4j write failed',
    );

    // Chunk 1 committed → its side effects ARE applied (the old whole-page path lost these).
    expect(chunkSizes).toEqual([2]);
    expect(store.links).toHaveLength(2); // e1 (email) + e2 (phone) minted links only
    expect(harness.cache.size).toBe(2); // both minted identifiers primed
    expect(harness.scopedRecomputes.size).toBe(0); // the merge never committed — no recompute yet

    // ── Run 2: watermark was held → the same (idempotent) page re-processes ──
    const run2 = new BatchResolveIdentityUseCase(saltProvider, store, BRAND, { batchSize: 2 });
    const { results } = await run2.executeWithOutcomes(EVENTS, NOW_ISO, onChunk);

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.outcome !== 'invalid')).toBe(true);
    expect(chunkSizes).toEqual([2, 2, 2, 1]); // run1 chunk1 + run2's three chunks

    // Merge side effect applied EXACTLY once (deterministic event_id keyed upsert).
    expect(harness.scopedRecomputes.size).toBe(1);
    const recompute = [...harness.scopedRecomputes.values()][0]!;
    expect(recompute.brand_id).toBe(BRAND);

    // No duplicate graph links: (brain,type,hash) unique.
    const linkKeys = store.links.map((l) => `${l.brain_id}|${l.type}|${l.hash}`);
    expect(new Set(linkKeys).size).toBe(linkKeys.length);

    // Cache primes exact: 2 distinct emails (a, c) + 1 phone — the post-merge chunk re-primes
    // overwrite the merged-away brain_id with the canonical survivor (Map-set = sliding upsert).
    const emailEntries = [...harness.cache.keys()].filter((k) => k.includes('|email|'));
    expect(emailEntries).toHaveLength(2);
    expect([...harness.cache.keys()].filter((k) => k.includes('|phone|'))).toHaveLength(1);
    expect(harness.restitch.size).toBe(0); // flag OFF — parity with the removed consumers
    expect(harness.journey.size).toBe(0);
  });

  it('whole-page callers without the hook keep the exact prior return shape', async () => {
    const store = new ChunkFakeStore();
    const use = new BatchResolveIdentityUseCase(saltProvider, store, BRAND, { batchSize: 2 });
    const { results, outcomes } = await use.executeWithOutcomes(EVENTS, NOW_ISO);
    expect(results).toHaveLength(5);
    expect(outcomes.length).toBeGreaterThanOrEqual(5 - 1); // merge events still produce an outcome per event
  });
});
