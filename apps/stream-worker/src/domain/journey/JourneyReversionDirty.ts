/**
 * SPEC: B.2 (WB-B2, AMD-08, AMD-11) — JourneyReversionDirty: the PURE map from an identity-map MUTATION
 * event to the set of brand-first, brain-grain "dirty" keys whose JOURNEYS must be rebuilt as version N+1.
 *
 * HEXAGONAL: this is DOMAIN — it imports NO infrastructure (no kafkajs, no pg). It takes an already
 * type-narrowed identity event and returns the dirty entries; the consumer (interfaces/) parses the wire
 * record and the repository (infrastructure/pg/) persists them into ops.journey_reversion_pending.
 *
 * WHY (B.2): a canonical journey (gold journey_events, brain-grain) is deterministic on the identity map.
 * When that map MUTATES the affected brain_ids' journeys change and must be re-versioned:
 *   - MERGE   → the survivor's journey now folds in the absorbed brain's touchpoints; the absorbed brain's
 *               rows are superseded. Both brain_ids are dirty (cause='merge'). The Spark reversion job
 *               (gold_journey_events_reversion.py) already performs the flip-then-copy-as-N+1 transfer.
 *   - UNMERGE → the split reappears: both the survivor and the restored id get rebuilt (cause='unmerge').
 *   - RESTITCH (identity.linked) → a late identify attaches new sessions to an EXISTING brain, changing
 *               that brain's journey composition; its journey is rebuilt as N+1 (cause='restitch'). This is
 *               the A.5.5 late-identify path — the linked brain_id is dirtied so B.1's construction (fed by
 *               the re-stitched silver_session_identity, WA-18) re-emits the enriched journey.
 *
 * NOT a re-version trigger (returns []):
 *   - identity.minted      → a brand-new brain_id: no existing journey to re-version (mirrors the
 *                            IdentityChangeRecomputeConsumer minted-skip). Its journey is BUILT, not
 *                            re-versioned, by the next B.1 construction run.
 *   - identity.suppressed  → erasure/consent-withdrawal, handled by the suppression/erasure path, not by
 *                            journey re-versioning.
 *   - identity.review_queued → a probable merge queued for human review, never auto-committed.
 *
 * COORDINATION WITH WB-B1 (the journey job): a dirty entry is the event-driven HAND-OFF — the Spark
 * reversion job drains ops.journey_reversion_pending each run, rebuilds those brains' journeys as N+1, and
 * writes journey_version_log {brand_id, brain_id, from_version, to_version, cause, at} (AMD-11) at its
 * re-version step, then clears the drained rows AFTER its MERGE commits (crash-safe). This mirrors the
 * WA-18 restitch dirty-set pattern (ops.restitch_pending) exactly, at brain grain instead of session grain.
 *
 * INVARIANTS:
 *   - brand_id FIRST on every entry (I-S01); a dirty brain_id is meaningless without its tenant.
 *   - brain_id is an opaque UUID — NEVER raw PII (I-S02). No identifier hashes ride this lane (journey
 *     re-version is brain-grain; session re-stitch keys ride ops.restitch_pending instead).
 *   - IDEMPOTENT: entries are de-duplicated within an event on (brand_id, brain_id); the PG table PK
 *     (brand_id, brain_id) makes re-delivery of the same mutation a no-op upsert.
 *   - No money.
 */
import type {
  IdentityLinkedEvent,
  IdentityMergedEvent,
  IdentityUnmergedEvent,
} from '@brain/contracts';

/** The identity event_name values this mapper turns into journey-reversion dirty keys. */
export type JourneyReversionTriggerEvent =
  | 'identity.linked'
  | 'identity.merged'
  | 'identity.unmerged';

/** The re-version CAUSE recorded on the dirty entry (and later on journey_version_log). AMD-11. */
export type JourneyReversionCause = 'merge' | 'unmerge' | 'restitch';

/** One brand-first, brain-grain dirty entry destined for ops.journey_reversion_pending (PK brand+brain). */
export interface JourneyDirtyEntry {
  /** Tenant key — FIRST (I-S01). */
  brand_id: string;
  /** The brain_id whose journey must be rebuilt as version N+1 (opaque UUID, never PII). */
  brain_id: string;
  /** Why the journey is dirty (drives journey_version_log.cause at re-version time). */
  cause: JourneyReversionCause;
  /** The mutation class that dirtied this brain (provenance / audit). */
  trigger_event: JourneyReversionTriggerEvent;
  /** The identity event_id that produced this dirty entry (causation chain). */
  source_event_id: string;
}

