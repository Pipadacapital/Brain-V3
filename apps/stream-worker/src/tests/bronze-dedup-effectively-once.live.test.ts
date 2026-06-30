/**
 * bronze-dedup-effectively-once.live.test.ts — Bronze "effectively-once" dedup, proven end-to-end.
 *
 * THE CONTRACT (DELIVERABLE 2.2): the Brain ingest path is at-least-once. The collector and every
 * connector re-emit on retry, a crashed worker re-produces in-flight events, and a replayed Kafka
 * offset re-delivers a record that was already landed. The dedup GUARANTEE that turns at-least-once
 * delivery into effectively-once Bronze is NOT the Kafka producer — it is the Spark sink's
 *   MERGE INTO brain_bronze.collector_events ... ON (brand_id, event_id) WHEN NOT MATCHED THEN INSERT
 * (db/iceberg/spark/bronze_materialize.py). WHEN NOT MATCHED makes a re-delivery of an already-landed
 * (brand_id, event_id) a no-op — never a second row.
 *
 * WHY KAFKA PRODUCER IDEMPOTENCE DOES NOT COVER THIS (the load-bearing comment):
 *   kafkajs/Kafka producer idempotence (enable.idempotence) dedups RETRIES *within a single producer
 *   session* — it is keyed by (producer-id [PID], epoch, per-partition sequence number). It guarantees
 *   that the broker writes a given (PID, seq) at most once even if the producer's internal retry fires.
 *   It does NOT cover:
 *     • two SEPARATE application-level `send()` calls of the same business event (distinct sequence
 *       numbers → both written) — the at-least-once shape a connector retry produces;
 *     • a worker CRASH-REPLAY where the produce succeeded but the downstream delete/ack did not, so the
 *       event is produced again by a NEW producer session (new PID/epoch → idempotence state reset →
 *       both written);
 *     • a Kafka consumer-offset REPLAY (the Spark checkpoint resume path documented in
 *       build_writer()): the same offset is re-read after an unclean kill.
 *   In all three the broker holds 2+ copies of the event. The (brand_id, event_id) MERGE is the ONLY
 *   thing that collapses them to one Bronze row. This test proves exactly that.
 *
 * SHAPE: produce N events with KNOWN event_ids → wait for them to land → RE-produce the SAME N
 * event_ids (the crash-replay) → poll Trino and assert EXACTLY ONE row per event_id (no dupes).
 *
 * Uses a SERVER_TRUSTED event type (order.live.v1) so the write/dedup mechanics are exercised without
 * the pixel-lane R2/R3 admission gate (that gate is covered by ingest-hardening.e2e.test.ts). The
 * envelope-level dedup (same event delivered twice back-to-back) is covered by bronze.e2e.test.ts; this
 * suite adds the N-event, produce→land→REPLAY (separate produce passes) effectively-once proof.
 *
 * BRAIN V4 SERVING: StarRocks is REMOVED — Bronze is read over Trino-over-Iceberg (createTrinoPool,
 * catalog='iceberg'), the same serving engine the app uses. Trino reads Iceberg snapshots directly, so
 * unlike the old StarRocks reader there is NO external-table metadata cache to bust (no REFRESH needed);
 * a freshly MERGEd row is visible on the next snapshot. The three-part name
 * `iceberg.brain_bronze.collector_events` resolves the raw Bronze table directly.
 *
 * REQUIRES the `lakehouse` docker profile (Kafka KRaft + Spark sink + Iceberg REST + MinIO + Trino on
 * :8090). The suite self-skips (SKIP_IF_NO_LAKEHOUSE) when the stack is not up — the operator runs it
 * live; CI does not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Kafka, type Producer } from 'kafkajs';
import { createTrinoPool, type SilverPool } from '@brain/metric-engine';
import { produceCollectorEvent, KAFKA_BROKERS, type CollectorEnvelope } from './helpers/iceberg-bronze.js';

const EVENT_NAME = 'order.live.v1'; // SERVER_TRUSTED lane — no pixel R2/R3 gate (see bronze_materialize.py)
const BRAND_A = '33333333-3333-4333-8333-333333333333'; // dedup-suite-specific brand (avoids cross-suite collisions)
const N = 5; // number of distinct known event_ids to round-trip

const TRINO_URL =
  process.env['TRINO_URL'] ??
  `http://${process.env['TRINO_HOST'] ?? '127.0.0.1'}:${process.env['TRINO_PORT'] ?? '8090'}`;
const TRINO_USER = process.env['TRINO_USER'] ?? 'brain';
// Three-part name — resolves the raw Bronze table directly through the iceberg catalog (no serving view).
const BRONZE_TABLE = 'iceberg.brain_bronze.collector_events';
// The running Spark sink consumes the env-PREFIXED topic; the local-prod stack uses `prod.` (verified:
// spark-bronze-sink COLLECTOR_TOPIC=prod.collector.event.v1). Default to that so the test exercises the
// LIVE sink without a manual override; override COLLECTOR_TOPIC for a differently-prefixed env.
const COLLECTOR_TOPIC = process.env['COLLECTOR_TOPIC'] ?? 'prod.collector.event.v1';

let producer: Producer;
let trino: SilverPool;
let infraUp = false;

function makeEnvelope(eventId: string, brandId: string): CollectorEnvelope {
  const occurredAt = new Date().toISOString();
  return {
    schema_version: '1',
    event_id: eventId,
    brand_id: brandId, // server-trusted lane: the Spark sink writes under the claimed brand
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
 * Poll Trino until at least `minDistinct` of the given event_ids are visible, then return the
 * per-event_id row count map. Trino reads Iceberg snapshots directly — no REFRESH/cache-bust needed.
 * GROUP BY event_id lets us assert EXACTLY ONE row per id (a dupe would surface as count 2+).
 */
