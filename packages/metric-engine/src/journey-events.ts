/**
 * @brain/metric-engine — computeJourneyEventsCurrent (versioned journey-ledger serving read).
 *
 * The SOLE read seam for the versioned event-sourced journey ledger's CURRENT projection
 * (brain_serving.mv_journey_events_current — `is_current = true` over iceberg.brain_gold.journey_events,
 * built by gold_journey_events.py + its merge re-versioning companion). One row per
 * (brand_id, touchpoint_id): the canonical resolved-identity timeline for a customer — an identity
 * merge flips the superseded version and appends a data_version+1 copy owned by the canonical
 * brain_id, so this read always shows the post-merge truth without rewriting history.
 *
 * Read through withSilverBrand (brand predicate injected at the seam, I-ST01; the engine is the only
 * serving reader — the UI never queries Trino). Newest-first, KEYSET-paginated:
 * sequence_number is assigned by `row_number() OVER (PARTITION BY brand_id, brain_id ORDER BY
 * occurred_at ASC, touch_seq ASC)` at build time, so within ONE brain_id `ORDER BY occurred_at DESC,
 * sequence_number DESC` is exactly `ORDER BY sequence_number DESC` — the keyset continuation is the
 * single strict `sequence_number < ?` bound (bigint-exact; no timestamp-precision drift in the cursor).
 *
 * MONEY (I-S07): revenueMinor is bigint MINOR units carried as a string (BigInt-safe JSON) with the
 * sibling currencyCode — never a float, never blended; non-null ONLY on composite transaction rows
 * (revenue truth is the connector order, joined from silver_order_state at build time).
 *
 * Honest-empty: hasData=false when the customer has no ledger rows (or the serving tier is
 * unavailable — the seam degrades a missing mart to []). NO PII: brain_id is the opaque resolved key.
 *
 * @see db/trino/views/mv_journey_events_current.sql (the served projection)
 * @see packages/metric-engine/src/customer-orders.ts (sibling per-customer serving read)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface JourneyEventRow {
  /** Stable ledger key of this journey event (one current version each). */
  touchpointId: string;
  /** Resolved-timeline position (bigint → string, BigInt-safe JSON); the keyset cursor key. */
  sequenceNumber: string;
  /** Raw Trino/Iceberg timestamp string (UTC); serialized verbatim. */
  occurredAt: string;
  /** Derived event category (the Silver SoT mapping). Null = uncategorized. */
  eventCategory: string | null;
  eventType: string;
  channel: string | null;
  campaign: string | null;
  /** bigint MINOR units as string (I-S07); non-null ONLY on composite transaction rows. */
  revenueMinor: string | null;
  /** Sibling currency for revenueMinor — never blended. Null when revenueMinor is null. */
  currencyCode: string | null;
  /** True = a composite transaction row (order joined onto the journey). */
  isComposite: boolean;
  /** Identity-resolution confidence (0..1 double) — NOT money, NOT a percentage. Null = unresolved. */
  identityConfidence: number | null;
  /** Ledger version of this row (re-versioned on identity merge; served row is always current). */
  dataVersion: number;
  /**
   * SPEC: B.4 EXPLAINABILITY — every journey item carries `matched_via`: HOW this event's identity
   * was matched onto the resolved brain_id. Canonical journeys are `identity_basis='deterministic'`
   * (B.1), so this is a DERIVED coarse basis until the B.1 mart column lands (AMD-13 R1: derived from
   * silver_identity_map identifier_type once stitch v2 ships): 'order' (composite transaction touch) |
   * 'deterministic' (resolved to a brain_id at event time) | 'anonymous' (event predates identity —
   * brain_id_asof NULL). NEVER null (honest explainability on every row).
   */
  matchedVia: string;
  /**
   * SPEC: B.4 — point-in-time identity: the brain_id that OWNED this event's identity AT occurred_at
   * (the bi-temporal silver_identity_map interval covering the event, DG-2). NULL = the event predates
   * the identity / is anonymous. Load-bearing for replay explainability (what was known then).
   */
  brainIdAsof: string | null;
  /**
   * SPEC: B.4 — probabilistic-overlay marker. Canonical deterministic journeys set `estimated=false`.
   * A probabilistic overlay view (Wave A.3 silver_probabilistic_stitch) sets `estimated=true` and a
   * `confidence`; deterministic-only canonical rows never do. Honest per §A.3 (auto `estimated:true`).
   */
  estimated: boolean;
}

export interface JourneyEventsPage {
  /** True iff the customer has any current ledger rows. */
  hasData: boolean;
  /** The page of events (newest-first). */
  events: JourneyEventRow[];
  /**
   * The last row's sequence_number when a FURTHER page exists (pass back as afterSequence);
   * null = this page is the last.
   */
  nextAfterSequence: string | null;
}

