/**
 * spend-ledger-wiring.e2e.test.ts — Mandatory E2E + isolation suite for feat-ad-connectors Slice 1.
 *
 * NON-NEGOTIABLE: this is the CI gate that catches an unwired SpendLedgerConsumer
 * (the wired-to-nothing anti-pattern). Un-wire `await consumer.start()` in beforeAll →
 * AD1 poll times out → RED in CI.
 *
 * WHAT THIS TEST PROVES (that unit tests cannot):
 *   AD1: produce spend.live.v1 to Kafka → SpendLedgerConsumer (wired, running) →
 *        ad_spend_ledger row (non-inert proof). Money: spend_minor BIGINT exact.
 *   AD2: non-spend event on the live lane → skipped (no ad_spend_ledger write).
 *   AD3: idempotent re-read — same spend event twice → exactly ONE ledger row
 *        (ON CONFLICT (brand_id, platform, level, level_id, stat_date) DO NOTHING).
 *   AD4: no-GUC negative control — brain_app direct SELECT on ad_spend_ledger WITHOUT
 *        the GUC throws 22P02 (FORCE RLS fail-closed) — durable rule, run under brain_app.
 *   AD5: cross-brand isolation — brand A's spend rows invisible under brand B GUC.
 *   AD6: SECURITY DEFINER enumeration fn — list_ad_connectors_for_spend_repull() returns
 *        connected meta/google connectors (dispatch-only) AND is prosecdef + search_path pinned.
 *   AD7: overlap-lock — two concurrent acquireCursorLock on the same cursor → second SKIPs.
 *
 * RLS NOTE: all ledger reads run under BRAIN_APP_DATABASE_URL (brain_app, NOBYPASSRLS).
 *   assertBrainApp() called at the top of every isolation test (dev superuser masks RLS).
 *
 * INFRA REQUIRED: Redpanda + Postgres. Start: docker compose up -d redpanda postgres
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { Pool } from 'pg';
import { Kafka, Producer } from 'kafkajs';
import { LedgerWriter } from '../infrastructure/pg/LedgerWriter.js';
import { SpendLedgerConsumer } from '../interfaces/consumers/SpendLedgerConsumer.js';
import { InMemoryRetryCounter } from './support/InMemoryRetryCounter.js';
import { CollectorEventV1Schema } from '@brain/contracts';
import { uuidV5FromSpendRow, SPEND_LIVE_V1_EVENT_NAME } from '@brain/ad-spend-mapper';
import { acquireCursorLock } from '../jobs/meta-spend-repull/run.js';
import { assertBrainApp, seedTestBrand, cleanupConnectorFixtures } from './helpers/connector-lifecycle-fixtures.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const KAFKA_BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const TOPIC = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';

// Own test brands (distinct from other suites to avoid parallel conflicts). UUIDv4.
const AD_BRAND_A = 'ad5e0001-a700-4a70-8a70-000000000001';
const AD_BRAND_B = 'ad5e0002-b700-4b70-8b70-000000000002';
const AD_CI_META = 'ad5e00c1-c700-4c70-8c70-000000000003';

const SPEND_WIRING_GROUP = 'spend-ledger-wiring-test';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// ── Infra reachability ──────────────────────────────────────────────────────────

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

async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  predicate: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 400,
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

// ── Event builder ────────────────────────────────────────────────────────────────

function makeSpendLiveV1Buffer(params: {
  eventId: string;
  brandId: string;
  platform: 'meta' | 'google_ads';
  level: 'campaign' | 'adset' | 'ad' | 'creative';
  levelId: string;
  statDate: string;
  spendMinor: string;
  currencyCode: string;
}): Buffer {
  const occurredAt = new Date(`${params.statDate}T00:00:00.000Z`).toISOString();
  const envelope = CollectorEventV1Schema.parse({
    schema_version: '1',
    event_id: params.eventId,
    brand_id: params.brandId,
    correlation_id: `spend-wiring-test:${params.eventId}`,
    event_name: SPEND_LIVE_V1_EVENT_NAME,
    occurred_at: occurredAt,
    ingested_at: new Date().toISOString(),
    properties: {
      source: params.platform,
      platform: params.platform,
      level: params.level,
      level_id: params.levelId,
      parent_id: null,
      campaign_id: params.levelId,
      campaign_name: 'Test Campaign',
      stat_date: params.statDate,
      spend_minor: params.spendMinor,
      currency_code: params.currencyCode,
      impressions: '1000',
      clicks: '50',
      conversions_raw: { conversions: '3', all_conversions: '4' },
      account_timezone: 'UTC',
      occurred_at: occurredAt,
    },
  });
  return Buffer.from(JSON.stringify(envelope));
}

// ── DB helpers ───────────────────────────────────────────────────────────────────

async function seedAdConnector(
  superPool: Pool, brandId: string, ciId: string, provider: 'meta' | 'google_ads', adAccountId: string,
): Promise<void> {
  // Ads connectors pass shop_domain='' (ConnectorInstance.create skips *.myshopify.com validation).
  await superPool.query(
    `INSERT INTO connector_instance (id, brand_id, provider, status, shop_domain, secret_ref, ad_account_id)
     VALUES ($1, $2, $3, 'connected', '', $4, $5)
     ON CONFLICT (id) DO UPDATE SET status='connected', provider=EXCLUDED.provider, ad_account_id=EXCLUDED.ad_account_id`,
    [ciId, brandId, provider, `arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/${provider}/${brandId}/test`, adAccountId],
  );
}

async function readSpendRows(
  appPool: Pool, brandId: string, platform?: string,
): Promise<Array<{ level: string; level_id: string; spend_minor: string; stat_date: string }>> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    let sql = `SELECT level, level_id, spend_minor::text, stat_date::text
               FROM ad_spend_ledger WHERE brand_id = $1`;
    const params: unknown[] = [brandId];
    if (platform) { sql += ` AND platform = $2`; params.push(platform); }
    const result = await client.query<{ level: string; level_id: string; spend_minor: string; stat_date: string }>(sql, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── Shared state ─────────────────────────────────────────────────────────────────

let superPool: Pool;
let appPool: Pool;
let kafka: Kafka;
let producer: Producer;
let ledgerWriter: LedgerWriter;
let consumer: SpendLedgerConsumer;
let infraAvailable = false;

beforeAll(async () => {
  infraAvailable = await infraUp();
  if (!infraAvailable) {
    console.warn('[spend-ledger-wiring.e2e] SKIP — Redpanda or Postgres not reachable');
    return;
  }

  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 3 });

  await seedTestBrand(superPool, AD_BRAND_A, 'USD');
  await seedTestBrand(superPool, AD_BRAND_B, 'USD');
  await superPool.query(`DELETE FROM ad_spend_ledger WHERE brand_id IN ($1,$2)`, [AD_BRAND_A, AD_BRAND_B]).catch(() => undefined);

  kafka = new Kafka({ clientId: 'spend-ledger-wiring-test-producer', brokers: KAFKA_BROKERS, logLevel: 0, retry: { retries: 3 } });
  producer = kafka.producer();
  await producer.connect();

  // SpendLedgerConsumer — the SAME class wired in main.ts. Test-specific consumer group.
  ledgerWriter = new LedgerWriter(BRAIN_APP_DB_URL);
  consumer = new SpendLedgerConsumer(kafka, ledgerWriter, TOPIC, SPEND_WIRING_GROUP, new InMemoryRetryCounter());

  // UN-WIRE TEST: comment out `await consumer.start()` → AD1 poll will time out → RED.
  await consumer.start();

  console.info('[spend-ledger-wiring.e2e] SpendLedgerConsumer started on topic=%s group=%s', TOPIC, SPEND_WIRING_GROUP);
}, 60_000);

afterAll(async () => {
  await consumer?.stop().catch(() => undefined);
  await producer?.disconnect().catch(() => undefined);
  await ledgerWriter?.end().catch(() => undefined);

  await superPool?.query(`DELETE FROM ad_spend_ledger WHERE brand_id IN ($1,$2)`, [AD_BRAND_A, AD_BRAND_B]).catch(() => undefined);
  await cleanupConnectorFixtures(superPool, [AD_BRAND_A, AD_BRAND_B]);

  await appPool?.end().catch(() => undefined);
  await superPool?.end().catch(() => undefined);
}, 30_000);

// ── AD1: spend.live.v1 → ad_spend_ledger row (WIRED consumer, non-inert) ────────

describe('AD1: spend.live.v1 → ad_spend_ledger row (WIRED SpendLedgerConsumer)', () => {
  it('produces spend.live.v1; wired consumer writes the ad_spend_ledger row with exact BIGINT spend', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);

    const statDate = '2026-06-10';
    const levelId = `c_AD1_${Date.now()}`;
    const eventId = uuidV5FromSpendRow(AD_BRAND_A, 'meta', statDate, 'campaign', levelId);

    const buf = makeSpendLiveV1Buffer({
      eventId, brandId: AD_BRAND_A, platform: 'meta', level: 'campaign',
      levelId, statDate, spendMinor: '12345', currencyCode: 'USD',
    });
    await producer.send({ topic: TOPIC, messages: [{ key: AD_BRAND_A, value: buf }] });

    const rows = await pollUntil(
      () => readSpendRows(appPool, AD_BRAND_A, 'meta'),
      (r) => r.some((x) => x.level_id === levelId),
      40_000,
    );
    const row = rows.find((x) => x.level_id === levelId)!;
    expect(row.spend_minor).toBe('12345');   // exact BIGINT (I-S07)
    expect(row.level).toBe('campaign');
    expect(row.stat_date).toBe(statDate);
    console.info('[AD1] PASS — ad_spend_ledger row written via wired SpendLedgerConsumer');
  }, 50_000);
});

// ── AD2: non-spend event → skipped ───────────────────────────────────────────────

describe('AD2: non-spend event on live lane → consumer skips, no ad_spend_ledger row', () => {
  it('produces page.viewed → SpendLedgerConsumer skips (event_name filter)', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);

    const before = (await readSpendRows(appPool, AD_BRAND_A)).length;
    const env = CollectorEventV1Schema.parse({
      schema_version: '1', event_id: crypto.randomUUID(), brand_id: AD_BRAND_A,
      correlation_id: `ad2-skip:${Date.now()}`, event_name: 'page.viewed',
      occurred_at: new Date().toISOString(), ingested_at: new Date().toISOString(),
      properties: { source: 'shopify', page: 'home' },
    });
    await producer.send({ topic: TOPIC, messages: [{ key: AD_BRAND_A, value: Buffer.from(JSON.stringify(env)) }] });
    await new Promise((r) => setTimeout(r, 5_000));

    const after = (await readSpendRows(appPool, AD_BRAND_A)).length;
    expect(after).toBe(before);
    console.info('[AD2] PASS — non-spend event correctly skipped');
  }, 20_000);
});

// ── AD3: idempotent re-read — same event twice → ONE row ─────────────────────────

describe('AD3: idempotent trailing re-read — same spend.live.v1 twice → exactly ONE row', () => {
  it('delivers same event twice; ON CONFLICT DO NOTHING → exactly 1 row', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);

    const statDate = '2026-06-11';
    const levelId = `c_AD3_${Date.now()}`;
    const eventId = uuidV5FromSpendRow(AD_BRAND_A, 'google_ads', statDate, 'campaign', levelId);
    const buf = makeSpendLiveV1Buffer({
      eventId, brandId: AD_BRAND_A, platform: 'google_ads', level: 'campaign',
      levelId, statDate, spendMinor: '99999', currencyCode: 'USD',
    });
    // Produce twice (at-least-once re-delivery simulation = a trailing re-read overlap).
    await producer.send({ topic: TOPIC, messages: [{ key: AD_BRAND_A, value: buf }, { key: AD_BRAND_A, value: buf }] });

    await pollUntil(
      () => readSpendRows(appPool, AD_BRAND_A, 'google_ads'),
      (r) => r.some((x) => x.level_id === levelId),
      40_000,
    );
    await new Promise((r) => setTimeout(r, 3_000)); // allow any spurious second write

    const rows = (await readSpendRows(appPool, AD_BRAND_A, 'google_ads')).filter((x) => x.level_id === levelId);
    expect(rows).toHaveLength(1);
    console.info('[AD3] PASS — idempotent re-read: exactly 1 row for duplicate delivery');
  }, 50_000);
});

// ── AD4: no-GUC negative control (durable rule, under brain_app) ─────────────────

describe('AD4: no-GUC negative control — brain_app SELECT on ad_spend_ledger without GUC throws 22P02', () => {
  it('FORCE RLS fail-closed: no GUC -> empty::uuid cast -> 22P02 (non-inert under brain_app)', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);

    // Seed a row via superuser (bypasses RLS), then SELECT under brain_app WITHOUT the GUC.
    await superPool.query(
      `INSERT INTO ad_spend_ledger
        (brand_id, spend_event_id, platform, level, level_id, stat_date, spend_minor, currency_code, raw_event_id, occurred_at)
       VALUES ($1, $2, 'meta', 'campaign', 'c_AD4', '2026-06-01', 100, 'USD', $2, NOW())
       ON CONFLICT DO NOTHING`,
      [AD_BRAND_A, `ad4-${Date.now()}`],
    );

    let threw = false;
    let errorCode: string | undefined;
    try {
      await appPool.query(`SELECT count(*) FROM ad_spend_ledger`);
    } catch (err: unknown) {
      threw = true;
      errorCode = (err as { code?: string }).code;
    }
    expect(threw).toBe(true);
    expect(errorCode).toBe('22P02'); // ''::uuid cast failure — fail-closed
    console.info('[AD4] PASS — FORCE RLS + no GUC throws 22P02 (fail-closed)');
  }, 15_000);
});

// ── AD5: cross-brand isolation ───────────────────────────────────────────────────

describe('AD5: cross-brand isolation — brand B GUC cannot see brand A spend rows', () => {
  it('brand_A spend row invisible under brand_B GUC (FORCE RLS two-arg fail-closed)', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);

    await superPool.query(
      `INSERT INTO ad_spend_ledger
        (brand_id, spend_event_id, platform, level, level_id, stat_date, spend_minor, currency_code, raw_event_id, occurred_at)
       VALUES ($1, $2, 'meta', 'campaign', 'c_AD5', '2026-06-02', 500, 'USD', $2, NOW())
       ON CONFLICT DO NOTHING`,
      [AD_BRAND_A, `ad5-${Date.now()}`],
    );

    const brandBRows = await readSpendRows(appPool, AD_BRAND_B);
    expect(brandBRows.filter((x) => x.level_id === 'c_AD5')).toHaveLength(0);

    const brandARows = await readSpendRows(appPool, AD_BRAND_A);
    expect(brandARows.some((x) => x.level_id === 'c_AD5')).toBe(true);
    console.info('[AD5] PASS — cross-brand isolation holds');
  }, 15_000);
});

// ── AD6: SECURITY DEFINER enumeration fn ─────────────────────────────────────────

describe('AD6: list_ad_connectors_for_spend_repull() — SECURITY DEFINER + returns connected ads connectors', () => {
  it('is prosecdef + search_path pinned AND returns connected meta/google connectors (dispatch-only)', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);

    // Function metadata (via superuser — reads catalog).
    const meta = await superPool.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT p.prosecdef, p.proconfig
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.proname = 'list_ad_connectors_for_spend_repull' AND n.nspname='public'`,
    );
    expect(meta.rows[0]!.prosecdef).toBe(true);
    expect((meta.rows[0]!.proconfig ?? []).join(',')).toMatch(/search_path=public/);

    // Seed one connected meta connector, then call the fn under brain_app (NO GUC — the fn
    // is SECURITY DEFINER so it bypasses FORCE RLS to enumerate; the durable-rule pattern).
    await seedAdConnector(superPool, AD_BRAND_A, AD_CI_META, 'meta', 'act_123');
    const enumRows = await appPool.query<{ connector_instance_id: string; brand_id: string; provider: string; ad_account_id: string | null }>(
      `SELECT connector_instance_id, brand_id, provider, ad_account_id
       FROM list_ad_connectors_for_spend_repull() WHERE connector_instance_id = $1`,
      [AD_CI_META],
    );
    expect(enumRows.rows).toHaveLength(1);
    expect(enumRows.rows[0]!.provider).toBe('meta');
    expect(enumRows.rows[0]!.brand_id).toBe(AD_BRAND_A);
    expect(enumRows.rows[0]!.ad_account_id).toBe('act_123');
    console.info('[AD6] PASS — SECURITY DEFINER enumeration fn correct + dispatch-only');
  }, 20_000);
});

// ── AD7: overlap-lock — second concurrent lock SKIPs ─────────────────────────────

describe('AD7: overlap-lock — two concurrent cursor locks → second SKIPs (FOR UPDATE SKIP LOCKED)', () => {
  it('first acquireCursorLock holds; a concurrent second on the same cursor returns false', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);

    // Dedicated pools so each lock holds its own transaction/connection.
    const poolA = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 2 });
    const poolB = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 2 });
    try {
      // Self-contained: ensure the connector exists (FK target for connector_cursor).
      await seedAdConnector(superPool, AD_BRAND_A, AD_CI_META, 'meta', 'act_123');
      // Pre-seed the cursor row COMMITTED (via superuser) so neither concurrent client blocks
      // on an uncommitted INSERT — the test isolates the FOR UPDATE SKIP LOCKED behavior only.
      await superPool.query(
        `INSERT INTO connector_cursor (brand_id, connector_instance_id, resource, cursor_value, updated_at)
         VALUES ($1,$2,'meta.insights','',NOW()) ON CONFLICT ON CONSTRAINT connector_cursor_upsert_key DO NOTHING`,
        [AD_BRAND_A, AD_CI_META],
      );

      // Lock A: acquire + HOLD by opening a manual transaction that selects FOR UPDATE.
      const clientA = await poolA.connect();
      await clientA.query('BEGIN');
      await clientA.query(
        `SELECT set_config('app.current_brand_id', $1, true), set_config('app.current_user_id', $2, true), set_config('app.current_workspace_id', $2, true)`,
        [AD_BRAND_A, NIL_UUID],
      );
      const held = await clientA.query(
        `SELECT id FROM connector_cursor WHERE brand_id=$1 AND connector_instance_id=$2 AND resource='meta.insights' FOR UPDATE SKIP LOCKED`,
        [AD_BRAND_A, AD_CI_META],
      );
      expect(held.rowCount).toBe(1); // A holds the lock

      // Lock B: while A holds, a second acquire on the SAME cursor must SKIP (false).
      const acquiredB = await acquireCursorLock(poolB, AD_BRAND_A, AD_CI_META, 'meta.insights');
      expect(acquiredB).toBe(false);

      await clientA.query('ROLLBACK');
      clientA.release();
    } finally {
      await poolA.end().catch(() => undefined);
      await poolB.end().catch(() => undefined);
    }
    console.info('[AD7] PASS — overlap-lock: second concurrent lock skipped');
  }, 20_000);
});
