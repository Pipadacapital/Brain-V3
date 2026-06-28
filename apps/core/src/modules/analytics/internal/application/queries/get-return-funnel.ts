/**
 * getReturnFunnel — analytics use-case (ADR-002 sole-read-path, Silver tier) — SR-10.
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeReturnFunnel (metric engine), a read from the Silver mart
 * silver_return (Trino brain_serving.mv_silver_return) through the withSilverBrand seam. NO ad-hoc
 * COUNT/ratio here (D-3 / ADR-002) — the metric-engine seam owns the non-additive aggregation.
 *
 * Returns are a SEPARATE lifecycle: this surfaces return_class buckets + completion%, NEVER
 * terminal_class — the queryable proof of the SR-4 false-delivery fix.
 *
 * Serializes bigint → string (D-1), echoes the [from,to] range, shapes the honest no_data
 * discriminant. brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/return-funnel.ts
 */

import type { SilverPool, ReturnClass } from '@brain/metric-engine';
import { computeReturnFunnel } from '@brain/metric-engine';

export interface ReturnClassBucketDto {
  return_class: ReturnClass;
  count: string; // bigint → string
}

export interface ReturnCourierBucketDto {
  courier: string;
  total: string;
  completed: string;
}

export type ReturnFunnelResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;
      to: string;
      total: string;
      completed: string;
      in_progress: string;
      completion_pct: string | null;
      by_class: ReturnClassBucketDto[];
      by_courier: ReturnCourierBucketDto[];
      data_source: 'synthetic' | 'live';
    };

export interface ReturnFunnelParams {
  from: Date;
  to: Date;
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getReturnFunnel(
  brandId: string,
  deps: { srPool: SilverPool },
  params: ReturnFunnelParams,
): Promise<ReturnFunnelResult> {
  const result = await computeReturnFunnel(brandId, deps, { from: params.from, to: params.to });

  if (!result.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    total: String(result.total),
    completed: String(result.completed),
    in_progress: String(result.inProgress),
    completion_pct: result.completionPct,
    by_class: result.byClass.map((b) => ({
      return_class: b.return_class,
      count: String(b.count),
    })),
    by_courier: result.byCourier.map((c) => ({
      courier: c.courier,
      total: String(c.total),
      completed: String(c.completed),
    })),
    data_source: params.dataSource,
  };
}
