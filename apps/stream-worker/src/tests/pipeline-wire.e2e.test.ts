/**
 * pipeline-wire.e2e.test.ts — Full-wire end-to-end test (F-QA-01).
 *
 * Exercises the COMPLETE ingest spine in a single test — no mocked seams at
 * any cross-component boundary:
 *
 *   POST /collect (real TCP HTTP, collector on a real OS port)
 *     → collector_spool (INSERT, status=pending)
 *     → drainer produces to Redpanda (real broker)
 *     → collector_spool status=drained
 *     → CollectorEventConsumer reads from Redpanda (real consumer group, this process)
 *     → BronzeRepository.write() (as brain_app, RLS enforced)
 *     → bronze_events row visible under brain_app + correct-brand GUC
 *     → assert current_user = 'brain_app' (NOT 'brain' superuser — F-4 false-pass trap)
 *     → assert wrong-brand GUC → 0 rows (RLS negative control)
 *
 * REQUIRES live infra: Redpanda + Redis + Postgres.
 * Start with: docker compose up -d redpanda redis postgres
 *
 * NON-INERT: the test is skipped only if infra is genuinely unreachable at the
 * TCP level.  It is never skipped silently when infra is up.
 *
 * The collector is started as a child process (via tsx) on a random OS port so
 * the real Fastify listener + drainer + spool path runs end-to-end.  The
 * stream-worker consumer (CollectorEventConsumer) runs in this process.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Kafka } from 'kafkajs';
import { RedisDedupAdapter } from '../infrastructure/redis/RedisDedupAdapter.js';
import { BronzeRepository } from '../infrastructure/pg/BronzeRepository.js';
import { ProcessEventUseCase } from '../application/ProcessEventUseCase.js';
import { CollectorEventConsumer } from '../interfaces/consumers/CollectorEventConsumer.js';
import { buildDedupKey } from '../domain/bronze/DedupPolicy.js';

// ── Test config ────────────────────────────────────────────────────────────────

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://brain:brain@localhost:5432/brain';

const BRAIN_APP_DATABASE_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgresql://brain_app:brain_app@localhost:5432/brain';

const REDPANDA_BROKERS_STR =
  process.env['KAFKA_BROKERS'] ?? process.env['REDPANDA_BROKERS'] ?? 'localhost:9092';
const REDPANDA_BROKERS = REDPANDA_BROKERS_STR.split(',').map((b) => b.trim());

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const TOPIC = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';
const CONSUMER_GROUP = 'pipeline-wire-e2e';

// Test brand UUIDs (valid UUIDv4)
const BRAND_A = 'aaaa1111-aaaa-4aaa-8aaa-111111111111';
const BRAND_B = 'bbbb2222-bbbb-4bbb-8bbb-222222222222';

// ── Infra reachability checks ─────────────────────────────────────────────────

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

async function allInfraUp(): Promise<boolean> {
  const [broker] = REDPANDA_BROKERS;
  if (!broker) return false;
  const [rpHost, rpPortStr] = broker.split(':');
  const rpOk = await tcpReachable(rpHost ?? 'localhost', Number(rpPortStr ?? 9092));
  const pgOk = await tcpReachable('127.0.0.1', 5432);
  const redisOk = await tcpReachable('127.0.0.1', 6379);
  return rpOk && pgOk && redisOk;
}

// ── Free-port helper ──────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close((err) => { if (err) reject(err); else resolve(port); });
    });
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpPost(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k] = v;
          }
          try {
            resolve({ status: res.statusCode ?? 0, headers, body: JSON.parse(data) });
          } catch {
            reject(new Error(`Non-JSON response: ${data}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpGet(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          reject(new Error(`Non-JSON: ${data}`));
        }
      });
    }).on('error', reject);
  });
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

// ── Locate collector main.ts ───────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const COLLECTOR_MAIN = `${REPO_ROOT}apps/collector/src/main.ts`;

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('Full-wire pipeline E2E (F-QA-01): POST /collect → spool → Redpanda → stream-worker → bronze_events', () => {
  let collectorProc: ChildProcess | null = null;
  let collectorPort: number;
  let consumer: CollectorEventConsumer | null = null;
  let dedup: RedisDedupAdapter | null = null;
  let bronze: BronzeRepository | null = null;
  let brainAppPool: Pool | null = null;
  let superPool: Pool | null = null;
  let infraAvailable = false;

  // Per-run unique event UUID to avoid cross-run collisions
  // Must be a valid UUIDv4 because bronze_events.event_id is type UUID
  const TEST_EVENT_ID = crypto.randomUUID();

  beforeAll(async () => {
    infraAvailable = await allInfraUp();
    if (!infraAvailable) {
      console.warn('[pipeline-wire.e2e] SKIP — infra not reachable (Redpanda/PG/Redis)');
      return;
    }

    // ── 1. Start collector subprocess on a free port ──────────────────────────
    collectorPort = await getFreePort();

    collectorProc = spawn(
      'pnpm',
      ['exec', 'tsx', COLLECTOR_MAIN],
      {
        env: {
          ...process.env,
          PORT: String(collectorPort),
          NODE_ENV: 'development',
          DATABASE_URL: DATABASE_URL,
          REDPANDA_BROKERS: REDPANDA_BROKERS_STR,
          DRAIN_POLL_INTERVAL_MS: '200',
          // Point Apicurio to a connection-refused port so the backoff exhausts
          // quickly and the collector degrades gracefully to spool-only mode (D-10).
          // This avoids the ~30s wait when the artifact already exists (409) in CI.
          APICURIO_REGISTRY_URL: 'http://127.0.0.1:9',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    collectorProc.stdout?.on('data', (d: Buffer) => {
      process.stdout.write(`[collector-proc] ${d.toString()}`);
    });
    collectorProc.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(`[collector-proc:err] ${d.toString()}`);
    });

    // Wait for the collector HTTP listener to be ready (poll /healthz).
    // The collector starts listening AFTER registerSchemaWithBackoff() which has
    // a 30s budget — so we poll for up to 45s to cover the full backoff window.
    await pollUntil(
      () => httpGet(collectorPort, '/healthz').catch(() => null),
      (r) => r !== null && r.status === 200,
      45_000,
      500,
    );
    console.info(`[pipeline-wire.e2e] collector ready on port ${collectorPort}`);

    // ── 2. Start stream-worker consumer (in-process) ──────────────────────────
    const kafka = new Kafka({
      clientId: 'pipeline-wire-e2e',
      brokers: REDPANDA_BROKERS,
      logLevel: 0,
      retry: { retries: 3 },
    });

    dedup = new RedisDedupAdapter(REDIS_URL);
    bronze = new BronzeRepository(BRAIN_APP_DATABASE_URL);
    // enforceTenantDerivation=false: this suite proves the pipeline WIRING (collector →
    // Redpanda → stream-worker → Bronze plumbing) with a trusted-brand fixture, NOT the R2
    // token→brand gate (owned by ingest-hardening.e2e.test.ts, which drives a token-bearing event).
    const useCase = new ProcessEventUseCase(dedup, bronze, undefined, false);
    consumer = new CollectorEventConsumer(kafka, useCase, TOPIC, CONSUMER_GROUP);

    await consumer.start();
    console.info('[pipeline-wire.e2e] stream-worker consumer started');

    // ── 3. Assertion DB pools ─────────────────────────────────────────────────
    brainAppPool = new Pool({ connectionString: BRAIN_APP_DATABASE_URL });
    superPool = new Pool({ connectionString: DATABASE_URL });

    // Clean any leftover from a prior aborted run
    await superPool.query('DELETE FROM bronze_events WHERE event_id = $1', [TEST_EVENT_ID]);
    const redis = new Redis(REDIS_URL);
    await redis.del(buildDedupKey(BRAND_A, TEST_EVENT_ID));
    await redis.quit();
  }, 90_000);

  afterAll(async () => {
    // Clean up test data
    await superPool?.query('DELETE FROM bronze_events WHERE event_id = $1', [TEST_EVENT_ID]).catch(() => undefined);
    const redis = new Redis(REDIS_URL);
    await redis.del(buildDedupKey(BRAND_A, TEST_EVENT_ID)).catch(() => undefined);
    await redis.quit().catch(() => undefined);

    await consumer?.stop().catch(() => undefined);
    await dedup?.quit().catch(() => undefined);
    await bronze?.end().catch(() => undefined);

    // Terminate collector subprocess
    if (collectorProc && !collectorProc.killed) {
      collectorProc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        // ChildProcess extends EventEmitter — cast via EventEmitter to access .once()
        const proc = collectorProc as unknown as NodeJS.EventEmitter;
        proc.once('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
    }

    await brainAppPool?.end().catch(() => undefined);
    await superPool?.end().catch(() => undefined);
  }, 30_000);

  it(
    'event travels end-to-end: POST /collect → spool(drained) → Redpanda → stream-worker → bronze_events under brain_app',
    async () => {
      if (!infraAvailable) {
        console.warn('[pipeline-wire.e2e] Skipping — infra not available');
        return;
      }

      // ── Step 1: POST to collector via real TCP socket ─────────────────────
      const syntheticEvent = {
        schema_version: '1',
        event_id: TEST_EVENT_ID,
        brand_id: BRAND_A,
        correlation_id: `corr-wire-${TEST_EVENT_ID}`,
        event_name: 'page.viewed',
        occurred_at: new Date().toISOString(),
        ingested_at: new Date().toISOString(),
        properties: { page: 'home', test: 'pipeline-wire-e2e' },
      };

      console.info(`[pipeline-wire.e2e] POST /collect event_id=${TEST_EVENT_ID}`);
      const postResp = await httpPost(collectorPort, '/collect', syntheticEvent);

      expect(postResp.status).toBe(200);
      expect((postResp.body as { accepted: boolean }).accepted).toBe(true);

      const spoolId = postResp.headers['x-spool-id'];
      expect(spoolId).toBeTruthy();
      console.info(`[pipeline-wire.e2e] spool_id=${spoolId}`);

      // ── Step 2: Poll collector_spool until status='drained' ────────────────
      // The collector drainer (in the subprocess) polls every 200ms.
      const drainedRow = await pollUntil(
        async () => {
          const r = await superPool!.query<{ status: string }>(
            'SELECT status FROM collector_spool WHERE id = $1',
            [spoolId],
          );
          return r.rows[0] ?? null;
        },
        (row) => row.status === 'drained',
        20_000,
        300,
      );
      expect(drainedRow.status).toBe('drained');
      console.info(`[pipeline-wire.e2e] spool row drained — event produced to Redpanda`);

      // ── Step 3: Poll bronze_events under brain_app + correct-brand GUC ────
      // The in-process CollectorEventConsumer reads from Redpanda and writes to bronze_events.
      const bronzeRow = await pollUntil(
        async () => {
          const client = await brainAppPool!.connect();
          try {
            // Set brand GUC for RLS (scoped to this session, not transaction)
            await client.query(
              "SELECT set_config('app.current_brand_id', $1, false)",
              [BRAND_A],
            );
            const r = await client.query<{ event_id: string; current_user: string }>(
              'SELECT event_id, current_user FROM bronze_events WHERE event_id = $1',
              [TEST_EVENT_ID],
            );
            return r.rows[0] ?? null;
          } finally {
            client.release();
          }
        },
        (row) => row.event_id === TEST_EVENT_ID,
        30_000,
        300,
      );

      // ── Step 4: Assertions ────────────────────────────────────────────────

      // Row arrived end-to-end
      expect(bronzeRow.event_id).toBe(TEST_EVENT_ID);
      console.info(`[pipeline-wire.e2e] bronze_events row found: event_id=${bronzeRow.event_id} current_user=${bronzeRow.current_user}`);

      // Critical: must be brain_app, NOT brain superuser (F-4 false-pass trap)
      expect(bronzeRow.current_user).toBe('brain_app');
      expect(bronzeRow.current_user).not.toBe('brain');

      // ── Step 5: RLS negative control (wrong brand → 0 rows) ──────────────
      const wrongBrandClient = await brainAppPool!.connect();
      let wrongBrandCount = -1;
      let wrongBrandUser = 'unknown';
      try {
        await wrongBrandClient.query(
          "SELECT set_config('app.current_brand_id', $1, false)",
          [BRAND_B],
        );
        const userR = await wrongBrandClient.query<{ current_user: string }>('SELECT current_user');
        wrongBrandUser = userR.rows[0]?.current_user ?? 'unknown';
        const r = await wrongBrandClient.query<{ c: string }>(
          "SELECT count(*)::text AS c FROM bronze_events WHERE event_id = $1",
          [TEST_EVENT_ID],
        );
        wrongBrandCount = Number(r.rows[0]?.c ?? '-1');
      } finally {
        wrongBrandClient.release();
      }

      // Negative control: brand_B cannot see brand_A's rows
      expect(wrongBrandUser).toBe('brain_app');
      expect(wrongBrandCount).toBe(0);
      console.info(`[pipeline-wire.e2e] RLS negative control: wrong-brand GUC → ${wrongBrandCount} rows (expected 0)`);
    },
    90_000,
  );
});
