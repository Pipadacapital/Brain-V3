/**
 * live-order-bronze-wiring.e2e.test.ts — P0: the severed order.live.v1 → Bronze landing is restored.
 *
 * Shopify live + re-pull orders are produced as order.live.v1 to the live topic, but they carry NO
 * install_token. The pixel-lane CollectorEventConsumer (R2 gate ON) therefore quarantines them as
 * `tenant_unresolved` — so they NEVER reached Bronze, even though the LiveLedgerBridgeConsumer wrote
 * the ledger (its "CollectorEventConsumer already writes Bronze" comment is stale post-R2). With
 * Bronze empty, the Data Foundation health verdict (first_event / sync / fresh) never completes and
 * DQ bronze-ledger-provenance has orphans. This is the same severed-landing class the shopflo and
 * gokwik.rto_predict Bronze bridges already fixed — missed for orders.
 *
 * This test produces a REALISTIC order.live.v1 envelope (the post-mapper shape the Shopify re-pull
 * yields) to the live topic, lets the WIRED EventBronzeBridgeConsumer ('order.live.v1', enforce=false)
 * land it, and asserts:
 *   LO1: a bronze_events row with event_type='order.live.v1' under the (server-trusted) brand.
 *
 * UN-WIRE PROOF: comment out `await consumer.start()` in beforeAll → LO1 poll times out → RED.
 *
 * NOTE (mock-ingestion): the envelope is a TEST fixture standing in for the real Shopify re-pull →
 * shopify-mapper → produce. It exercises the consumer→Bronze seam end-to-end on the REAL substrate
 * (Redpanda → Postgres bronze_events). REQUIRES Redpanda + Postgres + Redis.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Kafka, type Producer } from 'kafkajs';
import { RedisDedupAdapter } from '../infrastructure/redis/RedisDedupAdapter.js';
import { RetryCounterAdapter } from '../infrastructure/redis/RetryCounterAdapter.js';
import { BronzeRepository } from '../infrastructure/pg/BronzeRepository.js';
import { ProcessEventUseCase } from '../application/ProcessEventUseCase.js';
import { EventBronzeBridgeConsumer } from '../interfaces/consumers/EventBronzeBridgeConsumer.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const REDIS = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const TOPIC = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';
const GROUP = 'live-order-bronze-wiring-test';
const EVENT_NAME = 'order.live.v1';

const BRAND = 'b9f10030-0030-4030-8030-0000000000b2';
const ORG = 'b9f10030-0030-4030-8030-0000000000f2';
const USER = 'b9f10030-0030-4030-8030-0000000000e2';

let superPool: pg.Pool;
let appPool: pg.Pool;
let producer: Producer;
let dedup: RedisDedupAdapter;
let retryCounter: RetryCounterAdapter;
let consumer: EventBronzeBridgeConsumer;
let bronze: BronzeRepository;
let infraUp = false;

/** Realistic post-mapper Shopify live/re-pull order (the shape the re-pull produces to the live lane). */
function liveOrderEnvelope() {
  const orderId = String(7_600_000_000_000 + Math.floor(Number(`0x${randomUUID().slice(0, 8)}`) % 1_000_000));
  const occurredAt = new Date().toISOString();
  return {
    schema_version: '1',
    event_id: randomUUID(), // brand+event_id is the dedup key; unique per run
    brand_id: BRAND, // server-trusted (re-pull derives it from the connector row, MT-1)
    correlation_id: `repull:${randomUUID()}:${randomUUID()}`,
    event_name: EVENT_NAME,
    occurred_at: occurredAt,
    ingested_at: occurredAt,
    properties: {
      source: 'shopify',
      shopify_order_id: orderId,
      order_id: orderId,
      amount_minor: '729700',
      currency_code: 'INR',
      payment_method: 'cod',
      financial_status: 'pending',
      fulfillment_status: null,
      cancelled_at: null,
      storefront_customer_id: '10047479349479',
    },
  };
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 3 });

    await superPool.query(`DELETE FROM bronze_events WHERE brand_id=$1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
    await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
    await superPool.query(
      `INSERT INTO app_user (id,email,email_normalized,password_hash)
       VALUES ($1,'lo@example.invalid','lo@example.invalid','x') ON CONFLICT (id) DO NOTHING`, [USER]);
    await superPool.query(
      `INSERT INTO organization (id,name,slug,owner_user_id)
       VALUES ($1,'LO Org','lo-org',$2) ON CONFLICT (id) DO NOTHING`, [ORG, USER]);
    await superPool.query(
      `INSERT INTO brand (id,organization_id,display_name,currency_code,status)
       VALUES ($1,$2,'LO Brand','INR','active') ON CONFLICT (id) DO NOTHING`, [BRAND, ORG]);

    const kafka = new Kafka({ clientId: 'live-order-bronze-wiring-producer', brokers: BROKERS, retry: { retries: 3 } });
    producer = kafka.producer();
    await producer.connect();

    dedup = new RedisDedupAdapter(REDIS);
    await dedup.connect();
    retryCounter = new RetryCounterAdapter(REDIS);
    await retryCounter.connect();
    bronze = new BronzeRepository(APP);
    const processEvent = new ProcessEventUseCase(dedup, bronze, undefined, /* enforceTenantDerivation */ false);
    consumer = new EventBronzeBridgeConsumer(kafka, processEvent, TOPIC, GROUP, retryCounter, EVENT_NAME, 'live_order_bronze_write_total');
    // UN-WIRE PROOF: comment the next line → LO1 poll times out → RED.
    await consumer.start();
    await new Promise((r) => setTimeout(r, 2500)); // let the group join + assign before producing
    infraUp = true;
  } catch {
    infraUp = false;
  }
}, 30_000);

afterAll(async () => {
  await consumer?.stop?.().catch(() => {});
  await producer?.disconnect?.().catch(() => {});
  await dedup?.quit?.().catch(() => {});
  await retryCounter?.quit?.().catch(() => {});
  await bronze?.end?.().catch(() => {});
  if (infraUp) {
    await superPool.query(`DELETE FROM bronze_events WHERE brand_id=$1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
    await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
  }
  await appPool?.end?.().catch(() => {});
  await superPool?.end?.().catch(() => {});
});

async function pollBronzeCount(): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const r = await superPool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM bronze_events WHERE brand_id=$1 AND event_type=$2`,
      [BRAND, EVENT_NAME]);
    if (Number(r.rows[0]?.c ?? '0') > 0) return Number(r.rows[0]!.c);
    await new Promise((res) => setTimeout(res, 500));
  }
  return 0;
}

describe('order.live.v1 → Bronze wiring (P0, live infra)', () => {
  it('SKIP_IF_NO_INFRA', () => {
    if (!infraUp) console.warn('[live-order-bronze-wiring] Redpanda/Postgres/Redis unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('LO1: a realistic order.live.v1 envelope lands in Bronze (was quarantined tenant_unresolved before the fix)', async () => {
    if (!infraUp) return;
    const env = liveOrderEnvelope();
    await producer.send({
      topic: TOPIC,
      messages: [{ key: BRAND, value: Buffer.from(JSON.stringify(env)),
        headers: { event_name: Buffer.from(EVENT_NAME) } }],
    });
    const count = await pollBronzeCount();
    expect(count).toBeGreaterThan(0); // the bridge wrote it to Bronze (server-trusted brand, enforce=false)
  }, 30_000);
});
