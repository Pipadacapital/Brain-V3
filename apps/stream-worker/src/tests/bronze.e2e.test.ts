/**
 * bronze.e2e.test.ts — Bronze landing / dedup / tenant-scoping against the Iceberg SoR.
 *
 * ICEBERG-BRONZE (ADR-0010): the stream-worker no longer writes Bronze to PostgreSQL
 * (data_plane.bronze_events dropped — migration 0070). The SOLE Bronze writer is the Kafka Connect
 * Iceberg sink (the compose `kafka-connect` service) → `brain_bronze.collector_events_connect`,
 * read over duckdb-serving via the lift view `collector_events_connect_lifted`. These tests produce raw-JSON
 * collector envelopes to the topic and assert the Connect sink's Bronze contract end-to-end:
 *
 *   1. Landing:     a produced event becomes a Bronze row.
 *   2. Append-only: the same (brand_id, event_id) delivered twice (two offsets) → TWO Bronze rows.
 *                   Bronze has NO dedup under ADR-0010; the effectively-once collapse to one row per
 *                   (brand_id, event_id) is the Silver admission MERGE (silver_collector_event.py) —
 *                   proven in bronze-dedup-effectively-once.live.test.ts.
 *   3. Isolation:   tenant scoping is PREDICATE-BASED at the read seam (every read filters
 *                   `brand_id = ?`, mirroring metric-engine withSilverBrand / dq silver-reader) — a
 *                   brand_B-scoped read returns 0 rows for a brand_A event; brand_A → 1. (This
 *                   replaces the old PG-RLS isolation control; there is no PG RLS on the lakehouse.)
 *
 * Uses a SERVER_TRUSTED event type (order.live.v1) so these write/scoping mechanics are exercised
 * without the pixel-lane R2/R3 gate — under ADR-0010/ADR-0015 that gate lives in the Silver
 * admission keystone (silver_collector_event.py), not in front of Bronze.
 *
 * REQUIRES the `lakehouse` docker profile (Kafka + kafka-connect + Iceberg REST + MinIO + duckdb-serving).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Kafka, type Producer } from 'kafkajs';
import {
  makeBronzeServingPool,
  icebergBronzeAvailable,
  produceCollectorEvent,
  pollIcebergBronzeCount,
  KAFKA_BROKERS,
  type BronzePool,
  type CollectorEnvelope,
} from './helpers/iceberg-bronze.js';

const EVENT_NAME = 'order.live.v1';
const BRAND_A = '11111111-1111-4111-8111-111111111111';
const BRAND_B = '22222222-2222-4222-8222-222222222222';

let producer: Producer;
let sr: BronzePool;
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
    properties: { source: 'shopify', order_id: `ord-${eventId.slice(0, 8)}`, amount_minor: '100000', currency_code: 'INR', payment_method: 'prepaid' },
  };
}

beforeAll(async () => {
  try {
    sr = makeBronzeServingPool();
    if (!(await icebergBronzeAvailable(sr))) {
      infraUp = false;
      return;
    }
    const kafka = new Kafka({ clientId: 'bronze-e2e-producer', brokers: KAFKA_BROKERS, retry: { retries: 3 } });
    producer = kafka.producer();
    await producer.connect();
    infraUp = true;
  } catch {
    infraUp = false;
  }
}, 30_000);

afterAll(async () => {
  await producer?.disconnect?.().catch(() => {});
  await sr?.end?.().catch(() => {});
});

describe('E2E: produce event → Kafka Connect sink → Iceberg Bronze row', () => {
  it('SKIP_IF_NO_LAKEHOUSE', () => {
    if (!infraUp) console.warn('[bronze.e2e] lakehouse unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('a produced event lands as exactly one Bronze row (read over duckdb-serving via the lift view)', async () => {
    if (!infraUp) return;
    const eventId = randomUUID();
    await produceCollectorEvent(producer, makeEnvelope(eventId, BRAND_A));
    // Connect sink commit interval is ~30s — tolerate 30-60s+ land latency (ADR-0010).
    const count = await pollIcebergBronzeCount(sr, { brandId: BRAND_A, eventId }, { min: 1, timeoutMs: 120_000 });
    expect(count).toBe(1);
  }, 150_000);
});

describe('Append-only (ADR-0010): same (brand_id, event_id) delivered twice → TWO Bronze rows', () => {
  it('the re-delivery APPENDS a second row — Bronze has no dedup; Silver owns effectively-once', async () => {
    if (!infraUp) return;
    const eventId = randomUUID();
    const env = makeEnvelope(eventId, BRAND_A);
    // Deliver twice (same brand_id + event_id — the BUSINESS idempotency key, two Kafka offsets).
    await produceCollectorEvent(producer, env);
    await produceCollectorEvent(producer, env);

    // Both copies MUST land: Bronze is the verbatim broker history under the Connect sink.
    // The collapse to exactly one row per (brand_id, event_id) happens at the Silver admission
    // gate (silver_collector_event.py window+MERGE) — see bronze-dedup-effectively-once.live.test.ts.
    const settled = await pollIcebergBronzeCount(sr, { brandId: BRAND_A, eventId }, { min: 2, timeoutMs: 150_000 });
    expect(settled).toBe(2); // both deliveries landed — append-only, no Bronze-side dedup
  }, 180_000);
});

describe('Isolation: read-seam tenant scoping (brand_id predicate, not PG RLS)', () => {
  it('a brand_A event is invisible to a brand_B-scoped read; visible to brand_A', async () => {
    if (!infraUp) return;
    const eventId = randomUUID();
    await produceCollectorEvent(producer, makeEnvelope(eventId, BRAND_A));

    // Positive control: brand_A sees its own row (tolerate the Connect sink's ~30s commit).
    const correctBrand = await pollIcebergBronzeCount(sr, { brandId: BRAND_A, eventId }, { min: 1, timeoutMs: 120_000 });
    expect(correctBrand).toBe(1);

    // Negative control: the same event_id under a brand_B-scoped predicate → 0 rows (read-seam isolation).
    const wrongBrand = await pollIcebergBronzeCount(sr, { brandId: BRAND_B, eventId }, { min: 1, timeoutMs: 3_000 });
    expect(wrongBrand).toBe(0);
  }, 150_000);
});
