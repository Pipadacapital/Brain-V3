/**
 * gokwik-awb-repull.e2e.test.ts — real-network synthetic-fixture e2e for the GoKwik AWB
 * trailing-window re-pull + the GokwikAwbLedgerConsumer ledger semantics (05-architecture.md §3).
 *
 * Proves the FULL data path end-to-end with a LABELLED SYNTHETIC fixture (DEV-HONESTY §4):
 *
 *   G1 (restatement + ledger): seed a connected `gokwik` connector + dev_secret + a provisional
 *      CoD recognition for the RTO order → run gokwik-awb-repull (reads the synthetic AWB fixture)
 *      → the WIRED GokwikAwbLedgerConsumer writes cod_delivery_confirmed (Delivered terminal) and
 *      cod_rto_clawback (signed-NEGATIVE, RTO terminal). Proves: enumerate (SECURITY DEFINER, NO
 *      GUC) → GUC-after-enumerate → map (awb hashed at boundary) → restatement-safe per-status
 *      event_id → terminal-state → ledger. A SECOND run is idempotent (no duplicate clawback).
 *
 *   G2 (isolation under brain_app): the brand is resolved ONLY from the connector row via the
 *      SECURITY DEFINER enumeration fn — never from a payload. assertBrainApp() guarantees the
 *      isolation reads run as brain_app (is_superuser=false) — under superuser they'd be INERT.
 *      A second brand with NO gokwik connector sees ZERO cod_* ledger rows (cross-brand isolation).
 *
 * INFRA: Redpanda + Postgres. The GokwikAwbLedgerConsumer is started here (same class as main.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Kafka } from 'kafkajs';
import { LedgerWriter } from '../infrastructure/pg/LedgerWriter.js';
import { GokwikAwbLedgerConsumer } from '../interfaces/consumers/ShipmentLedgerConsumer.js';
import { InMemoryRetryCounter } from './support/InMemoryRetryCounter.js';
import { run as runAwbRepull } from '../jobs/gokwik-awb-repull/run.js';
import { assertBrainApp, seedTestBrand, cleanupConnectorFixtures } from './helpers/connector-lifecycle-fixtures.js';

const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const KAFKA_BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const TOPIC = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';

// Brand A (has a gokwik connector). Brand B (no connector — isolation negative control).
const GK_BRAND_A = 'a0c1c701-0a00-4a00-8a00-00000000a001';
const GK_BRAND_B = 'a0c1c702-0b00-4b00-8b00-00000000b002';
const GK_CI_A = 'a0c1c0c1-0c00-4c00-8c00-00000000c003';
const GK_GROUP = 'gokwik-awb-ledger-e2e';

// The synthetic AWB fixture order ids (must match _fixtures/gokwik-shopflo/gokwik-awb-lifecycle.json).
const ORDER_RTO = 'ord_synth_rto_2';
const ORDER_DELIVERED = 'ord_synth_deliv_1';
// Salt for brand A (64-hex). gokwik-awb-repull reads IDENTITY_SALT_<BRAND_NO_DASHES_UPPER>.
const SALT_A_HEX = 'a'.repeat(64);

// A now-relative AWB fixture (the static committed fixture's fixed dates drift out of the
// 45-day trailing window over wall-clock time). Both orders reach a TERMINAL state within the
// last few days so the re-pull window always includes them. Full transition→terminal lifecycle.
const FIXTURE_TMP_PATH = join(tmpdir(), `gokwik-awb-e2e-${process.pid}.json`);
function daysAgoIso(d: number): string {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}
function writeNowRelativeFixture(): void {
  const records = [
    { awb_number: 'AWB-E2E-DELIV', order_id: ORDER_DELIVERED, status: 'order placed', status_changed_at: daysAgoIso(6), payment_method: 'cod', pincode: '560001' },
    { awb_number: 'AWB-E2E-DELIV', order_id: ORDER_DELIVERED, status: 'in transit', status_changed_at: daysAgoIso(4), payment_method: 'cod', pincode: '560001' },
    { awb_number: 'AWB-E2E-DELIV', order_id: ORDER_DELIVERED, status: 'delivered', status_changed_at: daysAgoIso(2), payment_method: 'cod', pincode: '560001' },
    { awb_number: 'AWB-E2E-RTO', order_id: ORDER_RTO, status: 'order placed', status_changed_at: daysAgoIso(6), payment_method: 'cod', pincode: '110001' },
    { awb_number: 'AWB-E2E-RTO', order_id: ORDER_RTO, status: 'in transit', status_changed_at: daysAgoIso(4), payment_method: 'cod', pincode: '110001' },
    { awb_number: 'AWB-E2E-RTO', order_id: ORDER_RTO, status: 'rto delivered', status_changed_at: daysAgoIso(1), payment_method: 'cod', pincode: '110001' },
  ];
  writeFileSync(FIXTURE_TMP_PATH, JSON.stringify({ _synthetic: true, records }), 'utf8');
}

function tcpReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { sock.destroy(); resolve(true); })
      .once('error', () => { sock.destroy(); resolve(false); })
      .once('timeout', () => { sock.destroy(); resolve(false); })
      .connect(port, host);
  });
}
async function infraUp(): Promise<boolean> {
  const [broker] = KAFKA_BROKERS;
  if (!broker) return false;
  const [h, p] = broker.split(':');
  return (await tcpReachable(h ?? 'localhost', Number(p ?? 9092))) && (await tcpReachable('127.0.0.1', 5432));
}
async function pollUntil<T>(fn: () => Promise<T | null>, pred: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await fn().catch(() => null);
    if (last !== null && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`pollUntil timed out. Last: ${JSON.stringify(last)}`);
}

async function seedGokwikConnector(superPool: Pool): Promise<void> {
  const ref = `brain/connector/gokwik/${GK_BRAND_A}/e2e`;
  await superPool.query(
    `INSERT INTO connector_instance (id, brand_id, provider, status, shop_domain, secret_ref, gokwik_appid)
     VALUES ($1,$2,'gokwik','connected','',$3,$4)
     ON CONFLICT (id) DO UPDATE SET status='connected', provider='gokwik', secret_ref=EXCLUDED.secret_ref, gokwik_appid=EXCLUDED.gokwik_appid`,
    [GK_CI_A, GK_BRAND_A, ref, 'appid_synth'],
  );
  await superPool.query(
    `INSERT INTO connector_sync_status (brand_id, connector_instance_id, state)
     VALUES ($1,$2,'waiting_for_data') ON CONFLICT (brand_id, connector_instance_id) DO UPDATE SET state='waiting_for_data'`,
    [GK_BRAND_A, GK_CI_A],
  );
  await superPool.query(
    `INSERT INTO dev_secret (name, secret_value) VALUES ($1,$2)
     ON CONFLICT (name) DO UPDATE SET secret_value=EXCLUDED.secret_value`,
    [ref, JSON.stringify({ appid: 'appid_synth', appsecret: 'SECRET_SYNTH_DEV' })],
  );
}

/** Seed a provisional CoD recognition so the RTO clawback has something to reverse. */
async function seedRecognition(superPool: Pool, brandId: string, orderId: string, amountMinor: string): Promise<void> {
  const ledgerEventId = `seed-${brandId}-${orderId}`;
  await superPool.query(
    `INSERT INTO realized_revenue_ledger (
       brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code,
       occurred_at, occurred_date, economic_effective_at, billing_posted_period, recognition_label, raw_event_id
     ) VALUES ($1,$2,$3,'provisional_recognition',$4::bigint,'INR',
       '2026-05-01T08:00:00Z',(timezone('UTC','2026-05-01T08:00:00Z'::timestamptz))::date,'2026-05-01T08:00:00Z','2026-05','provisional',$2)
     ON CONFLICT (brand_id, order_id, event_type, occurred_date) WHERE event_type <> 'refund' DO NOTHING`,
    [brandId, ledgerEventId, orderId, amountMinor],
  );
}

