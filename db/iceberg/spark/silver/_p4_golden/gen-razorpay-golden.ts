// gen-razorpay-golden.ts — ADR-0006 P4 golden-vector capture for the Razorpay normalizer.
// Runs the REAL @brain/razorpay-mapper on representative raw settlement-recon items with a fixed salt and
// dumps {raw_item, brand_id, salt_hex, expected:{...canonical settlement.live.v1 fields...}} JSON, so the
// PySpark ports can be asserted byte-for-byte against the actual TS (see test_razorpay-golden.py).
//
//   pnpm --filter @brain/razorpay-mapper exec tsx \
//     ../../db/iceberg/spark/silver/_p4_golden/gen-razorpay-golden.ts > shopify-... (see test for the path)
//
// Mirrors gen-shopify-golden.ts: capture the mapper output AND the event_id the caller (run.ts) seeds —
// uuidV5FromSettlementItem when a payment_id is present, else uuidV5FromSettlementSummary.
import {
  mapSettlementItemToEvent,
  uuidV5FromSettlementItem,
  uuidV5FromSettlementSummary,
  type RazorpaySettlementItem,
} from '@brain/razorpay-mapper';

const SALT = 'a'.repeat(64);            // a fixed 64-hex salt for reproducible vectors
const BRAND = '444a25f2-57d4-4e04-9f70-98a6480e1fc4';

// 4 representative raw recon items (card.* present on the first to prove the allowlist drop; per_order +
// brand_level; INR + AED; settled_at present + settled_at-null→created_at fallback).
const items: RazorpaySettlementItem[] = [
  // 1) payment, full fields, INR, per_order — card.* present (MUST never cross the boundary)
  {
    settlement_id: 'setl_Golden00000001', payment_id: 'pay_Golden0000000001', order_id: 'order_Golden00001',
    amount: 1499000, fee: 29980, tax: 5396, utr: 'UTR20260620000000000001', status: 'settled',
    created_at: 1750413540, settled_at: 1750500000, currency: 'INR', entity_type: 'payment',
    card_last4: '4242', card_network: 'Visa', card_issuer: 'HDFC', method: 'card',
  } as RazorpaySettlementItem,
  // 2) refund, has payment_id, INR, per_order
  {
    settlement_id: 'setl_Golden00000002', payment_id: 'pay_Golden0000000002', order_id: 'order_Golden00002',
    amount: 79900, fee: 0, tax: 0, utr: 'UTR20260621000000000002', status: 'processed',
    created_at: 1750500000, settled_at: 1750586400, currency: 'INR', entity_type: 'refund',
  },
  // 3) adjustment, NO payment_id → brand_level + summary event_id, AED, no utr
  {
    settlement_id: 'setl_Golden00000003', payment_id: null, order_id: null,
    amount: 4990, fee: 100, tax: 18, utr: null, status: 'created',
    created_at: 1750586400, settled_at: 1750672800, currency: 'aed', entity_type: 'adjustment',
  },
  // 4) reserve_deduction, NO payment_id, settled_at NULL → occurred_at falls back to created_at, INR
  {
    settlement_id: 'setl_Golden00000004', payment_id: null, order_id: null,
    amount: 250000, fee: null, tax: null, utr: null, status: 'pending',
    created_at: 1750672800, settled_at: null, currency: 'INR', entity_type: 'reserve_deduction',
  },
];

const vectors = items.map((it) => {
  const m = mapSettlementItemToEvent(it, BRAND, SALT);
  const p = m.properties;
  const settlementId = String(it.settlement_id ?? '');
  const paymentId = it.payment_id != null ? String(it.payment_id) : null;
  const event_id = paymentId
    ? uuidV5FromSettlementItem(BRAND, settlementId, paymentId, p.entity_type)
    : uuidV5FromSettlementSummary(BRAND, settlementId);
  return {
    raw_item: it,
    brand_id: BRAND,
    salt_hex: SALT,
    expected: {
      event_id,
      occurred_at: m.occurred_at,
      source: p.source,
      settlement_id: p.settlement_id,
      payment_id_hash: p.payment_id_hash,
      order_id: p.order_id,
      utr_hash: p.utr_hash,
      amount_minor: p.amount_minor,
      fee_minor: p.fee_minor,
      tax_minor: p.tax_minor,
      currency_code: p.currency_code,
      entity_type: p.entity_type,
      status: p.status,
      settlement_at: p.settlement_at,
      reconciliation_type: p.reconciliation_type,
    },
  };
});

console.log(JSON.stringify(vectors, null, 2));
