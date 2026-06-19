/**
 * generateRecommendations — run the registered detectors for a brand and reconcile the open set.
 *
 * For each detector: read its certified signal, run the pure detector, then
 *   - emit/refresh: upsert the recommendation (dedup on brand+detector+subject — doc 09 Part 9) and
 *     append a decision_log row ('raised' on first sight, 'refreshed' thereafter), OR
 *   - expire: if the detector no longer fires but an open rec exists, mark it 'expired' and log it
 *     (a resolved risk must not linger — doc 09 Part 9/14).
 *
 * Recommend-only (doc 09 Phase-1): nothing is auto-executed; the rec is an advisory record. The
 * decision_log is the append-only audit. brand_id is the session brand (BFF), never the request.
 */

import type { DbPool, QueryContext } from '@brain/db';
import { rtoRiskDetector, type RtoSignal } from '../domain/detectors/rto-risk.detector.js';

export interface GenerateResult {
  /** detectors that produced/refreshed an open recommendation this run. */
  raised: number;
  /** open recs that were expired because their detector no longer fires. */
  expired: number;
}

export interface GenerateDeps {
  pool: DbPool;
}

export async function generateRecommendations(
  brandId: string,
  correlationId: string,
  deps: GenerateDeps,
): Promise<GenerateResult> {
  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  let raised = 0;
  let expired = 0;
  try {
    // ── Detector: rto_risk ──────────────────────────────────────────────────
    const sigRes = await client.query<{
      order_count: string;
      rto_count: string;
      rto_gmv_minor: string;
    }>(ctx, `SELECT order_count, rto_count, rto_gmv_minor FROM rto_risk_signal_for_brand($1::uuid)`, [
      brandId,
    ]);
    const row = sigRes.rows[0];
    const signal: RtoSignal = {
      orderCount: Number(row?.order_count ?? '0'),
      rtoCount: Number(row?.rto_count ?? '0'),
      rtoGmvMinor: BigInt(row?.rto_gmv_minor ?? '0'),
    };

    const rec = rtoRiskDetector(signal);

    if (rec) {
      // Upsert — ON CONFLICT refreshes the open rec in place (no duplicate). xmax = 0 ⇒ inserted.
      const up = await client.query<{ recommendation_id: string; inserted: boolean }>(
        ctx,
        `INSERT INTO recommendation
           (brand_id, detector, subject, kind, confidence, priority, status, payload)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', $7::jsonb)
         ON CONFLICT (brand_id, detector, subject) DO UPDATE
           SET kind = EXCLUDED.kind, confidence = EXCLUDED.confidence, priority = EXCLUDED.priority,
               status = 'open', payload = EXCLUDED.payload, updated_at = NOW()
         RETURNING recommendation_id, (xmax = 0) AS inserted`,
        [brandId, rec.detector, rec.subject, rec.kind, rec.confidence, rec.priority, JSON.stringify(rec.payload)],
      );
      const { recommendation_id, inserted } = up.rows[0]!;
      raised += 1;

      await client.query(
        ctx,
        `INSERT INTO decision_log (brand_id, kind, recommendation_id, actor, action, reason, payload)
         VALUES ($1, 'recommendation', $2, $3, $4, $5, $6::jsonb)`,
        [
          brandId,
          recommendation_id,
          `detector:${rec.detector}`,
          inserted ? 'raised' : 'refreshed',
          rec.payload.title,
          JSON.stringify(rec.payload.evidence),
        ],
      );
    } else {
      // Detector did not fire — expire any open rec for this (detector, subject) and log it.
      const ex = await client.query<{ recommendation_id: string }>(
        ctx,
        `UPDATE recommendation SET status = 'expired', updated_at = NOW()
          WHERE brand_id = $1 AND detector = 'rto_risk' AND subject = 'brand' AND status = 'open'
        RETURNING recommendation_id`,
        [brandId],
      );
      for (const r of ex.rows) {
        expired += 1;
        await client.query(
          ctx,
          `INSERT INTO decision_log (brand_id, kind, recommendation_id, actor, action, reason)
           VALUES ($1, 'recommendation', $2, 'detector:rto_risk', 'expired', 'signal no longer fires')`,
          [brandId, r.recommendation_id],
        );
      }
    }

    return { raised, expired };
  } finally {
    client.release();
  }
}
