/**
 * razorpay.manifest.ts — the Razorpay IngestionManifest (ingestion-framework onboarding).
 *
 * Razorpay is Brain's payment-settlement source of truth. Its live lane (apps/stream-worker
 * razorpay-settlement-repull) polls /v1/settlements/recon/combined over short trailing windows per
 * cursor resource (payments 30d, reserves 180d, adjustments 90d) and restates settlement facts
 * idempotently. This manifest DECLARES THE SAME three cursor resources as HISTORICAL backfill
 * surfaces so the generic `runResumableBackfill` driver can walk up to 2 years of settlement history,
 * resumably + deduped, with the matching page-fetcher in apps/stream-worker
 * (apps/stream-worker/.../ingestion-backfill/razorpay-resource-fetchers.ts).
 *
 * WHY this manifest lives in @brain/connector-core (not @brain/razorpay-mapper):
 *   connector-core is a leaf the mapper depends on (razorpay-mapper imports hashToUuidShaped from
 *   here). Importing the mapper back into this package would create a cycle, so the canonical
 *   event_name string is INLINED below (kept in sync with
 *   @brain/razorpay-mapper.SETTLEMENT_LIVE_V1_EVENT_NAME).
 *
 * RESOURCE / CURSOR / DEDUP design:
 *   - names = 'settlements.payments' | 'settlements.reserves' | 'settlements.adjustments' — DURABLE;
 *     each is the `resource` key on jobs.resource_backfill_state and lines up with the live re-pull's
 *     CURSOR_CONFIGS resource names so the two lanes describe the same logical streams. The three
 *     resources PARTITION the recon/combined entity_type space with NO overlap (payments resource =
 *     {payment, refund}, reserves = {reserve_deduction}, adjustments = {adjustment}); the fetcher
 *     filters each window to its partition so the same settlement fact is NEVER emitted under two
 *     resource names (which would mint two distinct event_ids — see dedup note — and double-count).
 *   - cursorStrategy = 'date_window' — recon/combined is queried from/to (Unix seconds); the backfill
 *     walks one bounded date range per page from the anchor back toward the floor.
 *   - dedupKeyStrategy = 'provider_id' (PRECOMPUTED live-parity event_id): the fetcher computes each
 *     record's event_id by calling the SAME mapper id fn the live re-pull lane uses
 *     (uuidV5FromSettlementItem for per-payment grain, with the entity_type discriminator so a
 *     correction for the same (settlement_id, payment) under a different entity_type derives a DISTINCT
 *     id; uuidV5FromSettlementSummary for brand-level reserve/adjustment grain, one per settlement_id),
 *     and carries it as FetchedRecord.providerId. The shared precomputedEventIdDeriver passes it
 *     through verbatim, so a backfilled record's event_id is BYTE-IDENTICAL to its live counterpart and
 *     Bronze deduplicates the two (no double-count — the revenue-truth invariant). The id-fn args are
 *     the RAW recon values (raw settlement_id + raw payment_id), but the seed string is never logged or
 *     persisted — only the uuid-shaped id survives the boundary (C1 / I-S09). The seeds live ONLY in
 *     @brain/razorpay-mapper so the backfill and live lanes can never drift.
 *   - maxBackfillWindowMs = TWO_YEARS_MS — Brain's default historical target; the driver clamps a
 *     requested window to this.
 */

import {
  TWO_YEARS_MS,
  type IngestionManifest,
  type ResourceDescriptor,
} from '../contracts/IngestionManifest.js';

/** Provider id — matches CONNECTOR_CATALOG + IConnector.provider + the ConnectorFactory key. */
export const RAZORPAY_PROVIDER = 'razorpay' as const;

/**
 * Canonical event_name every settlement resource emits. INLINED to keep connector-core a leaf (no
 * cycle into @brain/razorpay-mapper). MUST stay equal to
 * @brain/razorpay-mapper.SETTLEMENT_LIVE_V1_EVENT_NAME.
 */
const SETTLEMENT_LIVE_V1_EVENT_NAME = 'settlement.live.v1' as const;

/** recon/combined max records per skip-page (RazorpaySettlementsClient PAGE_SIZE). */
const RECON_PAGE_SIZE = 100;

/**
 * settlements.payments — per-payment settlement grain (entity_type ∈ {payment, refund}). Date-windowed
 * walk of recon/combined; 24-month historical backfill target.
 */
export const RAZORPAY_SETTLEMENTS_PAYMENTS_RESOURCE: ResourceDescriptor = {
  name: 'settlements.payments',
  kind: 'rest',
  emits: [SETTLEMENT_LIVE_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'date_window',
  // Precomputed live-parity event_id (fetcher stamps FetchedRecord.providerId via the mapper's own
  // uuidV5FromSettlementItem/Summary) → passed through verbatim → byte-identical to the live lane.
  dedupKeyStrategy: 'provider_id',
  pageSize: RECON_PAGE_SIZE,
  description: 'Razorpay per-payment settlements (recon/combined; payment + refund grain) — net-of-fees revenue truth.',
};

/**
 * settlements.reserves — rolling-reserve releases/deductions (entity_type = reserve_deduction).
 * Brand-level grain; date-windowed; 24-month historical backfill target.
 */
export const RAZORPAY_SETTLEMENTS_RESERVES_RESOURCE: ResourceDescriptor = {
  name: 'settlements.reserves',
  kind: 'rest',
  emits: [SETTLEMENT_LIVE_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'date_window',
  // Precomputed live-parity event_id (fetcher stamps FetchedRecord.providerId via the mapper's own
  // uuidV5FromSettlementSummary) → passed through verbatim → byte-identical to the live lane.
  dedupKeyStrategy: 'provider_id',
  pageSize: RECON_PAGE_SIZE,
  description: 'Razorpay rolling-reserve releases/deductions (recon/combined; brand-level grain).',
};

/**
 * settlements.adjustments — chargebacks/corrections (entity_type = adjustment). Brand-level grain;
 * date-windowed; 24-month historical backfill target.
 */
export const RAZORPAY_SETTLEMENTS_ADJUSTMENTS_RESOURCE: ResourceDescriptor = {
  name: 'settlements.adjustments',
  kind: 'rest',
  emits: [SETTLEMENT_LIVE_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'date_window',
  // Precomputed live-parity event_id (fetcher stamps FetchedRecord.providerId via the mapper's own
  // uuidV5FromSettlementSummary) → passed through verbatim → byte-identical to the live lane.
  dedupKeyStrategy: 'provider_id',
  pageSize: RECON_PAGE_SIZE,
  description: 'Razorpay settlement adjustments — chargebacks, corrections (recon/combined; brand-level grain).',
};

/**
 * The complete Razorpay ingestion manifest. Declared once; consumed by the generic backfill driver +
 * the dedup layer. Validate with assertManifestValid() at startup.
 */
export const RAZORPAY_INGESTION_MANIFEST: IngestionManifest = {
  provider: RAZORPAY_PROVIDER,
  resources: [
    RAZORPAY_SETTLEMENTS_PAYMENTS_RESOURCE,
    RAZORPAY_SETTLEMENTS_RESERVES_RESOURCE,
    RAZORPAY_SETTLEMENTS_ADJUSTMENTS_RESOURCE,
  ],
};
