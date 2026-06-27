import { mapOrderToEvent, uuidV5FromOrderLive } from '@brain/shopify-mapper';
const SALT = 'a'.repeat(64);            // a fixed 64-hex salt for reproducible vectors
const BRAND = '444a25f2-57d4-4e04-9f70-98a6480e1fc4';
const orders: any[] = [
  { id: 1001, name: '#1001', currency: 'INR', current_total_price: '1499.00', financial_status: 'paid', fulfillment_status: null, gateway: 'razorpay', payment_gateway_names: ['Razorpay'], updated_at: '2026-06-20T10:00:00Z', processed_at: '2026-06-20T09:59:00Z', created_at: '2026-06-20T09:58:00Z', cancelled_at: null, customer: { id: 55, email: '  Alice@Example.COM ', phone: '9876543210' } },
  { id: 1002, name: '#1002', currency: 'INR', current_total_price: '799', financial_status: 'pending', fulfillment_status: 'unfulfilled', gateway: 'cash_on_delivery', payment_gateway_names: ['Cash on Delivery (COD)'], updated_at: '2026-06-21T12:30:45Z', processed_at: null, created_at: '2026-06-21T12:30:00Z', cancelled_at: null, customer: { id: 56, email: 'bob@store.io', phone: null } },
  { id: 1003, name: '#1003', currency: 'AED', current_total_price: '49.9', financial_status: 'refunded', fulfillment_status: 'fulfilled', gateway: 'stripe', payment_gateway_names: ['stripe'], updated_at: '2026-06-22T08:15:00Z', processed_at: '2026-06-22T08:10:00Z', created_at: '2026-06-22T08:00:00Z', cancelled_at: '2026-06-23T00:00:00Z', customer: null },
];
const vectors = orders.map((o) => {
  const m = mapOrderToEvent(o, SALT, 'IN', 'order.live.v1' as any);
  const updatedAtMs = new Date(o.updated_at).getTime();
  const event_id = uuidV5FromOrderLive(BRAND, String(o.id), updatedAtMs);
  const p: any = m.properties;
  return { raw_order: o, brand_id: BRAND, salt_hex: SALT, region: 'IN',
    expected: { event_id, occurred_at: m.occurred_at, amount_minor: p.amount_minor, currency_code: p.currency_code,
      payment_method: p.payment_method, financial_status: p.financial_status, cancelled_at: p.cancelled_at,
      hashed_customer_email: p.hashed_customer_email ?? null, hashed_customer_phone: p.hashed_customer_phone ?? null } };
});
console.log(JSON.stringify(vectors, null, 2));
