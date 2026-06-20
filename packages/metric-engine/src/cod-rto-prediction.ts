/**
 * cod-rto-prediction — RTO-risk distribution from the gokwik.rto_predict.v1 Bronze stream.
 *
 * The GoKwik RTO-Predict consumer lands one prediction per (order, request_id) in bronze_events
 * (payload.properties.risk_flag ∈ high|medium|low|control|unknown — VERBATIM categorical, never a
 * fabricated number). This read seam surfaces the LATEST prediction per order over a window, so the
 * COD-RTO decisioning surface can answer "how many open-COD orders are high-risk right now?".
 *
 * HONEST EMPTY: 0 predictions → hasData=false (never a fabricated zero). DEV-HONESTY: a synthetic
 * source (data_source='synthetic') drives the UI Synthetic badge — coverage is never faked.
 *
 * F-SEC-02: reads inside withBrandTxn (GUC transaction-scoped, RLS-enforced under brain_app).
 * The canonical Bronze envelope nests mapper output under payload.properties.* — read via
 * ->'properties' (the same lesson the checkout-funnel path corrected).
 */
import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

const RTO_PREDICT_EVENT_TYPE = 'gokwik.rto_predict.v1';
const WINDOW_DAYS = 30;

export interface RtoRiskDistributionResult {
  hasData: boolean;
  /** Distinct orders with a prediction in-window (counted by their LATEST prediction). */
  orderCount: bigint;
  high: bigint;
  medium: bigint;
  low: bigint;
  control: bigint;
  unknown: bigint;
  dataSource: 'live' | 'synthetic';
}

export async function computeRtoRiskDistribution(
  brandId: string,
  deps: EngineDeps,
): Promise<RtoRiskDistributionResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    // Latest prediction per order (DISTINCT ON order_id, newest occurred_at), then bucket by flag.
    const res = await client.query<{
      total: string;
      high: string;
      medium: string;
      low: string;
      control: string;
      unknown: string;
      synthetic_cnt: string;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (payload->'properties'->>'order_id')
                payload->'properties'->>'risk_flag'   AS risk_flag,
                payload->'properties'->>'data_source' AS data_source
           FROM bronze_events
          WHERE brand_id = $1
            AND event_type = $2
            AND occurred_at >= (now() - ($3::int * INTERVAL '1 day'))
            AND payload->'properties'->>'order_id' IS NOT NULL
          ORDER BY payload->'properties'->>'order_id', occurred_at DESC
       )
       SELECT
         COUNT(*)::text                                                   AS total,
         COUNT(*) FILTER (WHERE risk_flag = 'high')::text                 AS high,
         COUNT(*) FILTER (WHERE risk_flag = 'medium')::text               AS medium,
         COUNT(*) FILTER (WHERE risk_flag = 'low')::text                  AS low,
         COUNT(*) FILTER (WHERE risk_flag = 'control')::text              AS control,
         COUNT(*) FILTER (
           WHERE risk_flag IS NULL OR risk_flag NOT IN ('high','medium','low','control')
         )::text                                                          AS unknown,
         COUNT(*) FILTER (WHERE data_source = 'synthetic')::text          AS synthetic_cnt
       FROM latest`,
      [brandId, RTO_PREDICT_EVENT_TYPE, WINDOW_DAYS],
    );

    const row = res.rows[0];
    const orderCount = BigInt(row?.total ?? '0');
    if (orderCount === 0n) {
      return {
        hasData: false,
        orderCount: 0n,
        high: 0n,
        medium: 0n,
        low: 0n,
        control: 0n,
        unknown: 0n,
        dataSource: 'live',
      };
    }
    return {
      hasData: true,
      orderCount,
      high: BigInt(row?.high ?? '0'),
      medium: BigInt(row?.medium ?? '0'),
      low: BigInt(row?.low ?? '0'),
      control: BigInt(row?.control ?? '0'),
      unknown: BigInt(row?.unknown ?? '0'),
      dataSource: BigInt(row?.synthetic_cnt ?? '0') > 0n ? 'synthetic' : 'live',
    };
  });
}
