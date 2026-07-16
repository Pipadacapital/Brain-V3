/**
 * BatchResolveIdentityUseCase — the BATCHED identity-resolution path for the ONE-TIME BACKFILL CLI
 * (GAP-A). Replaces ~7 Neo4j round-trips PER EVENT with two bulk store calls PER BATCH
 * (readStateBatch + writeOutcomesBatch) while preserving PER-EVENT SEQUENTIAL SEMANTICS exactly.
 *
 * WHY sequential semantics matter: identity resolution is ORDER-DEPENDENT within a brand — event A
 * mints a brain_id for email E; event B carrying E must LINK to that brain, not mint a second one.
 * The batch therefore resolves events ONE AT A TIME against an in-memory OVERLAY of the read state:
 * after each event's (pure, unchanged) IdentityResolver.resolve(), the outcome is applied to the
 * overlay exactly as a subsequent per-event readState would observe it post-writeOutcome:
 *
 *   • mint/link  → each newLink appends an ExistingLink {brain_id: outcome.brainId, type, hash,
 *                  is_active: true} (readState's alias-RESOLVED view of the new IDENTIFIES edge);
 *                  a NEW phone edge also updates the raw phone-window brain set (readState's
 *                  windowed distinct count — RAW edge targets, NO alias resolution, mirroring the
 *                  count query) so the phone-guard threshold advances identically.
 *   • merge      → every overlay link whose brain_id is the merged (tombstoned) id is REWRITTEN to
 *                  the canonical id — because readState follows the live ALIAS_OF chain and would
 *                  return the canonical for those physical edges. The merged id joins aliasChain
 *                  (cycle-guard input). The RAW phone-window sets are NOT rewritten (the physical
 *                  edges are not re-pointed by a merge; the count query does not alias-resolve).
 *   • phone-guard→ suppress updates fold into the SharedUtility map exactly like the graph upsert:
 *                  profile_count keeps the GREATEST value; suppressed_until takes the new value.
 *
 * SUPERSET-READ SAFETY: readStateBatch returns the UNION of the whole batch's hashes. That is safe
 * because the resolver only ever consults links whose (type, hash) equal the CURRENT event's
 * identifiers, and the LINK branch's "already linked" filter also tests only the current event's
 * (type, hash) pairs — extra rows for other events' hashes can never change a decision. (This holds
 * ONLY on the deterministic flag-OFF path — see the scope note below.)
 *
 * SCOPE (deliberately narrower than the live per-event execute(), matching the backfill CLI's
 * existing wiring EXACTLY — deterministic-only):
 *   • NO confidence/review deps, NO event publisher, NO flag service — so the priority-config path,
 *     the shared-device guard, and the probabilistic review gate NEVER run (exactly like the CLI's
 *     `new ResolveIdentityUseCase(saltProvider, identityRepo)`). The shared-device guard in
 *     particular is NOT batch-safe under a superset read (its mint-path `ownedElsewhere` set is
 *     built from ALL returned links, not just the event's own) — keeping it off is both the CLI's
 *     current behaviour and the correctness boundary. Do NOT wire flags into this class without
 *     re-deriving the overlay for those paths.
 *   • SINGLE BRAND per instance (the backfill is per-tenant). Events for any other brand are
 *     rejected as invalid (the CLI's tenant guard already filters them; defence-in-depth).
 *
 * Extraction/hashing is the SHARED extractEventIdentifiers (factored verbatim out of execute()) —
 * one implementation, zero drift, byte-identical hashes.
 *
 * PII: no raw identifier values in logs (hash-only, I-S02); contactPiiWrites pass through to the
 * store's bulk writer untouched.
 */
