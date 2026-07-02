/**
 * bronze.e2e.test.ts — Bronze landing / dedup / tenant-scoping against the Iceberg SoR.
 *
 * ICEBERG-BRONZE: the stream-worker no longer writes Bronze to PostgreSQL (data_plane.bronze_events
 * dropped — migration 0070). The SOLE Bronze writer is the Spark sink → Iceberg
 * `brain_bronze.collector_events`, read via the StarRocks external catalog. These tests produce
 * raw-JSON collector envelopes to the topic and assert the Spark sink's Bronze contract end-to-end:
 *
 *   1. Landing:   a produced event becomes a Bronze row.
 *   2. Dedup:     the same (brand_id, event_id) delivered twice → exactly ONE row (Spark MERGE
 *                 WHEN NOT MATCHED — the append-only idempotency invariant I-E02, the Iceberg
 *                 equivalent of the old Redis-NX + PG-PK backstop).
 *   3. Isolation: tenant scoping is PREDICATE-BASED at the read seam (every read filters
 *                 `brand_id = ?`, mirroring metric-engine withSilverBrand / dq silver-reader) — a
 *                 brand_B-scoped read returns 0 rows for a brand_A event; brand_A → 1. (This replaces
 *                 the old PG-RLS isolation control; there is no PG RLS on the lakehouse.)
 *
 * Uses a SERVER_TRUSTED event type (order.live.v1) so these write/dedup/scoping mechanics are exercised
 * without the pixel-lane R2/R3 gate — that gate is covered end-to-end by ingest-hardening.e2e.test.ts.
 *
 * REQUIRES the `lakehouse` docker profile (Redpanda + Spark sink + Iceberg REST + MinIO + StarRocks).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Kafka, type Producer } from 'kafkajs';
import {
  makeBronzeTrinoPool,
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
    sr = makeBronzeTrinoPool();
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

describe('E2E: produce event → Spark sink → Iceberg Bronze row', () => {
  it('SKIP_IF_NO_LAKEHOUSE', () => {
    if (!infraUp) console.warn('[bronze.e2e] lakehouse unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('a produced event lands as exactly one Bronze row (read via StarRocks)', async () => {
    if (!infraUp) return;
    const eventId = randomUUID();
    await produceCollectorEvent(producer, makeEnvelope(eventId, BRAND_A));
    const count = await pollIcebergBronzeCount(sr, { brandId: BRAND_A, eventId }, { min: 1, timeoutMs: 60_000 });
    expect(count).toBe(1);
  }, 75_000);
});

describe('Dedup/replay: same (brand_id, event_id) delivered twice → exactly one row (I-E02)', () => {
  it('Spark MERGE WHEN NOT MATCHED collapses the re-delivery to one Bronze row', async () => {
    if (!infraUp) return;
    const eventId = randomUUID();
    const env = makeEnvelope(eventId, BRAND_A);
    // Deliver twice (same brand_id + event_id) — the idempotency key.
    await produceCollectorEvent(producer, env);
    await produceCollectorEvent(producer, env);

    // Wait for the row to land, then settle one more Spark trigger cycle and assert it never doubled.
    const landed = await pollIcebergBronzeCount(sr, { brandId: BRAND_A, eventId }, { min: 1, timeoutMs: 60_000 });
    expect(landed).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 14_000)); // ~1 extra trigger cycle for a possible 2nd-batch insert
    const settled = await pollIcebergBronzeCount(sr, { brandId: BRAND_A, eventId }, { min: 1, timeoutMs: 5_000 });
    expect(settled).toBe(1); // exactly one — MERGE deduped the replay
  }, 90_000);
});

describe('Isolation: read-seam tenant scoping (brand_id predicate, not PG RLS)', () => {
  it('a brand_A event is invisible to a brand_B-scoped read; visible to brand_A', async () => {
    if (!infraUp) return;
    const eventId = randomUUID();
    await produceCollectorEvent(producer, makeEnvelope(eventId, BRAND_A));

    // Positive control: brand_A sees its own row.
    const correctBrand = await pollIcebergBronzeCount(sr, { brandId: BRAND_A, eventId }, { min: 1, timeoutMs: 60_000 });
    expect(correctBrand).toBe(1);

    // Negative control: the same event_id under a brand_B-scoped predicate → 0 rows (read-seam isolation).
    const wrongBrand = await pollIcebergBronzeCount(sr, { brandId: BRAND_B, eventId }, { min: 1, timeoutMs: 3_000 });
    expect(wrongBrand).toBe(0);
  }, 75_000);
});
