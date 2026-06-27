/**
 * identity-replay-determinism — the OPERATOR REPLAY rebuilds one brand's identity graph via the SAME
 * domain logic (IdentityResolver streaming + computeConnectedComponents batch union-find), in an
 * isolated in-memory shadow store, and the result is DETERMINISTIC + ORDER-INDEPENDENT.
 *
 * Pure-domain unit tests over IdentityReplayEngine + InMemoryIdentityGraph (no DB / Kafka / Neo4j).
 *
 * Invariants under test:
 *   1. A bridging event that shares strong keys with two prior identities MERGES them (resolver reuse).
 *   2. The streaming rebuild's partition equals the batch union-find's partition (stream == backfill).
 *   3. Permuting the event order yields a BYTE-IDENTICAL partition signature (order-independence).
 *   4. Re-running yields the SAME signature even though brain_ids are minted randomly (label-free).
 *   5. Idempotent: replaying the same events twice does not change the partition (re-process no-op).
 *   6. A medium (anon_id) id lets a later event ADOPT a known brain_id (resolve-only reuse in replay).
 */
import { describe, it, expect } from 'vitest';
import {
  replayIdentity,
  assertOrderIndependent,
  type ReplayEvent,
} from '../domain/identity/IdentityReplayEngine.js';
import type { ExtractedIdentifier } from '../domain/identity/IdentityResolver.js';

const BRAND = '11111111-1111-1111-1111-111111111111';

function sid(type: ExtractedIdentifier['type'], hash: string): ExtractedIdentifier {
  return { type, hash, tier: 'strong', confidence: 'high' };
}
function mid(type: ExtractedIdentifier['type'], hash: string): ExtractedIdentifier {
  return { type, hash, tier: 'medium', confidence: 'low' };
}

/**
 * Two strong components:
 *   { email:A, phone:P }  (e3 bridges e1+e2 → MERGE)
 *   { email:B }
 */
const events: ReplayEvent[] = [
  { event_id: 'e1', identifiers: [sid('email', 'h_emailA')] },
  { event_id: 'e2', identifiers: [sid('phone', 'h_phoneP')] },
  { event_id: 'e3', identifiers: [sid('email', 'h_emailA'), sid('phone', 'h_phoneP')] },
  { event_id: 'e4', identifiers: [sid('email', 'h_emailB')] },
];

describe('IdentityReplayEngine — deterministic, order-independent rebuild', () => {
  it('reuses the resolver: a bridging event MERGES two prior identities', async () => {
    const r = await replayIdentity(events, { brandId: BRAND });
    expect(r.outcomes).toContain('merged');
    expect(r.distinctIdentities).toBe(2); // {emailA,phoneP} ∪ {emailB}
  });

  it('streaming rebuild == batch union-find (stream == backfill)', async () => {
    const r = await replayIdentity(events, { brandId: BRAND });
    expect(r.streamEqualsBatch).toBe(true);
    expect(r.streamSignature).toBe(r.batchSignature);
  });

  it('is order-independent: every permutation yields the SAME partition signature', async () => {
    const report = await assertOrderIndependent(events, { brandId: BRAND });
    expect(report.orderIndependent).toBe(true);
    expect(report.streamEqualsBatch).toBe(true);
    expect(report.signatures).toHaveLength(1); // exactly one distinct signature across all orders
  });

  it('is label-free: two independent replays produce the SAME signature (random brain_ids differ)', async () => {
    const a = await replayIdentity(events, { brandId: BRAND });
    const b = await replayIdentity(events, { brandId: BRAND });
    expect(a.streamSignature).toBe(b.streamSignature);
  });

  it('is idempotent: replaying the same events twice does not change the partition', async () => {
    const once = await replayIdentity(events, { brandId: BRAND });
    const twice = await replayIdentity([...events, ...events], { brandId: BRAND });
    expect(twice.streamSignature).toBe(once.streamSignature);
    expect(twice.distinctIdentities).toBe(once.distinctIdentities);
  });

  it('medium (anon_id) id lets a later event ADOPT a known brain_id (resolve-only, not a new mint)', async () => {
    const adopt: ReplayEvent[] = [
      { event_id: 'm1', identifiers: [sid('email', 'h_e1'), mid('anon_id', 'h_an1')] },
      { event_id: 'm2', identifiers: [mid('anon_id', 'h_an1')] },
    ];
    const r = await replayIdentity(adopt, { brandId: BRAND });
    expect(r.outcomes).toEqual(['minted', 'linked']);
    expect(r.distinctIdentities).toBe(1);
  });

  it('rejects cross-brand access in the isolated shadow graph', async () => {
    const r = await replayIdentity(events, { brandId: BRAND });
    await expect(r.graph.readState('22222222-2222-2222-2222-222222222222', [])).rejects.toThrow(
      /cross-brand/,
    );
  });
});
