/**
 * identity-confidence-review-gate.test.ts — F1 LIVE-PATH proof that the confidence/decision layer is
 * WIRED into ResolveIdentityUseCase.execute and ENFORCES the probabilistic review gate.
 *
 * Drives REAL Bronze-event buffers through the REAL use-case (real SHA-256 hashing, real
 * IdentityResolver, real ConfidenceEngine + DecisionEngine + ProbabilisticMatcher) against an
 * in-memory IdentityStore + the in-memory Decision Log / Evidence Store. No DB / Neo4j needed.
 *
 * Proves:
 *   (a) deterministic email/phone agreement still AUTO-MERGES (band exact) — unchanged.
 *   (b) a strong WEAK-signal agreement with NO deterministic key → route_to_review, NOT a merge,
 *       with a persisted review record (Decision Log + Evidence Store + graph review queue) and the
 *       verdict stamped on the evidence.
 *   (c) a probabilistic outcome is NEVER isMergeEligible (band sub-'exact').
 *   (d) commit-after-write: the graph write happens FIRST; a review-write failure never loses it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ConfidenceVerdict } from '@brain/contracts';
import { ResolveIdentityUseCase } from '../application/ResolveIdentityUseCase.js';
import type { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';
import type { IdentityStore, IdentityReadState, ReviewQueueItem } from '../domain/identity/IdentityStore.js';
import type { ExtractedIdentifier, ResolveOutcome, ExistingLink } from '../domain/identity/IdentityResolver.js';
import { ConfidenceEngine } from '../domain/identity/confidence/index.js';
import { createDefaultMatcherRegistry } from '../domain/identity/matchers/MatcherRegistry.js';
import { DecisionEngine } from '../domain/identity/decisions/DecisionEngine.js';
import { InMemoryDecisionLog } from '../infrastructure/identity/InMemoryDecisionLog.js';
import { InMemoryEvidenceStore } from '../infrastructure/identity/InMemoryEvidenceStore.js';

const BRAND = 'c9990099-0099-0099-0099-000000000099';
const NOW = '2026-06-28T00:00:00.000Z';

/** Fixed-salt provider so the use-case's real SHA-256 hashing is deterministic across events. */
const saltProvider = { saltHexForBrand: async () => 'ab'.repeat(32) } as unknown as SaltProvider;

interface StoredLink {
  brain_id: string;
  identifier_type: string;
  identifier_value: string;
  tier: string;
  is_active: boolean;
}

/** An in-memory IdentityStore that applies outcomes + records the stamped verdict + review queue. */
class FakeStore implements IdentityStore {
  links: StoredLink[] = [];
  writes: Array<{ outcome: ResolveOutcome; verdict?: ConfidenceVerdict }> = [];
  reviews: ReviewQueueItem[] = [];
  /** Global call-order trace — proves the graph write precedes any review write. */
  trace: string[] = [];
  /** When true, enqueueReview throws (fail-open assertion). */
  failReviewWrite = false;

  async readState(
    _brandId: string,
    identifierHashes: Array<{ type: string; hash: string }>,
  ): Promise<IdentityReadState> {
    const pairs = new Set(identifierHashes.map((i) => `${i.type}:${i.hash}`));
    const existingLinks = this.links
      .filter((l) => l.is_active && pairs.has(`${l.identifier_type}:${l.identifier_value}`))
      .map((l) => ({
        brain_id: l.brain_id,
        identifier_type: l.identifier_type,
        identifier_value: l.identifier_value,
        is_active: l.is_active,
      }));
    return {
      existingLinks,
      sharedUtilityMap: new Map(),
      phoneCount: new Map(),
      aliasChain: new Set(),
      brandConfig: { phone_guard_threshold: 10, suppression_window_days: 30 },
    };
  }

