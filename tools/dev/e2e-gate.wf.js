export const meta = {
  name: 'e2e-delivery-gate',
  description: 'End-to-end delivery gate: positive + negative + edge verification across all 7 connectors + pipeline + perf + attribution + IA, with evidence. The bar before declaring delivered.',
  phases: [
    { title: 'Suites', detail: 'whole-repo test suites + gate guard + naming guard + money-invariant sweep' },
    { title: 'Connectors', detail: 'per-connector positive/negative/edge E2E (7 parallel)' },
    { title: 'CrossCutting', detail: 'perf + attribution + IA + pipeline integrity' },
    { title: 'Report', detail: 'evidence-backed delivery report; PASS/FAIL per area' },
  ],
}

const REPO = '/Users/rishabhporwal/Desktop/Brain V3'
const BODD = '1a6adb32-eb0d-41f9-8409-dc423240e444'   // Shopify+Meta+GoKwik
const ULENIN = '5b2e975c-7186-4608-84d6-760f51fe2389' // WooCommerce

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'verdict', 'positive', 'negative', 'edge', 'evidence'],
  properties: {
    area: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'pass_with_caveats', 'fail', 'blocked_data'] },
    positive: { type: 'string', description: 'what flows + counts/evidence' },
    negative: { type: 'string', description: 'bad-HMAC/dedup/isolation/fail-closed results' },
    edge: { type: 'string', description: 'multi-currency/zero-neg/return-vs-delivery/COD/retry results' },
    evidence: { type: 'string', description: 'exact commands/SQL run + outputs' },
    caveats: { type: 'array', items: { type: 'string' } },
  },
}

const COMMON = `You are running the END-TO-END DELIVERY GATE for the Brain V4 commerce-OS at ${REPO}. A long program just landed (GoKwik/Shiprocket/Shopify/Woo connector depth + advertising + Shopflo + API perf + IA redesign + brand-edit + attribution serving-host default fix), and a full medallion refresh just ran. The user requires positive + negative + EDGE verification before delivery. Be rigorous and EVIDENCE-BACKED — run real commands/queries/tests; cite outputs. Do NOT fabricate green. If something is honestly empty-by-data (e.g. attribution with no anon↔order overlap), say so plainly with the proof, and mark blocked_data (not fail). docker compose is up (postgres, duckdb-serving@localhost:8091, kafka, kafka-connect, minio, redis). Serving SQL: curl -s -X POST localhost:8091/v1/query -H 'Content-Type: application/json' -d '{"sql":"SELECT ..."}'. PG: docker compose exec -T postgres psql -U brain -d brain -c "...". Tests: pnpm --filter <pkg> test:unit. READ-ONLY except running tests.`

phase('Suites')

const suites = await agent(
  `${COMMON}

AREA: Whole-repo test suites + structural invariants (the unit/integration evidence layer).
Run and report PASS/FAIL with counts:
1. Test suites for the touched packages: pnpm --filter @brain/{gokwik-mapper,shopify-mapper,woocommerce-mapper,shopflo-mapper,shiprocket-mapper,ad-spend-mapper,logistics-status,metric-engine,contracts} test:unit ; and apps: pnpm --filter @brain/{core,stream-worker} test (or the touched suites). Capture totals.
2. python3 -m pytest db/iceberg/duckdb/serving -q (must exit 0).
3. bash tools/lint/v4-naming-guard.sh (must pass).
4. py_compile every db/iceberg/duckdb/silver/*.py and db/iceberg/duckdb/gold/*.py.
5. MONEY INVARIANT sweep: grep the mappers + silver for any float money / hardcoded *100 / blended currency / INR-default — confirm money is bigint minor + sibling currency_code everywhere. Report any violation.
6. Whole-repo typecheck: pnpm -r typecheck (or the touched packages) — report any RED.
verdict=pass only if suites green + guards pass + no money-invariant violation.`,
  { label: 'suites+invariants', phase: 'Suites', schema: RESULT_SCHEMA, model: 'opus' },
)

phase('Connectors')

