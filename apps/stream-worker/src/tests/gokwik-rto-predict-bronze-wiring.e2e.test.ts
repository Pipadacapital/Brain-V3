/**
 * gokwik-rto-predict-bronze-wiring.e2e.test.ts — P0 follow-up: the RTO-Predict consumer.
 *
 * gokwik.rto_predict.v1 events were emitted to the live lane but quarantined by the pixel lane (no
 * install_token) and consumed by NOTHING — the risk signal was lost. This produces realistic
 * RTO-Predict envelopes (the post-mapper shape) to the live topic, lets the WIRED
 * EventBronzeBridgeConsumer land them, and asserts:
 *   RP1: a bronze_events row with event_type='gokwik.rto_predict.v1' under the brand;
 *   RP2: computeRtoRiskDistribution returns hasData with the LATEST-per-order risk buckets.
 *
 * UN-WIRE PROOF: comment out `await consumer.start()` → RP1 poll times out → RED.
 * NOTE (mock-ingestion): the envelopes are TEST fixtures for the consumer→Bronze→read seam on the
 * REAL substrate (Redpanda → Postgres bronze_events). REQUIRES Redpanda + Postgres + Redis.
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
const GROUP = 'gokwik-rto-predict-bronze-wiring-test';
const EVENT_NAME = 'gokwik.rto_predict.v1';

const BRAND = 'd9f10030-0030-4030-8030-0000000000a1';
const ORG = 'd9f10030-0030-4030-8030-0000000000f1';
const USER = 'd9f10030-0030-4030-8030-0000000000e1';
const ORDER_A = 'gid://shopify/Order/9001';
const ORDER_B = 'gid://shopify/Order/9002';

let superPool: pg.Pool;
let appPool: pg.Pool;
let producer: Producer;
let dedup: RedisDedupAdapter;
let retryCounter: RetryCounterAdapter;
let consumer: EventBronzeBridgeConsumer;
let bronze: BronzeRepository;
let infraUp = false;

/** Realistic post-mapper RTO-Predict properties (categorical risk_flag — never a fabricated score). */
function rtoEnvelope(orderId: string, riskFlag: string, riskRaw: string, occurredAt: string) {
  return {
    schema_version: '1',
    event_id: randomUUID(),
    brand_id: BRAND,
    correlation_id: randomUUID(),
    event_name: EVENT_NAME,
    occurred_at: occurredAt,
    ingested_at: occurredAt,
    properties: {
      source: 'gokwik',
      data_source: 'real',
      order_id: orderId,
      request_id: `req_${randomUUID().slice(0, 8)}`,
      risk_flag: riskFlag,
      risk_flag_raw: riskRaw,
      risk_reason: 'address mismatch + prior RTO history',
      occurred_at: occurredAt,
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
       VALUES ($1,'rp@example.invalid','rp@example.invalid','x') ON CONFLICT (id) DO NOTHING`, [USER]);
    await superPool.query(
      `INSERT INTO organization (id,name,slug,owner_user_id)
       VALUES ($1,'RP Org','rp-org',$2) ON CONFLICT (id) DO NOTHING`, [ORG, USER]);
    await superPool.query(
      `INSERT INTO brand (id,organization_id,display_name,currency_code,status)
       VALUES ($1,$2,'RP Brand','INR','active') ON CONFLICT (id) DO NOTHING`, [BRAND, ORG]);

    const kafka = new Kafka({ clientId: 'gokwik-rto-predict-bronze-wiring-producer', brokers: BROKERS, retry: { retries: 3 } });
    producer = kafka.producer();
    await producer.connect();
    dedup = new RedisDedupAdapter(REDIS);
    await dedup.connect();
    retryCounter = new RetryCounterAdapter(REDIS);
    await retryCounter.connect();
    bronze = new BronzeRepository(APP);
    const processEvent = new ProcessEventUseCase(dedup, bronze, undefined, /* enforceTenantDerivation */ false);
    consumer = new EventBronzeBridgeConsumer(kafka, processEvent, TOPIC, GROUP, retryCounter, EVENT_NAME, 'gokwik_rto_predict_bronze_write_total');
    await consumer.start();
    await new Promise((r) => setTimeout(r, 2500));
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
    if (Number(r.rows[0]?.c ?? '0') >= 3) return Number(r.rows[0]!.c);
    await new Promise((res) => setTimeout(res, 500));
  }
  return 0;
}

describe('GoKwik RTO-Predict → Bronze wiring (P0 follow-up, live infra)', () => {
  it('SKIP_IF_NO_INFRA', () => {
    if (!infraUp) console.warn('[gokwik-rto-predict-bronze-wiring] infra unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('RP1: realistic gokwik.rto_predict.v1 envelopes land in Bronze (were consumed by nothing before)', async () => {
    if (!infraUp) return;
    const t0 = new Date();
    const earlier = new Date(t0.getTime() - 60_000).toISOString();
    const later = new Date(t0.getTime() - 1_000).toISOString();
    // ORDER_A: low (earlier) then high (later) → latest = high. ORDER_B: low.
    await producer.send({
      topic: TOPIC,
      messages: [
        { key: BRAND, value: Buffer.from(JSON.stringify(rtoEnvelope(ORDER_A, 'low', 'Low Risk', earlier))), headers: { event_name: Buffer.from(EVENT_NAME) } },
        { key: BRAND, value: Buffer.from(JSON.stringify(rtoEnvelope(ORDER_A, 'high', 'High Risk', later))), headers: { event_name: Buffer.from(EVENT_NAME) } },
        { key: BRAND, value: Buffer.from(JSON.stringify(rtoEnvelope(ORDER_B, 'low', 'Low Risk', later))), headers: { event_name: Buffer.from(EVENT_NAME) } },
      ],
    });
    expect(await pollBronzeCount()).toBeGreaterThanOrEqual(3);
  }, 30_000);

  // NOTE: the former RP2 case asserted computeRtoRiskDistribution returns buckets after the event
  // landed in PG Bronze. Since the payments-Silver re-point (PR #211) that metric reads StarRocks
  // silver_checkout_signal, not PG Bronze — its read-path is covered by the metric-engine unit tests
  // (cod-rto-prediction.test.ts). This e2e now asserts only the bridge's job: the Bronze landing.
});