  async writeOutcome(
    _brandId: string,
    outcome: ResolveOutcome,
    _identifiers: ExtractedIdentifier[],
    verdict?: ConfidenceVerdict,
  ): Promise<{ written: boolean }> {
    this.trace.push('writeOutcome');
    this.writes.push({ outcome, verdict });
    for (const id of outcome.newLinks) {
      const key = `${outcome.brainId}:${id.type}:${id.hash}`;
      if (!this.links.some((l) => `${l.brain_id}:${l.identifier_type}:${l.identifier_value}` === key)) {
        this.links.push({
          brain_id: outcome.brainId,
          identifier_type: id.type,
          identifier_value: id.hash,
          tier: id.tier,
          is_active: true,
        });
      }
    }
    return { written: true };
  }

  async findCandidatesByWeakSignals(
    _brandId: string,
    weakHashes: Array<{ type: string; hash: string }>,
  ): Promise<ExistingLink[]> {
    const pairs = new Set(weakHashes.map((i) => `${i.type}:${i.hash}`));
    return this.links
      .filter((l) => l.is_active && l.tier === 'weak' && pairs.has(`${l.identifier_type}:${l.identifier_value}`))
      .map((l) => ({
        brain_id: l.brain_id,
        identifier_type: l.identifier_type,
        identifier_value: l.identifier_value,
        is_active: l.is_active,
      }));
  }

  async enqueueReview(_brandId: string, item: ReviewQueueItem): Promise<void> {
    this.trace.push('enqueueReview');
    if (this.failReviewWrite) throw new Error('simulated review-queue write failure');
    this.reviews.push(item);
  }
}

function bronzeEvent(eventId: string, props: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      brand_id: BRAND,
      event_id: eventId,
      region_code: 'IN',
      payload: { properties: props },
    }),
    'utf8',
  );
}

function buildUseCase(store: FakeStore, decisionLog: InMemoryDecisionLog, evidenceStore: InMemoryEvidenceStore) {
  const confidenceEngine = new ConfidenceEngine({ matchers: createDefaultMatcherRegistry().enabled() });
  return new ResolveIdentityUseCase(saltProvider, store, undefined, {
    confidenceEngine,
    decisionEngine: new DecisionEngine(),
    decisionLog,
    evidenceStore,
  });
}