/**
 * De-duplicate entries within one event on brain_id (brand_id is constant per event). Stable order (first
 * occurrence wins) so a replay produces byte-identical entry sets. A merge whose survivor == absorbed (a
 * degenerate self-merge) therefore collapses to a single entry.
 */
function dedupe(entries: JourneyDirtyEntry[]): JourneyDirtyEntry[] {
  const seen = new Set<string>();
  const out: JourneyDirtyEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.brain_id)) continue;
    seen.add(e.brain_id);
    out.push(e);
  }
  return out;
}

/**
 * identity.merged → dirty {canonical_brain_id, merged_brain_id}, cause='merge'. Both brains are dirty: the
 * survivor's journey folds in the absorbed timeline; the absorbed brain's rows are superseded (is_current
 * flipped) by the reversion job.
 */
export function mergedToJourneyDirty(event: IdentityMergedEvent): JourneyDirtyEntry[] {
  const { brand_id, event_id, payload } = event;
  return dedupe(
    [payload.canonical_brain_id, payload.merged_brain_id].map((brain_id) => ({
      brand_id,
      brain_id,
      cause: 'merge' as const,
      trigger_event: 'identity.merged' as const,
      source_event_id: event_id,
    })),
  );
}

/**
 * identity.unmerged → dirty {canonical_brain_id, restored_brain_id}, cause='unmerge'. The split reappears:
 * the survivor loses the transferred rows and the restored id regains them, each rebuilt as N+1.
 */
export function unmergedToJourneyDirty(event: IdentityUnmergedEvent): JourneyDirtyEntry[] {
  const { brand_id, event_id, payload } = event;
  return dedupe(
    [payload.canonical_brain_id, payload.restored_brain_id].map((brain_id) => ({
      brand_id,
      brain_id,
      cause: 'unmerge' as const,
      trigger_event: 'identity.unmerged' as const,
      source_event_id: event_id,
    })),
  );
}

/**
 * identity.linked → dirty {brain_id}, cause='restitch'. A late identify attaches new sessions to this
 * EXISTING brain (A.5.5); its journey composition changes and is rebuilt as N+1 once the re-stitch (WA-18)
 * folds the historical sessions into silver_session_identity.
 */
export function linkedToJourneyDirty(event: IdentityLinkedEvent): JourneyDirtyEntry[] {
  const { brand_id, event_id, payload } = event;
  return [
    {
      brand_id,
      brain_id: payload.brain_id,
      cause: 'restitch' as const,
      trigger_event: 'identity.linked' as const,
      source_event_id: event_id,
    },
  ];
}

/**
 * The journey-level version bump contract (AMD-11 R1). A re-version pass rebuilds a brain's journey as
 * exactly version N+1 — the journey-level version is derived as max(data_version) over the brain's current
 * touchpoint rows, and each pass increments it by one. This pure helper is the single source of truth for
 * the bump, mirrored by the Spark reversion job's journey_version_log write (db/iceberg/spark/gold/
 * _journey_version_log_pure.py — keep the two in lockstep, like the platform-flags twin).
 *
 * @param fromVersion the journey-level version BEFORE this re-version (>= 0).
 * @throws RangeError if fromVersion is negative or non-integer (a version is a monotone counter).
 */
export function nextJourneyVersion(fromVersion: number): number {
  if (!Number.isInteger(fromVersion) || fromVersion < 0) {
    throw new RangeError(`nextJourneyVersion: fromVersion must be a non-negative integer, got ${fromVersion}`);
  }
  return fromVersion + 1;
}

/** One journey_version_log row (AMD-11): the audit of a single re-version transition at brain grain. */
export interface JourneyVersionLogEntry {
  brand_id: string;
  brain_id: string;
  from_version: number;
  to_version: number;
  cause: JourneyReversionCause;
  /** ISO-8601 UTC instant the re-version committed. */
  at: string;
}

/**
 * Build the journey_version_log entry for a single re-version transition. to_version is ALWAYS
 * from_version + 1 (nextJourneyVersion). Pure — used to construct log rows and to unit-test the bump.
 */
export function buildJourneyVersionLogEntry(
  brand_id: string,
  brain_id: string,
  fromVersion: number,
  cause: JourneyReversionCause,
  at: string,
): JourneyVersionLogEntry {
  return {
    brand_id,
    brain_id,
    from_version: fromVersion,
    to_version: nextJourneyVersion(fromVersion),
    cause,
    at,
  };
}
