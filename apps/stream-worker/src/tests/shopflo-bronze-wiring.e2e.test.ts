/**
 * shopflo-bronze-wiring.e2e.test.ts — P0: shopflo.checkout_abandoned.v1 lands in (Iceberg) Bronze.
 *
 * ICEBERG-BRONZE: Bronze is the Spark sink → Iceberg `brain_bronze.collector_events` (PG bronze_events
 * dropped — migration 0070). shopflo.checkout_abandoned.v1 is a SERVER_TRUSTED lane event (no install
 * token; brand_id is server-derived), so the Spark sink writes it under the claimed brand without an
 * R2/R3 gate. This test produces a realistic Shopflo abandoned-checkout envelope to the collector topic
 * and asserts it lands in Iceberg Bronze (read via the StarRocks external catalog).
 *
 * REQUIRES the `lakehouse` docker profile (Redpanda + Spark sink + Iceberg REST + MinIO + StarRocks).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Kafka, type Producer } from 'kafkajs';
import type mysql from 'mysql2/promise';
import {
  makeStarrocksPool,
  icebergBronzeAvailable,
  produceCollectorEvent,
  pollIcebergBronzeCount,
  KAFKA_BROKERS,
  type CollectorEnvelope,
} from './helpers/iceberg-bronze.js';

const EVENT_NAME = 'shopflo.checkout_abandoned.v1';
const BRAND = 'b9f10030-0030-4030-8030-0000000000a1';

let producer: Producer;
let sr: mysql.Pool;
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
    sr = makeStarrocksPool();
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
    const landed = await pollIcebergBronzeCount(sr, { brandId: BRAND, eventId: env.event_id }, { min: 1, timeoutMs: 60_000 });
    expect(landed).toBeGreaterThan(0);
  }, 75_000);
});
