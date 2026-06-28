/**
 * @brain/metric-engine — getCustomerOrders (per-customer order list for Customer 360).
 *
 * The SOLE read seam for ONE resolved customer's orders — read through withSilverBrand
 * (brand predicate injected at the seam, I-ST01) over brain_serving.mv_silver_order_state, the
 * deterministic 1-row-per-(brand_id, order_id) latest-lifecycle-state fold. Backs the Customer
 * Profile "Orders" sub-tab, which is count-only today: this turns the count into the actual list.
 *
 * GRAIN: one row per order_id (latest captured lifecycle state), newest-first, capped at `limit`.
 * MONEY (I-S07): orderValueMinor is SIGNED bigint MINOR units (carried as string for BigInt-safe JSON)
 * paired with its sibling currencyCode — never a float, never blended across currencies.
 *
 * Honest-empty: returns [] when the customer has no orders (or the serving tier is unavailable — the
 * seam degrades a missing mart to []). brain_id/brand_id are varchar in this mart. NO PII (no raw
 * email/phone; identifiers are hashed upstream).
 * @see packages/metric-engine/src/customer-360.ts (sibling per-customer Gold read)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface CustomerOrderRow {
  orderId: string;
  lifecycleState: string;
  isTerminal: boolean;
  /** SIGNED bigint MINOR units as string (BigInt-safe JSON); paired with currencyCode. */
  orderValueMinor: string;
  currencyCode: string | null;
  /** ISO-8601 — when the order was first observed (placed). Null = unknown. */
  firstEventAt: string | null;
  /** ISO-8601 — when the latest lifecycle state took effect. Null = unknown. */
  stateEffectiveAt: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function toIso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * getCustomerOrders — the resolved customer's orders (latest state each), newest-first.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param brainId - The resolved customer's brain_id.
 * @param deps    - the Trino serving pool (createTrinoPool) injected at the root.
 * @param limit   - max orders to return (clamped 1..200; default 50).
 */
export async function getCustomerOrders(
  brandId: string,
  brainId: string,
  deps: { srPool: SilverPool },
  limit: number = DEFAULT_LIMIT,
): Promise<CustomerOrderRow[]> {
  if (!brainId || brainId.length === 0) return [];
  const lim = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT);

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      order_id: string;
      lifecycle_state: string | null;
      is_terminal: boolean | number | null;
      order_value_minor: string | number | null;
      currency_code: string | null;
      first_event_at: string | Date | null;
      state_effective_at: string | Date | null;
    }>(
      // BRAND_PREDICATE must be the LAST placeholder — the seam APPENDS brandId, so brain_id = ? (the
      // caller's own placeholder) comes first and brand_id = ? is appended last.
      `SELECT order_id, lifecycle_state, is_terminal, order_value_minor, currency_code,
              first_event_at, state_effective_at
         FROM brain_serving.mv_silver_order_state
        WHERE brain_id = ? AND ${BRAND_PREDICATE}
        ORDER BY state_effective_at DESC, order_id ASC
        LIMIT ${lim}`,
      [brainId],
    );

    return rows.map((r) => ({
      orderId: r.order_id,
      lifecycleState: r.lifecycle_state ?? 'unknown',
      isTerminal: r.is_terminal === true || Number(r.is_terminal) === 1,
      orderValueMinor: BigInt(String(r.order_value_minor ?? '0').split('.')[0] ?? '0').toString(),
      currencyCode: r.currency_code ?? null,
      firstEventAt: toIso(r.first_event_at),
      stateEffectiveAt: toIso(r.state_effective_at),
    }));
  });
}
