/**
 * getOrdersList — a paginated list of orders (latest canonical state per order) from SILVER.
 *
 * One row per order at its canonical latest state (mv_silver_order_state is already deduped to one
 * row per (brand_id, order_id) — newest-ingested wins in the Spark build), newest-first, offset-
 * paginated. The per-order drill-down was removed (it read Bronze) — the Data browser shows the full
 * canonical record + a detail modal.
 *
 * NEVER-READ-BRONZE (product rule): Bronze is the raw source of truth we DERIVE from, never a read
 * surface. This list reads the Silver serving mart — the SAME canonical spine the Data browser reads —
 * so the dashboard order list and the Data tab agree exactly (they were diverging when this read Bronze:
 * Bronze's per-event LIKE 'order.%' distinct-count vs Silver's one-row-per-order).
 *
 * Read from the Iceberg serving views (mv_silver_order_state + mv_silver_order_line for the gross value),
 * brand-scoped by the withSilverBrand seam (brand from session — D-1; the seam injects brand_id = ? —
 * F-SEC-02, placed LAST). Money is bigint-as-string minor units (I-S07). Honest no_data (D-2) when the
 * brand has 0 orders. Value = GROSS order total (Σ line totals) — populated for ALL orders including
 * `placed`, matching the Data browser; the mart's own order_value_minor is RECOGNISED revenue (0 until
 * confirmed) which reads as "0 for every order" in a plain list.
 */
import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';
import { type BronzeReadDeps, hasSilver } from './_bronze-source.js';

export interface OrderListItemDto {
  order_id: string;
  occurred_at: string;
  amount_minor: string;
  currency_code: string;
  payment_method: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  /** True when this order carried the economic breakdown (has order lines → links to a richer detail view). */
  has_depth: boolean;
}

export type OrdersListResult =
  | { state: 'no_data'; page: number; page_size: number; total: string }
  | {
      state: 'has_data';
      page: number;
      page_size: number;
      total: string; // bigint → string (total distinct orders)
      orders: OrderListItemDto[];
    };

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function minorOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return /^-?\d+$/.test(s) ? s : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

interface ListRow {
  order_id: string;
  occurred_at: string | null;
  amount_minor: string | number | null;
  currency_code: string | null;
  lifecycle_state: string | null;
  is_terminal: boolean | number | null;
  has_depth: boolean | number | null;
}

/**
 * getOrdersList — latest canonical-state orders for the brand, newest-first, offset-paginated.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param params  - 1-based page + page size (clamped server-side).
 * @param deps    - EngineDeps carrying the Silver serving pool.
 */
export async function getOrdersList(
  brandId: string,
  params: { page?: number; pageSize?: number },
  deps: BronzeReadDeps,
): Promise<OrdersListResult> {
  const pageSize = Math.min(Math.max(1, Math.trunc(params.pageSize || DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
  const page = Math.max(1, Math.trunc(params.page || 1));
  const offset = (page - 1) * pageSize;

  // no Silver serving wired → honest no_data.
  if (!hasSilver(deps)) return { state: 'no_data', page, page_size: pageSize, total: '0' };

  // ── Silver canonical order spine — brand-isolated via the withSilverBrand seam ──────────
  {
    // Gross order total (Σ line totals) — matches the Data browser's "Value" column. COALESCE→0 when an
    // order has no lines yet. Line presence → has_depth (links to the richer detail view).
    const GROSS =
      'COALESCE((SELECT SUM(ol.line_total_minor) FROM brain_serving.mv_silver_order_line ol '
      + 'WHERE ol.brand_id = os.brand_id AND ol.order_id = os.order_id), 0)';
    const HAS_DEPTH =
      '(SELECT count(*) FROM brain_serving.mv_silver_order_line ol '
      + 'WHERE ol.brand_id = os.brand_id AND ol.order_id = os.order_id) > 0';

    const result = await withSilverBrand(deps.srPool, brandId, async (scope) => {
      // mv_silver_order_state is already one row per (brand_id, order_id) — a plain COUNT is the order total.
      const totalRows = await scope.runScoped<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM brain_serving.mv_silver_order_state os WHERE ${BRAND_PREDICATE}`,
      );
      const total = String(totalRows[0]?.n ?? '0');
      if (total === '0') return { total: '0', rows: [] as ListRow[] };
      const rows = await scope.runScoped<ListRow>(
        `SELECT os.order_id AS order_id,
                to_iso8601(os.first_event_at) AS occurred_at,
                ${GROSS} AS amount_minor,
                os.currency_code AS currency_code,
                os.lifecycle_state AS lifecycle_state,
                os.is_terminal AS is_terminal,
                ${HAS_DEPTH} AS has_depth
           FROM brain_serving.mv_silver_order_state os
          WHERE ${BRAND_PREDICATE}
          ORDER BY os.first_event_at DESC, os.order_id ASC
          OFFSET ${offset} LIMIT ${pageSize}`,
      );
      return { total, rows };
    });
    if (result.total === '0') return { state: 'no_data', page, page_size: pageSize, total: '0' };
    return {
      state: 'has_data', page, page_size: pageSize, total: result.total,
      orders: result.rows.map((r) => ({
        order_id: r.order_id,
        // occurred_at is already an ISO-8601 string from to_iso8601 (no brittle ' UTC'-suffix Date parse).
        occurred_at: strOrNull(r.occurred_at) ?? new Date(0).toISOString(),
        amount_minor: minorOrNull(r.amount_minor) ?? '0',
        currency_code: strOrNull(r.currency_code) ?? 'INR',
        // Silver collapses the raw Bronze financial/payment fields into the canonical lifecycle_state; that
        // IS the order's status. payment_method lives in the shipment mart, not the order spine → null here.
        payment_method: null,
        financial_status: strOrNull(r.lifecycle_state),
        fulfillment_status: (r.is_terminal === true || Number(r.is_terminal) === 1) ? 'terminal' : null,
        has_depth: r.has_depth === true || Number(r.has_depth) === 1,
      })),
    };
  }
}
