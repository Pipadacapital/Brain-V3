/**
 * spend-repull-smoke.e2e.test.ts — Real-network synthetic-fixture smoke for the spend re-pull
 * jobs (ADR-AD-9 dev-honesty boundary).
 *
 * Proves the FULL data path end-to-end with a SYNTHETIC fixture (recorded-response fetch stub),
 * honest about the dev boundary (real OAuth + real app creds are a platform follow-up):
 *
 *   SM1 (Meta): seed a connected `meta` connector + dev_secret bundle → run meta-spend-repull
 *      with a stubbed fetch returning synthetic Insights rows → the repull EMITS spend.live.v1 on
 *      the live lane (collector.event.v1). Proves: enumerate (SECURITY DEFINER) → GUC-after-enumerate
 *      → map (spend major→minor) → emit spend.live.v1. From the live lane the Spark sink lands it in
 *      Bronze (Iceberg, server-trusted) → silver_marketing_spend — Bronze is the SOLE spend SoR; there
 *      is NO PostgreSQL ad_spend_ledger (ad spend is analytical, not operational state).
 *
 *   SM2 (Google throttle): a stubbed fetch returning RESOURCE_EXHAUSTED → the run marks the
 *      connector sync_status='error' (RateLimited) and ABORTS without emitting spend (ADR-AD-7).
 *
 * The status surface reflects REAL connector_sync_status (never a simulated badge — ADR-AD-9).
 *
 * INFRA: Redpanda + Postgres. A tail-positioned test consumer collects the emitted spend.live.v1.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import { Pool } from 'pg';
import { Kafka, type Consumer } from 'kafkajs';
import { run as runMetaRepull } from '../jobs/meta-spend-repull/run.js';
import { run as runGoogleRepull } from '../jobs/google-ads-spend-repull/run.js';
import { assertBrainApp, seedTestBrand, cleanupConnectorFixtures } from './helpers/connector-lifecycle-fixtures.js';

const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const KAFKA_BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const TOPIC = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';

const SMK_BRAND = 'ad5e0003-c700-4c70-8c70-000000000004';
const SMK_CI_META = 'ad5e00c2-d700-4d70-8d70-000000000005';
const SMK_CI_GOOGLE = 'ad5e00c3-e700-4e70-8e70-000000000006';
// Unique per run so the test consumer starts at the topic TAIL (fromBeginning:false). A fixed group
// carries a stale committed offset and replays millions of historical messages every run (flaky).
// The consumer is started in beforeAll BEFORE the repull emits, so a tail-positioned fresh group
// still catches the new spend.live.v1 message.
const SMOKE_GROUP = `spend-emit-smoke-test-${Date.now()}`;

/** Collected spend.live.v1 envelopes for SMK_BRAND, keyed by platform (the repull's real output). */
const emittedByPlatform = new Map<string, number>();

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

async function seedAdConnector(superPool: Pool, ciId: string, provider: 'meta' | 'google_ads', adAccountId: string): Promise<void> {
  const ref = `brain/connector/${provider}/${SMK_BRAND}/smoke`;
  await superPool.query(
    `INSERT INTO connector_instance (id, brand_id, provider, status, shop_domain, secret_ref, ad_account_id)
     VALUES ($1,$2,$3,'connected','',$4,$5)
     ON CONFLICT (id) DO UPDATE SET status='connected', provider=EXCLUDED.provider, secret_ref=EXCLUDED.secret_ref, ad_account_id=EXCLUDED.ad_account_id`,
    [ciId, SMK_BRAND, provider, ref, adAccountId],
  );
  await superPool.query(
    `INSERT INTO connector_sync_status (brand_id, connector_instance_id, state)
     VALUES ($1,$2,'waiting_for_data') ON CONFLICT (brand_id, connector_instance_id) DO UPDATE SET state='waiting_for_data'`,
    [SMK_BRAND, ciId],
  );
  return Promise.resolve();
}
async function seedDevSecret(superPool: Pool, provider: 'meta' | 'google_ads', value: object): Promise<void> {
  const name = `brain/connector/${provider}/${SMK_BRAND}/smoke`;
  await superPool.query(
    `INSERT INTO dev_secret (name, secret_value) VALUES ($1,$2)
     ON CONFLICT (name) DO UPDATE SET secret_value=EXCLUDED.secret_value`,
    [name, JSON.stringify(value)],
  );
}
async function readSyncState(superPool: Pool, ciId: string): Promise<string | null> {
  const r = await superPool.query<{ state: string }>(`SELECT state FROM connector_sync_status WHERE connector_instance_id=$1`, [ciId]);
  return r.rows[0]?.state ?? null;
}

let superPool: Pool;
let appPool: Pool;
let kafka: Kafka;
let consumer: Consumer;
let infraAvailable = false;