describe('F1 — confidence/decision review gate wired into the live resolve path', () => {
  let store: FakeStore;
  let decisionLog: InMemoryDecisionLog;
  let evidenceStore: InMemoryEvidenceStore;
  let useCase: ResolveIdentityUseCase;

  beforeEach(() => {
    store = new FakeStore();
    decisionLog = new InMemoryDecisionLog();
    evidenceStore = new InMemoryEvidenceStore();
    useCase = buildUseCase(store, decisionLog, evidenceStore);
  });

  it('(a) deterministic email/phone agreement STILL auto-merges (band exact) with no review', async () => {
    // Seed two distinct customers: one known by email, one by phone.
    await useCase.execute(bronzeEvent('e1', { email: 'merge-me@example.com' }), NOW);
    await useCase.execute(bronzeEvent('e2', { phone: '+919812345678' }), NOW);
    expect(store.writes.map((w) => w.outcome.action)).toEqual(['minted', 'minted']);

    // An event carrying BOTH strong keys → two distinct strong brain_ids → deterministic merge.
    const res = await useCase.execute(
      bronzeEvent('e3', { email: 'merge-me@example.com', phone: '+919812345678' }),
      NOW,
    );

    expect(res.outcome).toBe('merged');
    const mergeWrite = store.writes.at(-1)!;
    expect(mergeWrite.outcome.action).toBe('merged');
    expect(mergeWrite.outcome.merge).toBeDefined();
    // The committed edges carry the DETERMINISTIC exact verdict (not a faked constant divorced from the engine).
    expect(mergeWrite.verdict?.band).toBe('exact');
    expect(mergeWrite.verdict?.matcher_id).toBe('deterministic-union-find');
    // No probabilistic review for a deterministic strong-key merge.
    expect(store.reviews).toHaveLength(0);
    expect(decisionLog.all()).toHaveLength(0);
  });

  it('(b)+(c) a weak-signal agreement with NO deterministic key ROUTES TO REVIEW, never merges', async () => {
    // Customer A: a known customer (email) that ALSO carries a weak cookie signal.
    await useCase.execute(
      bronzeEvent('a1', { email: 'known@example.com', cookie_id: 'cookie-XYZ' }),
      NOW,
    );
    const bidA = store.writes[0]!.outcome.brainId;

    store.trace = []; // isolate the trace for the review event

    // Event B: NO email/phone/device key — ONLY the same weak cookie. Deterministic resolver MINTS a
    // fresh brain_id; the ProbabilisticMatcher finds the weak agreement with A → route_to_review.
    const res = await useCase.execute(bronzeEvent('b1', { cookie_id: 'cookie-XYZ' }), NOW);

    // The deterministic outcome is a MINT (a fresh brain_id) — it did NOT merge into A.
    expect(res.outcome).toBe('minted');
    const bidB = res.brainId!;
    expect(bidB).not.toBe(bidA);

    // A review record was persisted (Decision Log + Evidence Store + graph review queue).
    expect(store.reviews).toHaveLength(1);
    const review = store.reviews[0]!;
    expect([review.brain_id_a, review.brain_id_b].sort()).toEqual([bidA, bidB].sort());

    const ledger = decisionLog.all();
    expect(ledger).toHaveLength(1);
    const decision = ledger[0]!.decision;
    expect(decision.command).toBe('route_to_review');

    // The verdict is stamped on the evidence (hash-only, machine-auditable).
    const evidence = await evidenceStore.get({ brand_id: BRAND, decision_id: ledger[0]!.decision_id });
    expect(evidence).not.toBeNull();
    expect(evidence!.matcher_id).toBe('probabilistic-fellegi-sunter');
    expect(evidence!.identifier_combo.length).toBeGreaterThan(0);

    // (c) The probabilistic verdict is NEVER merge-eligible (band sub-'exact').
    const engine = new ConfidenceEngine({ matchers: createDefaultMatcherRegistry().enabled() });
    if (decision.command === 'route_to_review') {
      expect(decision.verdict.band).not.toBe('exact');
      expect(decision.verdict.score).toBeLessThanOrEqual(95);
      expect(engine.isMergeEligible(decision.verdict)).toBe(false);
    }

    // The MINT edge itself still carries a deterministic stamp (the probabilistic verdict never commits).
    const mintWrite = store.writes.at(-1)!;
    expect(mintWrite.outcome.action).toBe('minted');
    expect(mintWrite.verdict?.band).toBe('exact');
    expect(mintWrite.verdict?.matcher_id).toBe('deterministic-union-find');
  });

  it('(d) commit-after-write: the graph write precedes the review write', async () => {
    await useCase.execute(bronzeEvent('a1', { email: 'order@example.com', cookie_id: 'c-1' }), NOW);
    store.trace = [];
    await useCase.execute(bronzeEvent('b1', { cookie_id: 'c-1' }), NOW);
    // writeOutcome (the deterministic graph commit) is FIRST; the review enqueue follows.
    expect(store.trace[0]).toBe('writeOutcome');
    expect(store.trace).toContain('enqueueReview');
    expect(store.trace.indexOf('writeOutcome')).toBeLessThan(store.trace.indexOf('enqueueReview'));
  });

  it('(d) fail-open: a review-write failure NEVER loses the deterministic graph write', async () => {
    await useCase.execute(bronzeEvent('a1', { email: 'fo@example.com', cookie_id: 'c-fo' }), NOW);
    store.failReviewWrite = true;

    // Even though the review enqueue throws, execute() resolves normally and the mint is committed.
    const res = await useCase.execute(bronzeEvent('b1', { cookie_id: 'c-fo' }), NOW);
    expect(res.outcome).toBe('minted');
    expect(store.writes.at(-1)!.outcome.action).toBe('minted'); // graph write survived
    expect(store.reviews).toHaveLength(0); // the review write failed (fail-open)
  });
});
