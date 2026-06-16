#!/usr/bin/env node
/**
 * Shopify ingestion validation SPIKE (de-risk before building the real connector sync).
 *
 * Pulls real data from a live store via the Admin REST API and reports whether the
 * order/refund shape matches what the Bronze layer + realized-revenue ledger will need.
 * Standalone, no repo deps (Node 18+ global fetch). NOT production code.
 *
 * Usage:
 *   SHOPIFY_SHOP=boddactive.myshopify.com \
 *   SHOPIFY_ADMIN_TOKEN=shpat_xxx_or_oauth_token \
 *   [SHOPIFY_API_VERSION=2025-07] \
 *   node tools/shopify-spike/pull-orders.mjs
 */

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-07';

if (!SHOP || !TOKEN) {
  console.error('Missing env. Required: SHOPIFY_SHOP (e.g. boddactive.myshopify.com), SHOPIFY_ADMIN_TOKEN.');
  process.exit(1);
}

const base = `https://${SHOP.replace(/^https?:\/\//, '')}/admin/api/${VERSION}`;

async function api(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${path} → HTTP ${res.status}\n${body.slice(0, 500)}`);
  }
  return JSON.parse(body);
}

function money(n) {
  return Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function dist(arr) {
  const m = {};
  for (const v of arr) m[v ?? 'null'] = (m[v ?? 'null'] ?? 0) + 1;
  return m;
}

(async () => {
  console.log(`\n=== Shopify spike: ${SHOP} (API ${VERSION}) ===\n`);

  // 1. Shop — currency + timezone drive every monetary/day-boundary metric (onboarding hard-validates these).
  const { shop } = await api('/shop.json');
  console.log('SHOP');
  console.log(`  name:        ${shop.name}`);
  console.log(`  domain:      ${shop.myshopify_domain}`);
  console.log(`  currency:    ${shop.currency}`);
  console.log(`  timezone:    ${shop.iana_timezone} (${shop.timezone})`);
  console.log(`  country:     ${shop.country_code} · plan: ${shop.plan_display_name}`);
  console.log(`  created:     ${shop.created_at}`);

  // 2. Order count (status=any → includes cancelled/archived).
  const { count } = await api('/orders/count.json?status=any');
  console.log(`\nORDERS  total (status=any): ${count}`);

  // 3. Pull a recent page for shape analysis.
  const fields = [
    'id', 'name', 'created_at', 'processed_at', 'updated_at', 'cancelled_at',
    'currency', 'current_total_price', 'total_price', 'subtotal_price', 'total_tax',
    'financial_status', 'fulfillment_status', 'gateway', 'payment_gateway_names',
    'tags', 'test', 'refunds', 'customer',
  ].join(',');
  const { orders } = await api(`/orders.json?status=any&limit=50&fields=${fields}`);

  if (!orders.length) {
    console.log('\nNo orders returned on the first page. Store may be empty or token lacks read_orders.');
    return;
  }

  const dates = orders.map((o) => o.created_at).sort();
  const withRefunds = orders.filter((o) => (o.refunds?.length ?? 0) > 0);
  const testOrders = orders.filter((o) => o.test);
  const currencies = [...new Set(orders.map((o) => o.currency))];
  const gmv = orders.reduce((s, o) => s + Number(o.current_total_price ?? o.total_price ?? 0), 0);

  console.log(`\nSAMPLE PAGE (${orders.length} orders)`);
  console.log(`  date range:        ${dates[0]}  →  ${dates[dates.length - 1]}`);
  console.log(`  currencies:        ${currencies.join(', ')}`);
  console.log(`  page GMV:          ${currencies[0]} ${money(gmv)}`);
  console.log(`  financial_status:  ${JSON.stringify(dist(orders.map((o) => o.financial_status)))}`);
  console.log(`  fulfillment:       ${JSON.stringify(dist(orders.map((o) => o.fulfillment_status)))}`);
  console.log(`  payment gateways:  ${JSON.stringify(dist(orders.flatMap((o) => o.payment_gateway_names ?? [o.gateway])))}`);
  console.log(`  orders w/ refunds: ${withRefunds.length}/${orders.length}`);
  console.log(`  test orders:       ${testOrders.length}/${orders.length}`);
  console.log(`  has customer obj:  ${orders.filter((o) => o.customer).length}/${orders.length}`);

  // 4. One full sample — the exact fields the ledger/identity will read.
  const s = orders.find((o) => (o.refunds?.length ?? 0) > 0) ?? orders[0];
  console.log('\nSAMPLE ORDER (ledger/identity-relevant fields)');
  console.log(JSON.stringify({
    id: s.id,
    name: s.name,
    created_at: s.created_at,
    processed_at: s.processed_at,
    currency: s.currency,
    total_price: s.total_price,
    current_total_price: s.current_total_price,
    financial_status: s.financial_status,
    fulfillment_status: s.fulfillment_status,
    payment_gateway_names: s.payment_gateway_names,
    test: s.test,
    refund_count: s.refunds?.length ?? 0,
    refund_sample: s.refunds?.[0]
      ? { id: s.refunds[0].id, created_at: s.refunds[0].created_at, transactions: s.refunds[0].transactions?.length ?? 0 }
      : null,
    customer: s.customer
      ? { id: s.customer.id, email_present: !!s.customer.email, phone_present: !!s.customer.phone }
      : null,
  }, null, 2));

  console.log('\n=== Spike OK — Admin API reachable, order data pulled. ===\n');
})().catch((err) => {
  console.error('\nSPIKE FAILED:\n' + err.message + '\n');
  console.error('Hints: 401=bad/expired token · 403=missing read_orders scope · 404=wrong shop domain or unsupported API version.');
  process.exit(1);
});
