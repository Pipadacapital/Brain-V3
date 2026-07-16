/**
 * batch-identity-parity — the SHIP GATE for the GAP-A batched backfill path (BatchResolveIdentityUseCase).
 *
 * PROVES batch == per-event: ~1000 synthetic events with heavily overlapping identifiers are run
 *   (a) through the LIVE per-event ResolveIdentityUseCase.execute(), and
 *   (b) through BatchResolveIdentityUseCase (batch sizes 1 / 100 / 1000 — 1 degenerates the batch
 *       machinery to per-event; 100 forces many cross-batch dependencies; 1000 puts everything in
 *       ONE batch so every dependency resolves through the in-memory overlay),
 * against the SAME Neo4j-faithful in-memory fake store, and asserts the per-event ResolveResult
 * (outcome + brain_id per event_id, in order) AND the complete final store state (links, customers,
 * aliases, merge events, phone-guard rows, reviews, audit ledger, contact_pii) are IDENTICAL.
 *
 * DETERMINISM HARNESS: brain_ids are minted with node:crypto randomUUID — random across runs — so
 * the module is mocked with a SEEDED, RESETTABLE generator. Both paths then mint the same UUID
 * sequence IFF they mint at the same events, making the comparison byte-exact (including which side
 * of a merge is canonical — lowest UUID). The system clock is frozen (timestamps byte-equal).
 *
 * HARD CASES COVERED (explicit fixtures + a seeded-random tail):
 *   • same email across events → LINK not double-mint (incl. across a batch boundary at 99→100);
 *   • two earlier mints bridged by a later two-email event → MERGE (canonical = lowest UUID);
 *   • CHAINED merges (A+B→K, then K+C→K') — the overlay's alias rewrite must be transitive;
 *   • post-merge events on the merged side's identifier → resolve to the canonical (alias chain);
 *   • phone-guard: threshold-0 run drives the suppression + wouldExceed branches and the windowed
 *     distinct-brain count growth (suppressed phones still LINK on mint → count advances — the
 *     overlay's RAW phone-window sets must track it exactly); threshold-3 run keeps phones as live
 *     merge keys (fold-into-one-brain behaviour);
 *   • anon/device medium-tier adoption (anon-only event adopts the known brain), medium AMBIGUITY
 *     (one event carrying two anons of two different brains → dropped evidence → mint that links
 *     BOTH anons → the next anon-only event is ambiguous and mints again);
 *   • pre-hashed email identifiers (64-hex pass-through) + storefront_customer_id (strong_on_link).
 *
 * The fake store mirrors the Neo4jIdentityRepository READ semantics precisely where it matters:
 * alias-RESOLVED existing links (live merged_into chain), RAW (non-alias-resolved) windowed phone
 * counts, live alias chain, shared-utility upsert fold (max profile_count / last suppressed_until),
 * H6 first_identified_at + merge inheritance, PG audit insert order, contact_pii first-wins.
 * Its writeOutcomesBatch is sequential writeOutcome — the store-side equivalence the
 * IdentityStore contract requires of real bulk writers (the Neo4j UNWIND Cypher itself needs a
 * live graph to verify; THIS test pins the overlay/batching semantics).
 *
 * Hash-only fixtures, no live services. @effort("deterministic").
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { SaltProvider, LocalSecretsProvider } from '../infrastructure/secrets/SaltProvider.js';
import { ResolveIdentityUseCase, type ResolveResult } from '../application/ResolveIdentityUseCase.js';
import { BatchResolveIdentityUseCase } from '../application/BatchResolveIdentityUseCase.js';
import type {
  IdentityStore,
  IdentityReadState,
  IdentityBatchReadState,
  BatchOutcomeItem,
} from '../domain/identity/IdentityStore.js';
import type {
  ExtractedIdentifier,
  ExistingLink,
  SharedUtilityState,
  BrandPhoneGuardConfig,
  ResolveOutcome,
} from '../domain/identity/IdentityResolver.js';
import type { ConfidenceVerdict } from '@brain/contracts';

// ── Deterministic, resettable randomUUID (everything else in node:crypto stays REAL) ─────────────
const uuidState = vi.hoisted(() => ({ seed: 0x5eed }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  // mulberry32 — tiny seeded PRNG; hex spread across the whole UUID so sort order varies realistically.
  const next = (): number => {
    uuidState.seed |= 0;
    uuidState.seed = (uuidState.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(uuidState.seed ^ (uuidState.seed >>> 15), 1 | uuidState.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randomUUID = (): string => {
    const hex = Array.from({ length: 32 }, () => Math.floor(next() * 16).toString(16)).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  return { ...actual, randomUUID };
});
const resetUuidSequence = (): void => {
  uuidState.seed = 0x5eed;
};

const BRAND = '11111111-2222-3333-4444-555555555555';
const SALT_HEX = 'ab'.repeat(32);
const FROZEN_NOW = new Date('2026-07-17T00:00:00.000Z');
const STRONG_LINK_TYPES = ['email', 'phone', 'storefront_customer_id', 'pre_hashed_email', 'pre_hashed_phone'];
const STRONG_TIERS = new Set(['strong', 'strong_on_link']);

// ── Neo4j-faithful in-memory fake store ───────────────────────────────────────────────────────────
interface FLink { brain_id: string; type: string; hash: string; tier: string; is_active: boolean; created_at: number }
interface FCustomer {
  brain_id: string;
  lifecycle_state: 'active' | 'merged';
  merged_into: string | null;
  first_identified_at: number | null;
}

class FakeGraphStore implements IdentityStore {
  readonly links: FLink[] = [];
  readonly customers = new Map<string, FCustomer>();
  readonly aliases: Array<{ merged: string; canonical: string; merge_id: string }> = [];
  readonly mergeEvents = new Map<string, { canonical: string; merged: string }>();
  readonly sharedUtility = new Map<string, SharedUtilityState>();
  readonly reviews: Array<{ brain_id: string; reason: string }> = [];
  readonly auditRows: Array<{ brain_id: string; action: string; merge_id: string | null; identifier_types: string[] }> = [];
  readonly contactPii = new Map<string, { brain_id: string; pii_type: string; identifier_hash: string; raw_value: string }>();

  constructor(private readonly brandConfig: BrandPhoneGuardConfig) {}

  /** F2 alias-resolution — follow the LIVE merged_into chain to the canonical survivor. */
  private canonicalOf(brainId: string): string {
    const seen = new Set<string>();
    let cur = brainId;
    while (!seen.has(cur)) {
      seen.add(cur);
      const c = this.customers.get(cur);
      if (!c || c.merged_into == null) return cur;
      cur = c.merged_into;
    }
    return cur;
  }

  async readState(
    _brandId: string,
    identifierHashes: Array<{ type: string; hash: string }>,
    now: Date = new Date(),
  ): Promise<IdentityReadState> {
    const wanted = new Set(identifierHashes.map((i) => `${i.type}:${i.hash}`));
    // 1. existing links — ALIAS-RESOLVED brain ids (one row per physical active edge).
    const existingLinks: ExistingLink[] = this.links
      .filter((l) => l.is_active && wanted.has(`${l.type}:${l.hash}`))
      .map((l) => ({
        brain_id: this.canonicalOf(l.brain_id),
        identifier_type: l.type,
        identifier_value: l.hash,
        is_active: true,
      }));

    // 2. strong-owned brains — active strong-TYPE edges on the (canonical) node itself.
    const strongOwnedBrainIds = new Set<string>();
    for (const b of new Set(existingLinks.map((l) => l.brain_id))) {
      if (this.links.some((l) => l.is_active && l.brain_id === b && STRONG_LINK_TYPES.includes(l.type))) {
        strongOwnedBrainIds.add(b);
      }
    }

    // 3+4. phone-guard rows + RAW windowed distinct-brain counts (NO alias resolution).
    const phoneHashes = identifierHashes.filter((i) => i.type === 'phone').map((i) => i.hash);
    const sharedUtilityMap = new Map<string, SharedUtilityState>();
    const phoneCount = new Map<string, number>();
    const cutoffMs = now.getTime() - this.brandConfig.suppression_window_days * 86_400_000;
    for (const hash of phoneHashes) {
      const su = this.sharedUtility.get(hash);
      if (su) sharedUtilityMap.set(hash, { ...su });
      phoneCount.set(hash, this.rawPhoneWindowBrains(hash, cutoffMs).size);
    }

    // 5. live alias chain (observed/merged brain ids).
    const aliasChain = new Set<string>();
    for (const c of this.customers.values()) if (c.merged_into != null) aliasChain.add(c.brain_id);

    return { existingLinks, sharedUtilityMap, phoneCount, aliasChain, brandConfig: this.brandConfig, strongOwnedBrainIds };
  }

  async readStateBatch(
    brandId: string,
    identifierHashes: Array<{ type: string; hash: string }>,
    now: Date = new Date(),
  ): Promise<IdentityBatchReadState> {
    const base = await this.readState(brandId, identifierHashes, now);
    const cutoffMs = now.getTime() - this.brandConfig.suppression_window_days * 86_400_000;
    const phoneBrainIdsInWindow = new Map<string, Set<string>>();
    for (const i of identifierHashes) {
      if (i.type !== 'phone') continue;
      phoneBrainIdsInWindow.set(i.hash, this.rawPhoneWindowBrains(i.hash, cutoffMs));
    }
    return { ...base, phoneBrainIdsInWindow };
  }

  private rawPhoneWindowBrains(hash: string, cutoffMs: number): Set<string> {
    return new Set(
      this.links
        .filter((l) => l.is_active && l.type === 'phone' && l.hash === hash && l.created_at > cutoffMs)
        .map((l) => l.brain_id), // RAW edge target — deliberately NOT alias-resolved (mirrors the count query)
    );
  }

  async writeOutcome(
    _brandId: string,
    outcome: ResolveOutcome,
    identifiers: ExtractedIdentifier[],
    _verdict?: ConfidenceVerdict,
  ): Promise<{ written: boolean }> {
    const nowMs = Date.now();

    // customer node
    this.ensureCustomer(outcome.brainId);

    // identity_link edges (MERGE: reactivate or create)
    for (const id of outcome.newLinks) {
      const existing = this.links.find((l) => l.brain_id === outcome.brainId && l.type === id.type && l.hash === id.hash);
      if (existing) existing.is_active = true;
      else this.links.push({ brain_id: outcome.brainId, type: id.type, hash: id.hash, tier: id.tier, is_active: true, created_at: nowMs });
    }

    // H6: first_identified_at — set once when an active strong-TIER edge exists.
    const c = this.customers.get(outcome.brainId)!;
    if (
      c.first_identified_at == null &&
      this.links.some((l) => l.is_active && l.brain_id === outcome.brainId && STRONG_TIERS.has(l.tier))
    ) {
      c.first_identified_at = nowMs;
    }

    // merge: tombstone + MergeEvent + ALIAS_OF + fia inheritance
    if (outcome.action === 'merged' && outcome.merge) {
      const { canonicalBrainId, mergedBrainId, mergeId } = outcome.merge;
      const m = this.ensureCustomer(mergedBrainId);
      m.lifecycle_state = 'merged';
      m.merged_into = canonicalBrainId;
      if (!this.mergeEvents.has(mergeId)) this.mergeEvents.set(mergeId, { canonical: canonicalBrainId, merged: mergedBrainId });
      if (!this.aliases.some((a) => a.merged === mergedBrainId && a.canonical === canonicalBrainId)) {
        this.aliases.push({ merged: mergedBrainId, canonical: canonicalBrainId, merge_id: mergeId });
      }
      const can = this.customers.get(canonicalBrainId)!;
      if (m.first_identified_at != null && (can.first_identified_at == null || m.first_identified_at < can.first_identified_at)) {
        can.first_identified_at = m.first_identified_at;
      }
    }

    // phone-guard SharedUtility upsert (max profile_count; unconditional suppressed_until)
    for (const u of outcome.phoneGuardUpdates) {
      if (!u.suppress) continue;
      const prev = this.sharedUtility.get(u.identifier_value);
      this.sharedUtility.set(u.identifier_value, {
        identifier_type: u.identifier_type,
        identifier_value: u.identifier_value,
        profile_count: prev ? Math.max(prev.profile_count, u.profile_count) : u.profile_count,
        suppressed_until: u.suppressed_until,
      });
    }

    // merge_review_queue
    if (outcome.routeToReview && outcome.reviewReason) {
      this.reviews.push({ brain_id: outcome.brainId, reason: outcome.reviewReason });
    }

    // PG mirror: identity_audit (insert order) + contact_pii (ON CONFLICT DO NOTHING → first wins)
    this.auditRows.push({
      brain_id: outcome.brainId,
      action: outcome.action === 'minted' ? 'mint' : outcome.action === 'merged' ? 'merge' : 'link',
      merge_id: outcome.merge?.mergeId ?? null,
      identifier_types: identifiers.map((i) => i.type),
    });
    for (const pii of outcome.contactPiiWrites) {
      const key = `${pii.brain_id}|${pii.pii_type}`;
      if (!this.contactPii.has(key)) {
        this.contactPii.set(key, {
          brain_id: pii.brain_id, pii_type: pii.pii_type, identifier_hash: pii.identifier_hash, raw_value: pii.raw_value,
        });
      }
    }

    return { written: true };
  }

  /** The contract's reference semantics: apply IN ORDER, equivalent to sequential writeOutcome. */
  async writeOutcomesBatch(brandId: string, items: BatchOutcomeItem[]): Promise<{ written: number }> {
    for (const item of items) await this.writeOutcome(brandId, item.outcome, item.identifiers, item.verdict);
    return { written: items.length };
  }

  private ensureCustomer(brainId: string): FCustomer {
    let c = this.customers.get(brainId);
    if (!c) {
      c = { brain_id: brainId, lifecycle_state: 'active', merged_into: null, first_identified_at: null };
      this.customers.set(brainId, c);
    }
    return c;
  }

  /** Canonicalized full-state snapshot for byte-exact comparison. */
  dump(): Record<string, unknown> {
    const byJson = (a: unknown, b: unknown): number => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    return {
      links: this.links.map((l) => ({ ...l })).sort(byJson),
      customers: [...this.customers.values()].map((c) => ({ ...c })).sort(byJson),
      aliases: this.aliases.map((a) => ({ ...a })).sort(byJson),
      mergeEvents: [...this.mergeEvents.entries()].sort(byJson),
      sharedUtility: [...this.sharedUtility.entries()]
        .map(([k, v]) => [k, { ...v, suppressed_until: v.suppressed_until ? v.suppressed_until.getTime() : null }])
        .sort(byJson),
      reviews: this.reviews.map((r) => ({ ...r })), // insertion order is part of the contract
      auditRows: this.auditRows.map((r) => ({ ...r })), // insertion order preserved
      contactPii: [...this.contactPii.entries()].sort(byJson),
    };
  }
}