beforeAll(async () => {
  infraAvailable = await infraUp();
  if (!infraAvailable) { console.warn('[spend-repull-smoke.e2e] SKIP — infra not reachable'); return; }
  // run.ts reads its DB/broker config from env — ensure the brain_app URL is set so its internal
  // pg pools + the dev_secret resolver authenticate (avoids pg SCRAM "password must be a string").
  process.env['BRAIN_APP_DATABASE_URL'] = BRAIN_APP_DB_URL;
  process.env['KAFKA_BROKERS'] = KAFKA_BROKERS.join(',');
  process.env['COLLECTOR_TOPIC'] = TOPIC;
  process.env['APP_ENV'] = 'dev';
  process.env['GOOGLE_ADS_CLIENT_ID'] = 'smoke-client-id';
  process.env['GOOGLE_ADS_CLIENT_SECRET'] = 'smoke-client-secret';
  process.env['GOOGLE_ADS_DEVELOPER_TOKEN'] = 'smoke-dev-token';
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 3 });
  await seedTestBrand(superPool, SMK_BRAND, 'INR');

  // Tail-positioned test consumer collects spend.live.v1 for SMK_BRAND (the repull's real output —
  // Bronze ingestion of the live lane is covered by the Spark Bronze e2e, not re-proven here).
  kafka = new Kafka({ clientId: 'spend-smoke-consumer', brokers: KAFKA_BROKERS, logLevel: 0 });
  consumer = kafka.consumer({ groupId: SMOKE_GROUP });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const env = JSON.parse(message.value?.toString() ?? '{}') as {
          event_name?: string; brand_id?: string; payload?: { platform?: string };
        };
        if (env.event_name === 'spend.live.v1' && env.brand_id === SMK_BRAND) {
          const platform = env.payload?.platform ?? 'unknown';
          emittedByPlatform.set(platform, (emittedByPlatform.get(platform) ?? 0) + 1);
        }
      } catch { /* ignore non-JSON */ }
    },
  });
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await consumer?.disconnect().catch(() => undefined);
  await superPool?.query(`DELETE FROM dev_secret WHERE name LIKE $1`, [`brain/connector/%/${SMK_BRAND}/smoke`]).catch(() => undefined);
  await cleanupConnectorFixtures(superPool, [SMK_BRAND]);
  await appPool?.end().catch(() => undefined);
  await superPool?.end().catch(() => undefined);
}, 30_000);

// ── SM1: Meta synthetic-fixture repull → spend.live.v1 emitted on the live lane ───

describe('SM1: meta-spend-repull synthetic fixture → connect→repull→spend.live.v1 (Bronze lane)', () => {
  it('runs the real meta repull with a stubbed Insights fetch → emits spend.live.v1 to Kafka', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);

    await seedAdConnector(superPool, SMK_CI_META, 'meta', 'act_smoke_meta');
    await seedDevSecret(superPool, 'meta', { access_token: 'SYNTHETIC_DEV_TOKEN', ad_account_id: 'act_smoke_meta' });

    const statDate = '2026-06-12';
    const fetchStub = vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('?fields=currency')) {
        return new Response(JSON.stringify({ currency: 'USD', timezone_name: 'America/Los_Angeles' }), { status: 200 });
      }
      if (url.includes('/insights')) {
        const isCampaign = url.includes('level=campaign');
        const data = isCampaign
          ? [{ campaign_id: 'cmp_smoke_1', campaign_name: 'Smoke', spend: '42.50', impressions: '100', clicks: '7', date_start: statDate }]
          : [];
        return new Response(JSON.stringify({ data, paging: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch);

    await runMetaRepull(SMK_CI_META);
    vi.unstubAllGlobals();

    // The repull's real output: a spend.live.v1 event on the live lane (→ Spark sink → Bronze).
    const count = await pollUntil(() => Promise.resolve(emittedByPlatform.get('meta') ?? 0), (n) => n >= 1, 40_000);
    expect(count).toBeGreaterThanOrEqual(1);

    // Status surface reflects REAL sync_status (connected after a successful run — ADR-AD-9).
    expect(await readSyncState(superPool, SMK_CI_META)).toBe('connected');
    console.info('[SM1] PASS — meta synthetic repull → spend.live.v1 emitted; sync_status=connected');
  }, 60_000);
});

// ── SM2: Google RESOURCE_EXHAUSTED → RateLimited + abort (no spend emitted) ───────

describe('SM2: google-ads-spend-repull RESOURCE_EXHAUSTED → RateLimited + abort run (ADR-AD-7)', () => {
  it('daily ops-quota error → sync_status=error (RateLimited), no spend.live.v1 emitted', async () => {
    if (!infraAvailable) return;
    await assertBrainApp(appPool);

    await seedAdConnector(superPool, SMK_CI_GOOGLE, 'google_ads', '1234567890');
    await seedDevSecret(superPool, 'google_ads', {
      refresh_token: 'SYNTHETIC_REFRESH', client_id: 'cid', client_secret: 'csecret',
      developer_token: 'devtoken', customer_id: '1234567890',
    });

    const beforeGoogle = emittedByPlatform.get('google_ads') ?? 0;

    const fetchStub = vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'SYNTHETIC_ACCESS' }), { status: 200 });
      }
      if (url.includes('searchStream')) {
        return new Response(JSON.stringify({
          error: { status: 'RESOURCE_EXHAUSTED', details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_EXHAUSTED' } }] }] },
        }), { status: 429 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch);

    await runGoogleRepull(SMK_CI_GOOGLE);
    vi.unstubAllGlobals();

    // Give any (erroneously) emitted event time to arrive, then assert none did.
    await new Promise((r) => setTimeout(r, 2000));
    expect(emittedByPlatform.get('google_ads') ?? 0).toBe(beforeGoogle); // no spend emitted under daily quota

    expect(await readSyncState(superPool, SMK_CI_GOOGLE)).toBe('error');
    console.info('[SM2] PASS — RESOURCE_EXHAUSTED → RateLimited abort, no spend emitted; sync_status=error');
  }, 60_000);
});
