/**
 * getOrderDetail — a single order's economic breakdown, read from Bronze (feat-shopify-order-depth).
 *
 * The order-depth capture (line items, tax, shipping, discounts, refunds) lands in Bronze as JSONB
 * under payload.properties.* (the mapper's OrderProperties). This bounded single-row read returns
 * that composition for ONE order so a stakeholder can drill into what was actually sold — the
 * captured truth of the order, straight from the source-of-truth layer.
 *
 * Bronze (not the ledger) is the correct source here: the ledger holds recognition EVENTS
 * (provisional/finalization/refund amounts), never the line-item composition. We read the LATEST
 * order.* event for the order_id — live order events are per-state rows keyed by updated_at, so the
 * most recent occurred_at is the current state.
 *
 * Read under withBrandTxn (RLS-scoped, brand_id from session — D-1; never manual WHERE — F-SEC-02).
 * Money is bigint-as-string minor units exactly as the mapper stored it (I-S07; no float, no /100).
 * PII posture: OrderProperties already carries only hashed identifiers — no raw email/phone here.
 */
import { withBrandTxn, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';
import { type BronzeReadDeps, ICEBERG_BRONZE, useIceberg } from './_bronze-source.js';

export interface OrderLineItemDto {
  sku: string | null;
  title: string | null;
  quantity: number;
  unit_price_minor: string;
  line_total_minor: string;
  line_discount_minor: string;
  product_id: string | null;
  variant_id: string | null;
}
export interface OrderTaxLineDto {
  title: string | null;
  rate: number | null;
  amount_minor: string;
}
export interface OrderDiscountCodeDto {
  code: string | null;
  amount_minor: string;
  type: string | null;
}
export interface OrderRefundDto {
  refund_id: string | null;
  processed_at: string | null;
  amount_minor: string;
  reason: string | null;
}

export interface OrderDetailDto {
  order_id: string;
  occurred_at: string;
  currency_code: string;
  amount_minor: string;
  payment_method: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  cancelled_at: string | null;
  /** True when the source order carried the economic breakdown (false = legacy/flat order). */
  has_depth: boolean;
  line_items: OrderLineItemDto[];
  tax_lines: OrderTaxLineDto[];
  tax_total_minor: string | null;
  shipping_total_minor: string | null;
  discount_codes: OrderDiscountCodeDto[];
  discount_total_minor: string | null;
  refunds: OrderRefundDto[];
  refund_total_minor: string | null;
}

export type OrderDetailResult =
  | { state: 'not_found'; order_id: string }
  | { state: 'has_data'; order_id: string; detail: OrderDetailDto };

/** A minor-units string, or null when absent/malformed. Never coerces a number to float. */
function minorOrNull(v: unknown): string | null {
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return v;
  return null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

interface RawProps {
  order_id?: unknown;
  currency_code?: unknown;
  amount_minor?: unknown;
  payment_method?: unknown;
  financial_status?: unknown;
  fulfillment_status?: unknown;
  cancelled_at?: unknown;
  line_items?: unknown;
  tax_lines?: unknown;
  tax_total_minor?: unknown;
  shipping_total_minor?: unknown;
  discount_codes?: unknown;
  discount_total_minor?: unknown;
  refunds?: unknown;
  refund_total_minor?: unknown;
}

function mapLineItems(raw: unknown): OrderLineItemDto[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((li: Record<string, unknown>) => ({
    sku: strOrNull(li['sku']),
    title: strOrNull(li['title']),
    quantity: typeof li['quantity'] === 'number' ? li['quantity'] : 0,
    unit_price_minor: minorOrNull(li['unit_price_minor']) ?? '0',
    line_total_minor: minorOrNull(li['line_total_minor']) ?? '0',
    line_discount_minor: minorOrNull(li['line_discount_minor']) ?? '0',
    product_id: strOrNull(li['product_id']),
    variant_id: strOrNull(li['variant_id']),
  }));
}
function mapTaxLines(raw: unknown): OrderTaxLineDto[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t: Record<string, unknown>) => ({
    title: strOrNull(t['title']),
    rate: typeof t['rate'] === 'number' ? t['rate'] : null,
    amount_minor: minorOrNull(t['amount_minor']) ?? '0',
  }));
}
function mapDiscountCodes(raw: unknown): OrderDiscountCodeDto[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d: Record<string, unknown>) => ({
    code: strOrNull(d['code']),
    amount_minor: minorOrNull(d['amount_minor']) ?? '0',
    type: strOrNull(d['type']),
  }));
}
function mapRefunds(raw: unknown): OrderRefundDto[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: Record<string, unknown>) => ({
    refund_id: strOrNull(r['refund_id']),
    processed_at: strOrNull(r['processed_at']),
    amount_minor: minorOrNull(r['amount_minor']) ?? '0',
    reason: strOrNull(r['reason']),
  }));
}