async function readCodLedger(appPool: Pool, brandId: string, eventType: string): Promise<{ n: number; sum: string }> {
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    const r = await c.query<{ n: string; s: string }>(
      `SELECT count(*)::text AS n, COALESCE(SUM(amount_minor),0)::text AS s
       FROM realized_revenue_ledger WHERE brand_id=$1 AND event_type=$2`,
      [brandId, eventType],
    );
    await c.query('COMMIT');
    return { n: Number(r.rows[0]!.n), sum: r.rows[0]!.s };
  } finally { c.release(); }
}

let superPool: Pool;
let appPool: Pool;
let kafka: Kafka;
let ledgerWriter: LedgerWriter;
let consumer: GokwikAwbLedgerConsumer;
let infraAvailable = false;

beforeAll(async () => {
  infraAvailable = await infraUp();
  if (!infraAvailable) { console.warn('[gokwik-awb-repull.e2e] SKIP — infra not reachable'); return; }
  process.env['BRAIN_APP_DATABASE_URL'] = BRAIN_APP_DB_URL;
  process.env['KAFKA_BROKERS'] = KAFKA_BROKERS.join(',');
  process.env['COLLECTOR_TOPIC'] = TOPIC;
  process.env['APP_ENV'] = 'dev';
  process.env[`IDENTITY_SALT_${GK_BRAND_A.replace(/-/g, '').toUpperCase()}`] = SALT_A_HEX;
  writeNowRelativeFixture();
  process.env['GOKWIK_AWB_FIXTURE_PATH'] = FIXTURE_TMP_PATH;

  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 3 });
  await seedTestBrand(superPool, GK_BRAND_A, 'INR');
  await seedTestBrand(superPool, GK_BRAND_B, 'INR');
  await superPool.query(`DELETE FROM realized_revenue_ledger WHERE brand_id IN ($1,$2)`, [GK_BRAND_A, GK_BRAND_B]).catch(() => undefined);

  await seedGokwikConnector(superPool);
  // recognized CoD revenue for the RTO order (12345 paisa) — the clawback must reverse it.
  await seedRecognition(superPool, GK_BRAND_A, ORDER_RTO, '12345');
  await seedRecognition(superPool, GK_BRAND_A, ORDER_DELIVERED, '67890');

  kafka = new Kafka({ clientId: 'gokwik-awb-e2e', brokers: KAFKA_BROKERS, logLevel: 0 });
  ledgerWriter = new LedgerWriter(BRAIN_APP_DB_URL);
  consumer = new GokwikAwbLedgerConsumer(kafka, ledgerWriter, TOPIC, GK_GROUP, new InMemoryRetryCounter());
  await consumer.start();
}, 60_000);

