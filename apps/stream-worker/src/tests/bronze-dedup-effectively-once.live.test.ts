/**
 * bronze-dedup-effectively-once.live.test.ts — effectively-once under ADR-0010, proven end-to-end.
 *
 * THE CONTRACT (ADR-0010 form): the Brain ingest path is at-least-once. The collector and every
 * connector re-emit on retry, a crashed worker re-produces in-flight events, and a replayed Kafka
 * offset re-delivers a record that was already landed. Under ADR-0010 the Kafka Connect Iceberg sink
 * (the compose `kafka-connect` service) is the ONLY Bronze landing writer and Bronze is APPEND-ONLY:
 * there is NO Bronze-level dedup anymore. Re-producing the same business event (same event_id, new
 * Kafka offset) lands a SECOND Bronze row — by design (Bronze is the verbatim broker history).
 *
 * WHERE effectively-once now lives (two layers):
 *   (a) OFFSET-level — the Connect sink's commit coordination over the `control-iceberg` topic makes
 *       a re-delivery of the exact same (topic, partition, offset) after a connector restart land
 *       zero extra rows. Not drivable from a test (we cannot replay a committed offset from here).
 *   (b) BUSINESS-level — the Silver admission gate (db/iceberg/duckdb/silver/silver_collector_event.py)
 *       collapses all Bronze copies of a (brand_id, event_id) via its window (row_number over
 *       brand_id,event_id) + MERGE: exactly ONE row per (brand_id, event_id) in
 *       iceberg.brain_silver.silver_collector_event. THAT is the dedup SoR every downstream
 *       consumer (journey/revenue/attribution) reads through.
 *
 * SHAPE (this suite proves (b), and the append-only Bronze premise on the way):
 *   produce N events with KNOWN event_ids → wait for them to land in Bronze → RE-produce the SAME N
 *   event_ids (the crash-replay) → poll Bronze via the lift view and assert BOTH copies landed
 *   (count >= 2 per event_id — append-only, no Bronze dedup) → then assert Silver holds EXACTLY ONE
 *   row per event_id.
 *
 * SILVER CAVEAT: silver_collector_event only advances when the Silver DuckDB job runs (the
 * v4-refresh loop / ONESHOT), which this test cannot invoke. So the Silver assertion is
 * CONDITIONAL: by default it makes one bounded opportunistic poll — if NO Silver rows for these
 * event_ids are visible (the job hasn't run since the produce), it logs a warning and skips the
 * exactness check rather than failing a correct stack. Set DEDUP_SILVER_ASSERT=1 to make it
 * blocking (waits up to 5 min for a refresh-loop pass; run `ONESHOT=1 pnpm dev:v4-refresh` in
 * parallel to force it).
 *
 * Uses a SERVER_TRUSTED event type (order.live.v1) so Silver admission passes without the pixel-lane
 * R2/R3 gate (under ADR-0010/ADR-0015 that gate lives in the Silver admission keystone
 * silver_collector_event.py, not in front of Bronze).
 *
 * Bronze is read over the serving tier through the ADR-0010 lift view
 * `brain_bronze.collector_events_connect_lifted` (the raw connect table is payload + kafka
 * coords only; the view lifts event_id/brand_id). The Connect sink commits on a ~30s interval, so
 * Bronze polls tolerate 30-60s+ latency.
 *
 * REQUIRES the `lakehouse` docker profile (Kafka KRaft + kafka-connect + Iceberg REST + MinIO +
 * duckdb-serving on :8091). The suite self-skips (SKIP_IF_NO_LAKEHOUSE) when the stack is not up — the
 * operator runs it live; CI does not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Kafka, type Producer } from 'kafkajs';
import { createDuckDbServingPool, type SilverPool } from '@brain/metric-engine';
import { produceCollectorEvent, KAFKA_BROKERS, type CollectorEnvelope } from './helpers/iceberg-bronze.js';

const EVENT_NAME = 'order.live.v1'; // SERVER_TRUSTED lane — no pixel R2/R3 gate at Silver admission
const BRAND_A = '33333333-3333-4333-8333-333333333333'; // dedup-suite-specific brand (avoids cross-suite collisions)
const N = 5; // number of distinct known event_ids to round-trip

const SERVING_URL =
  process.env['DUCKDB_SERVING_URL'] ??
  `http://${process.env['DUCKDB_SERVING_HOST'] ?? '127.0.0.1'}:${process.env['DUCKDB_SERVING_PORT'] ?? '8091'}`;
// ADR-0010 Bronze read target: the lift view over the Kafka Connect collector table (the raw
// table is payload + kafka coords only; the view lifts the event_id/brand_id these polls filter on).
// TWO-PART name — resolves to the replica-LOCAL lift view on duckdb-serving
// (a 3-part iceberg.* name would bypass the local view and hit the raw catalog table).
const BRONZE_TABLE = 'brain_bronze.collector_events_connect_lifted';
// The business-level dedup SoR: one row per (brand_id, event_id) after the Silver admission MERGE.
const SILVER_TABLE = 'iceberg.brain_silver.silver_collector_event';
// The running Connect sink consumes the env-PREFIXED topic; the local-prod stack uses `prod.`
// (the kafka-connect collector connector reads prod.collector.event.v1). Default to that so the test
// exercises the LIVE sink without a manual override; override COLLECTOR_TOPIC for other envs.
const COLLECTOR_TOPIC = process.env['COLLECTOR_TOPIC'] ?? 'prod.collector.event.v1';
// DEDUP_SILVER_ASSERT=1 → the Silver exactly-once assertion becomes blocking (waits for a Silver
// job pass) instead of opportunistic-with-skip.
const SILVER_ASSERT_BLOCKING = process.env['DEDUP_SILVER_ASSERT'] === '1';

let producer: Producer;
let serving: SilverPool;
let infraUp = false;

function makeEnvelope(eventId: string, brandId: string): CollectorEnvelope {
  const occurredAt = new Date().toISOString();
  return {
    schema_version: '1',
    event_id: eventId,
    brand_id: brandId, // server-trusted lane: Silver admission trusts the claimed brand
    correlation_id: `corr-${eventId}`,
    event_name: EVENT_NAME,
    occurred_at: occurredAt,
    ingested_at: occurredAt,
    properties: {
      source: 'shopify',
      order_id: `ord-${eventId.slice(0, 8)}`,
      amount_minor: '100000',
      currency_code: 'INR',
      payment_method: 'prepaid',
    },
  };
}

/**
 * Poll a table over duckdb-serving until EVERY given event_id has at least `minPerId` rows, then return
 * the per-event_id row count map (last-seen counts at timeout). The replica reads Iceberg snapshots
 * fresh on plain re-query —
 * no cache-bust needed; rows become visible on the first snapshot after the Connect sink's ~30s
 * commit, so Bronze polls use generous timeouts.
 */