import { IdentityResolver } from '../domain/identity/IdentityResolver.js';
import type {
  ExistingLink,
  SharedUtilityState,
  ResolveOutcome,
  ExtractedIdentifier,
} from '../domain/identity/IdentityResolver.js';
import type { IdentityStore, IdentityBatchReadState, BatchOutcomeItem } from '../domain/identity/IdentityStore.js';
import type { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';
import type { ResolveResult } from './ResolveIdentityUseCase.js';
import { extractEventIdentifiers } from './extract-event-identifiers.js';

/** Default events per readStateBatch/writeOutcomesBatch round-trip (CLI-overridable). */
export const DEFAULT_IDENTITY_BATCH_SIZE = 500;

/**
 * The in-memory overlay of one batch's read state — the “graph as the NEXT per-event readState
 * would see it”, advanced after every resolved event so intra-batch dependencies (mint→link,
 * mint+mint→merge, phone-guard counts) resolve identically to the per-event path.
 */
interface BatchOverlay {
  /** Alias-RESOLVED active links (readState shape). Mutated in place: adds + merge rewrites. */
  links: ExistingLink[];
  /** Phone-guard SharedUtility rows keyed by phone hash (upsert semantics mirror the graph). */
  sharedUtility: Map<string, SharedUtilityState>;
  /** RAW windowed phone→distinct-brain sets (NO alias resolution — mirrors the count query). */
  phoneSets: Map<string, Set<string>>;
  /** Derived sizes of phoneSets — the map handed to resolve() (get-or-0, like per-event). */
  phoneCount: Map<string, number>;
  /** Live merged (observed) brain_ids — the resolver's cycle-guard input. */
  aliasChain: Set<string>;
}

export class BatchResolveIdentityUseCase {
  private readonly resolver = new IdentityResolver();
  private readonly batchSize: number;

  constructor(
    private readonly saltProvider: SaltProvider,
    /** Must implement readStateBatch + writeOutcomesBatch (bulk-capable store). */
    private readonly identityRepo: IdentityStore,
    /** The ONE brand this backfill run resolves (per-tenant; other brands are rejected). */
    private readonly brandId: string,
    opts: { batchSize?: number } = {},
  ) {
    if (!identityRepo.readStateBatch || !identityRepo.writeOutcomesBatch) {
      throw new Error(
        '[batch-identity] the supplied IdentityStore is not bulk-capable (readStateBatch/writeOutcomesBatch missing)',
      );
    }
    const n = opts.batchSize ?? DEFAULT_IDENTITY_BATCH_SIZE;
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`[batch-identity] invalid batchSize ${String(opts.batchSize)} — must be a positive integer`);
    }
    this.batchSize = n;
  }

  /**
   * Resolve a sequence of Bronze event Buffers with per-event-sequential semantics, in internal
   * batches of `batchSize`. Returns one ResolveResult per input, in input order — the same shape
   * per-event execute() returns, so the CLI's outcome accounting is unchanged.
   *
   * Batches are strictly sequential: batch k's writeOutcomesBatch completes BEFORE batch k+1's
   * readStateBatch, so a cross-batch dependency (mint in batch k, link in batch k+1) is observed
   * through the store exactly as the per-event path would observe it.
   *
   * Error model: a failure anywhere in a batch (salt fetch, store read/write) throws for the WHOLE
   * batch after rolling nothing forward (the bulk write is one transaction) — the CLI catches and
   * falls back to the per-event path for that batch, converging on the old per-event error
   * accounting. Deterministic + idempotent writes make the retry safe.
   */
  async execute(rawValues: Array<Buffer | null>, now: string): Promise<ResolveResult[]> {
    const results: ResolveResult[] = [];
    for (let i = 0; i < rawValues.length; i += this.batchSize) {
      const chunk = rawValues.slice(i, i + this.batchSize);
      results.push(...(await this.executeOneBatch(chunk, now)));
    }
    return results;
  }

  /** One batch: extract+hash all → ONE bulk read → sequential resolve over the overlay → ONE bulk write. */
  private async executeOneBatch(rawValues: Array<Buffer | null>, _now: string): Promise<ResolveResult[]> {
    // ── 1. Extract + hash every event (the SHARED front-half; byte-identical to execute()) ──────
    type Slot =
      | { kind: 'done'; result: ResolveResult }
      | {
          kind: 'resolve';
          brandId: string;
          eventId: string;
          identifiers: ExtractedIdentifier[];
          /** Filled in step 4 (sequential resolve) — read back for the result mapping in step 6. */
          outcome?: ResolveOutcome;
        };
    const slots: Slot[] = [];

    for (const raw of rawValues) {
      const extracted = await extractEventIdentifiers(raw, this.saltProvider);
      if (extracted.status === 'invalid') {
        slots.push({ kind: 'done', result: { outcome: 'invalid', reason: extracted.reason } });
        continue;
      }
      if (extracted.status === 'no_identifiers') {
        slots.push({
          kind: 'done',
          result: { outcome: 'no_identifiers', brandId: extracted.brandId, eventId: extracted.eventId },
        });
        continue;
      }
      // Tenant guard (defence-in-depth — the CLI already filters): the batch read/write is scoped to
      // ONE brand; an event for another brand must never fold into this brand's overlay.
      if (extracted.brandId !== this.brandId) {
        slots.push({
          kind: 'done',
          result: { outcome: 'invalid', reason: 'brand mismatch (batch backfill is single-brand)' },
        });
        continue;
      }
      slots.push({
        kind: 'resolve',
        brandId: extracted.brandId,
        eventId: extracted.eventId,
        identifiers: extracted.identifiers,
      });
    }

    const toResolve = slots.filter((s): s is Extract<Slot, { kind: 'resolve' }> => s.kind === 'resolve');
    if (toResolve.length === 0) {
      return slots.map((s) => (s as Extract<Slot, { kind: 'done' }>).result);
    }

    // ── 2. ONE bulk read over the UNION of the batch's identifier hashes ────────────────────────
    const seen = new Set<string>();
    const unionHashes: Array<{ type: string; hash: string }> = [];
    for (const s of toResolve) {
      for (const id of s.identifiers) {
        const key = `${id.type}:${id.hash}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unionHashes.push({ type: id.type, hash: id.hash });
      }
    }
    const state: IdentityBatchReadState = await this.identityRepo.readStateBatch!(this.brandId, unionHashes);

    // ── 3. Seed the overlay from the bulk read ───────────────────────────────────────────────────
    const overlay: BatchOverlay = {
      links: state.existingLinks.map((l) => ({ ...l })),
      sharedUtility: new Map([...state.sharedUtilityMap].map(([k, v]) => [k, { ...v }])),
      phoneSets: new Map([...state.phoneBrainIdsInWindow].map(([k, v]) => [k, new Set(v)])),
      phoneCount: new Map(state.phoneCount),
      aliasChain: new Set(state.aliasChain),
    };

    // ── 4. Resolve sequentially over the overlay (the pure resolver — UNCHANGED) ────────────────
    const outcomes: BatchOutcomeItem[] = [];
    for (const s of toResolve) {
      const outcome = this.resolver.resolve(
        this.brandId,
        s.identifiers,
        overlay.links,
        overlay.sharedUtility,
        overlay.phoneCount,
        state.brandConfig,
        overlay.aliasChain,
        undefined,   // now → resolver default (identical to the per-event call)
        undefined,   // priorityConfig — flag path NOT wired (deterministic-only, like the CLI)
        undefined,   // strongOwnedBrainIds — shared-device guard NOT wired (see scope note)
      );
      this.applyOutcomeToOverlay(overlay, outcome);
      // verdict undefined — the CLI wires no confidence deps, so per-event writeOutcome also gets
      // undefined (the store stamps its deterministic-exact fallback). Identical stamp either way.
      outcomes.push({ outcome, identifiers: s.identifiers, verdict: undefined });
      s.outcome = outcome; // stash for the result mapping below
    }

    // ── 5. ONE bulk write, in event order (equivalent-by-contract to sequential writeOutcome) ───
    await this.identityRepo.writeOutcomesBatch!(this.brandId, outcomes);

    // ── 6. Results in input order ────────────────────────────────────────────────────────────────
    return slots.map((s) => {
      if (s.kind === 'done') return s.result;
      const outcome = s.outcome!;
      return { outcome: outcome.action, brainId: outcome.brainId, brandId: s.brandId, eventId: s.eventId };
    });
  }

  /**
   * Advance the overlay with one resolved outcome — EXACTLY what the next per-event readState
   * would observe after writeOutcome committed. This is the semantic crux; see the module doc.
   */
  private applyOutcomeToOverlay(overlay: BatchOverlay, outcome: ResolveOutcome): void {
    // New IDENTIFIES edges (mint → all identifiers minus guard-filtered mediums; link → the
    // not-yet-linked ones; merge/skipped → none). Each corresponds to ONE new physical edge whose
    // alias-resolved target is outcome.brainId (canonical at this point in the sequence). The
    // resolver guarantees no duplicate (brain, type, hash) can be emitted here: LINK filters ids
    // already linked to the brain (alias-resolved), and a MINT's brain is fresh.
    for (const nl of outcome.newLinks) {
      overlay.links.push({
        brain_id: outcome.brainId,
        identifier_type: nl.type,
        identifier_value: nl.hash,
        is_active: true,
      });
      // A new ACTIVE phone edge lands inside the suppression window (created_at = now) — advance the
      // RAW windowed distinct-brain set/count iff this brain is genuinely new for the hash, exactly
      // what a per-event re-read of the count query would return.
      if (nl.type === 'phone') {
        let set = overlay.phoneSets.get(nl.hash);
        if (!set) {
          set = new Set<string>();
          overlay.phoneSets.set(nl.hash, set);
        }
        if (!set.has(outcome.brainId)) {
          set.add(outcome.brainId);
          overlay.phoneCount.set(nl.hash, set.size);
        }
      }
    }

    // Merge: the merged customer is tombstoned behind a live ALIAS_OF → every physical edge still
    // pointing at it now alias-RESOLVES to the canonical. Rewrite the overlay's resolved view
    // (duplicates after rewrite are fine — readState also returns one row per physical edge, and the
    // resolver matches set-wise). The merged id joins the live alias chain (cycle-guard input).
    // RAW phone-window sets are untouched: a merge re-points NO physical edges and the windowed
    // count query does NOT alias-resolve.
    if (outcome.action === 'merged' && outcome.merge) {
      const { canonicalBrainId, mergedBrainId } = outcome.merge;
      for (const link of overlay.links) {
        if (link.brain_id === mergedBrainId) link.brain_id = canonicalBrainId;
      }
      overlay.aliasChain.add(mergedBrainId);
    }

    // Phone-guard SharedUtility upserts — mirror the graph write exactly: only suppress rows are
    // written; profile_count keeps the GREATEST value; suppressed_until takes the new value.
    for (const u of outcome.phoneGuardUpdates) {
      if (!u.suppress) continue;
      const prev = overlay.sharedUtility.get(u.identifier_value);
      overlay.sharedUtility.set(u.identifier_value, {
        identifier_type: u.identifier_type,
        identifier_value: u.identifier_value,
        profile_count: prev ? Math.max(prev.profile_count, u.profile_count) : u.profile_count,
        suppressed_until: u.suppressed_until,
      });
    }

    // routeToReview / contactPiiWrites / audit have NO read-state footprint — write-side only.
  }
}
