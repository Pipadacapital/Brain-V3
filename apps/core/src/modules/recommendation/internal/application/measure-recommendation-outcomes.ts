/**
 * measureRecommendationOutcomes — the learning loop (doc 09 Part 10): for each open recommendation,
 * re-fetch its detector's CURRENT headline metric and compare to the value AT RAISE (stored in the
 * rec's evidence), recording the then/now/delta/improved into recommendation_outcome.
 *
 * This is what makes the engine MEASURE whether its decisions worked — the rec then carries its own
 * effectiveness evidence ("RTO was 5.0%, now 4.1% — improving"), and the signal feeds (later) the
 * auto-muting of low-precision detectors. Idempotent: upsert per (recommendation_id, window).
 * brand_id is the session brand (BFF), never the request.
 */

import type { DbPool, QueryContext } from '@brain/db';
import type { SilverPool } from '@brain/metric-engine';
import { detectorById } from '../domain/detectors/registry.js';

export interface MeasureResult {
  /** recommendations measured this run. */
  measured: number;
}

export interface MeasureDeps {
  pool: DbPool;
  /** StarRocks Silver/Gold pool — detector REVENUE signals read the lakehouse ledger (Epic 1 / B). */
  srPool: SilverPool;
}

export async function measureRecommendationOutcomes(
  brandId: string,
  correlationId: string,
  deps: MeasureDeps,
): Promise<MeasureResult> {
  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  let measured = 0;
  try {
    const recs = await client.query<{
      recommendation_id: string;
      detector: string;
      payload: { evidence?: Record<string, unknown> };
    }>(
      ctx,
      `SELECT recommendation_id, detector, payload FROM recommendation
        WHERE brand_id = $1 AND status = 'open'`,
      [brandId],
    );

    for (const rec of recs.rows) {
      const detector = detectorById(rec.detector);
      if (!detector) continue;

      const signal = await detector.fetchSignal({ client, ctx, srPool: deps.srPool }, brandId);
      const m = detector.metric(signal);
      const now = m.value;
      const then = Number(rec.payload?.evidence?.[m.key] ?? now);
      const delta = Number((now - then).toFixed(2));
      // improved = moved in the better direction (both current risk detectors are lower-is-better).
      const improved = m.lowerIsBetter ? now < then : now > then;

      const measuredPayload = { metric: m.key, then, now, delta, improved };
      await client.query(
        ctx,
        `INSERT INTO recommendation_outcome (recommendation_id, brand_id, measurement_window, measured)
         VALUES ($1, $2, 'latest', $3::jsonb)
         ON CONFLICT (recommendation_id, measurement_window) DO UPDATE
           SET measured = EXCLUDED.measured, measured_at = NOW()`,
        [rec.recommendation_id, brandId, JSON.stringify(measuredPayload)],
      );
      measured += 1;
    }

    return { measured };
  } finally {
    client.release();
  }
}
