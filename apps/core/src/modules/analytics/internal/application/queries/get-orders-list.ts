/**
 * getOrdersList — a paginated list of orders (latest state per order) from Bronze.
 *
 * One row per order_id at its latest captured state (live order events are per-state; newest
 * occurred_at wins), newest-first, offset-paginated. The list links into getOrderDetail for the
 * full economic breakdown. Reads Bronze (the source-of-truth layer) — consistent with the detail
 * view and always populated (Silver may lag).
 *
 * Read under withBrandTxn (RLS-scoped; brand from session — D-1; never manual WHERE — F-SEC-02).
 * Money is bigint-as-string minor units (I-S07). Honest no_data (D-2) when the brand has 0 orders.
 * PII posture: OrderProperties carries only hashed identifiers — no raw email/phone here.
 */
import type { EngineDeps } from '@brain/metric-engine';
import { withBrandTxn } from '@brain/metric-engine';

export interface OrderListItemDto {
  order_id: string;
  occurred_at: string;
  amount_minor: string;
  currency_code: string;
  payment_method: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  /** True when this order carried the economic breakdown (links to a richer detail view). */
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
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return v;
  return null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

interface ListRow {
  order_id: string;
  occurred_at: Date;
  amount_minor: string | null;
  currency_code: string | null;
  payment_method: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  has_depth: boolean;
}

/**
 * getOrdersList — latest-state orders for the brand, newest-first, offset-paginated.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param params  - 1-based page + page size (clamped server-side).
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getOrdersList(
  brandId: string,
  params: { page?: number; pageSize?: number },
  deps: EngineDeps,
): Promise<OrdersListResult> {
  const pageSize = Math.min(Math.max(1, Math.trunc(params.pageSize || DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
  const page = Math.max(1, Math.trunc(params.page || 1));
  const offset = (page - 1) * pageSize;

  const { total, rows } = await withBrandTxn(deps.pool, brandId, async (client) => {
    // Total distinct orders (the pagination denominator). The ORDER_ID extraction matches the
    // reconciliation + detail reads (COALESCE the nested + legacy top-level forms).
    const totalRes = await client.query<{ n: string }>(
      `SELECT COUNT(DISTINCT COALESCE(payload->'properties'->>'order_id', payload->>'order_id'))::text AS n
         FROM bronze_events
        WHERE brand_id = $1
          AND event_type LIKE 'order.%'
          AND COALESCE(payload->'properties'->>'order_id', payload->>'order_id') IS NOT NULL`,
      [brandId],
    );
    const totalCount = totalRes.rows[0]?.n ?? '0';

    if (totalCount === '0') return { total: '0', rows: [] as ListRow[] };

    // Latest event per order (DISTINCT ON order_id, newest occurred_at), then page newest-first.
    const res = await client.query<ListRow>(
      `WITH latest AS (
         SELECT DISTINCT ON (COALESCE(payload->'properties'->>'order_id', payload->>'order_id'))
                COALESCE(payload->'properties'->>'order_id', payload->>'order_id') AS order_id,
                occurred_at,
                payload->'properties'->>'amount_minor'         AS amount_minor,
                payload->'properties'->>'currency_code'        AS currency_code,
                payload->'properties'->>'payment_method'       AS payment_method,
                payload->'properties'->>'financial_status'     AS financial_status,
                payload->'properties'->>'fulfillment_status'   AS fulfillment_status,
                jsonb_typeof(payload->'properties'->'line_items') = 'array' AS has_depth
           FROM bronze_events
          WHERE brand_id = $1
            AND event_type LIKE 'order.%'
            AND COALESCE(payload->'properties'->>'order_id', payload->>'order_id') IS NOT NULL
          ORDER BY order_id, occurred_at DESC
       )
       SELECT * FROM latest
        ORDER BY occurred_at DESC, order_id ASC
        LIMIT $2 OFFSET $3`,
      [brandId, pageSize, offset],
    );
    return { total: totalCount, rows: res.rows };
  });

  if (total === '0') {
    return { state: 'no_data', page, page_size: pageSize, total: '0' };
  }

  return {
    state: 'has_data',
    page,
    page_size: pageSize,
    total,
    orders: rows.map((r) => ({
      order_id: r.order_id,
      occurred_at: r.occurred_at.toISOString(),
      amount_minor: minorOrNull(r.amount_minor) ?? '0',
      currency_code: strOrNull(r.currency_code) ?? 'INR',
      payment_method: strOrNull(r.payment_method),
      financial_status: strOrNull(r.financial_status),
      fulfillment_status: strOrNull(r.fulfillment_status),
      has_depth: r.has_depth === true,
    })),
  };
}