async function pollCountsByEventId(
  table: string,
  brandId: string,
  eventIds: string[],
  opts: { minPerId?: number; timeoutMs?: number; intervalMs?: number } = {},
): Promise<Map<string, number>> {
  const minPerId = opts.minPerId ?? 1;
  const interval = opts.intervalMs ?? 2000;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const placeholders = eventIds.map(() => '?').join(',');
  const sql =
    `SELECT event_id, COUNT(*) AS c FROM ${table} ` +
    `WHERE brand_id = ? AND event_id IN (${placeholders}) GROUP BY event_id`;
  const params = [brandId, ...eventIds];

  let counts = new Map<string, number>();
  for (;;) {
    const rows = await serving.query<{ event_id: string; c: number | string }>(sql, params);
    counts = new Map(rows.map((r) => [String(r.event_id), Number(r.c)]));
    const satisfied =
      counts.size >= eventIds.length && eventIds.every((id) => (counts.get(id) ?? 0) >= minPerId);
    if (satisfied) return counts;
    if (Date.now() >= deadline) return counts;
    await new Promise((r) => setTimeout(r, interval));
  }
}

beforeAll(async () => {
  try {
    serving = createDuckDbServingPool({ baseUrl: SERVING_URL });
    // Probe the exact read path the assertions use — if Bronze isn't reachable over serving, skip.
    await serving.query(`SELECT 1 FROM ${BRONZE_TABLE} LIMIT 1`);
    const kafka = new Kafka({ clientId: 'bronze-dedup-e2e-producer', brokers: KAFKA_BROKERS, retry: { retries: 3 } });
    producer = kafka.producer();
    await producer.connect();
    infraUp = true;
  } catch {
    infraUp = false;
  }
}, 30_000);

