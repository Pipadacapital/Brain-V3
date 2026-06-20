/**
 * capi-source.query.ts — the CAPI passback SOURCE query (Track A / @data-engineer).
 * @effort deterministic — a key-equality join + a deterministic event_id; no model/ML.
 *
 * Produces the candidate conversion events to pass back to Meta CAPI: every FINALIZED
 * realized-revenue purchase, joined to the consent-keying identity hash and (defensively)
 * to the silver.touchpoint click-ids (_fbc/_fbp). It does NOT decide whether to send —
 * that is can_contact()'s job downstream (capi-passback.service). This query only
 * MATERIALIZES the source rows; the gate is the SOLE outbound decision (I-ST05).
 *
 * THE JOIN (architecture §3.1):
 *   realized_revenue_ledger (recognition_label='finalized' only — provisional/settling
 *     are NOT passed back) ⋈ identity_link (brain_id → the subject_hash, the SAME salted
 *     64-hex consent key) ⋈ [optional] silver.touchpoint (last-touch _fbc/_fbp/utm).
 *
 * DETERMINISTIC event_id (Meta dedup + capi_passback_log idempotency):
 *   sha256(brand_id ‖ order_id ‖ 'Purchase' ‖ ledger_event_id) — a replay yields the SAME
 *   id, so Meta dedups AND capi_passback_log dedups (ON CONFLICT DO NOTHING). Computed
 *   here (not in SQL) so it lives next to the field semantics.
 *
 * MONEY (I-S07): value_minor is BIGINT minor + currency_code, taken verbatim from the
 *   ledger. The minor→major conversion happens ONLY at the wire boundary (capi-adapter);
 *   this query never floats money.
 *
 * PII: subject_hash is the internal salted 64-hex (the consent key) — NEVER raw PII. The
 *   Meta-format unsalted em/ph match keys are computed transiently at the send boundary
 *   from the contact_pii vault (metaMatchHash, @backend-developer) and are NOT selected
 *   here. silver.touchpoint click-ids are not PII.
 *
 * SILVER DEFENSIVENESS (architecture §3.1 ASSUMPTION): silver.touchpoint is a StarRocks
 *   Silver mart that may not be live in every worktree. The click-id enrichment is an
 *   OPTIONAL second step (enrichWithClickIds) the caller may skip; when absent/empty the
 *   click-ids are simply omitted (Meta still matches on hashed em/ph). match_key_count
 *   records how many keys were present (the UI's match-quality proxy). The passback fires
 *   regardless — honest, lower-match, never blocked on a missing mart.
 *
 * ISOLATION: every read runs under brain_app + the brand GUC (RLS FORCE). The caller sets
 *   set_config('app.current_brand_id', brandId, true) on the transaction; this query never
 *   sees another brand's rows. brandId is from session (NEVER request body).
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** A single finalized-purchase candidate, pre-gate, pre-match-hash. */
export interface CapiSourceRow {
  brandId: string;
  /** Deterministic Meta event_id (dedup): sha256(brand‖order‖'Purchase'‖ledger_event_id). */
  eventId: string;
  orderId: string;
  ledgerEventId: string;
  /** The internal salted 64-hex consent key (brain_id → identity_link). Never raw PII. */
  subjectHash: string | null;
  /** BIGINT minor units (I-S07); string-serialized to preserve precision. */
  valueMinor: string;
  currencyCode: string;
  /** Order event-time → the Meta event_time. */
  occurredAt: string;
  /** Optional last-touch click-ids (enrichWithClickIds); null until/unless silver is read. */
  fbc: string | null;
  fbp: string | null;
  /** em+ph+fbc+fbp present count — the match-quality proxy. Computed at send time. */
  matchKeyCount: number;
}

/** Deterministic Meta event_id — the dedup key (architecture §3.3). */
export function capiEventId(
  brandId: string,
  orderId: string,
  ledgerEventId: string,
): string {
  return createHash('sha256')
    .update(`${brandId}‖${orderId}‖Purchase‖${ledgerEventId}`)
    .digest('hex');
}

