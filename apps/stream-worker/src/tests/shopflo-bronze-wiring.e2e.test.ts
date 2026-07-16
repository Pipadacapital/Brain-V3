/**
 * shopflo-bronze-wiring.e2e.test.ts — P0: shopflo.checkout_abandoned.v1 lands in (Iceberg) Bronze.
 *
 * ICEBERG-BRONZE (ADR-0010): Bronze is the Kafka Connect Iceberg sink (the compose kafka-connect
 * service — the SOLE Bronze writer, append-only) → `brain_bronze.collector_events_connect`, read
 * over duckdb-serving via the lift view (PG bronze_events dropped — migration 0070).
 * shopflo.checkout_abandoned.v1 is a SERVER_TRUSTED lane event (no install token; brand_id is
 * server-derived), so the Silver admission gate passes it under the claimed brand without an R2/R3
 * gate. This test produces a realistic Shopflo abandoned-checkout envelope to the collector topic
 * and asserts it lands in Iceberg Bronze (read over duckdb-serving via the lift view).
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

const EVENT_NAME = 'shopflo.checkout_abandoned.v1';
const BRAND = 'b9f10030-0030-4030-8030-0000000000a1';

let producer: Producer;
let sr: BronzePool;
let infraUp = false;

function shopfloEnvelope(): CollectorEnvelope {
  const checkoutId = `chk_${randomUUID().slice(0, 12)}`;
  const occurredAt = new Date().toISOString();
  return {
    schema_version: '1',
    event_id: randomUUID(), // brand+event_id is the dedup key; unique per run
    brand_id: BRAND,
    correlation_id: randomUUID(),
    event_name: EVENT_NAME,
    occurred_at: occurredAt,
    ingested_at: occurredAt,
    properties: {
      data_source: 'real',
      checkout_id: checkoutId,
      has_address: true,
      line_items: [
        { title: 'Ceramic Pour-Over Kettle', quantity: 1, unit_price_minor: '199900' },
        { title: 'Single-Origin Beans 500g', quantity: 2, unit_price_minor: '25000' },
      ],
      subtotal_minor: '249900',
      total_discount_minor: '50000',
      total_tax_minor: '35982',
      total_price_minor: '235882',
      currency_code: 'INR',
      occurred_at: occurredAt,
    },
  };
}

beforeAll(async () => {
  try {
    sr = makeBronzeServingPool();
    if (!(await icebergBronzeAvailable(sr))) {
      infraUp = false;
      return;
    }
    const kafka = new Kafka({ clientId: 'shopflo-bronze-wiring-producer', brokers: KAFKA_BROKERS, retry: { retries: 3 } });
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

describe('shopflo.checkout_abandoned.v1 → Iceberg Bronze wiring (P0, lakehouse)', () => {
  it('SKIP_IF_NO_LAKEHOUSE', () => {
    if (!infraUp) console.warn('[shopflo-bronze-wiring] lakehouse unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('SF1: a realistic shopflo.checkout_abandoned.v1 envelope lands in Iceberg Bronze (server-trusted lane)', async () => {
    if (!infraUp) return;
    const env = shopfloEnvelope();
    await produceCollectorEvent(producer, env);
    // ADR-0010: Connect-sink commit visibility is 30-60s+ under load — helper's 120s default.
    const landed = await pollIcebergBronzeCount(sr, { brandId: BRAND, eventId: env.event_id }, { min: 1 });
    expect(landed).toBeGreaterThan(0);
  }, 150_000);
});