export interface JourneyEventsParams {
  /** The resolved customer's brain_id (canonical owner of the current ledger rows). */
  brainId: string;
  /** Keyset continuation: only rows with sequence_number strictly BELOW this (digits string). */
  afterSequence?: string | null;
  /** Page size (clamped 1..200; default 50). */
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Normalize a possibly-null DB string field. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

/** Normalize a Trino boolean (native boolean, or 0/1 over a legacy wire) → boolean. */
function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1';
}

interface JourneyEventDbRow {
  touchpoint_id: string;
  sequence_number: string | number;
  occurred_at: string;
  event_category: string | null;
  event_type: string;
  channel: string | null;
  campaign: string | null;
  revenue_minor: string | number | null;
  currency_code: string | null;
  is_composite: number | boolean;
  identity_confidence: string | number | null;
  data_version: string | number;
  // SPEC: B.4 — point-in-time identity columns (already projected by mv_journey_events_current).
  brain_id_asof: string | null;
  identity_confidence_asof: string | number | null;
}

/**
 * SPEC: B.4 — the shared SELECT column list for the journey ledger read (current + as-of paths).
 * Includes the DG-2 point-in-time identity columns so matched_via / brain_id_asof explainability is
 * present on every row. mv_journey_events_current already projects all of these.
 */
const LEDGER_COLUMNS = `touchpoint_id, sequence_number, occurred_at, event_category, event_type,
                channel, campaign, revenue_minor, currency_code, is_composite,
                identity_confidence, data_version, brain_id_asof, identity_confidence_asof`;

/**
 * SPEC: B.4 EXPLAINABILITY — derive the coarse `matched_via` basis for a canonical (deterministic)
 * journey row. Canonical journeys are deterministic-only (B.1); the true identifier_type arrives with
 * the B.1 mart column (AMD-13 R1). Until then: composite transaction touch → 'order'; resolved identity
 * at event time (brain_id_asof present) → 'deterministic'; else the event predates identity → 'anonymous'.
 */
function deriveMatchedVia(r: JourneyEventDbRow): string {
  if (r.is_composite === true || r.is_composite === 1) return 'order';
  if (r.brain_id_asof !== null && r.brain_id_asof !== undefined && String(r.brain_id_asof).length > 0) {
    return 'deterministic';
  }
  return 'anonymous';
}

/** SPEC: B.4 — map a raw ledger DB row to the JourneyEventRow contract (current + as-of paths share this). */
function toJourneyEventRow(r: JourneyEventDbRow): JourneyEventRow {
  return {
    touchpointId: String(r.touchpoint_id),
    // bigint-safe: Trino may surface bigint as string or number — String() either way (never float math).
    sequenceNumber: String(r.sequence_number),
    occurredAt: String(r.occurred_at),
    eventCategory: str(r.event_category),
    eventType: String(r.event_type),
    channel: str(r.channel),
    campaign: str(r.campaign),
    // Money: bigint minor units → string verbatim (drop any decimal tail — exact integer in the mart).
    revenueMinor: r.revenue_minor == null ? null : String(String(r.revenue_minor).split('.')[0] ?? '0'),
    currencyCode: str(r.currency_code),
    isComposite: asBool(r.is_composite),
    identityConfidence:
      r.identity_confidence === null || r.identity_confidence === undefined
        ? null
        : Number(r.identity_confidence),
    dataVersion: Number(r.data_version),
    // SPEC: B.4 explainability — every item carries matched_via + point-in-time identity.
    matchedVia: deriveMatchedVia(r),
    brainIdAsof: str(r.brain_id_asof),
    // Canonical journeys are deterministic-only — estimated is always false here (probabilistic
    // overlays live in a separate Wave A.3 view and set estimated:true + confidence).
    estimated: false,
  };
}

/**
 * computeJourneyEventsCurrent — one customer's current journey-ledger page, newest-first.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - the Trino serving pool (createTrinoPool) injected at the root.
 * @param params  - brainId + optional keyset continuation (afterSequence) + page size.
 */
