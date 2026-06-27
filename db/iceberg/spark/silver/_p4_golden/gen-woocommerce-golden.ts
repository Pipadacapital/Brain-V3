import { mapWooOrderToEvent, uuidV5FromOrderLive } from '@brain/woocommerce-mapper';
const SALT = 'a'.repeat(64); // a fixed 64-hex salt for reproducible vectors
const BRAND = '444a25f2-57d4-4e04-9f70-98a6480e1fc4';
// Representative wc/v3 orders: prepaid+email+phone, COD (method), AED cancelled+no-billing, title-based COD + naive-GMT date.
const orders: any[] = [
  { id: 5001, status: 'processing', currency: 'INR', total: '1499.00', payment_method: 'razorpay', payment_method_title: 'Razorpay', date_created_gmt: '2026-06-20T09:58:00', date_modified_gmt: '2026-06-20T10:00:00', customer_id: 77, billing: { email: '  Alice@Example.COM ', phone: '9876543210' } },
  { id: 5002, status: 'pending', currency: 'INR', total: '799', payment_method: 'cod', payment_method_title: 'Cash on delivery', date_created_gmt: '2026-06-21T12:30:00Z', date_modified_gmt: '2026-06-21T12:30:45Z', customer_id: 0, billing: { email: 'bob@store.io', phone: null } },
  { id: 5003, status: 'cancelled', currency: 'aed', total: '49.90', payment_method: 'stripe', payment_method_title: 'Credit Card (Stripe)', date_created_gmt: '2026-06-22T08:00:00Z', date_modified_gmt: '2026-06-22T08:15:00Z', customer_id: null, billing: null },
  { id: 5004, status: 'completed', currency: 'INR', total: '250.5', payment_method: 'bacs', payment_method_title: 'Pay via COD', date_created_gmt: '2026-06-23T06:00:00', date_modified_gmt: null, customer_id: 88, billing: { email: 'carol@shop.in', phone: '+919812345678' } },
];
const vectors = orders.map((o) => {
  const m = mapWooOrderToEvent(o, BRAND, SALT, 'IN', 'real');
  // The Woo live lane (WooCommerceWebhookStrategy + repull) seeds with Date.parse(occurred_at):
  const updatedAtMs = Date.parse(m.occurred_at);
  const event_id = uuidV5FromOrderLive(BRAND, String(o.id), updatedAtMs);
  const p: any = m.properties;
  return {
    raw_order: o, brand_id: BRAND, salt_hex: SALT, region: 'IN',
    expected: {
      event_id, occurred_at: m.occurred_at, amount_minor: p.amount_minor, currency_code: p.currency_code,
      payment_method: p.payment_method, financial_status: p.financial_status ?? null,
      fulfillment_status: p.fulfillment_status ?? null, cancelled_at: p.cancelled_at ?? null,
      hashed_customer_email: p.hashed_customer_email ?? null, hashed_customer_phone: p.hashed_customer_phone ?? null,
      storefront_customer_id: p.storefront_customer_id ?? null,
    },
  };
});
console.log(JSON.stringify(vectors, null, 2));