const CONNECTORS = [
  { key: 'shopify', brand: BODD, prompt: `Shopify (brand ${BODD}): POSITIVE — orders/customers/products flow Bronze→Silver→Gold→serving (counts via duckdb-serving: mv_silver_order_state, mv_gold_customer_360, mv_gold_revenue_ledger). Confirm the 4 resource events (product/customer/refund/fulfillment.upsert/recorded) are admitted in BOTH the silver keystone SERVER_TRUSTED list and app-side ProcessEventUseCase/bronzeBridges (grep). NEGATIVE — ShopifyWebhookStrategy HMAC fail-closed (run its unit + pipeline.integration tests); webhook registration idempotent (422-as-success). EDGE — COD recognition now reads shiprocket.shipment_status.v1 (grep silver_order_state); order-webhook replay >5min not rejected; offline OAuth token (no grant_options per-user).` },
  { key: 'woocommerce', brand: ULENIN, prompt: `WooCommerce (brand ${ULENIN}): POSITIVE — after the refresh, does ULenin now show customers/products/coupons (not just orders)? duckdb-serving counts: mv_silver_order_state, mv_gold_customer_360, silver_coupon/mv for the brand; Bronze collector_events_connect event_type distribution (order.live.v1 + now customer.upsert.v1/product.upsert.v1/coupon.upsert.v1?). NOTE the live webhook lane needs a real Woo webhook to emit non-order events; the BACKFILL lane + the mapper/admission are the code path under test — confirm they're wired. NEGATIVE — X-WC-Webhook-Signature HMAC fail-closed (WooCommerceWebhookStrategy.unit tests). EDGE — multi-currency money (mapper tests prove JPY 0dp/KWD 3dp/INR 2dp); coupon percent vs fixed (amount_percent never scaled to money).` },
  { key: 'gokwik', brand: BODD, prompt: `GoKwik (brand ${BODD}, webhook-first): POSITIVE — connector_instance connected; the canonical order/checkout/payment events admitted (grep SERVER_TRUSTED + silver_payment/silver_checkout_signal source-neutral). NEGATIVE — GokwikWebhookStrategy HMAC fail-closed + unknown→skip (run unit tests); webhook_secret provisioning (registry generatedSecretFields). EDGE — money bigint minor + currency; the empty-amount-not-quarantined vs zero-amount-quarantined behavior. NOTE live data needs a signed webhook delivered (no public tunnel in dev) — verify the CODE path + tests, state the dev-delivery caveat.` },
  { key: 'shiprocket', brand: BODD, prompt: `Shiprocket (brand ${BODD}): POSITIVE — shipment_status admitted; mv_silver_return view + computeReturnFunnel exist. NEGATIVE — resolver migration 0118 fn matches the route; webhook_secret provisioned. EDGE (THE key one) — run @brain/logistics-status + @brain/shiprocket-mapper unit tests and CONFIRM the test proving return.completed does NOT classify as forward DELIVERED (the false-delivery bug). Also exception_class/NDR projected on silver_shipment_event.` },
  { key: 'shopflo', brand: null, prompt: `Shopflo (webhook-first, live on zero brands): POSITIVE — mapShopfloOrder now emits order.live.v1 (grep shopflo-mapper) so it's an ORDER source; the 3 shopflo.checkout_* admitted in SERVER_TRUSTED + app-side. NEGATIVE — ShopfloWebhookStrategy HMAC fail-closed + dispatch table (run shopflo-mapper 20/20 + strategy tests). EDGE — the shared lit('gokwik') discriminant fix (silver_payment/silver_checkout_signal now COALESCE-derive source); money bigint+currency. State the code-only/no-live-brand caveat.` },
  { key: 'meta-ads', brand: BODD, prompt: `Meta Ads (brand ${BODD}, polling): POSITIVE — 969 spend.live.v1 in Bronze; silver_marketing_spend has Meta spend (duckdb-serving count platform='meta'). The enriched props (conversions/conv_value_minor/cpc_minor/ctr) are in the mapper + silver_ad_spend_normalize (grep). NEGATIVE — token-refresh hardening; ad-account activation (1 of 6). EDGE — money per-currency minor (ad-spend-mapper tests: Meta purchase revenue→minor); ad.entity.updated entity-sync job emits campaign names. CAVEAT: silver_marketing_spend columnar projection of the enriched props is a documented deferred follow-up (#29) — enriched data lands in Bronze payload but may not be visible at the mart yet; verify + state this honestly.` },
  { key: 'google-ads', brand: null, prompt: `Google Ads (polling, live on zero brands): POSITIVE — shares the ad-spend pipeline; GAQL widened (grep google-ads-searchstream-client + run.ts for conversions_value/ctr/average_cpc/channel-type). NEGATIVE — per-account login_customer_id + MCC customer_client expansion fix (grep). EDGE — cost_micros→minor + conversions_value→minor (ad-spend-mapper Google tests); google-entity-sync emits ad.entity.updated. State the code-only/no-live-brand caveat + the #29 mart-projection caveat.` },
]