export async function computeJourneyEventsCurrent(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyEventsParams,
): Promise<JourneyEventsPage> {
  if (!params.brainId || params.brainId.length === 0) {
    return { hasData: false, events: [], nextAfterSequence: null };
  }
  const lim = Math.min(Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

  // The keyset bound is seam-validated (digits only) then bound as a bigint param — an invalid
  // continuation is treated as absent (first page) rather than hard-failing a read.
  const after =
    params.afterSequence && /^\d+$/.test(params.afterSequence) ? BigInt(params.afterSequence) : null;

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally (see journey-mix.ts).
    // LIMIT lim+1 = look-ahead row: its presence means a further page exists (it is not returned).
    if (after !== null) {
      return scope.runScoped<JourneyEventDbRow>(
        `SELECT ${LEDGER_COLUMNS}
           FROM brain_serving.mv_journey_events_current
          WHERE brain_id = ?
            AND sequence_number < ?
            AND ${BRAND_PREDICATE}
          ORDER BY occurred_at DESC, sequence_number DESC
          LIMIT ${lim + 1}`,
        [params.brainId, after],
      );
    }
    return scope.runScoped<JourneyEventDbRow>(
      `SELECT ${LEDGER_COLUMNS}
         FROM brain_serving.mv_journey_events_current
        WHERE brain_id = ?
          AND ${BRAND_PREDICATE}
        ORDER BY occurred_at DESC, sequence_number DESC
        LIMIT ${lim + 1}`,
      [params.brainId],
    );
  });

  if (rows.length === 0) {
    return { hasData: false, events: [], nextAfterSequence: null };
  }

  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;

  const events: JourneyEventRow[] = page.map(toJourneyEventRow);

  const last = events[events.length - 1];
  return {
    hasData: true,
    events,
    nextAfterSequence: hasMore && last ? last.sequenceNumber : null,
  };
}

// ── SPEC: B.4 — Journey Replay (as-of) + Explainability ────────────────────────────────────────────
//
// AMD-10 (BINDING, R1): replay is reconstructed from RETAINED version history + bi-temporal identity
// intervals — NEVER Iceberg time-travel (SNAPSHOT_TTL_MS=7d makes `FOR TIMESTAMP AS OF` unusable as the
// system axis). The retained mechanism: journey_events version rows are never deleted (is_current flips on
// merge re-version); every row carries occurred_at (event valid-time) + brain_id_asof (the DG-2 point-in-
// time identity). Replaying a canonical brain_id X to a wall-clock T = the canonical timeline restricted to
// events that had OCCURRED by T (`occurred_at <= T`) — so a T BEFORE identification yields the SHORTER
// anonymous-era subset (B.5.3), while the per-row brain_id_asof honestly shows what identity was known then.
// Batch-path only (no Redis), responses marked `replayed: true`.

/** A serving timestamp literal 'YYYY-MM-DD HH:MM:SS(.fff)' (UTC) for a Trino `occurred_at <= ?` bound. */
function toServingTs(iso: string): string {
  // Accept an ISO-8601 instant; normalize the 'T'/'Z' form Trino's bare timestamp comparison rejects.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso; // leave as-is; the seam binds it verbatim (may honest-empty)
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

export interface JourneyEventsAsOfParams {
  /** The resolved customer's brain_id (canonical owner of the current ledger rows). */
  brainId: string;
  /** Replay wall-clock: ISO-8601 instant. Only events with occurred_at <= asOf are returned (B.4). */
  asOf: string;
  /** Keyset continuation: only rows with sequence_number strictly BELOW this (digits string). */
  afterSequence?: string | null;
  /** Page size (clamped 1..200; default 50). */
  limit?: number;
}

/**
 * computeJourneyEventsAsOf — SPEC: B.4 — one customer's journey AS KNOWN AT `asOf`, newest-first.
 *
 * The replay/audit read: the canonical current ledger for brainId, gated to `occurred_at <= asOf`
 * (retained version history — AMD-10 R1, NOT Iceberg time-travel). Keyset-paginated exactly like the
 * current path. Every row carries matched_via + brain_id_asof (what identity was known then). Batch-path
 * only — the caller must NOT cache this read (responses are marked replayed downstream).
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - the Trino serving pool.
 * @param params  - brainId + asOf + optional keyset continuation + page size.
 */
export async function computeJourneyEventsAsOf(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyEventsAsOfParams,
): Promise<JourneyEventsPage> {
  if (!params.brainId || params.brainId.length === 0 || !params.asOf || params.asOf.length === 0) {
    return { hasData: false, events: [], nextAfterSequence: null };
  }
  const lim = Math.min(Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const asOfTs = toServingTs(params.asOf);
  const after =
    params.afterSequence && /^\d+$/.test(params.afterSequence) ? BigInt(params.afterSequence) : null;

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally. `occurred_at <= ?` is the
    // replay temporal gate (version history as-of T). Params bind in WHERE order: brainId, asOf, [after].
    if (after !== null) {
      return scope.runScoped<JourneyEventDbRow>(
        `SELECT ${LEDGER_COLUMNS}
           FROM brain_serving.mv_journey_events_current
          WHERE brain_id = ?
            AND occurred_at <= ?
            AND sequence_number < ?
            AND ${BRAND_PREDICATE}
          ORDER BY occurred_at DESC, sequence_number DESC
          LIMIT ${lim + 1}`,
        [params.brainId, asOfTs, after],
      );
    }
    return scope.runScoped<JourneyEventDbRow>(
      `SELECT ${LEDGER_COLUMNS}
         FROM brain_serving.mv_journey_events_current
        WHERE brain_id = ?
          AND occurred_at <= ?
          AND ${BRAND_PREDICATE}
        ORDER BY occurred_at DESC, sequence_number DESC
        LIMIT ${lim + 1}`,
      [params.brainId, asOfTs],
    );
  });

  if (rows.length === 0) {
    return { hasData: false, events: [], nextAfterSequence: null };
  }

  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;
  const events: JourneyEventRow[] = page.map(toJourneyEventRow);
  const last = events[events.length - 1];
  return {
    hasData: true,
    events,
    nextAfterSequence: hasMore && last ? last.sequenceNumber : null,
  };
}

