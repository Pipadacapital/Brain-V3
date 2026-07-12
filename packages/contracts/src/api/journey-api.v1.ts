// SPEC: B.3
/**
 * journey-api.v1 — Zod response contracts for the Wave-B Journey APIs (SPEC: B.3, AMD-14).
 *
 * The three journey surfaces the spec names, served on the sanctioned core BFF seam (AMD-14
 * R1 — no standalone gateway): the per-customer timeline, the per-order trace (the
 * explainability surface), and the two-journey compare. Tenant is ALWAYS the session brand_id
 * (D-1 — never a query param); these schemas carry NO brand_id.
 *
 * INVARIANTS (mirror analytics.api.v1 §3):
 *  - Money = MinorUnitsSchema (bigint-as-string) — NEVER a float. (Only compare/trace carry any
 *    revenue, on composite rows; the timeline items are behavioral — no money.)
 *  - Honest-empty = z.discriminatedUnion('state', [...]); `no_data` carries NO has_data fields —
 *    a NEW endpoint ships and answers honest-empty when no journey exists.
 *  - Schemas are NOT `.strict()` (§7): core may ADD a benign field without breaking a web read.
 *  - matched_via / journey_version are NULLABLE: matched_via (AUD-JE-34/35) is the B.4 coarse
 *    stitch-provenance basis ('order' | 'deterministic' | 'anonymous') — always populated on the
 *    Trino ledger/trace paths, honestly null ONLY on the A.4 timeline cache hot path (the cache
 *    member carries no provenance); journey_version is the DERIVED journey-level version
 *    (AMD-11 — max data_version), null on the pre-ledger cache path.
 */
import { z } from 'zod';
import { MinorUnitsSchema, DataSourceSchema } from './_money.js';

// ── (1) GET /v1/customers/{brain_id}/journey — paginated newest-first timeline ──────────────
// items {ts,type,channel,campaign?,url_path?,session_id,matched_via,journey_version}. Served from
// the A.4 touchpoint cache (hot) with Trino ledger fallback (cold); `source` says which path served.

export const CustomerJourneyItemSchema = z.object({
  /** Event timestamp — ISO-8601 string (Trino ledger) or epoch-ms number (cache). */
  ts: z.union([z.string(), z.number()]),
  type: z.string(),
  channel: z.string().nullable(),
  campaign: z.string().nullable(),
  url_path: z.string().nullable(),
  session_id: z.string().nullable(),
  /**
   * Stitch provenance (AUD-JE-34) — the B.4 coarse basis ('order' | 'deterministic' | 'anonymous')
   * on the Trino ledger path; NULL only on the A.4 cache hot path (no provenance in the cache member).
   */
  matched_via: z.string().nullable(),
  /** Derived journey-level version (AMD-11 — max data_version); null on the cache path. */
  journey_version: z.number().nullable(),
});
export type CustomerJourneyItem = z.infer<typeof CustomerJourneyItemSchema>;

export const CustomerJourneyTimelineSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    brain_id: z.string(),
    items: z.array(CustomerJourneyItemSchema),
    /** Opaque pagination cursor for the next (older) page; null = last page. */
    next_cursor: z.string().nullable(),
    /** Derived journey-level version echoed for the X-Journey-Version header; null on cache path. */
    journey_version: z.number().nullable(),
    /** Which serving path answered: the hot A.4 cache or the durable Trino ledger. */
    source: z.enum(['cache', 'trino']),
    data_source: DataSourceSchema,
  }),
]);
export type CustomerJourneyTimeline = z.infer<typeof CustomerJourneyTimelineSchema>;

// ── (2) GET /v1/journeys/trace?order_id= — lookback touchpoints + identity evidence ─────────
// The explainability surface: the ordered touchpoints in the attribution lookback preceding the
// order, each with matched_via, plus the resolved customer's identity_evidence.

export const TraceTouchSchema = z.object({
  touch_seq: z.number(),
  occurred_at: z.string(),
  channel: z.string().nullable(),
  event_type: z.string(),
  utm_campaign: z.string().nullable(),
  landing_path: z.string().nullable(),
  /**
   * Stitch provenance (AUD-JE-35) — per-touch coarse basis: 'deterministic' (the touch carries a
   * stitched_brain_id) | 'anonymous'. Kept nullable for wire back-compat with pre-provenance cores.
   */
  matched_via: z.string().nullable(),
});
export type TraceTouch = z.infer<typeof TraceTouchSchema>;

export const IdentityEvidenceItemSchema = z.object({
  /** Identifier TYPE only (email/phone/anon/device/...) — NEVER the value. */
  identifier_type: z.string(),
  first_seen: z.string(),
  source: z.string(),
});
export type IdentityEvidenceItem = z.infer<typeof IdentityEvidenceItemSchema>;

export const JourneyTraceSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    order_id: z.string(),
    /** The resolved customer key for the traced journey (null when only anon-stitched). */
    brain_id: z.string().nullable(),
    /** The attribution lookback window applied (days before the conversion touch). */
    lookback_days: z.number(),
    touches: z.array(TraceTouchSchema),
    identity_evidence: z.array(IdentityEvidenceItemSchema),
    data_source: DataSourceSchema,
  }),
]);
export type JourneyTrace = z.infer<typeof JourneyTraceSchema>;

// ── (3) GET /v1/journeys/compare?left=&right= — two journeys with t_minus_conversion_ms ─────

export const CompareTouchSchema = z.object({
  sequence_number: MinorUnitsSchema, // bigint → string (ledger position — NOT money)
  occurred_at: z.string(),
  event_type: z.string(),
  channel: z.string().nullable(),
  campaign: z.string().nullable(),
  is_composite: z.boolean(),
  /** ms from this touch to the journey's conversion; 0 at conversion, positive BEFORE it, null if no conversion. */
  t_minus_conversion_ms: z.number().nullable(),
});
export type CompareTouch = z.infer<typeof CompareTouchSchema>;

export const CompareJourneySchema = z.object({
  brain_id: z.string(),
  /** The conversion anchor timestamp (latest composite/order touch), or null when the journey never converted. */
  conversion_at: z.string().nullable(),
  touches: z.array(CompareTouchSchema),
});
export type CompareJourney = z.infer<typeof CompareJourneySchema>;

export const JourneyCompareSchema = z.object({
  left: CompareJourneySchema,
  right: CompareJourneySchema,
  data_source: DataSourceSchema,
});
export type JourneyCompare = z.infer<typeof JourneyCompareSchema>;
