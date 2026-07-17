/**
 * pipeline-wire.e2e.test.ts — Full-wire end-to-end test (F-QA-01).
 *
 * Exercises the COMPLETE ingest spine in a single test — no mocked seams at any cross-component
 * boundary, all the way to the Bronze system-of-record (Iceberg). ADR-0015 direct-to-log:
 *
 *   POST /collect (real TCP HTTP, collector on a real OS port)
 *     → collector PRODUCES straight to Kafka (idempotent producer, acks=-1 — the spool is DELETED)
 *     → event observed on the collector topic by a real Kafka consumer (the mid-wire proof)
 *     → the Kafka Connect Iceberg sink (the compose kafka-connect service — the SOLE Bronze writer,
 *       ADR-0010/ADR-0015 D3, ~30s commit interval) APPENDS the record into Iceberg Bronze
 *       (brain_bronze.collector_events_connect)
 *     → the row is readable over duckdb-serving via the lift view, brand-scoped
 *     → wrong-brand-scoped read → 0 rows (read-seam tenant isolation)
 *
 * The event is order.live.v1 (SERVER_TRUSTED lane) so nothing gates it downstream (the pixel-lane
 * R2/R3 gate lives at Silver admission) — this suite proves the WIRING from the HTTP edge all the
 * way to Iceberg Bronze.
 *
 * REQUIRES the `lakehouse` docker profile (Kafka + kafka-connect + Iceberg REST + MinIO +
 * duckdb-serving; PG only for the collector's fail-open edge-guard oracle). The collector runs as
 * a child process; the Connect sink runs in Docker.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Kafka, logLevel } from 'kafkajs';
import type { Consumer } from 'kafkajs';
import { makeBronzeServingPool, icebergBronzeAvailable, pollIcebergBronzeCount, type BronzePool } from './helpers/iceberg-bronze.js';

// ── Test config ────────────────────────────────────────────────────────────────

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://brain:brain@localhost:5432/brain';

const KAFKA_BROKERS_STR = process.env['KAFKA_BROKERS'] ?? 'localhost:9092';
const KAFKA_BROKERS = KAFKA_BROKERS_STR.split(',').map((b) => b.trim());

// The collector derives its topic prefix from NODE_ENV (main.ts): production → `prod.`, which is
// what the RUNNING Kafka Connect collector sink consumes in the local-prod stack. Overridable for
// a dev-prefixed stack (COLLECTOR_NODE_ENV=development → dev. prefix).
const COLLECTOR_NODE_ENV = process.env['COLLECTOR_NODE_ENV'] ?? 'production';
const COLLECTOR_TOPIC = `${COLLECTOR_NODE_ENV === 'production' ? 'prod' : 'dev'}.collector.event.v1`;

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

describe('Full-wire pipeline E2E (F-QA-01): POST /collect → Kafka → Connect → Iceberg Bronze', () => {
  let collectorProc: ChildProcess | null = null;
  let collectorPort: number;
  let consumer: Consumer | null = null;
  let sr: BronzePool | null = null;      // duckdb-serving — reads Iceberg Bronze (the SoR)
  let infraAvailable = false;

  // Per-run unique event UUID (Iceberg event_id is a string; UUID is fine).
  const TEST_EVENT_ID = crypto.randomUUID();

  // The mid-wire proof: a real consumer on the collector topic records every observed event_id
  // (subscribed BEFORE the POST so the produced record cannot be missed).
  const observedEventIds = new Set<string>();

  beforeAll(async () => {
    // Collector deps (Kafka; PG only for the fail-open edge guard) plus the lakehouse read path.
    const [broker] = KAFKA_BROKERS;
    const [kHost, kPortStr] = (broker ?? 'localhost:9092').split(':');
    const kafkaOk = await tcpReachable(kHost ?? 'localhost', Number(kPortStr ?? 9092));
    sr = makeBronzeServingPool();
    const lakehouseOk = await icebergBronzeAvailable(sr);
    infraAvailable = kafkaOk && lakehouseOk;
    if (!infraAvailable) {
      console.warn('[pipeline-wire.e2e] SKIP — infra not reachable (Kafka/duckdb-serving)');
      return;
    }

    // ── Mid-wire Kafka observer: consume the collector topic (unique group, latest offset) ────
    const kafka = new Kafka({ clientId: 'pipeline-wire-e2e', brokers: KAFKA_BROKERS, logLevel: logLevel.NOTHING });
    consumer = kafka.consumer({ groupId: `pipeline-wire-e2e-${crypto.randomUUID()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: COLLECTOR_TOPIC, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        try {
          const parsed = JSON.parse(message.value?.toString() ?? '{}') as { event_id?: string };
          if (typeof parsed.event_id === 'string') observedEventIds.add(parsed.event_id);
        } catch {
          // non-JSON records on the topic are not this test's concern
        }
      },
    });

    // ── Start collector subprocess on a free port ─────────────────────────────
    collectorPort = await getFreePort();
    collectorProc = spawn(
      'pnpm',
      ['exec', 'tsx', COLLECTOR_MAIN],
      {
        env: {
          ...process.env,
          PORT: String(collectorPort),
          // production → `prod.` topic prefix (what the RUNNING Connect collector sink consumes).
          // NOT inherited from process.env — vitest sets NODE_ENV=test (→ `dev.` prefix, no sink).
          NODE_ENV: COLLECTOR_NODE_ENV,
          DATABASE_URL,
          KAFKA_BROKERS: KAFKA_BROKERS_STR,
          // Point Apicurio at a connection-refused port so registration attempts fail fast and the
          // collector degrades gracefully (D-10) — the accept path never depends on the registry.
          APICURIO_REGISTRY_URL: 'http://127.0.0.1:9',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    collectorProc.stdout?.on('data', (d: Buffer) => { process.stdout.write(`[collector-proc] ${d.toString()}`); });
    collectorProc.stderr?.on('data', (d: Buffer) => { process.stderr.write(`[collector-proc:err] ${d.toString()}`); });

    // Wait for the collector HTTP listener (it starts AFTER a schema-registry backoff budget).
    await pollUntil(
      () => httpGet(collectorPort, '/healthz').catch(() => null),
      (r) => r !== null && r.status === 200,
      60_000,
      500,
    );
    console.info(`[pipeline-wire.e2e] collector ready on port ${collectorPort}`);
  }, 120_000);

  afterAll(async () => {
    if (collectorProc && !collectorProc.killed) {
      collectorProc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const proc = collectorProc as unknown as NodeJS.EventEmitter;
        proc.once('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
    }
    await consumer?.disconnect().catch(() => undefined);
    await sr?.end?.().catch(() => undefined);
  }, 30_000);

  it(
    'event travels end-to-end: POST /collect → produce-ack → Kafka → Connect → Iceberg Bronze',
    async () => {
      if (!infraAvailable) {
        console.warn('[pipeline-wire.e2e] Skipping — infra not available');
        return;
      }

      // ── Step 1: POST to the collector over a real TCP socket ──────────────
      // order.live.v1 = SERVER_TRUSTED lane (server-derived brand, no install_token) → the Connect
      // sink lands it as-is, exercising the full wire without the pixel gate.
      const syntheticEvent = {
        schema_version: '1',
        event_id: TEST_EVENT_ID,
        brand_id: BRAND_A,
        correlation_id: `corr-wire-${TEST_EVENT_ID}`,
        event_name: 'order.live.v1',
        occurred_at: new Date().toISOString(),
        ingested_at: new Date().toISOString(),
        properties: { source: 'shopify', order_id: `wire-${TEST_EVENT_ID.slice(0, 8)}`, amount_minor: '100000', currency_code: 'INR', payment_method: 'prepaid', test: 'pipeline-wire-e2e' },
      };

      console.info(`[pipeline-wire.e2e] POST /collect event_id=${TEST_EVENT_ID}`);
      const postResp = await httpPost(collectorPort, '/collect', syntheticEvent);
      expect(postResp.status).toBe(200);
      expect((postResp.body as { accepted: boolean }).accepted).toBe(true);
      // ADR-0015 public contract: no X-Spool-Id anymore; correlation + received-at are stamped.
      expect(postResp.headers['x-correlation-id']).toBeTruthy();
      expect(postResp.headers['x-received-at']).toBeTruthy();
      expect((postResp.body as { received_at: string }).received_at).toBeTruthy();

      // ── Step 2: the produced record is observable on the collector topic (mid-wire proof) ──
      await pollUntil(
        async () => observedEventIds.has(TEST_EVENT_ID),
        (seen) => seen === true,
        20_000,
        300,
      );
      console.info('[pipeline-wire.e2e] event observed on the collector topic — produced to Kafka');

      // ── Step 3: the Connect sink lands it in Iceberg Bronze (read via duckdb-serving, brand-scoped) ──
      const landed = await pollIcebergBronzeCount(sr!, { brandId: BRAND_A, eventId: TEST_EVENT_ID }, { min: 1, timeoutMs: 75_000 });
      expect(landed).toBe(1);
      console.info('[pipeline-wire.e2e] bronze row found in Iceberg under BRAND_A');

      // ── Step 4: read-seam tenant isolation (wrong brand → 0 rows) ─────────
      const wrongBrand = await pollIcebergBronzeCount(sr!, { brandId: BRAND_B, eventId: TEST_EVENT_ID }, { min: 1, timeoutMs: 3_000 });
      expect(wrongBrand).toBe(0);
      console.info(`[pipeline-wire.e2e] read-seam isolation: wrong-brand → ${wrongBrand} rows (expected 0)`);
    },
    180_000,
  );
});