/**
 * Fetch FINALIZED purchase candidates for a brand over an occurred_at window.
 *
 * Runs the read INSIDE a caller-managed transaction whose brand GUC is already set
 * (so RLS FORCE is enforced and the join stays tenant-scoped). One row per finalized
 * positive-amount purchase (reversals/refunds are negative and excluded — a passback
 * is a CONVERSION, not a reversal). The deterministic event_id is computed per row.
 *
 * NOTE on identity resolution: realized_revenue_ledger.brain_id → identity_link's
 *   active strong email/phone hash gives the subject_hash (the consent key). When a row
 *   has no resolvable strong identifier, subject_hash is NULL and the downstream gate
 *   treats it as default-closed (no consent key → cannot establish consent → BLOCK).
 */
export async function fetchFinalizedPurchaseCandidates(
  client: PoolClient,
  brandId: string,
  from: Date,
  to: Date,
): Promise<CapiSourceRow[]> {
  const res = await client.query<{
    order_id: string;
    ledger_event_id: string;
    subject_hash: string | null;
    value_minor: string;
    currency_code: string;
    occurred_at: Date;
  }>(
    `SELECT
        l.order_id,
        l.ledger_event_id,
        il.identifier_value AS subject_hash,
        l.amount_minor::text AS value_minor,
        l.currency_code,
        l.occurred_at
       FROM realized_revenue_ledger l
       LEFT JOIN LATERAL (
         SELECT identifier_value
           FROM identity_link
          WHERE brand_id = l.brand_id
            AND brain_id = l.brain_id
            AND is_active = TRUE
            AND identifier_type IN ('email','phone')
            AND tier IN ('strong','strong_on_link')
          ORDER BY (identifier_type = 'email') DESC, created_at ASC
          LIMIT 1
       ) il ON TRUE
      WHERE l.brand_id = $1
        AND l.recognition_label = 'finalized'
        AND l.event_type = 'finalization'
        AND l.amount_minor > 0
        AND l.occurred_at >= $2
        AND l.occurred_at <= $3
        -- Idempotency for the passback orchestrator: skip conversions already attempted (any
        -- terminal status row in capi_passback_log). Keeps an every-tick loop from re-sending to
        -- Meta. Keyed on (order_id, ledger_event_id) — the columns the log stores — under the same
        -- brand GUC (RLS-scoped). A conversion is attempted at most once.
        AND NOT EXISTS (
          SELECT 1 FROM capi_passback_log pb
           WHERE pb.brand_id = l.brand_id
             AND pb.order_id = l.order_id
             AND pb.ledger_event_id = l.ledger_event_id
        )
      ORDER BY l.occurred_at ASC`,
    [brandId, from, to],
  );

  return res.rows.map((r) => ({
    brandId,
    eventId: capiEventId(brandId, r.order_id, r.ledger_event_id),
    orderId: r.order_id,
    ledgerEventId: r.ledger_event_id,
    subjectHash: r.subject_hash,
    valueMinor: r.value_minor,
    currencyCode: r.currency_code,
    occurredAt: r.occurred_at.toISOString(),
    fbc: null,
    fbp: null,
    // Provisional: em/ph presence is decided at the send boundary (vault read); a
    // resolvable subject_hash implies at least one hashable identifier → count >= 1.
    matchKeyCount: r.subject_hash ? 1 : 0,
  }));
}

/**
 * Convenience wrapper that opens its own transaction + sets the brand GUC, for callers
 * outside an existing transaction. Mirrors the analytics read seam.
 */
export async function fetchFinalizedPurchaseCandidatesScoped(
  pool: Pool,
  brandId: string,
  from: Date,
  to: Date,
): Promise<CapiSourceRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    const rows = await fetchFinalizedPurchaseCandidates(client, brandId, from, to);
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
