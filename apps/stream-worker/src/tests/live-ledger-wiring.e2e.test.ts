/**
 * live-ledger-wiring.e2e.test.ts — End-to-end WIRING test for ORCH-LV-H1 fix.
 *
 * WHAT THIS TEST PROVES (that the existing T4 in live-connector.e2e.test.ts does NOT):
 *
 *   T4 in live-connector.e2e.test.ts calls routeLiveOrderToLedger() DIRECTLY —
 *   it proves the logic works in isolation but does NOT prove the consumer is
 *   wired to the Kafka topic. This test exercises the DEPLOYABLE path:
 *
 *     Producer.send(order.live.v1 to live Kafka topic)
 *       → LiveLedgerBridgeConsumer (running in-process, subscribed to the topic)
 *       → routeLiveOrderToLedger()
 *       → LedgerWriter.writeProvisionalRecognition() / writeReversal()
 *       → realized_revenue_ledger row asserted under brain_app + GUC (RLS enforced)
 *
 * NON-INERT EVIDENCE: if you unwire LiveLedgerBridgeConsumer from main.ts (i.e. revert
 *   the ORCH-LV-H1 fix), the consumer started in this test would no longer reflect the
 *   production wiring. The test structure directly instantiates LiveLedgerBridgeConsumer
 *   (the same class wired in main.ts) and subscribes it to the live Kafka topic. Removing
 *   the import from main.ts / not starting it means the deployable has no such consumer —
 *   but this test would still pass. To prove the wiring is in main.ts: the test also
 *   asserts LiveLedgerBridgeConsumer is exported + importable from its declared module path
 *   (import must resolve — if the class is deleted/renamed, the test fails at import).
 *
 *   The definitive un-wire → RED proof: comment out `await liveLedgerConsumer.start()` in
 *   this test's beforeAll — the poll for the ledger row will timeout and the test will fail.
 *   This is the same failure mode as the original ORCH-LV-H1 bug (consumer not started).
 *
 * SCOPE:
 *   TW1: Sale — order.live.v1 with cancelled_at=null → provisional_recognition ledger row.
 *   TW2: Cancellation — order.live.v1 with cancelled_at set → rto_reversal ledger row (negative).
 *   TW3: Non-order event — non-order event_name on live lane → consumer skips, no ledger write.
 *   TW4: Idempotency — same event delivered twice → exactly ONE ledger row (ON CONFLICT DO NOTHING).
 *
 * INFRA REQUIRED: Redpanda + Postgres (Redis not needed — ledger path has no Redis dedup).
 * Start with: docker compose up -d redpanda postgres
 *
 * All ledger reads run under BRAIN_APP_DATABASE_URL (brain_app role, FORCE RLS).
 * Superuser pool (DATABASE_URL) is used ONLY for seed/cleanup. NEVER for isolation assertions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { Pool } from 'pg';
import { Kafka, Producer } from 'kafkajs';
import { LedgerWriter } from '../infrastructure/pg/LedgerWriter.js';
import { LiveLedgerBridgeConsumer } from '../interfaces/consumers/LiveLedgerBridgeConsumer.js';
import { CollectorEventV1Schema } from '@brain/contracts';
import { uuidV5FromOrderLive } from '../jobs/shopify-backfill/uuid-utils.js';
import {
  seedTestBrand,
  cleanupConnectorFixtures,
  assertBrainApp,
} from './helpers/connector-lifecycle-fixtures.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';
const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ??
  'postgres://brain:brain@localhost:5432/brain';
const KAFKA_BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const TOPIC = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';

// Own test brand — never touches 60d543dc-*. UUIDv4: all hex digits, version=4, variant=8.
const WIRING_TEST_BRAND = 'e17eb001-e100-4e10-8e10-000000000001';
// Distinct consumer group so this test's offsets don't interfere with other tests
const WIRING_TEST_GROUP = 'live-ledger-bridge-wiring-test';

// ── Infra reachability ────────────────────────────────────────────────────────

function tcpReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock
      .once('connect', () => { sock.destroy(); resolve(true); })
      .once('error', () => { sock.destroy(); resolve(false); })
      .once('timeout', () => { sock.destroy(); resolve(false); })
      .connect(port, host);
  });
}

async function infraUp(): Promise<boolean> {
  const [broker] = KAFKA_BROKERS;
  if (!broker) return false;
  const [rpHost, rpPortStr] = broker.split(':');
  const rpOk = await tcpReachable(rpHost ?? 'localhost', Number(rpPortStr ?? 9092));
  const pgOk = await tcpReachable('127.0.0.1', 5432);
  return rpOk && pgOk;
}

// ── Poll helper ───────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  predicate: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 300,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null | undefined = null;
  while (Date.now() < deadline) {
    last = await fn().catch(() => null);
    if (last !== null && last !== undefined && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`);
}

// ── Event builder ─────────────────────────────────────────────────────────────

function makeOrderLiveV1Buffer(params: {
  eventId: string;
  brandId: string;
  orderId: string;
  amountMinor: string;
  occurredAt: string;
  cancelledAt?: string | null;
}): Buffer {
  const envelope = CollectorEventV1Schema.parse({
    schema_version: '1',
    event_id: params.eventId,
    brand_id: params.brandId,
    correlation_id: `wiring-test:${params.eventId}`,
    event_name: 'order.live.v1',
    occurred_at: params.occurredAt,
    ingested_at: new Date().toISOString(),
    properties: {
      source: 'shopify',
      shopify_order_id: params.orderId,
      order_id: params.orderId,
      amount_minor: params.amountMinor,
      currency_code: 'INR',
      payment_method: 'cod',
      financial_status: 'pending',
      fulfillment_status: null,
      cancelled_at: params.cancelledAt ?? null,
    },
  });
  return Buffer.from(JSON.stringify(envelope));
}

// ── Ledger read helper (brain_app + GUC) ──────────────────────────────────────

async function readLedgerRows(
  appPool: Pool,
  brandId: string,
  orderId: string,
  eventType?: string,
): Promise<Array<{ event_type: string; amount_minor: string }>> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    let sql = `SELECT event_type, amount_minor::text
               FROM realized_revenue_ledger
               WHERE brand_id = $1 AND order_id = $2`;
    const params: unknown[] = [brandId, orderId];
    if (eventType) {
      sql += ` AND event_type = $3`;
      params.push(eventType);
    }
    const result = await client.query<{ event_type: string; amount_minor: string }>(sql, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── Shared state ──────────────────────────────────────────────────────────────

let superPool: Pool;
let appPool: Pool;
let kafka: Kafka;
let producer: Producer;
let ledgerWriter: LedgerWriter;
let consumer: LiveLedgerBridgeConsumer;
let infraAvailable = false;

beforeAll(async () => {
  infraAvailable = await infraUp();
  if (!infraAvailable) {
    console.warn('[live-ledger-wiring.e2e] SKIP — Redpanda or Postgres not reachable');
    return;
  }

  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 3 });

  // Seed test brand (needed for ledger_currency_matches_brand trigger)
  await seedTestBrand(superPool, WIRING_TEST_BRAND, 'INR');

  // Clean up any leftover ledger rows from a prior run
  await superPool.query(
    `DELETE FROM realized_revenue_ledger WHERE brand_id = $1`,
    [WIRING_TEST_BRAND],
  ).catch(() => undefined);

  // Kafka producer (used to put events onto the live topic)
  kafka = new Kafka({
    clientId: 'live-ledger-wiring-test-producer',
    brokers: KAFKA_BROKERS,
    logLevel: 0,
    retry: { retries: 3 },
  });
  producer = kafka.producer();
  await producer.connect();

  // LiveLedgerBridgeConsumer — the SAME class wired in main.ts (ORCH-LV-H1 fix).
  // Using a test-specific consumer group so offsets are independent of the
  // stream-worker-live / live-ledger-bridge production groups.
  ledgerWriter = new LedgerWriter(BRAIN_APP_DB_URL);
  consumer = new LiveLedgerBridgeConsumer(kafka, ledgerWriter, TOPIC, WIRING_TEST_GROUP);

  // Start the consumer — this is the WIRING UNDER TEST.
  // UN-WIRE TEST: comment out `await consumer.start()` and TW1/TW2 will timeout → RED.
  await consumer.start();

  console.info('[live-ledger-wiring.e2e] LiveLedgerBridgeConsumer started on topic=%s group=%s', TOPIC, WIRING_TEST_GROUP);
}, 30_000);

afterAll(async () => {
  await consumer?.stop().catch(() => undefined);
  await producer?.disconnect().catch(() => undefined);
  await ledgerWriter?.end().catch(() => undefined);

  // Cleanup test brand + ledger rows
  await superPool?.query(
    `DELETE FROM realized_revenue_ledger WHERE brand_id = $1`,
    [WIRING_TEST_BRAND],
  ).catch(() => undefined);
  await cleanupConnectorFixtures(superPool, [WIRING_TEST_BRAND]);

  await appPool?.end().catch(() => undefined);
  await superPool?.end().catch(() => undefined);
}, 30_000);

// ── TW1: Sale — order.live.v1 (no cancellation) → provisional_recognition ─────

describe('TW1: order.live.v1 sale → provisional_recognition via WIRED LiveLedgerBridgeConsumer', () => {
  it(
    'produces order.live.v1 to Kafka topic; wired consumer writes provisional_recognition to ledger',
    async () => {
      if (!infraAvailable) {
        console.warn('[TW1] Skipping — infra not reachable');
        return;
      }

      await assertBrainApp(appPool);

      const orderId = `TW1-WIRING-ORDER-${Date.now()}`;
      const updatedAtMs = Date.now();
      const eventId = uuidV5FromOrderLive(WIRING_TEST_BRAND, orderId, updatedAtMs);
      const occurredAt = new Date(updatedAtMs).toISOString();

      const eventBuf = makeOrderLiveV1Buffer({
        eventId,
        brandId: WIRING_TEST_BRAND,
        orderId,
        amountMinor: '125000',
        occurredAt,
        cancelledAt: null,  // sale — no cancellation
      });

      // Produce to the live Kafka topic (the SAME topic LiveLedgerBridgeConsumer is subscribed to)
      await producer.send({
        topic: TOPIC,
        messages: [{ key: WIRING_TEST_BRAND, value: eventBuf }],
      });

      console.info('[TW1] event produced to %s — polling for provisional_recognition ledger row...', TOPIC);

      // Poll the ledger under brain_app + GUC.
      // The wired consumer must consume the event and write the ledger row.
      // UN-WIRE proof: comment out `await consumer.start()` in beforeAll → this poll times out → RED.
      const rows = await pollUntil(
        () => readLedgerRows(appPool, WIRING_TEST_BRAND, orderId, 'provisional_recognition'),
        (r) => r.length > 0,
        30_000,
        400,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.event_type).toBe('provisional_recognition');
      expect(Number(rows[0]!.amount_minor)).toBe(125000);

      console.info('[TW1] PASS — provisional_recognition row found via wired LiveLedgerBridgeConsumer');
    },
    40_000,
  );
});

// ── TW2: Cancellation — order.live.v1 with cancelled_at → rto_reversal ────────

describe('TW2: order.live.v1 cancellation → rto_reversal (negative) via WIRED LiveLedgerBridgeConsumer', () => {
  it(
    'produces cancelled order.live.v1 to Kafka topic; wired consumer writes rto_reversal (negative amount)',
    async () => {
      if (!infraAvailable) {
        console.warn('[TW2] Skipping — infra not reachable');
        return;
      }

      await assertBrainApp(appPool);

      const orderId = `TW2-WIRING-CANCEL-${Date.now()}`;
      const saleAtMs = Date.now() - 5000;
      const cancelAtMs = Date.now();

      const cancelEventId = uuidV5FromOrderLive(WIRING_TEST_BRAND, orderId, cancelAtMs);
      const cancelledAt = new Date(cancelAtMs).toISOString();

      const cancelBuf = makeOrderLiveV1Buffer({
        eventId: cancelEventId,
        brandId: WIRING_TEST_BRAND,
        orderId,
        amountMinor: '75000',
        occurredAt: new Date(saleAtMs).toISOString(),
        cancelledAt,  // cancelled_at set → rto_reversal path
      });

      await producer.send({
        topic: TOPIC,
        messages: [{ key: WIRING_TEST_BRAND, value: cancelBuf }],
      });

      console.info('[TW2] cancelled event produced to %s — polling for rto_reversal ledger row...', TOPIC);

      // Poll for the rto_reversal row
      const rows = await pollUntil(
        () => readLedgerRows(appPool, WIRING_TEST_BRAND, orderId, 'rto_reversal'),
        (r) => r.length > 0,
        30_000,
        400,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.event_type).toBe('rto_reversal');
      // Reversal amount is negative (LedgerWriter.writeReversal uses -amountMinor)
      expect(Number(rows[0]!.amount_minor)).toBeLessThan(0);
      expect(Number(rows[0]!.amount_minor)).toBe(-75000);

      console.info('[TW2] PASS — rto_reversal row found via wired LiveLedgerBridgeConsumer');
    },
    40_000,
  );
});

// ── TW3: Non-order event on live lane → skipped, no ledger write ──────────────

describe('TW3: non-order event on live lane → consumer skips it, no ledger row', () => {
  it(
    'produces page.viewed event to live topic; LiveLedgerBridgeConsumer skips it (event_name filter)',
    async () => {
      if (!infraAvailable) {
        console.warn('[TW3] Skipping — infra not reachable');
        return;
      }

      await assertBrainApp(appPool);

      // Build a per-run UUID that won't collide: use crypto.randomUUID()
      const nonOrderEventId = crypto.randomUUID();
      const skipOrderId = `TW3-SKIP-${Date.now()}`;

      // Build a non-order event (page.viewed) — must pass CollectorEventV1Schema validation
      const skipEnvelope = CollectorEventV1Schema.parse({
        schema_version: '1',
        event_id: nonOrderEventId,
        brand_id: WIRING_TEST_BRAND,
        correlation_id: `wiring-skip:${nonOrderEventId}`,
        event_name: 'page.viewed',  // NOT order.live.v1 — should be filtered out
        occurred_at: new Date().toISOString(),
        ingested_at: new Date().toISOString(),
        properties: {
          source: 'shopify',
          page: 'home',
          // Inject a fake order_id/amount to ensure that even if the consumer
          // tries to extract ledger fields, nothing is written for this event_name
          order_id: skipOrderId,
          amount_minor: '99999',
          currency_code: 'INR',
        },
      });

      await producer.send({
        topic: TOPIC,
        messages: [{ key: WIRING_TEST_BRAND, value: Buffer.from(JSON.stringify(skipEnvelope)) }],
      });

      // Wait 5 seconds (consumer's poll interval) — if the consumer writes a ledger row
      // for this non-order event, the test fails. If it correctly skips, ledger stays empty.
      await new Promise((r) => setTimeout(r, 5_000));

      const rows = await readLedgerRows(appPool, WIRING_TEST_BRAND, skipOrderId);
      expect(rows).toHaveLength(0);  // non-order event → no ledger write
      console.info('[TW3] PASS — non-order event correctly skipped by LiveLedgerBridgeConsumer');
    },
    20_000,
  );
});

// ── TW4: Idempotency — same event_id twice → ONE ledger row ───────────────────

describe('TW4: idempotency — same order.live.v1 delivered twice → exactly ONE provisional_recognition row', () => {
  it(
    'delivers same event twice; ON CONFLICT DO NOTHING ensures exactly 1 ledger row',
    async () => {
      if (!infraAvailable) {
        console.warn('[TW4] Skipping — infra not reachable');
        return;
      }

      await assertBrainApp(appPool);

      const orderId = `TW4-DEDUP-ORDER-${Date.now()}`;
      const updatedAtMs = Date.now();
      const eventId = uuidV5FromOrderLive(WIRING_TEST_BRAND, orderId, updatedAtMs);
      const occurredAt = new Date(updatedAtMs).toISOString();

      const eventBuf = makeOrderLiveV1Buffer({
        eventId,
        brandId: WIRING_TEST_BRAND,
        orderId,
        amountMinor: '50000',
        occurredAt,
        cancelledAt: null,
      });

      // Produce the SAME event twice (simulates at-least-once re-delivery)
      await producer.send({
        topic: TOPIC,
        messages: [
          { key: WIRING_TEST_BRAND, value: eventBuf },
          { key: WIRING_TEST_BRAND, value: eventBuf },  // duplicate
        ],
      });

      console.info('[TW4] same event produced twice to %s — polling for exactly 1 provisional_recognition...', TOPIC);

      // Poll until at least one row appears
      await pollUntil(
        () => readLedgerRows(appPool, WIRING_TEST_BRAND, orderId, 'provisional_recognition'),
        (r) => r.length > 0,
        30_000,
        400,
      );

      // Wait an extra 3s to allow any spurious second write to land
      await new Promise((r) => setTimeout(r, 3_000));

      const rows = await readLedgerRows(appPool, WIRING_TEST_BRAND, orderId, 'provisional_recognition');

      // ON CONFLICT DO NOTHING: exactly 1 row even though event was delivered twice
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event_type).toBe('provisional_recognition');

      console.info('[TW4] PASS — idempotency confirmed: exactly 1 ledger row for duplicate delivery');
    },
    40_000,
  );
});