afterAll(async () => {
  await consumer?.stop().catch(() => undefined);
  await ledgerWriter?.end().catch(() => undefined);
  await superPool?.query(`DELETE FROM realized_revenue_ledger WHERE brand_id IN ($1,$2)`, [GK_BRAND_A, GK_BRAND_B]).catch(() => undefined);
  await superPool?.query(`DELETE FROM dev_secret WHERE name LIKE $1`, [`brain/connector/gokwik/${GK_BRAND_A}/%`]).catch(() => undefined);
  await cleanupConnectorFixtures(superPool, [GK_BRAND_A, GK_BRAND_B]);
  await appPool?.end().catch(() => undefined);
  await superPool?.end().catch(() => undefined);
  rmSync(FIXTURE_TMP_PATH, { force: true });
}, 30_000);

describe('G1: AWB trailing-window re-pull → terminal RTO/Delivered → CoD ledger (restatement-safe)', () => {
  it('terminal Delivered → cod_delivery_confirmed; terminal RTO → signed-negative cod_rto_clawback; idempotent on re-run', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);   // isolation reads run as brain_app (else INERT)

    // Run 1 — the re-pull reads the synthetic AWB fixture (DEV-HONESTY: data_source=synthetic).
    await runAwbRepull(GK_CI_A);

    // Delivered terminal → cod_delivery_confirmed (0-amount provenance row).
    const deliv = await pollUntil(
      () => readCodLedger(appPool, GK_BRAND_A, 'cod_delivery_confirmed'),
      (v) => v.n >= 1, 40_000,
    );
    expect(deliv.n).toBe(1);

    // RTO terminal → cod_rto_clawback = signed-NEGATIVE recognized amount (-12345).
    const claw = await pollUntil(
      () => readCodLedger(appPool, GK_BRAND_A, 'cod_rto_clawback'),
      (v) => v.n >= 1, 40_000,
    );
    expect(claw.n).toBe(1);
    expect(claw.sum).toBe('-12345');   // reverses the seeded recognition exactly

    // Run 2 — idempotent restatement: re-reading the same terminal transitions writes nothing new.
    await runAwbRepull(GK_CI_A);
    const clawAfter = await pollUntil(
      () => readCodLedger(appPool, GK_BRAND_A, 'cod_rto_clawback'),
      (v) => v.n >= 1, 10_000,
    );
    expect(clawAfter.n).toBe(1);       // still exactly ONE clawback (dedup key held)
    expect(clawAfter.sum).toBe('-12345');
    console.info('[G1] PASS — terminal Delivered/RTO → CoD ledger; clawback=-12345; idempotent re-run');
  }, 120_000);
});

describe('G2: cross-brand isolation (brand resolved from connector row, never payload)', () => {
  it('brand B (no gokwik connector) sees ZERO cod_* ledger rows — verified under brain_app', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);   // MUST run as brain_app or the isolation check is INERT

    // Brand B has no gokwik connector → the enumeration fn never dispatches its brand →
    // no cod_rto_clawback / cod_delivery_confirmed can ever be attributed to it.
    const bClaw = await readCodLedger(appPool, GK_BRAND_B, 'cod_rto_clawback');
    const bDeliv = await readCodLedger(appPool, GK_BRAND_B, 'cod_delivery_confirmed');
    expect(bClaw.n).toBe(0);
    expect(bDeliv.n).toBe(0);
    console.info('[G2] PASS — brand B isolated (no cod_* rows); brand from connector row, not payload');
  }, 30_000);
});
