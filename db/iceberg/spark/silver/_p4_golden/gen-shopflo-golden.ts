// gen-shopflo-golden.ts — ADR-0006 P4 golden-vector capture for the Shopflo normalizer.
//
// Runs the REAL TS mapper (@brain/shopflo-mapper::mapShopfloCheckoutAbandoned) + the handler's event_id
// stamp (uuidV5FromShopfloCheckout over the RAW envelope checkout_id + occurred_at — exactly as
// shopfloWebhookHandler/ShopfloWebhookStrategy compute the Bronze event_id) on 4 representative raw webhook
// bodies with a fixed salt, and dumps { raw, brand_id, salt_hex, region, expected:{...canonical fields...} }.
// test_shopflo-golden.py then asserts the PySpark-side ports reproduce these byte-for-byte.
//
// Run:  pnpm --filter @brain/shopflo-mapper exec tsx ../../db/iceberg/spark/silver/_p4_golden/gen-shopflo-golden.ts > \
//         db/iceberg/spark/silver/_p4_golden/shopflo-checkout-golden.json
//   (or:  npx tsx db/iceberg/spark/silver/_p4_golden/gen-shopflo-golden.ts)

import { mapShopfloCheckoutAbandoned, uuidV5FromShopfloCheckout } from '@brain/shopflo-mapper';

const SALT = 'a'.repeat(64); // a fixed 64-hex salt for reproducible vectors
const BRAND = '444a25f2-57d4-4e04-9f70-98a6480e1fc4';

// Representative RAW Shopflo checkout_abandoned webhook bodies (the verbatim payload landed in Bronze).
// Coverage: customer email+phone hashing; top-level email/phone fallback; addressless checkout; lowercase +
// non-INR currency; integer & decimal money (incl 2-dp); formatted phone; occurred_at vs created_at
// precedence; empty line_items; cart_token present.
const checkouts: any[] = [
  // 1) Full: customer email+phone, shipping address, 2 line items (integer + decimal price), INR.
  {
    merchant_id: 'merch_a', event: 'checkout_abandoned',
    checkout_id: 'chk_0001', cart_token: 'cart_0001',
    customer: { uid: 'cust_1', email: '  Buyer@Example.COM ', phone: '+917777777777', marketing_consent: true },
    shipping_address: { city: 'Bengaluru', pincode: '560001' },
    line_items: [
      { id: 'li_1', title: 'Tee', quantity: 1, price: 55 },
      { id: 'li_2', title: 'Cap', quantity: 2, price: 5.5 },
    ],
    subtotal_price: 66, total_discount: 0, total_shipping: 0, total_tax: 9.92, total_price: 66,
    currency: 'INR',
    occurred_at: '2026-06-10T12:00:00Z', created_at: '2026-06-10T11:59:00Z',
  },
  // 2) Addressless: customer email null (top-level email also null) → only phone hashes; marketing false;
  //    occurred_at differs from created_at (occurred_at must win for BOTH the canonical occurred_at + the
  //    event_id seed); formatted phone (spaces/dashes); 1 line item.
  {
    merchant_id: 'merch_a', event: 'checkout_abandoned',
    checkout_id: 'chk_0002', cart_token: 'cart_0002',
    customer: { uid: 'cust_2', email: null, phone: '098765 43210', marketing_consent: false },
    shipping_address: null, billing_address: null,
    line_items: [{ id: 99, title: null, quantity: '3', price: '29.5' }],
    subtotal_price: 2950, total_discount: '0', total_shipping: 0, total_tax: 0, total_price: 2950,
    currency: 'inr',
    occurred_at: '2026-06-11T08:30:45Z', created_at: '2026-06-11T08:00:00Z',
  },
  // 3) Top-level email/phone fallback (no customer object); AED currency; 2-dp decimal money; no line_items;
  //    billing address present (has_address via billing).
  {
    merchant_id: 'merch_b', event: 'checkout_abandoned',
    checkout_id: 'chk_0003', cart_token: null,
    email: 'Top.Level@Shop.io', phone: '8888888888', marketing_consent: true,
    billing_address: { line1: '12 MG Road' },
    line_items: [],
    subtotal_price: '1234.56', total_discount: '34.56', total_shipping: '0', total_tax: '0', total_price: '1200.00',
    currency: 'aed',
    occurred_at: '2026-06-12T15:45:00Z',
  },
  // 4) No PII at all (email/phone absent); empty shipping object {} → has_address false; integer money;
  //    cart_token used for properties.checkout_id fallback is NOT exercised here (checkout_id present).
  {
    merchant_id: 'merch_b', event: 'checkout_abandoned',
    checkout_id: 'chk_0004', cart_token: 'cart_0004',
    customer: { uid: 'cust_4' },
    shipping_address: {},
    line_items: [{ id: 'li_x', title: 'Bottle', quantity: 1, price: '0' }],
    subtotal_price: 0, total_discount: 0, total_shipping: 0, total_tax: 0, total_price: 0,
    currency: 'INR',
    occurred_at: '2026-06-13T00:00:00.000Z', created_at: '2026-06-13T00:00:00.000Z',
  },
];

const vectors = checkouts.map((raw) => {
  const mapped = mapShopfloCheckoutAbandoned(raw, BRAND, SALT, 'IN', 'real');
  const p: any = mapped.properties;
  // The Bronze event_id the webhook handler stamps: RAW envelope checkout_id + RAW envelope occurred_at.
  const eidCheckout = typeof raw.checkout_id === 'string' ? raw.checkout_id : '';
  const eidOccurred = typeof raw.occurred_at === 'string' ? raw.occurred_at : '';
  const event_id = uuidV5FromShopfloCheckout(BRAND, eidCheckout, eidOccurred);
  return {
    raw,
    brand_id: BRAND,
    salt_hex: SALT,
    region: 'IN',
    expected: {
      event_id,
      occurred_at: mapped.occurred_at,
      source: p.source,
      data_source: p.data_source,
      checkout_id: p.checkout_id,
      cart_token: p.cart_token,
      customer_email_hash: p.customer_email_hash ?? null,
      customer_phone_hash: p.customer_phone_hash ?? null,
      marketing_consent: p.marketing_consent,
      has_address: p.has_address,
      line_items: p.line_items,
      subtotal_minor: p.subtotal_minor,
      total_discount_minor: p.total_discount_minor,
      total_shipping_minor: p.total_shipping_minor,
      total_tax_minor: p.total_tax_minor,
      total_price_minor: p.total_price_minor,
      currency_code: p.currency_code,
    },
  };
});

console.log(JSON.stringify(vectors, null, 2));
