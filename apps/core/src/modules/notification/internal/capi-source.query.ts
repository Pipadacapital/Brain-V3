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
import type { Pool } from 'pg';
import type { SilverPool } from '@brain/metric-engine';
import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

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
/**
 * MEDALLION REALIGNMENT (Epic 1): the finalized purchases now come from the lakehouse
 * (brain_gold.gold_revenue_ledger, Bronze-sourced) — NOT the PG realized_revenue_ledger. Because that
 * ledger lives in StarRocks while the consent key (identity_link) and the passback idempotency log
 * (capi_passback_log) live in PostgreSQL, this is a deterministic CROSS-STORE read:
 *   1. StarRocks — finalized positive-amount purchases in the window (+ the resolved brain_id).
 *   2. PostgreSQL — resolve subject_hash per brain_id (identity_link strong email/phone) AND drop any
 *      order already attempted (capi_passback_log), under the brand GUC (RLS).
 *
 * IDEMPOTENCY (changed, deliberately): keyed on ORDER_ID only — robust against the recognition
 * rebuild giving a finalization a new deterministic ledger_event_id. A purchase conversion is sent at
 * most once per order regardless of ledger-id churn (Meta still dedups on the deterministic event_id).
 */
export async function fetchFinalizedPurchaseCandidatesScoped(
  pool: Pool,
  srPool: SilverPool,
  brandId: string,
  from: Date,
  to: Date,
): Promise<CapiSourceRow[]> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  // ── 1. Finalized purchases from the lakehouse ledger (StarRocks). ──
  const orders = await withSilverBrand(srPool, brandId, async (scope) =>
    scope.runScoped<{
      order_id: string;
      ledger_event_id: string;
      brain_id: string | null;
      value_minor: string | number;
      currency_code: string;
      occurred_at: string;
    }>(
      `SELECT order_id, ledger_event_id, brain_id, amount_minor AS value_minor, currency_code, occurred_at
         FROM brain_serving.mv_gold_revenue_ledger
        WHERE event_type = 'finalization'
          AND recognition_label = 'finalized'
          AND amount_minor > 0
          AND occurred_at >= ? AND occurred_at <= ?
          AND ${BRAND_PREDICATE}
        ORDER BY occurred_at ASC`,
      [fromIso, toIso],
    ),
  );
  if (orders.length === 0) return [];

  // ── 2a. subject_hash per brain_id — from the Neo4j-derived silver_identity_link (StarRocks). ──
  // MEDALLION REALIGNMENT (Epic 3 / ADR-0004): identity moved off PG; the strong email/phone hash for a
  // brain_id comes from the lakehouse identity projection. Prefer email, then phone (chosen in TS).
  const brainIds = [...new Set(orders.map((o) => o.brain_id).filter((b): b is string => !!b))];
  const subjByBrain = new Map<string, string>();
  if (brainIds.length > 0) {
    const subjRows = await withSilverBrand(srPool, brandId, async (scope) =>
      scope.runScoped<{ brain_id: string; identifier_type: string; identifier_value: string }>(
        `SELECT brain_id, identifier_type, identifier_value
           FROM brain_ops.silver_identity_link
          WHERE is_active = true
            AND identifier_type IN ('email','phone')
            AND tier IN ('strong','strong_on_link')
            AND brain_id IN (${brainIds.map(() => '?').join(',')})
            AND ${BRAND_PREDICATE}`,
        [...brainIds],
      ),
    );
    for (const r of subjRows) {
      // Prefer email over phone; first-write-wins within a type.
      const existing = subjByBrain.get(r.brain_id);
      if (!existing || r.identifier_type === 'email') subjByBrain.set(r.brain_id, r.identifier_value);
    }
  }

  // ── 2b. already-attempted order_ids — capi_passback_log stays PG (CAPI's own dedup log). ──
  const alreadySent = new Set<string>();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    const orderIds = orders.map((o) => o.order_id);
    const sent = await client.query<{ order_id: string }>(
      `SELECT DISTINCT order_id FROM capi_passback_log WHERE brand_id = $1 AND order_id = ANY($2::text[])`,
      [brandId, orderIds],
    );
    for (const r of sent.rows) alreadySent.add(r.order_id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // ── 3. Assemble candidates (drop already-attempted; attach consent key + deterministic event_id). ──
  return orders
    .filter((o) => !alreadySent.has(o.order_id))
    .map((o) => {
      const subjectHash = o.brain_id ? subjByBrain.get(o.brain_id) ?? null : null;
      return {
        brandId,
        eventId: capiEventId(brandId, o.order_id, o.ledger_event_id),
        orderId: o.order_id,
        ledgerEventId: o.ledger_event_id,
        subjectHash,
        valueMinor: String(o.value_minor ?? '0').split('.')[0] || '0',
        currencyCode: o.currency_code,
        occurredAt: new Date(o.occurred_at).toISOString(),
        fbc: null,
        fbp: null,
        matchKeyCount: subjectHash ? 1 : 0,
      };
    });
}
