/**
 * settlement-ledger-wiring.e2e.test.ts — Mandatory E2E wiring test for SettlementLedgerConsumer.
 *
 * MB-4 NON-NEGOTIABLE: this is the CI gate that catches an unwired SettlementLedgerConsumer.
 * This is occurrence #3 of the wired-to-nothing anti-pattern (ORCH-LV-H1 history).
 *
 * WHAT THIS TEST PROVES (that unit tests canNOT):
 *   SW1: produce settlement.live.v1 to Kafka → SettlementLedgerConsumer (wired, running) →
 *        two-hop join → settlement_finalization row in ledger (non-inert proof).
 *   SW2: brand-level settlement (rolling_reserve_release, no order_id) → brand-level row.
 *   SW3: non-settlement event on live lane → skipped (no ledger write).
 *   SW4: idempotency — same settlement event twice → ONE ledger row.
 *   SW5: no-GUC negative control — brain_app direct SELECT on connector_razorpay_order_map
 *        WITHOUT GUC = 0 rows (durable rule: system-job-force-rls-enumeration).
 *   SW6: cross-brand isolation — brand A's map rows invisible under brand B GUC.
 *
 * UN-WIRE PROOF: comment out `await consumer.start()` in beforeAll →
 *   SW1 poll times out → RED in CI. Same as ORCH-LV-H1 root cause.
 *
 * RLS NOTE: all ledger reads + map table reads run under BRAIN_APP_DATABASE_URL
 *   (brain_app, NOBYPASSRLS). assertBrainApp() called at the top of every isolation test.
 *
 * INFRA REQUIRED: Redpanda + Postgres (no Redis needed — settlement path has no Redis dedup).
 *   Start: docker compose up -d redpanda postgres
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { Pool } from 'pg';
import { Kafka, Producer } from 'kafkajs';
import { LedgerWriter } from '../infrastructure/pg/LedgerWriter.js';
import { SettlementLedgerConsumer } from '../interfaces/consumers/SettlementLedgerConsumer.js';
import { CollectorEventV1Schema } from '@brain/contracts';
import {
  uuidV5FromSettlementItem,
  uuidV5FromSettlementSummary,
  SETTLEMENT_LIVE_V1_EVENT_NAME,
} from '@brain/razorpay-mapper';
import {
  seedTestBrand,
  cleanupConnectorFixtures,
  assertBrainApp,
  CONNECTOR_TEST_BRAND_A,
  CONNECTOR_TEST_BRAND_B,
  CONNECTOR_TEST_CI_ID,
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

// Own test brands — distinct from connector-lifecycle fixtures to avoid parallel conflicts
// UUIDv4: hex-only, version=4, variant=8 range
const SW_BRAND_A = 'a7e40001-a700-4a70-8a70-000000000001';
const SW_BRAND_B = 'a7e40002-b700-4b70-8b70-000000000002';
const SW_CI_ID   = 'a7e400c1-c700-4c70-8c70-000000000003';

const SETTLEMENT_WIRING_GROUP = 'settlement-ledger-wiring-test';

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
  throw new Error(`pollUntil timed out after ${timeoutMs}ms. Last: ${JSON.stringify(last)}`);
}

// ── Event builder helpers ─────────────────────────────────────────────────────

function makeSettlementLiveV1Buffer(params: {
  eventId: string;
  brandId: string;
  settlementId: string;
  orderId: string | null;       // razorpay order_XXXX — null for brand_level
  amountMinor: string;
  feeMinor: string;
  taxMinor: string;
  entityType: string;
  reconciliationType: 'per_order' | 'brand_level';
  occurredAt: string;
}): Buffer {
  const envelope = CollectorEventV1Schema.parse({
    schema_version: '1',
    event_id: params.eventId,
    brand_id: params.brandId,
    correlation_id: `sw-wiring-test:${params.eventId}`,
    event_name: SETTLEMENT_LIVE_V1_EVENT_NAME,
    occurred_at: params.occurredAt,
    ingested_at: new Date().toISOString(),
    properties: {
      source: 'razorpay',
      settlement_id: params.settlementId,
      payment_id_hash: null,
      order_id: params.orderId,
      utr_hash: null,
      amount_minor: params.amountMinor,
      fee_minor: params.feeMinor,
      tax_minor: params.taxMinor,
      currency_code: 'INR',
      entity_type: params.entityType,
      status: 'settled',
      settlement_at: params.occurredAt,
      occurred_at: params.occurredAt,
      reconciliation_type: params.reconciliationType,
    },
  });
  return Buffer.from(JSON.stringify(envelope));
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function seedMapRow(
  superPool: Pool,
  brandId: string,
  razorpayOrderId: string,
  shopifyOrderId: string,
  razorpayPaymentId: string,
): Promise<void> {
  await superPool.query(
    `INSERT INTO connector_razorpay_order_map
       (brand_id, razorpay_order_id, shopify_order_id, razorpay_payment_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (brand_id, razorpay_payment_id) DO NOTHING`,
    [brandId, razorpayOrderId, shopifyOrderId, razorpayPaymentId],
  );
}

async function readLedgerRows(
  appPool: Pool,
  brandId: string,
  orderId: string,
  eventType?: string,
): Promise<Array<{ event_type: string; amount_minor: string; reconciliation_type: string | null }>> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    let sql = `SELECT event_type, amount_minor::text, reconciliation_type
               FROM realized_revenue_ledger
               WHERE brand_id = $1 AND order_id = $2`;
    const params: unknown[] = [brandId, orderId];
    if (eventType) {
      sql += ` AND event_type = $3`;
      params.push(eventType);
    }
    const result = await client.query<{
      event_type: string;
      amount_minor: string;
      reconciliation_type: string | null;
    }>(sql, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function readMapRows(
  appPool: Pool,
  brandId: string,
): Promise<Array<{ shopify_order_id: string }>> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    const result = await client.query<{ shopify_order_id: string }>(
      `SELECT shopify_order_id FROM connector_razorpay_order_map WHERE brand_id = $1`,
      [brandId],
    );
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
let mapPool: Pool;
let kafka: Kafka;
let producer: Producer;
let ledgerWriter: LedgerWriter;
let consumer: SettlementLedgerConsumer;
let infraAvailable = false;

beforeAll(async () => {
  infraAvailable = await infraUp();
  if (!infraAvailable) {
    console.warn('[settlement-ledger-wiring.e2e] SKIP — Redpanda or Postgres not reachable');
    return;
  }

  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 3 });
  mapPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 3 });

  // Seed test brands (needed for ledger_currency_matches_brand trigger + FK constraints)
  await seedTestBrand(superPool, SW_BRAND_A, 'INR');
  await seedTestBrand(superPool, SW_BRAND_B, 'INR');

  // Clean up any leftover rows from prior runs
  await superPool.query(`DELETE FROM realized_revenue_ledger WHERE brand_id IN ($1, $2)`, [SW_BRAND_A, SW_BRAND_B]).catch(() => undefined);
  await superPool.query(`DELETE FROM connector_razorpay_order_map WHERE brand_id IN ($1, $2)`, [SW_BRAND_A, SW_BRAND_B]).catch(() => undefined);

  // Kafka producer
  kafka = new Kafka({
    clientId: 'settlement-ledger-wiring-test-producer',
    brokers: KAFKA_BROKERS,
    logLevel: 0,
    retry: { retries: 3 },
  });
  producer = kafka.producer();
  await producer.connect();

  // SettlementLedgerConsumer — the SAME class wired in main.ts (MB-4).
  // Test-specific consumer group so offsets are independent of production groups.
  ledgerWriter = new LedgerWriter(BRAIN_APP_DB_URL);
  consumer = new SettlementLedgerConsumer(kafka, ledgerWriter, mapPool, TOPIC, SETTLEMENT_WIRING_GROUP);

  // UN-WIRE TEST: comment out `await consumer.start()` → SW1/SW2 poll will time out → RED.
  await consumer.start();

  console.info('[settlement-ledger-wiring.e2e] SettlementLedgerConsumer started on topic=%s group=%s', TOPIC, SETTLEMENT_WIRING_GROUP);
}, 30_000);

afterAll(async () => {
  await consumer?.stop().catch(() => undefined);
  await producer?.disconnect().catch(() => undefined);
  await ledgerWriter?.end().catch(() => undefined);

  await superPool?.query(`DELETE FROM realized_revenue_ledger WHERE brand_id IN ($1, $2)`, [SW_BRAND_A, SW_BRAND_B]).catch(() => undefined);
  await superPool?.query(`DELETE FROM connector_razorpay_order_map WHERE brand_id IN ($1, $2)`, [SW_BRAND_A, SW_BRAND_B]).catch(() => undefined);
  await cleanupConnectorFixtures(superPool, [SW_BRAND_A, SW_BRAND_B]);

  await mapPool?.end().catch(() => undefined);
  await appPool?.end().catch(() => undefined);
  await superPool?.end().catch(() => undefined);
}, 30_000);

// ── SW1: per-order settlement → settlement_finalization + fee + GST rows ──────

describe('SW1: settlement.live.v1 per-order → finalization + fee + GST rows (WIRED consumer)', () => {
  it(
    'produces settlement.live.v1 to Kafka; wired consumer writes finalization+fee+tax rows',
    async () => {
      if (!infraAvailable) return;

      await assertBrainApp(appPool);

      const settlementId = `setl_SW1Test${Date.now()}`;
      const razorpayOrderId = `order_SW1Order${Date.now()}`;
      const shopifyOrderId = `sw1-shopify-order-${Date.now()}`;
      const occurredAt = new Date().toISOString();

      // Seed the map row so the two-hop join resolves
      await seedMapRow(superPool, SW_BRAND_A, razorpayOrderId, shopifyOrderId, `pay_SW1Pay${Date.now()}`);

      const eventId = uuidV5FromSettlementItem(SW_BRAND_A, settlementId, `pay_SW1`, 'payment');

      const buf = makeSettlementLiveV1Buffer({
        eventId,
        brandId: SW_BRAND_A,
        settlementId,
        orderId: razorpayOrderId,
        amountMinor: '97640',   // settled_amount
        feeMinor: '2000',       // MDR
        taxMinor: '360',        // GST_18 on MDR
        entityType: 'payment',
        reconciliationType: 'per_order',
        occurredAt,
      });

      await producer.send({ topic: TOPIC, messages: [{ key: SW_BRAND_A, value: buf }] });

      console.info('[SW1] event produced — polling for settlement_finalization ledger row...');

      // Poll for settlement_finalization row (provisional sale row UNTOUCHED)
      const rows = await pollUntil(
        () => readLedgerRows(appPool, SW_BRAND_A, shopifyOrderId, 'settlement_finalization'),
        (r) => r.length > 0,
        30_000,
        400,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.event_type).toBe('settlement_finalization');
      expect(rows[0]!.amount_minor).toBe('97640');
      expect(rows[0]!.reconciliation_type).toBe('per_order');

      // Also assert fee row was written (payment_fee, negative)
      const feeRows = await readLedgerRows(appPool, SW_BRAND_A, shopifyOrderId, 'payment_fee');
      expect(feeRows.length).toBeGreaterThan(0);
      expect(Number(feeRows[0]!.amount_minor)).toBe(-2000);

      // Also assert GST row was written (settlement_tax, negative, SEPARATE from fee)
      const taxRows = await readLedgerRows(appPool, SW_BRAND_A, shopifyOrderId, 'settlement_tax');
      expect(taxRows.length).toBeGreaterThan(0);
      expect(Number(taxRows[0]!.amount_minor)).toBe(-360);

      console.info('[SW1] PASS — finalization+fee+tax rows written via wired SettlementLedgerConsumer');
    },
    40_000,
  );
});

// ── SW2: brand-level settlement (reserve_release, no order_id) ────────────────

describe('SW2: brand-level settlement.live.v1 → rolling_reserve_release ledger row', () => {
  it(
    'produces brand-level event (no order_id) → brand-level row with synthetic order_id',
    async () => {
      if (!infraAvailable) return;

      await assertBrainApp(appPool);

      const settlementId = `setl_SW2Reserve${Date.now()}`;
      const eventId = uuidV5FromSettlementSummary(SW_BRAND_A, settlementId);
      const occurredAt = new Date().toISOString();
      const syntheticOrderId = `__brand_level__:${settlementId}`;

      const buf = makeSettlementLiveV1Buffer({
        eventId,
        brandId: SW_BRAND_A,
        settlementId,
        orderId: null,            // no order_id — brand-level
        amountMinor: '50000',     // reserve release (positive)
        feeMinor: '0',
        taxMinor: '0',
        entityType: 'adjustment',
        reconciliationType: 'brand_level',
        occurredAt,
      });

      await producer.send({ topic: TOPIC, messages: [{ key: SW_BRAND_A, value: buf }] });

      console.info('[SW2] brand-level event produced — polling for brand-level ledger row...');

      // Poll for brand-level settlement row
      const rows = await pollUntil(
        () => readLedgerRows(appPool, SW_BRAND_A, syntheticOrderId),
        (r) => r.length > 0,
        30_000,
        400,
      );

      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.reconciliation_type).toBe('brand_level');

      console.info('[SW2] PASS — brand-level settlement row written without order join');
    },
    40_000,
  );
});

// ── SW3: non-settlement event → skipped, no ledger write ──────────────────────

describe('SW3: non-settlement event on live lane → consumer skips, no ledger row', () => {
  it(
    'produces page.viewed event → SettlementLedgerConsumer skips (event_name filter)',
    async () => {
      if (!infraAvailable) return;

      await assertBrainApp(appPool);

      const skipOrderId = `SW3-SKIP-${Date.now()}`;
      const nonSettlementEnvelope = CollectorEventV1Schema.parse({
        schema_version: '1',
        event_id: crypto.randomUUID(),
        brand_id: SW_BRAND_A,
        correlation_id: `sw3-skip:${Date.now()}`,
        event_name: 'page.viewed',   // NOT settlement.live.v1
        occurred_at: new Date().toISOString(),
        ingested_at: new Date().toISOString(),
        properties: {
          source: 'shopify',
          page: 'home',
          order_id: skipOrderId,
          amount_minor: '99999',
          currency_code: 'INR',
        },
      });

      await producer.send({
        topic: TOPIC,
        messages: [{ key: SW_BRAND_A, value: Buffer.from(JSON.stringify(nonSettlementEnvelope)) }],
      });

      // Wait for consumer poll interval
      await new Promise((r) => setTimeout(r, 5_000));

      const rows = await readLedgerRows(appPool, SW_BRAND_A, skipOrderId);
      expect(rows).toHaveLength(0);

      console.info('[SW3] PASS — non-settlement event correctly skipped');
    },
    20_000,
  );
});

// ── SW4: idempotency — same settlement event twice → ONE ledger row ────────────

describe('SW4: idempotency — same settlement.live.v1 twice → exactly ONE settlement_finalization row', () => {
  it(
    'delivers same event twice; ON CONFLICT DO NOTHING → exactly 1 finalization row',
    async () => {
      if (!infraAvailable) return;

      await assertBrainApp(appPool);

      const settlementId = `setl_SW4Dedup${Date.now()}`;
      const razorpayOrderId = `order_SW4Order${Date.now()}`;
      const shopifyOrderId = `sw4-shopify-order-${Date.now()}`;
      const occurredAt = new Date().toISOString();

      await seedMapRow(superPool, SW_BRAND_A, razorpayOrderId, shopifyOrderId, `pay_SW4Pay${Date.now()}`);

      const eventId = uuidV5FromSettlementItem(SW_BRAND_A, settlementId, 'pay_SW4', 'payment');
      const buf = makeSettlementLiveV1Buffer({
        eventId,
        brandId: SW_BRAND_A,
        settlementId,
        orderId: razorpayOrderId,
        amountMinor: '50000',
        feeMinor: '1000',
        taxMinor: '180',
        entityType: 'payment',
        reconciliationType: 'per_order',
        occurredAt,
      });

      // Produce SAME event twice (at-least-once re-delivery simulation)
      await producer.send({
        topic: TOPIC,
        messages: [
          { key: SW_BRAND_A, value: buf },
          { key: SW_BRAND_A, value: buf },  // duplicate
        ],
      });

      // Poll until at least one settlement_finalization row appears
      await pollUntil(
        () => readLedgerRows(appPool, SW_BRAND_A, shopifyOrderId, 'settlement_finalization'),
        (r) => r.length > 0,
        30_000,
        400,
      );

      // Wait extra to allow any spurious second write
      await new Promise((r) => setTimeout(r, 3_000));

      const rows = await readLedgerRows(appPool, SW_BRAND_A, shopifyOrderId, 'settlement_finalization');
      expect(rows).toHaveLength(1);   // exactly ONE despite duplicate delivery

      console.info('[SW4] PASS — ON CONFLICT DO NOTHING: exactly 1 row for duplicate settlement delivery');
    },
    40_000,
  );
});

// ── SW5: no-GUC negative control (durable rule: system-job-force-rls-enumeration) ─
//
// Postgres RLS policy: brand_id = current_setting('app.current_brand_id', TRUE)::uuid
// When no GUC is set, current_setting(..., TRUE) returns '' (empty string).
// Casting '' to uuid throws error code 22P02 (invalid_text_representation).
// This is the FAIL-CLOSED behavior: brain_app CANNOT read any row without a valid
// brand GUC set. The error, not 0-rows, IS the security guarantee here.
// In production, brain_app always calls set_config('app.current_brand_id', brandId, ...)
// before any query; missing GUC is a programming error caught at the DB layer.

describe('SW5: no-GUC negative control — brain_app direct SELECT without GUC throws (FORCE RLS fail-closed)', () => {
  it(
    'brain_app SELECT on connector_razorpay_order_map without GUC throws uuid cast error (FORCE RLS fail-closed)',
    async () => {
      if (!infraAvailable) return;

      await assertBrainApp(appPool);

      // Seed a map row for SW_BRAND_A (via superuser — bypasses RLS)
      await seedMapRow(superPool, SW_BRAND_A, 'order_SW5Test', 'shopify_SW5', 'pay_SW5Pay123456789');

      // Direct SELECT under brain_app WITHOUT setting the GUC.
      // FORCE RLS evaluates: brand_id = current_setting('app.current_brand_id', TRUE)::uuid
      // current_setting returns '' (empty string) → ''::uuid → 22P02 error.
      // This is the fail-closed guarantee: no row leaks, query errors immediately.
      let threw = false;
      let errorCode: string | undefined;
      try {
        await appPool.query(
          `SELECT count(*) AS cnt FROM connector_razorpay_order_map`,
        );
      } catch (err: unknown) {
        threw = true;
        errorCode = (err as { code?: string }).code;
      }

      // ASSERT: query MUST throw — fail-closed, not silently returning 0
      expect(threw).toBe(true);
      // PostgreSQL error 22P02 = invalid_text_representation (''::uuid cast failure)
      expect(errorCode).toBe('22P02');

      console.info('[SW5] PASS — FORCE RLS + no GUC throws 22P02 (fail-closed, uuid cast error)');
    },
    15_000,
  );
});

// ── SW6: cross-brand isolation ────────────────────────────────────────────────

describe('SW6: cross-brand isolation — brand B GUC cannot see brand A map rows', () => {
  it(
    'brand_A map row invisible under brand_B GUC (FORCE RLS two-arg fail-closed)',
    async () => {
      if (!infraAvailable) return;

      await assertBrainApp(appPool);

      // Seed a map row for SW_BRAND_A
      await seedMapRow(superPool, SW_BRAND_A, 'order_SW6Test', 'shopify_SW6', 'pay_SW6Brand_A_Pay12');

      // Read under brand B GUC → should return 0 rows (brand A's data invisible)
      const brandBRows = await readMapRows(appPool, SW_BRAND_B);
      expect(brandBRows).toHaveLength(0);

      // Read under brand A GUC → should return >=1 row (brand A can see its own data)
      const brandARows = await readMapRows(appPool, SW_BRAND_A);
      expect(brandARows.length).toBeGreaterThan(0);

      console.info('[SW6] PASS — cross-brand isolation: brand B sees 0 of brand A map rows');
    },
    15_000,
  );
});