// ── SPEC: B.4 — identity_asof (map state at replay time) + identity_evidence ───────────────────────
//
// The replay's IDENTITY axis: the mapping state as the system knew it at asOf, read ONLY through the
// sanctioned bi-temporal accessor `brain_serving.identity_asof` (WA-14 — never the raw silver_identity_map;
// tools/lint/identity-view-guard.sh). We pin BOTH temporal axes to asOf (t_valid = t_system = asOf): the
// identifiers that resolved to brainId AND were system-known by then. Yields `identity_evidence`
// [{identifier_type, first_seen, source}] — the explainability payload shared with the WB-B3 trace endpoint.

export interface IdentityEvidenceItem {
  /** The identifier kind that matched (email/phone/anon/device/…). */
  identifierType: string;
  /** When this identifier→brain_id mapping first became VALID (effective_from) — ISO/serving string. */
  firstSeen: string;
  /** Provenance of the mapping: the sanctioned identity map (deterministic resolver). */
  source: string;
}

export interface IdentityAsOfState {
  /** True iff, as of asOf, ANY identifier was system-known to resolve to brainId (identified-by-then). */
  identified: boolean;
  /** The identifier intervals system-known at asOf (dedup'd by identifier_type, earliest first_seen). */
  evidence: IdentityEvidenceItem[];
}

interface IdentityAsOfDbRow {
  identifier_type: string;
  effective_from: string | null;
  confidence: string | number | null;
}

/**
 * resolveIdentityAsOf — SPEC: B.4 — the identity map state for `brainId` as known at `asOf`.
 *
 * Reads the sanctioned `brain_serving.identity_asof` accessor (WA-14) with the canonical bi-temporal
 * predicate pinned to asOf on BOTH axes (valid + system). Returns identity_evidence for explainability and
 * an `identified` flag (empty ⇒ the customer was still anonymous at asOf). Honest-empty on a missing map.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param deps    - the Trino serving pool.
 * @param params  - brainId + asOf (ISO-8601).
 */
export async function resolveIdentityAsOf(
  brandId: string,
  deps: { srPool: SilverPool },
  params: { brainId: string; asOf: string },
): Promise<IdentityAsOfState> {
  if (!params.brainId || params.brainId.length === 0 || !params.asOf || params.asOf.length === 0) {
    return { identified: false, evidence: [] };
  }
  const asOfTs = toServingTs(params.asOf);

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // Bi-temporal as-of predicate (identity_asof.sql, copied verbatim): valid AND system pinned to asOf.
    // ${BRAND_PREDICATE} LAST. Params bind: brainId, effective(asOf), effective(asOf), system(asOf), system(asOf).
    return scope.runScoped<IdentityAsOfDbRow>(
      `SELECT identifier_type, min(effective_from) AS effective_from, max(confidence) AS confidence
         FROM brain_serving.identity_asof
        WHERE brain_id = ?
          AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
          AND system_from   <= ? AND (system_to   IS NULL OR system_to   > ?)
          AND ${BRAND_PREDICATE}
        GROUP BY identifier_type
        ORDER BY identifier_type`,
      [params.brainId, asOfTs, asOfTs, asOfTs, asOfTs],
    );
  });

  const evidence: IdentityEvidenceItem[] = rows.map((r) => ({
    identifierType: String(r.identifier_type),
    firstSeen: r.effective_from === null || r.effective_from === undefined ? '' : String(r.effective_from),
    // Provenance: the deterministic identity map (read via the sanctioned identity_asof accessor).
    // Token deliberately omits the physical table-name prefix (identity-view-guard scans for it).
    source: 'identity_map',
  }));

  return { identified: evidence.length > 0, evidence };
}
