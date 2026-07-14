// seed-line-item-order.mjs — inject ONE synthetic order.live.v1 carrying properties.line_items
// onto the live collector topic, so it lands in Iceberg Bronze via the real ingest path: the
// compose kafka-connect Iceberg sink (ADR-0010) picks it up automatically and commits it to
// brain_bronze.collector_events_connect within ~30s (the sink's commit interval) — nothing to run.
// This unblocks the order-line reader flip verification (ADR-0002): dev re-pull order.live.v1
// payloads carry NO line_items, so the line-grain mart is empty and the order-line unnest cannot
// be data-verified without a seeded line order.
//
// Reproducible. Run from anywhere:  node tools/seed/seed-line-item-order.mjs
// Then wait ~30s for the kafka-connect sink commit before querying Bronze.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// MK-1..MK-4: seeds must NEVER masquerade as real data and must NEVER run in production.
if ((process.env.APP_ENV ?? 'dev').startsWith('prod')) {
  console.error(`refusing: this script injects a synthetic order and must not run in production (APP_ENV=${process.env.APP_ENV})`);
  process.exit(1);
}

// kafkajs lives in the stream-worker workspace (pnpm, not hoisted) — resolve it from there
// regardless of cwd / this script's location.
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, '../../apps/stream-worker/package.json'));
const { Kafka } = require('kafkajs');

const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const TOPIC = process.env.COLLECTOR_TOPIC ?? 'dev.collector.event.v1';
const BRAND = process.env.BRAND_ID ?? '124e6af5-e6c5-4b85-bf43-7b36fa528101';
const ORDER_ID = process.env.SEED_ORDER_ID ?? 'LINE-TEST-0001';

const eventId = randomUUID();
const now = new Date().toISOString();

// Line-item shape mirrors feat-shopify-order-depth's mapper: minor-unit money as BIGINT strings.
const lineItems = [
  { sku: 'TSHIRT-BLK-M', title: 'Black Tee (M)', quantity: 2, unit_price_minor: '49900',
    line_total_minor: '99800', line_discount_minor: '0', product_id: 'p-1001', variant_id: 'v-2001' },
  { sku: 'CAP-NVY-OS', title: 'Navy Cap', quantity: 1, unit_price_minor: '29900',
    line_total_minor: '24900', line_discount_minor: '5000', product_id: 'p-1002', variant_id: 'v-2002' },
  { sku: 'SOCKS-WHT-L', title: 'White Socks (L)', quantity: 3, unit_price_minor: '9900',
    line_total_minor: '29700', line_discount_minor: '0', product_id: 'p-1003', variant_id: 'v-2003' },
];

const envelope = {
  schema_version: '1',
  event_id: eventId,
  brand_id: BRAND,                         // server-trusted (order.live lane: enforceTenantDerivation=false)
  correlation_id: randomUUID(),
  event_name: 'order.live.v1',
  occurred_at: now,
  ingested_at: now,
  properties: {
    source: 'shopify',
    order_id: ORDER_ID,
    shopify_order_id: ORDER_ID,
    currency_code: 'INR',
    amount_minor: '154400',                // 99800 + 24900 + 29700
    payment_method: 'prepaid',
    financial_status: 'paid',
    fulfillment_status: 'fulfilled',
    line_items: lineItems,
    // MK-1..MK-4: stamp the synthetic flag onto the Bronze envelope so this seeded order is
    // distinguishable from real ingest downstream (mirrors the gokwik jobs' convention).
    processing_flags: { _synthetic: true },
  },
};

const kafka = new Kafka({ clientId: 'seed-line-item-order', brokers: BROKERS });
const producer = kafka.producer();
await producer.connect();
await producer.send({
  topic: TOPIC,
  messages: [{
    key: BRAND,
    value: JSON.stringify(envelope),
    headers: { event_name: 'order.live.v1' },
  }],
});
await producer.disconnect();
console.log(`[seed-line-order] produced order.live.v1 order_id=${ORDER_ID} event_id=${eventId} lines=${lineItems.length} → ${TOPIC}`);