/**
 * getOrderDetail — the latest captured composition of one order, brand-scoped.
 *
 * @param brandId  Brand UUID (from session — D-1).
 * @param orderId  Order natural key (the Shopify order_id).
 * @param deps     pg.Pool (+ optional srPool when reading Bronze from Iceberg).
 */
export async function getOrderDetail(
  brandId: string,
  orderId: string,
  deps: BronzeReadDeps,
): Promise<OrderDetailResult> {
  // ── Iceberg Bronze source (Slice 5): props comes back as a JSON STRING → parse it; the rest of
  // the mapping below is shared. Brand isolation via the withSilverBrand seam (${BRAND_PREDICATE}).
  const fetchIceberg = async (
    deps2: BronzeReadDeps & { srPool: NonNullable<BronzeReadDeps['srPool']> },
  ): Promise<{ occurred_at: Date; props: RawProps | null } | null> => {
    const ORDER_ID = "COALESCE(get_json_object(payload, '$.properties.order_id'), get_json_object(payload, '$.order_id'))";
    const r = await withSilverBrand(deps2.srPool, brandId, async (scope) => {
      const rs = await scope.runScoped<{ occurred_at: Date | string; props: string | null }>(
        `SELECT occurred_at, get_json_object(payload, '$.properties') AS props
           FROM ${ICEBERG_BRONZE}
          WHERE event_type LIKE 'order.%' AND ${ORDER_ID} = ? AND ${BRAND_PREDICATE}
          ORDER BY occurred_at DESC LIMIT 1`,
        [orderId],
      );
      return rs[0] ?? null;
    });
    if (!r || r.props == null) return null;
    let props: RawProps | null;
    try { props = JSON.parse(r.props) as RawProps; } catch { props = null; }
    return { occurred_at: r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at), props };
  };

  const row = useIceberg(deps)
    ? await fetchIceberg(deps)
    : await withBrandTxn(deps.pool, brandId, async (client) => {
    const result = await client.query<{ occurred_at: Date; props: RawProps | null }>(
      `SELECT occurred_at, payload->'properties' AS props
         FROM bronze_events
        WHERE brand_id = $1
          AND event_type LIKE 'order.%'
          AND COALESCE(payload->'properties'->>'order_id', payload->>'order_id') = $2
        ORDER BY occurred_at DESC
        LIMIT 1`,
      [brandId, orderId],
    );
    return result.rows[0] ?? null;
  });

  if (!row || !row.props) {
    return { state: 'not_found', order_id: orderId };
  }

  const p = row.props;
  const line_items = mapLineItems(p.line_items);
  const tax_lines = mapTaxLines(p.tax_lines);
  const discount_codes = mapDiscountCodes(p.discount_codes);
  const refunds = mapRefunds(p.refunds);
  const tax_total_minor = minorOrNull(p.tax_total_minor);
  const shipping_total_minor = minorOrNull(p.shipping_total_minor);
  const discount_total_minor = minorOrNull(p.discount_total_minor);
  const refund_total_minor = minorOrNull(p.refund_total_minor);

  const has_depth =
    line_items.length > 0 ||
    tax_lines.length > 0 ||
    refunds.length > 0 ||
    discount_codes.length > 0 ||
    tax_total_minor !== null ||
    shipping_total_minor !== null;

  return {
    state: 'has_data',
    order_id: orderId,
    detail: {
      order_id: orderId,
      occurred_at: row.occurred_at.toISOString(),
      currency_code: strOrNull(p.currency_code) ?? 'INR',
      amount_minor: minorOrNull(p.amount_minor) ?? '0',
      payment_method: strOrNull(p.payment_method),
      financial_status: strOrNull(p.financial_status),
      fulfillment_status: strOrNull(p.fulfillment_status),
      cancelled_at: strOrNull(p.cancelled_at),
      has_depth,
      line_items,
      tax_lines,
      tax_total_minor,
      shipping_total_minor,
      discount_codes,
      discount_total_minor,
      refunds,
      refund_total_minor,
    },
  };
}
