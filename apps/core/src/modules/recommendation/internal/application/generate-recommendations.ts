/**
 * generateRecommendations — run the REGISTERED detectors for a brand and reconcile the open set.
 *
 * For each detector in the registry: read its certified signal, run the pure detector, then
 *   - emit/refresh: upsert the recommendation (dedup on brand+detector+subject — doc 09 Part 9) and
 *     append a decision_log row ('raised' on first sight, 'refreshed' thereafter), OR
 *   - expire: if the detector no longer fires but an open rec exists, mark it 'expired' and log it
 *     (a resolved risk must not linger — doc 09 Part 9/14).
 *
 * Recommend-only (doc 09 Phase-1): nothing is auto-executed; the rec is an advisory record. The
 * decision_log is the append-only audit. brand_id is the session brand (BFF), never the request.
 *
 * PERF (PF-6): within a brand the detector signals are independent reads, so they are fetched
 * CONCURRENTLY (Promise.all) rather than serially, and detectors that share the exact same
 * fetchSignal (the two CM2 detectors) share one in-flight fetch. The per-detector signals are
 * returned as a memo so measureRecommendationOutcomes reuses them instead of re-fetching. The
 * decision_log writes are batched into a single multi-row INSERT per brand (idempotency is
 * unchanged — the recommendation upsert's ON CONFLICT still dedups, and decision_log stays
 * append-only).
 */

import type { DbPool, QueryContext } from '@brain/db';
import type { SilverPool } from '@brain/metric-engine';
import { DETECTORS, type Detector } from '../domain/detectors/registry.js';

export interface GenerateResult {
  /** detectors that produced/refreshed an open recommendation this run. */
  raised: number;
  /** open recs that were expired because their detector no longer fires. */
  expired: number;
  /**
   * Per-detector signal fetched this run, keyed by detector id — handed to
   * measureRecommendationOutcomes so it does not re-fetch the same signal per open rec.
   */
  signals: Map<string, unknown>;
}

export interface GenerateDeps {
  pool: DbPool;
  /** StarRocks Silver/Gold pool — detector REVENUE signals read the lakehouse ledger (Epic 1 / B). */
  srPool: SilverPool;
}

/** An append-only decision_log row staged for the per-brand batch insert. */
interface DecisionLogRow {
  recommendationId: string;
  actor: string;
  action: string;
  reason: string;
  /** JSON-encoded evidence, or null for the (reason-only) expire rows. */
  payload: string | null;
}

/**
 * Fetch every detector signal CONCURRENTLY, deduping detectors that share the exact same
 * fetchSignal reference (the two CM2 detectors) onto one in-flight promise. Returns a memo keyed
 * by detector id so callers can look up by detector.
 */
async function fetchSignals(
  detectors: readonly Detector[],
  deps: GenerateDeps,
  ctx: QueryContext,
  client: Parameters<Detector['fetchSignal']>[0]['client'],
  brandId: string,
): Promise<Map<string, unknown>> {
  // Dedup shared signal sources by fetchSignal identity → one promise per distinct source.
  const bySource = new Map<Detector['fetchSignal'], Promise<unknown>>();
  const fetchFor = (detector: Detector): Promise<unknown> => {
    let p = bySource.get(detector.fetchSignal);
    if (!p) {
      p = detector.fetchSignal({ client, ctx, srPool: deps.srPool }, brandId);
      bySource.set(detector.fetchSignal, p);
    }
    return p;
  };
  const resolved = await Promise.all(detectors.map((d) => fetchFor(d)));
  const signals = new Map<string, unknown>();
  detectors.forEach((d, i) => signals.set(d.id, resolved[i]));
  return signals;
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
    // (a) Fetch the independent detector signals concurrently (PF-6).
    const signals = await fetchSignals(DETECTORS, deps, ctx, client, brandId);
    const decisionLogRows: DecisionLogRow[] = [];

    for (const detector of DETECTORS) {
      const signal = signals.get(detector.id);
      const rec = detector.detect(signal);

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

        decisionLogRows.push({
          recommendationId: recommendation_id,
          actor: `detector:${rec.detector}`,
          action: inserted ? 'raised' : 'refreshed',
          reason: rec.payload.title,
          payload: JSON.stringify(rec.payload.evidence),
        });
      } else {
        // Detector did not fire — expire any open rec for this (detector, subject) and log it.
        const ex = await client.query<{ recommendation_id: string }>(
          ctx,
          `UPDATE recommendation SET status = 'expired', updated_at = NOW()
            WHERE brand_id = $1 AND detector = $2 AND subject = $3 AND status = 'open'
          RETURNING recommendation_id`,
          [brandId, detector.id, detector.subject],
        );
        for (const r of ex.rows) {
          expired += 1;
          decisionLogRows.push({
            recommendationId: r.recommendation_id,
            actor: `detector:${detector.id}`,
            action: 'expired',
            reason: 'signal no longer fires',
            payload: null,
          });
        }
      }
    }

    // (c) Batch the append-only decision_log writes into ONE multi-row INSERT per brand.
    if (decisionLogRows.length > 0) {
      await insertDecisionLogBatch(client, ctx, brandId, decisionLogRows);
    }

    return { raised, expired, signals };
  } finally {
    client.release();
  }
}

/** Single multi-row INSERT for the brand's decision_log rows (append-only — no ON CONFLICT). */
async function insertDecisionLogBatch(
  client: Awaited<ReturnType<DbPool['connect']>>,
  ctx: QueryContext,
  brandId: string,
  rows: DecisionLogRow[],
): Promise<void> {
  const params: unknown[] = [brandId];
  const tuples = rows.map((r, i) => {
    const base = 2 + i * 5; // $1 is brand_id; each row contributes 5 params.
    params.push(r.recommendationId, r.actor, r.action, r.reason, r.payload);
    return `($1, 'recommendation', $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`;
  });
  await client.query(
    ctx,
    `INSERT INTO decision_log (brand_id, kind, recommendation_id, actor, action, reason, payload)
     VALUES ${tuples.join(', ')}`,
    params,
  );
}
