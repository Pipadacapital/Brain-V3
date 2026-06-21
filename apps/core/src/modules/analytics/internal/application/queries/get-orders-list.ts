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
import { withBrandTxn, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';
import { type BronzeReadDeps, ICEBERG_BRONZE, useIceberg } from './_bronze-source.js';

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
  deps: BronzeReadDeps,
): Promise<OrdersListResult> {
  const pageSize = Math.min(Math.max(1, Math.trunc(params.pageSize || DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
  const page = Math.max(1, Math.trunc(params.page || 1));
  const offset = (page - 1) * pageSize;

  // ── Iceberg Bronze source (Slice 5) — brand-isolated via the withSilverBrand seam ──────────
  if (useIceberg(deps)) {
    // order_id = COALESCE(nested, legacy top-level) — matches the PG read + reconciliation.
    const ORDER_ID = "COALESCE(get_json_object(payload, '$.properties.order_id'), get_json_object(payload, '$.order_id'))";
    const result = await withSilverBrand(deps.srPool, brandId, async (scope) => {
      const totalRows = await scope.runScoped<{ n: number | string }>(
        `SELECT COUNT(DISTINCT ${ORDER_ID}) AS n FROM ${ICEBERG_BRONZE}
          WHERE event_type LIKE 'order.%' AND ${ORDER_ID} IS NOT NULL AND ${BRAND_PREDICATE}`,
      );
      const total = String(totalRows[0]?.n ?? '0');
      if (total === '0') return { total: '0', rows: [] as ListRow[] };
      // DISTINCT ON → row_number() window (StarRocks has no DISTINCT ON). pageSize/offset are clamped ints.
      const rows = await scope.runScoped<ListRow>(
        `SELECT order_id, occurred_at, amount_minor, currency_code, payment_method, financial_status, fulfillment_status, has_depth FROM (
           SELECT ${ORDER_ID} AS order_id, occurred_at,
                  get_json_object(payload, '$.properties.amount_minor')       AS amount_minor,
                  get_json_object(payload, '$.properties.currency_code')      AS currency_code,
                  get_json_object(payload, '$.properties.payment_method')     AS payment_method,
                  get_json_object(payload, '$.properties.financial_status')   AS financial_status,
                  get_json_object(payload, '$.properties.fulfillment_status') AS fulfillment_status,
                  CASE WHEN get_json_object(payload, '$.properties.line_items') IS NOT NULL THEN true ELSE false END AS has_depth,
                  row_number() OVER (PARTITION BY ${ORDER_ID} ORDER BY occurred_at DESC) AS rn
             FROM ${ICEBERG_BRONZE}
            WHERE event_type LIKE 'order.%' AND ${ORDER_ID} IS NOT NULL AND ${BRAND_PREDICATE}
         ) t WHERE rn = 1
          ORDER BY occurred_at DESC, order_id ASC
          LIMIT ${pageSize} OFFSET ${offset}`,
      );
      return { total, rows };
    });
    if (result.total === '0') return { state: 'no_data', page, page_size: pageSize, total: '0' };
    return {
      state: 'has_data', page, page_size: pageSize, total: result.total,
      orders: result.rows.map((r) => ({
        order_id: r.order_id,
        occurred_at: (r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at)).toISOString(),
        amount_minor: minorOrNull(r.amount_minor) ?? '0',
        currency_code: strOrNull(r.currency_code) ?? 'INR',
        payment_method: strOrNull(r.payment_method),
        financial_status: strOrNull(r.financial_status),
        fulfillment_status: strOrNull(r.fulfillment_status),
        has_depth: r.has_depth === true || Number(r.has_depth) === 1,
      })),
    };
  }

  // ── Postgres Bronze source (default) ────────────────────────────────────────
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
