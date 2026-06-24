/**
 * measureRecommendationOutcomes — the learning loop (doc 09 Part 10): for each open recommendation,
 * re-fetch its detector's CURRENT headline metric and compare to the value AT RAISE (stored in the
 * rec's evidence), recording the then/now/delta/improved into recommendation_outcome.
 *
 * This is what makes the engine MEASURE whether its decisions worked — the rec then carries its own
 * effectiveness evidence ("RTO was 5.0%, now 4.1% — improving"), and the signal feeds (later) the
 * auto-muting of low-precision detectors. Idempotent: upsert per (recommendation_id, window).
 * brand_id is the session brand (BFF), never the request.
 *
 * PERF (PF-6): the signal each detector produces this run is the SAME signal generateRecommendations
 * already fetched, so the caller passes that memo (deps.signals) and we reuse it instead of
 * re-fetching once per open recommendation. Any detector not in the memo (e.g. an open rec whose
 * detector did not run this pass) is fetched ONCE and memoized locally. The outcome upserts are
 * batched into a single multi-row INSERT ... ON CONFLICT per brand.
 */

import type { DbPool, QueryContext } from '@brain/db';
import type { SilverPool } from '@brain/metric-engine';
import { detectorById, type Detector } from '../domain/detectors/registry.js';

export interface MeasureResult {
  /** recommendations measured this run. */
  measured: number;
}

export interface MeasureDeps {
  pool: DbPool;
  /** StarRocks Silver/Gold pool — detector REVENUE signals read the lakehouse ledger (Epic 1 / B). */
  srPool: SilverPool;
  /**
   * Per-detector signals already fetched by generateRecommendations this run (keyed by detector id).
   * Reused here so an open rec's outcome is measured WITHOUT re-fetching the detector signal.
   */
  signals?: Map<string, unknown>;
}

/** An outcome row staged for the per-brand batch upsert. */
interface OutcomeRow {
  recommendationId: string;
  /** JSON-encoded { metric, then, now, delta, improved }. */
  measured: string;
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

    // Reuse generate's signals; fetch (and memoize) only detectors missing from that memo.
    const signalCache = new Map<string, unknown>(deps.signals ?? []);
    const inFlight = new Map<Detector['fetchSignal'], Promise<unknown>>();
    const signalFor = async (detector: Detector): Promise<unknown> => {
      if (signalCache.has(detector.id)) return signalCache.get(detector.id);
      let p = inFlight.get(detector.fetchSignal);
      if (!p) {
        p = detector.fetchSignal({ client, ctx, srPool: deps.srPool }, brandId);
        inFlight.set(detector.fetchSignal, p);
      }
      const sig = await p;
      signalCache.set(detector.id, sig);
      return sig;
    };

    const outcomeRows: OutcomeRow[] = [];
    for (const rec of recs.rows) {
      const detector = detectorById(rec.detector);
      if (!detector) continue;

      const signal = await signalFor(detector);
      const m = detector.metric(signal);
      const now = m.value;
      const then = Number(rec.payload?.evidence?.[m.key] ?? now);
      const delta = Number((now - then).toFixed(2));
      // improved = moved in the better direction (both current risk detectors are lower-is-better).
      const improved = m.lowerIsBetter ? now < then : now > then;

      const measuredPayload = { metric: m.key, then, now, delta, improved };
      outcomeRows.push({ recommendationId: rec.recommendation_id, measured: JSON.stringify(measuredPayload) });
      measured += 1;
    }

    // Batch the per-rec outcome upserts into ONE multi-row INSERT ... ON CONFLICT per brand.
    if (outcomeRows.length > 0) {
      await upsertOutcomeBatch(client, ctx, brandId, outcomeRows);
    }

    return { measured };
  } finally {
    client.release();
  }
}

/** Single multi-row upsert for the brand's outcome rows — idempotent per (recommendation_id, window). */
async function upsertOutcomeBatch(
  client: Awaited<ReturnType<DbPool['connect']>>,
  ctx: QueryContext,
  brandId: string,
  rows: OutcomeRow[],
): Promise<void> {
  const params: unknown[] = [brandId];
  const tuples = rows.map((r, i) => {
    const base = 2 + i * 2; // $1 is brand_id; each row contributes 2 params.
    params.push(r.recommendationId, r.measured);
    return `($${base}, $1, 'latest', $${base + 1}::jsonb)`;
  });
  await client.query(
    ctx,
    `INSERT INTO recommendation_outcome (recommendation_id, brand_id, measurement_window, measured)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (recommendation_id, measurement_window) DO UPDATE
       SET measured = EXCLUDED.measured, measured_at = NOW()`,
    params,
  );
}
