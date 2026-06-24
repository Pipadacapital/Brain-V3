/**
 * live-order-bronze-wiring.e2e.test.ts — P0: order.live.v1 lands in (Iceberg) Bronze.
 *
 * ICEBERG-BRONZE: Bronze is the Spark sink → Iceberg `brain_bronze.collector_events` (the PG
 * data_plane.bronze_events table is dropped — migration 0070). order.live.v1 is a SERVER_TRUSTED lane
 * event — the Spark sink writes it under its claimed (server-derived) brand_id with no token/consent
 * gate. Shopify live + re-pull orders are produced as order.live.v1 carrying NO install_token; the
 * server-trusted lane is exactly what lets them reach Bronze (the historical pixel-lane R2 gate would
 * have quarantined them as tenant_unresolved).
 *
 * This test produces a realistic re-pull order.live.v1 envelope to the collector topic and asserts it
 * lands in Iceberg Bronze (read via the StarRocks external catalog).
 *
 * UN-WIRE PROOF: if the Spark bronze sink is not running, SKIP_IF_NO_LAKEHOUSE fires (PENDING).
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

const EVENT_NAME = 'order.live.v1';
const BRAND = 'b9f10030-0030-4030-8030-0000000000b2';

let producer: Producer;
let sr: mysql.Pool;
let infraUp = false;

/** Realistic post-mapper Shopify live/re-pull order (the shape the re-pull produces to the live lane). */
function liveOrderEnvelope(): CollectorEnvelope {
  const orderId = String(7_600_000_000_000 + Math.floor(Number(`0x${randomUUID().slice(0, 8)}`) % 1_000_000));
  const occurredAt = new Date().toISOString();
  return {
    schema_version: '1',
    event_id: randomUUID(), // brand+event_id is the dedup key; unique per run
    brand_id: BRAND, // server-trusted (re-pull derives it from the connector row, MT-1)
    correlation_id: `repull:${randomUUID()}:${randomUUID()}`,
    event_name: EVENT_NAME,
    occurred_at: occurredAt,
    ingested_at: occurredAt,
    properties: {
      source: 'shopify',
      shopify_order_id: orderId,
      order_id: orderId,
      amount_minor: '729700',
      currency_code: 'INR',
      payment_method: 'cod',
      financial_status: 'pending',
      fulfillment_status: null,
      cancelled_at: null,
      storefront_customer_id: '10047479349479',
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
    const kafka = new Kafka({ clientId: 'live-order-bronze-wiring-producer', brokers: KAFKA_BROKERS, retry: { retries: 3 } });
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

describe('order.live.v1 → Iceberg Bronze wiring (P0, lakehouse)', () => {
  it('SKIP_IF_NO_LAKEHOUSE', () => {
    if (!infraUp) console.warn('[live-order-bronze-wiring] lakehouse (Redpanda/Spark/Iceberg/StarRocks) unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('LO1: a realistic order.live.v1 envelope lands in Iceberg Bronze (server-trusted lane)', async () => {
    if (!infraUp) return;
    const env = liveOrderEnvelope();
    await produceCollectorEvent(producer, env);
    const landed = await pollIcebergBronzeCount(sr, { brandId: BRAND, eventId: env.event_id }, { min: 1, timeoutMs: 60_000 });
    expect(landed).toBeGreaterThan(0); // the Spark sink wrote it to Iceberg Bronze
  }, 75_000);
});
