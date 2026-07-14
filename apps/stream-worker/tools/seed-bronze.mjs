#!/usr/bin/env node
/**
 * seed-bronze.mjs — seed a MINIMAL Bronze fixture for the integration live-suite (CI) and local dev.
 *
 * WHY: the DuckDB transform tier (tools/dev/duckdb-refresh.sh) reads the Kafka-Connect-landed Bronze
 * tables (brain_bronze.collector_events_connect via ADR-0010). On a COLD catalog with no events, the
 * keystone silver_collector_event has no brain_bronze.collector_events_connect to read → it never
 * creates the brain_silver namespace → every downstream Silver/Gold job fails with
 * "Namespace brain_silver does not exist" (92 failed jobs). Producing even a handful of collector
 * events breaks that cascade: Connect lands them → the keystone builds brain_silver → the rest of the
 * medallion (namespaces + tables) is created transitively, so the refresh + Trino views succeed.
 *
 * WHAT: produces realistic `order.live.v1` collector envelopes (the exact shape apps/stream-worker's
 * live-order-bronze-wiring.e2e.test.ts uses) to the Bronze-bound Kafka topic, then POLLS Trino over
 * the Iceberg lift view until the events have landed (Kafka Connect commits on a ~30-60s interval).
 *
 * Usage:
 *   KAFKA_BROKERS=localhost:19092 TRINO_URL=http://localhost:8090 node tools/seed-bronze.mjs
 *   (run from apps/stream-worker so `kafkajs` resolves; see the `seed:bronze` package script)
 */
import { Kafka } from 'kafkajs';
import { randomUUID } from 'node:crypto';

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');
const COLLECTOR_TOPIC = process.env.COLLECTOR_TOPIC ?? 'prod.collector.event.v1'; // the connector's subscribed topic
const TRINO_URL =
  process.env.TRINO_URL ?? `http://${process.env.TRINO_HOST ?? 'localhost'}:${process.env.TRINO_PORT ?? '8090'}`;
const TRINO_USER = process.env.TRINO_USER ?? 'brain';
// Poll the RAW Connect-landed table (auto-created by the iceberg-bronze-collector connector), NOT the
// `_lifted` serving view — that view is created LATER by db/trino/views/run-trino-views.sh, so it does
// not exist yet at seed time (polling it silently returns 0 forever).
const BRONZE_TABLE = 'iceberg.brain_bronze.collector_events_connect';
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 180_000);

// Two stable test brands (deterministic UUIDs). The live suites seed their OWN brands; these just
// give the order spine (silver_order_state) + revenue ledger real rows so the marts are non-trivial.
const BRANDS = ['0a000001-0000-4000-8000-000000000001', 'b9f10030-0030-4030-8030-0000000000b2'];

/** Realistic post-mapper Shopify live order (mirrors liveOrderEnvelope in live-order-bronze-wiring.e2e.test.ts). */
function orderEnvelope(brandId, { amountMinor, paymentMethod }) {
  const orderId = String(7_600_000_000_000 + Math.floor(Number(`0x${randomUUID().slice(0, 8)}`) % 1_000_000));
  const now = new Date().toISOString();
  return {
    schema_version: '1',
    event_id: randomUUID(), // brand+event_id is the Silver dedup key — unique per event
    brand_id: brandId, // server-trusted lane (re-pull derives brand_id from the connector row)
    correlation_id: `seed:${randomUUID()}`,
    event_name: 'order.live.v1',
    occurred_at: now,
    ingested_at: now,
    properties: {
      source: 'shopify',
      shopify_order_id: orderId,
      order_id: orderId,
      amount_minor: String(amountMinor),
      currency_code: 'INR',
      payment_method: paymentMethod,
      financial_status: paymentMethod === 'cod' ? 'pending' : 'paid',
      fulfillment_status: null,
      cancelled_at: null,
      storefront_customer_id: String(10_000_000_000_000 + Math.floor(Number(`0x${randomUUID().slice(0, 8)}`) % 1_000_000)),
    },
  };
}

async function produce() {
  const kafka = new Kafka({ clientId: 'ci-bronze-seeder', brokers: KAFKA_BROKERS, retry: { retries: 8 } });
  const producer = kafka.producer();
  await producer.connect();
  const amounts = [729700, 149900, 259900]; // paise; a prepaid + cod mix per brand
  let n = 0;
  for (const brandId of BRANDS) {
    for (let i = 0; i < amounts.length; i++) {
      const env = orderEnvelope(brandId, { amountMinor: amounts[i], paymentMethod: i === 0 ? 'cod' : 'prepaid' });
      await producer.send({
        topic: COLLECTOR_TOPIC,
        messages: [{ key: env.brand_id, value: Buffer.from(JSON.stringify(env)), headers: { event_name: Buffer.from(env.event_name) } }],
      });
      n++;
    }
  }
  await producer.disconnect();
  console.log(`✓ produced ${n} order.live.v1 events to ${COLLECTOR_TOPIC} (${BRANDS.length} brands)`);
  return n;
}

/**
 * Minimal Trino REST client: POST the query, follow nextUri to completion. Returns the COUNT, or
 * null if the table does not exist yet (the connector auto-creates it on its first commit) — so the
 * poller can distinguish "table not created yet" from "table exists, 0 rows".
 */
async function trinoCount() {
  let uri = `${TRINO_URL}/v1/statement`;
  let init = {
    method: 'POST',
    headers: { 'X-Trino-User': TRINO_USER, 'Content-Type': 'text/plain' },
    body: `SELECT COUNT(*) FROM ${BRONZE_TABLE}`,
  };
  let count = null;
  for (let hops = 0; hops < 50; hops++) {
    const resp = await fetch(uri, init);
    if (!resp.ok) throw new Error(`trino HTTP ${resp.status}`);
    const body = await resp.json();
    if (body.error) {
      // TABLE_NOT_FOUND / NoSuchTable while the connector hasn't committed yet → not-ready, poll on.
      const name = body.error.errorName ?? '';
      if (/NOT_FOUND|NoSuch|TABLE_NOT_FOUND/i.test(name) || /does not exist/i.test(body.error.message ?? '')) return null;
      throw new Error(`trino error: ${body.error.message ?? name}`);
    }
    if (Array.isArray(body.data) && body.data.length) count = Number(body.data[0][0]);
    if (!body.nextUri) break;
    uri = body.nextUri;
    init = { method: 'GET', headers: { 'X-Trino-User': TRINO_USER } };
  }
  return count;
}

async function pollUntilLanded(minRows) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  console.log(`polling ${BRONZE_TABLE} over Trino until >= ${minRows} rows (Connect commit ~30-60s)…`);
  while (Date.now() < deadline) {
    let count = null;
    try {
      count = await trinoCount();
    } catch (e) {
      console.log(`  … trino not ready (${e.message})`);
    }
    if (count != null && count >= minRows) {
      console.log(`✓ Bronze landed: ${count} rows in ${BRONZE_TABLE}`);
      return;
    }
    const shown = count == null ? 'table not created yet' : `${count} rows`;
    console.log(`  … ${shown} (${Math.ceil((deadline - Date.now()) / 1000)}s left)`);
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`Bronze did not reach ${minRows} rows within ${POLL_TIMEOUT_MS / 1000}s`);
}

try {
  const produced = await produce();
  await pollUntilLanded(produced);
  console.log('✓ Bronze seeding complete — the DuckDB refresh now has inputs');
  process.exit(0);
} catch (err) {
  console.error(`✗ Bronze seeding failed: ${err?.message ?? err}`);
  process.exit(1);
}