afterAll(async () => {
  await producer?.disconnect?.().catch(() => {});
  // The serving pool is a stateless HTTP adapter — no connection to close.
});

describe('Effectively-once (ADR-0010): append-only Bronze + Silver (brand_id,event_id) MERGE', () => {
  it('SKIP_IF_NO_LAKEHOUSE', () => {
    if (!infraUp) console.warn('[bronze-dedup.e2e] lakehouse/duckdb-serving unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('re-produced events land as ADDITIONAL Bronze rows; Silver holds exactly ONE row per event_id', async () => {
    if (!infraUp) return;

    // KNOWN event_ids — the business idempotency keys we will round-trip and re-deliver.
    const eventIds = Array.from({ length: N }, () => randomUUID());
    const envelopes = eventIds.map((id) => makeEnvelope(id, BRAND_A));

    // Pass 1 — first delivery (the "real" produce that succeeded).
    for (const env of envelopes) await produceCollectorEvent(producer, env, COLLECTOR_TOPIC);

    // Wait for all N to land in Bronze (Connect sink commit interval ~30s → generous timeout).
    const afterFirst = await pollCountsByEventId(BRONZE_TABLE, BRAND_A, eventIds, {
      minPerId: 1,
      timeoutMs: 150_000,
    });
    expect(afterFirst.size).toBe(N); // all N distinct events landed

    // Pass 2 — RE-PRODUCE the SAME event_ids. This is the at-least-once / crash-replay case: the
    // produce already succeeded once but the ack/delete didn't, so the SAME business events are
    // produced again (new offsets). NOTE (load-bearing, ADR-0010): Bronze is APPEND-ONLY under the
    // Connect sink — there is NO Bronze MERGE anymore, so BOTH copies MUST land as rows. Kafka
    // producer idempotence does not collapse these distinct send() calls either (per-PID/epoch,
    // intra-session retries only). The dedup that downstream consumers rely on is the SILVER
    // admission MERGE on (brand_id, event_id).
    for (const env of envelopes) await produceCollectorEvent(producer, env, COLLECTOR_TOPIC);

    // Append-only premise: each event_id now has BOTH copies in Bronze (>= 2 rows).
    const afterReplay = await pollCountsByEventId(BRONZE_TABLE, BRAND_A, eventIds, {
      minPerId: 2,
      timeoutMs: 150_000,
    });
    for (const id of eventIds) {
      expect(afterReplay.get(id) ?? 0).toBeGreaterThanOrEqual(2); // the replay APPENDED — no Bronze dedup
    }

    // Business-level effectively-once: silver_collector_event has EXACTLY ONE row per
    // (brand_id, event_id) — the Silver window+MERGE collapsed all Bronze copies.
    //
    // CONDITIONAL (see file docstring): Silver only advances when the Silver Spark job runs, which
    // this test cannot invoke. Default = one bounded opportunistic poll; if the job hasn't run since
    // the produce (0 of our ids visible), warn + skip. DEDUP_SILVER_ASSERT=1 = block up to 5 min
    // (operator runs `ONESHOT=1 pnpm dev:v4-refresh` in parallel).
    const silverTimeout = SILVER_ASSERT_BLOCKING ? 300_000 : 30_000;
    const silverCounts = await pollCountsByEventId(SILVER_TABLE, BRAND_A, eventIds, {
      minPerId: 1,
      timeoutMs: silverTimeout,
    });

    if (silverCounts.size === 0 && !SILVER_ASSERT_BLOCKING) {
      console.warn(
        '[bronze-dedup.e2e] Silver has no rows for the produced event_ids yet — the Silver job has ' +
          'not run since the produce. Silver exactly-once assertion SKIPPED (run ' +
          '`ONESHOT=1 pnpm dev:v4-refresh` and re-run, or set DEDUP_SILVER_ASSERT=1 to block on it).',
      );
      return;
    }

    // Once the Silver job has processed these events, the guarantee is exact: one row per id —
    // the Bronze duplicate NEVER became a second Silver row.
    expect(silverCounts.size).toBe(N);
    for (const id of eventIds) {
      expect(silverCounts.get(id)).toBe(1);
    }
    const total = [...silverCounts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(N);
  }, 700_000);
});
