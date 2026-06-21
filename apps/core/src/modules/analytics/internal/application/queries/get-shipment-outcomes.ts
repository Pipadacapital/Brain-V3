/**
 * getShipmentOutcomes — analytics use-case (ADR-002 sole-read-path, Silver tier).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeShipmentOutcomes (metric engine), a read from the Silver
 * mart silver_shipment (StarRocks brain_silver) through the withSilverBrand seam. NO ad-hoc
 * COUNT/ratio here (D-3 / ADR-002) — the metric-engine seam owns the non-additive aggregation.
 *
 * Serializes bigint → string (D-1), echoes the [from,to] range, shapes the honest no_data
 * discriminant. Multi-source (GoKwik AWB + Shiprocket) via the shared silver_shipment mart.
 *
 * I-ST01: the metric-engine is the SOLE Silver reader; the UI reaches Silver only through
 * BFF → this use-case → withSilverBrand. brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/shipment-outcomes.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeShipmentOutcomes } from '@brain/metric-engine';

export interface CourierOutcomeDto {
  courier: string;
  delivered: string; // bigint → string
  rto: string;       // bigint → string
  rto_pct: string | null;
}

export interface PincodeOutcomeDto {
  pincode: string;
  delivered: string;
  rto: string;
  rto_pct: string | null;
}

export type ShipmentOutcomesResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;
      to: string;
      total: string;
      delivered: string;
      rto: string;
      other: string;
      in_transit: string;
      rto_pct: string | null;
      by_courier: CourierOutcomeDto[];
      by_pincode: PincodeOutcomeDto[];
      data_source: 'synthetic' | 'live';
    };

export interface ShipmentOutcomesParams {
  from: Date;
  to: Date;
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getShipmentOutcomes(
  brandId: string,
  deps: { srPool: SilverPool },
  params: ShipmentOutcomesParams,
): Promise<ShipmentOutcomesResult> {
  const result = await computeShipmentOutcomes(brandId, deps, { from: params.from, to: params.to });

  if (!result.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    total: String(result.total),
    delivered: String(result.delivered),
    rto: String(result.rto),
    other: String(result.other),
    in_transit: String(result.inTransit),
    rto_pct: result.rtoPct,
    by_courier: result.byCourier.map((c) => ({
      courier: c.courier,
      delivered: String(c.delivered),
      rto: String(c.rto),
      rto_pct: c.rtoPct,
    })),
    by_pincode: result.byPincode.map((p) => ({
      pincode: p.pincode,
      delivered: String(p.delivered),
      rto: String(p.rto),
      rto_pct: p.rtoPct,
    })),
    data_source: params.dataSource,
  };
}
