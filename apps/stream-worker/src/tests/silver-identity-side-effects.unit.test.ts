/**
 * silver-identity side-effects — unit tests (ADR-0015 WS3).
 *
 * The Silver identity stage replaces the removed streaming consumers; this suite proves the
 * DIRECT side-effect application is behaviour-identical to the lanes it replaced:
 *   1. merged  → ops.scoped_recompute_request upsert (UNGATED, like IdentityChangeRecomputeConsumer)
 *                + servingCacheDirty=true (the caller evicts `${brand}:*` — the cache.invalidate lane)
 *                + tp-cache merge invalidation invoked (flag-gated inside the service — fake here).
 *   2. minted/linked/merged → ops.restitch_pending entries ONLY when `stitch.v2` is ON (default OFF).
 *   3. linked/merged → ops.journey_reversion_pending entries ONLY when `journey.engine` is ON.
 *   4. flags OFF (the default) → NO dirty writes, but the scoped recompute + eviction still fire
 *      (byte-identical to the consumer behaviour: recompute was never flag-gated).
 *   5. identifier cache primed with every deterministic (non-weak) identifier → outcome.brainId.
 *   6. deterministic event_id provenance: replaying the same outcome writes IDENTICAL rows.
 *
 * Pure fakes — no Kafka, no PG, no Redis, no Neo4j.
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { BatchOutcomeItem } from '../domain/identity/IdentityStore.js';
import type { ExtractedIdentifier, ResolveOutcome } from '../domain/identity/IdentityResolver.js';
import type { ScopedRecompute } from '../domain/identity/ScopedRecompute.js';
import type { RestitchDirtyEntry } from '../domain/identity/RestitchDirty.js';
import type { JourneyDirtyEntry } from '../domain/journey/JourneyReversionDirty.js';
import { applyResolveSideEffects, type SideEffectDeps } from '../jobs/silver-identity/side-effects.js';

const BRAND = randomUUID();
const BRAIN_A = randomUUID();
const BRAIN_B = randomUUID();
const NOW = new Date().toISOString();

const h = (seed: string): string => createHash('sha256').update(seed).digest('hex');
const EMAIL_HASH = h('email:jane@example.com');
const ANON_HASH = h('anon:device-1');
const COOKIE_HASH = h('cookie:weak-1');

function id(type: ExtractedIdentifier['type'], hash: string, tier: ExtractedIdentifier['tier']): ExtractedIdentifier {
  return { type, hash, tier, confidence: tier === 'strong' ? 'high' : 'low' };
}

function outcomeBase(action: ResolveOutcome['action'], brainId: string): ResolveOutcome {
  return {
    action,
    brainId,
    newLinks: [],
    phoneGuardUpdates: [],
    routeToReview: false,
    contactPiiWrites: [],
  };
}

function mintedItem(): BatchOutcomeItem {
  const identifiers = [id('email', EMAIL_HASH, 'strong'), id('anon_id', ANON_HASH, 'medium'), id('cookie_id', COOKIE_HASH, 'weak')];
  const outcome = outcomeBase('minted', BRAIN_A);
  outcome.newLinks = identifiers.filter((i) => i.tier !== 'weak');
  return { outcome, identifiers };
}

function linkedItem(): BatchOutcomeItem {
  const identifiers = [id('email', EMAIL_HASH, 'strong'), id('anon_id', ANON_HASH, 'medium')];
  const outcome = outcomeBase('linked', BRAIN_A);
  outcome.newLinks = [identifiers[1]!]; // only the anon is newly attached
  return { outcome, identifiers };
}

function mergedItem(): BatchOutcomeItem {
  const identifiers = [id('email', EMAIL_HASH, 'strong')];
  const outcome = outcomeBase('merged', BRAIN_A);
  outcome.merge = { canonicalBrainId: BRAIN_A, mergedBrainId: BRAIN_B, mergeId: randomUUID() };
  return { outcome, identifiers };
}

interface FakeDeps extends SideEffectDeps {
  recomputes: ScopedRecompute[];
  restitch: RestitchDirtyEntry[][];
  journey: JourneyDirtyEntry[][];
  primed: Array<{ type: string; hash: string; brainId: string }>;
  tpMerges: Array<Record<string, unknown>>;
}

function fakeDeps(opts: { stitchOn?: boolean; journeyOn?: boolean } = {}): FakeDeps {
  const recomputes: ScopedRecompute[] = [];
  const restitch: RestitchDirtyEntry[][] = [];
  const journey: JourneyDirtyEntry[][] = [];
  const primed: Array<{ type: string; hash: string; brainId: string }> = [];
  const tpMerges: Array<Record<string, unknown>> = [];
  return {
    recomputes, restitch, journey, primed, tpMerges,
    flags: {
      async isFlagEnabled(_brandId: string, flag: string): Promise<boolean> {
        if (flag === 'stitch.v2') return opts.stitchOn ?? false;
        if (flag === 'journey.engine') return opts.journeyOn ?? false;
        return false;
      },
    },
    scopedRecomputeRepo: { async upsert(r) { recomputes.push(r); } },
    restitchRepo: { async markDirty(entries) { restitch.push(entries); } },
    journeyReversionRepo: { async markDirty(entries) { journey.push(entries); } },
    identifierCache: { async primeMany(_brand, entries) { primed.push(...entries); } },
    tpMergeInvalidator: {
      async handleIdentityMerged(raw: Buffer | null) {
        tpMerges.push(JSON.parse(raw!.toString('utf8')) as Record<string, unknown>);
        return { outcome: 'merged' };
      },
    },
    now: NOW,
  };
}

describe('silver-identity side-effects — direct application of the removed consumer lanes', () => {
  it('merged → scoped recompute upsert (ungated) + servingCacheDirty + tp merge invalidation', async () => {
    const deps = fakeDeps(); // flags OFF (the default) — recompute must STILL fire
    const { counts, servingCacheDirty } = await applyResolveSideEffects(BRAND, [mergedItem()], deps);

    expect(counts.scopedRecomputes).toBe(1);
    expect(servingCacheDirty).toBe(true);
    const r = deps.recomputes[0]!;
    expect(r.brand_id).toBe(BRAND);
    expect(new Set(r.affected_brain_ids)).toEqual(new Set([BRAIN_A, BRAIN_B]));
    // tp-cache merge invalidation received the merge payload (brand-first envelope)
    expect(deps.tpMerges).toHaveLength(1);
    expect(deps.tpMerges[0]!['brand_id']).toBe(BRAND);
    // flags OFF → no dirty-set writes (byte-identical to the consumers' default-OFF gates)
    expect(deps.restitch).toHaveLength(0);
    expect(deps.journey).toHaveLength(0);
  });

  it('minted/linked with flags OFF → nothing enqueued; identifier cache still primed (non-weak only)', async () => {
    const deps = fakeDeps();
    const { counts, servingCacheDirty } = await applyResolveSideEffects(
      BRAND, [mintedItem(), linkedItem()], deps,
    );
    expect(servingCacheDirty).toBe(false);
    expect(counts.scopedRecomputes).toBe(0);
    expect(deps.restitch).toHaveLength(0);
    expect(deps.journey).toHaveLength(0);
    // cache primed with strong+medium hashes → BRAIN_A, weak (cookie) NEVER cached
    expect(deps.primed.every((p) => p.brainId === BRAIN_A)).toBe(true);
    expect(deps.primed.some((p) => p.hash === COOKIE_HASH)).toBe(false);
    expect(new Set(deps.primed.map((p) => p.hash))).toEqual(new Set([EMAIL_HASH, ANON_HASH]));
  });

  it('stitch.v2 ON → minted/linked/merged write restitch dirty keys (anchor + combo, brand-first)', async () => {
    const deps = fakeDeps({ stitchOn: true });
    await applyResolveSideEffects(BRAND, [mintedItem(), linkedItem(), mergedItem()], deps);
    expect(deps.restitch).toHaveLength(1); // one batched UNNEST write
    const entries = deps.restitch[0]!;
    expect(entries.every((e) => e.brand_id === BRAND)).toBe(true);
    // the merge contributes brain_id-grain keys for both brains
    const brainKeys = entries.filter((e) => e.dirty_kind === 'brain_id').map((e) => e.dirty_key);
    expect(new Set(brainKeys)).toEqual(new Set([BRAIN_A, BRAIN_B]));
  });

  it('journey.engine ON → linked (cause=restitch) + merged (cause=merge) write journey dirty brains', async () => {
    const deps = fakeDeps({ journeyOn: true });
    await applyResolveSideEffects(BRAND, [mintedItem(), linkedItem(), mergedItem()], deps);
    expect(deps.journey).toHaveLength(1);
    const entries = deps.journey[0]!;
    // minted is NOT a journey trigger; linked dirties BRAIN_A (restitch); merged dirties both.
    expect(entries.some((e) => e.cause === 'restitch' && e.brain_id === BRAIN_A)).toBe(true);
    expect(entries.some((e) => e.cause === 'merge' && e.brain_id === BRAIN_B)).toBe(true);
  });

  it('replay determinism: the same outcomes produce IDENTICAL rows (event_id provenance stable)', async () => {
    const item = mergedItem();
    const a = fakeDeps({ stitchOn: true, journeyOn: true });
    const b = fakeDeps({ stitchOn: true, journeyOn: true });
    await applyResolveSideEffects(BRAND, [item], a);
    await applyResolveSideEffects(BRAND, [item], b);
    expect(a.recomputes).toEqual(b.recomputes);
    expect(a.restitch).toEqual(b.restitch);
    expect(a.journey).toEqual(b.journey);
  });
});