const connectors = await parallel(
  CONNECTORS.map((c) => () =>
    agent(`${COMMON}\n\nAREA: ${c.key} connector E2E.\n${c.prompt}\n\nReport verdict (blocked_data if honestly empty-by-data, not a code fault). Give exact commands/SQL + outputs as evidence.`,
      { label: `e2e:${c.key}`, phase: 'Connectors', schema: RESULT_SCHEMA, model: 'opus' }),
  ),
)

phase('CrossCutting')

const cross = await parallel([
  () => agent(`${COMMON}\n\nAREA: API PERFORMANCE. Re-verify the perf fix holds. Time the heavy serving endpoints by querying duckdb-serving directly (they're <1s now) AND confirm the serving adapter's single-POST path (grep packages/metric-engine/src/duckdb-serving-adapter.ts — one POST /v1/query per query, no polling) + the serving cache TTL (300000) + gatherFoundationSignals caching (grep bff.routes.ts). POSITIVE — a representative serving query (e.g. COUNT on mv_gold_revenue_ledger for ${BODD}) returns in well under 1s. NEGATIVE/EDGE — the fail-safe serving cache (degrade to direct compute) + BigInt-safe JSON. Report timings + grep evidence.`,
    { label: 'cross:perf', phase: 'CrossCutting', schema: RESULT_SCHEMA, model: 'opus' }),
  () => agent(`${COMMON}\n\nAREA: ATTRIBUTION / journey stitch. The serving-host default fix (stream-worker config default 'localhost' — now the DUCKDB_SERVING_HOST default) unblocked the stitch job. POSITIVE — run pnpm --filter @brain/stream-worker exec tsx --env-file="${REPO}/.env.local-prod" src/jobs/journey-stitch-from-identity.ts and report brands/stitched/errors; confirm it RUNS now (was skipping at duration_ms=0). Then check ops.silver_journey_stitch count + gold_attribution_credit for ${BODD}. EDGE/HONEST — for ${BODD} expect 0 stitches because the 21 pixel-identified anons and the 642 order-customers are DISJOINT (verify: 0 of 21 anon brain_ids appear in mv_gold_revenue_ledger) — this is honest-empty (blocked_data), NOT a code fault; the synthetic demo brands additionally lack provisioned salt (D-2). Prove the chain works mechanically + state the data condition.`,
    { label: 'cross:attribution', phase: 'CrossCutting', schema: RESULT_SCHEMA, model: 'opus' }),
  () => agent(`${COMMON}\n\nAREA: IA redesign + brand-edit + pipeline integrity. POSITIVE — pnpm --filter @brain/web typecheck clean; the 8 nav tabs + customers/[id] route exist; old routes redirect (grep next redirects / the route files). Brand-edit: PATCH /v1/brands/:id threads region_code (grep brand.routes/service/repository) + EditBrandDialog wired. PIPELINE — the latest refresh ran green (read the newest /tmp/v4-refresh-final-*.log: status=ok, failures=0; report the per-phase failures count). NEGATIVE/EDGE — IA uses honest EmptyState (no fabricated data); brand-edit excludes currency/revenue (revenue-truth guard). Report evidence.`,
    { label: 'cross:ia-pipeline', phase: 'CrossCutting', schema: RESULT_SCHEMA, model: 'opus' }),
])

phase('Report')

const report = await agent(
  `You are the delivery lead. Produce the END-TO-END DELIVERY REPORT (markdown) from all gate results. The user requires positive+negative+edge proof before delivery.

SUITES: ${JSON.stringify(suites)}
CONNECTORS: ${JSON.stringify(connectors.filter(Boolean))}
CROSS-CUTTING: ${JSON.stringify(cross.filter(Boolean))}

Produce:
1. **Delivery verdict** — is everything end-to-end working + tested? One line per area: pass / pass_with_caveats / blocked_data, with the single strongest piece of evidence each.
2. **Coverage matrix** — area × {positive, negative, edge} with the proof for each cell.
3. **Honest caveats** — what is proven-with-LIVE-data vs proven-by-TEST vs honestly-empty-by-data (attribution non-overlap; Shopflo/Google no live brand; dev webhook-delivery needs a tunnel) vs deferred-follow-up (#29 mart projection, #19 perf-later, #27 IA backend gaps).
4. **Blockers** — anything that is an actual FAIL (code fault) vs a data/environment condition. Only code faults block delivery.
Write the full report to ${REPO}/docs/architecture/e2e-delivery-report.md. Be rigorous and honest — do NOT overstate green.`,
  { label: 'delivery-report', phase: 'Report', model: 'opus' },
)

return { suites, connectors, cross, report }