async function pollBronzeCountsByEventId(
  brandId: string,
  eventIds: string[],
  opts: { minDistinct?: number; timeoutMs?: number; intervalMs?: number } = {},
): Promise<Map<string, number>> {
  const minDistinct = opts.minDistinct ?? eventIds.length;
  const interval = opts.intervalMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const placeholders = eventIds.map(() => '?').join(',');
  const sql =
    `SELECT event_id, COUNT(*) AS c FROM ${BRONZE_TABLE} ` +
    `WHERE brand_id = ? AND event_id IN (${placeholders}) GROUP BY event_id`;
  const params = [brandId, ...eventIds];

  let counts = new Map<string, number>();
  for (;;) {
    const rows = await trino.query<{ event_id: string; c: number | string }>(sql, params);
    counts = new Map(rows.map((r) => [String(r.event_id), Number(r.c)]));
    if (counts.size >= minDistinct) return counts;
    if (Date.now() >= deadline) return counts;
    await new Promise((r) => setTimeout(r, interval));
  }
}

beforeAll(async () => {
  try {
    trino = createTrinoPool({ baseUrl: TRINO_URL, user: TRINO_USER, catalog: 'iceberg' });
    // Probe the exact read path the assertions use — if Bronze isn't reachable over Trino, skip.
    await trino.query(`SELECT 1 FROM ${BRONZE_TABLE} LIMIT 1`);
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
  // The Trino pool is a stateless HTTP adapter — no connection to close.
});

describe('Bronze effectively-once: at-least-once delivery + MERGE on (brand_id,event_id)', () => {
  it('SKIP_IF_NO_LAKEHOUSE', () => {
    if (!infraUp) console.warn('[bronze-dedup.e2e] lakehouse/Trino unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('N events RE-produced (crash-replay) land as exactly ONE Bronze row each', async () => {
    if (!infraUp) return;

    // KNOWN event_ids — the idempotency keys we will round-trip and re-deliver.
    const eventIds = Array.from({ length: N }, () => randomUUID());
    const envelopes = eventIds.map((id) => makeEnvelope(id, BRAND_A));

    // Pass 1 — first delivery (the "real" produce that succeeded).
    for (const env of envelopes) await produceCollectorEvent(producer, env, COLLECTOR_TOPIC);

    // Wait for all N to land in Bronze.
    const afterFirst = await pollBronzeCountsByEventId(BRAND_A, eventIds, { minDistinct: N, timeoutMs: 90_000 });
    expect(afterFirst.size).toBe(N); // all N distinct events landed

    // Pass 2 — RE-PRODUCE the SAME event_ids. This is the at-least-once / crash-replay case:
    //   the produce already succeeded once but the ack/delete didn't, so the SAME business events are
    //   produced again. NOTE (load-bearing): Kafka producer idempotence is per-PID/epoch and dedups only
    //   intra-session retries — it does NOT collapse these distinct send() calls (and a real crash-replay
    //   uses a NEW producer session anyway). The Bronze MERGE WHEN NOT MATCHED is what dedups them.
    for (const env of envelopes) await produceCollectorEvent(producer, env, COLLECTOR_TOPIC);

    // Let the replay flow through at least one more Spark trigger cycle before asserting no doubling.
    await new Promise((r) => setTimeout(r, 16_000));

    const settled = await pollBronzeCountsByEventId(BRAND_A, eventIds, { minDistinct: N, timeoutMs: 60_000 });
    expect(settled.size).toBe(N); // still exactly N distinct events — no new event_ids appeared

    // The guarantee: EXACTLY ONE row per event_id — the replay never produced a second row.
    for (const id of eventIds) {
      expect(settled.get(id)).toBe(1);
    }

    // Belt-and-suspenders: total rows for these ids == N (no dupe inflated the count).
    const total = [...settled.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(N);
  }, 200_000);
});