// ── Fixture: ~1000 events with explicit hard cases + a seeded-random overlapping tail ─────────────
type Props = Record<string, string>;
const ev = (i: number, props: Props): Buffer =>
  Buffer.from(
    JSON.stringify({ brand_id: BRAND, event_id: `evt-${String(i).padStart(4, '0')}`, payload: { properties: props } }),
    'utf8',
  );

function mulberry(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildFixture(): Buffer[] {
  const props: Props[] = [];

  // same email across events → link
  props.push({ email: 'a1@example.com' });
  props.push({ email: 'a1@example.com' });
  // two mints bridged by a later two-email event → merge; then resolve-to-canonical
  props.push({ email: 'b1@example.com' });
  props.push({ email: 'c1@example.com' });
  props.push({ email: 'b1@example.com', $email: '' }); // still just b1 (precedence exercise)
  props.push({ email: 'b1@example.com', phone: '' }); // no-op phone (empty ignored? typeof string — '' IS a string...)
  props.push({ email: 'b1@example.com' });
  props.push({ email: 'b1@example.com', customer_id: 'sf-1001' }); // storefront strong_on_link joins b1's brain
  props.push({ email: 'c1@example.com', customer_id: 'sf-1001' }); // bridges b1+c1 via sf-1001 → MERGE
  props.push({ email: 'c1@example.com' }); // resolves to the canonical survivor
  // phone lanes (behave differently per threshold run)
  for (let k = 0; k < 8; k++) props.push({ email: `d${k}@example.com`, phone: `98765430${k}0` });
  for (let k = 0; k < 8; k++) props.push({ email: `d${k + 8}@example.com`, phone: '9876543999' }); // shared phone lane
  props.push({ phone: '9876543999' }); // phone-only event on the shared lane
  // medium-tier adoption + ambiguity
  props.push({ email: 'm1@example.com', brain_anon_id: 'anon-adopt' });
  props.push({ brain_anon_id: 'anon-adopt' }); // adopt (LINK)
  props.push({ email: 'x1@example.com', brain_anon_id: 'anon-a' });
  props.push({ email: 'y1@example.com', brain_anon_id: 'anon-b' });
  props.push({ brain_anon_id: 'anon-a', anon_id: 'IGNORED-brain_anon_id-wins' }); // anon-a only → adopt x1's brain
  props.push({ device_id: 'dev-1', brain_anon_id: 'anon-a' }); // device rides along
  // chained merges: c2+c3 → K, then K+c4 → K'
  props.push({ email: 'c2@example.com' });
  props.push({ email: 'c3@example.com' });
  props.push({ email: 'c2@example.com', phone_number: '' }); // benign
  props.push({ email: 'c2@example.com', $phone: '' });
  props.push({ email: 'c2@example.com', hashed_customer_email: 'f'.repeat(64) }); // pre-hashed joins c2's brain
  props.push({ hashed_customer_email: 'f'.repeat(64) }); // pre-hashed only → resolves to same brain
  props.push({ email: 'c3@example.com', email2: 'ignored' });
  props.push({ email: 'c2@example.com', $email: 'shadowed' }); // email precedence: 'email' wins
  props.push({ email: 'c3@example.com', customer_id: 'sf-2002' });
  props.push({ email: 'c2@example.com', customer_id: 'sf-2002' }); // bridges c2+c3 → MERGE
  props.push({ email: 'c4@example.com' });
  props.push({ email: 'c4@example.com', customer_id: 'sf-2002' }); // bridges K+c4 → CHAINED MERGE
  props.push({ email: 'c2@example.com' }); // transitively resolves to the final canonical
  // seeded-random tail with heavy overlap (organically crosses every batch boundary)
  const rand = mulberry(0xf157);
  const emails = Array.from({ length: 60 }, (_, k) => `user${k}@example.com`);
  const phones = Array.from({ length: 25 }, (_, k) => `91000000${String(k).padStart(2, '0')}`);
  const anons = Array.from({ length: 30 }, (_, k) => `anon-t${k}`);
  const devices = Array.from({ length: 15 }, (_, k) => `dev-t${k}`);
  const sfids = Array.from({ length: 20 }, (_, k) => `sf-t${k}`);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  while (props.length < 995) {
    const p: Props = {};
    const roll = rand();
    if (roll < 0.55) p['email'] = pick(emails);
    if (rand() < 0.3) p['phone'] = pick(phones);
    if (rand() < 0.25) p['customer_id'] = pick(sfids);
    if (rand() < 0.35) p['brain_anon_id'] = pick(anons);
    if (rand() < 0.15) p['device_id'] = pick(devices);
    if (Object.keys(p).length === 0) p['email'] = pick(emails);
    props.push(p);
  }
  // explicit CROSS-BATCH dependency for batchSize=100: mint at 99, link at 100.
  props[99] = { email: 'boundary-z1@example.com' };
  props[100] = { email: 'boundary-z1@example.com' };
  // explicit CROSS-BATCH merge: mints at 198/199 (batch 2), bridge at 200 (batch 3).
  props[198] = { email: 'boundary-w1@example.com' };
  props[199] = { email: 'boundary-w2@example.com' };
  props[200] = { email: 'boundary-w1@example.com', customer_id: 'sf-boundary' };
  props.push({ email: 'boundary-w2@example.com', customer_id: 'sf-boundary' }); // → merge later on
  // medium ambiguity finale: one event carrying two anons of two different brains → dropped → mint
  // linking BOTH anons; the following anon-only event is then ambiguous → mints again.
  props.push({ brain_anon_id: 'anon-a', device_id: 'dev-of-y1' });
  props.push({ email: 'y1@example.com', device_id: 'dev-of-y1' });
  props.push({ brain_anon_id: 'anon-a', anon_id: 'never-read' });
  props.push({ email: 'tail-final@example.com', phone: '9876543999', brain_anon_id: 'anon-adopt' });

  return props.map((p, i) => ev(i, p));
}

// ── Runners ───────────────────────────────────────────────────────────────────────────────────────
const NOW_ISO = FROZEN_NOW.toISOString();
const saltProvider = new SaltProvider(new LocalSecretsProvider(), () => SALT_HEX);

async function runPerEvent(events: Buffer[], cfg: BrandPhoneGuardConfig) {
  resetUuidSequence();
  const store = new FakeGraphStore(cfg);
  const useCase = new ResolveIdentityUseCase(saltProvider, store); // exactly the CLI's wiring
  const results: ResolveResult[] = [];
  for (const buf of events) results.push(await useCase.execute(buf, NOW_ISO));
  return { store, results };
}

async function runBatch(events: Buffer[], cfg: BrandPhoneGuardConfig, batchSize: number) {
  resetUuidSequence();
  const store = new FakeGraphStore(cfg);
  const useCase = new BatchResolveIdentityUseCase(saltProvider, store, BRAND, { batchSize });
  const results = await useCase.execute(events, NOW_ISO);
  return { store, results };
}

// ── The gate ──────────────────────────────────────────────────────────────────────────────────────
describe('GAP-A batched backfill — batch == per-event parity (ship gate)', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  const events = buildFixture();

  for (const threshold of [3, 0]) {
    const cfg: BrandPhoneGuardConfig = { phone_guard_threshold: threshold, suppression_window_days: 30 };

    describe(`phone_guard_threshold=${threshold}`, () => {
      for (const batchSize of [1, 100, 1000]) {
        it(`batchSize=${batchSize}: identical per-event results + identical final store state`, async () => {
          const a = await runPerEvent(events, cfg);
          const b = await runBatch(events, cfg, batchSize);

          // Per-event brain_id assignment (outcome + brainId per event_id, in order) — byte-exact.
          expect(b.results.length).toBe(a.results.length);
          expect(b.results).toEqual(a.results);

          // Final graph + PG-mirror state — byte-exact.
          expect(b.store.dump()).toEqual(a.store.dump());
        });
      }

      it('the fixture actually exercises the hard cases (mint/link/merge/adoption)', async () => {
        const { results, store } = await runPerEvent(events, cfg);
        const counts: Record<string, number> = {};
        for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
        expect(counts['minted'] ?? 0).toBeGreaterThan(10);
        expect(counts['linked'] ?? 0).toBeGreaterThan(10);
        expect(counts['merged'] ?? 0).toBeGreaterThan(2); // incl. the chained + cross-batch merges
        expect(store.aliases.length).toBeGreaterThan(2);
        // cross-batch boundary (99 mint → 100 link, same brain)
        expect(results[100]!.outcome).toBe('linked');
        expect(results[100]!.brainId).toBe(results[99]!.brainId);
        if (threshold === 0) {
          // suppression machinery exercised: every phone event trips wouldExceed/suppressed
          expect(store.sharedUtility.size).toBeGreaterThan(0);
        }
      });
    });
  }
});
