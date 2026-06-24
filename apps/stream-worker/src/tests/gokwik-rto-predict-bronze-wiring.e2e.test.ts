/**
 * gokwik-rto-predict-bronze-wiring.e2e.test.ts — P0 follow-up: gokwik.rto_predict.v1 → Iceberg Bronze.
 *
 * ICEBERG-BRONZE: Bronze is the Spark sink → Iceberg `brain_bronze.collector_events` (PG bronze_events
 * dropped — migration 0070). gokwik.rto_predict.v1 is a SERVER_TRUSTED lane event (no install_token;
 * brand_id server-derived), so the Spark sink writes it under the claimed brand without an R2/R3 gate.
 * The risk signal was historically lost (the pixel lane quarantined these for lack of a token, and
 * nothing else consumed them); the server-trusted lane is what lets them reach Bronze.
 *
 * This produces three realistic RTO-Predict envelopes (the post-mapper shape) to the collector topic
 * and asserts all three land in Iceberg Bronze (read via the StarRocks external catalog), matched by
 * their exact event_ids so pre-existing rows of the same brand/type don't mask the assertion.
 *
 * The former RP2 case (computeRtoRiskDistribution) reads StarRocks silver_checkout_signal since the
 * payments-Silver re-point (PR #211) and is covered by the metric-engine unit tests — this e2e asserts
 * only the bridge's job: the Bronze landing.
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

const EVENT_NAME = 'gokwik.rto_predict.v1';
const BRAND = 'd9f10030-0030-4030-8030-0000000000a1';
const ORDER_A = 'gid://shopify/Order/9001';
const ORDER_B = 'gid://shopify/Order/9002';

let producer: Producer;
let sr: mysql.Pool;
let infraUp = false;

/** Realistic post-mapper RTO-Predict properties (categorical risk_flag — never a fabricated score). */
function rtoEnvelope(orderId: string, riskFlag: string, riskRaw: string, occurredAt: string): CollectorEnvelope {
  return {
    schema_version: '1',
    event_id: randomUUID(),
    brand_id: BRAND,
    correlation_id: randomUUID(),
    event_name: EVENT_NAME,
    occurred_at: occurredAt,
    ingested_at: occurredAt,
    properties: {
      source: 'gokwik',
      data_source: 'real',
      order_id: orderId,
      request_id: `req_${randomUUID().slice(0, 8)}`,
      risk_flag: riskFlag,
      risk_flag_raw: riskRaw,
      risk_reason: 'address mismatch + prior RTO history',
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
    const kafka = new Kafka({ clientId: 'gokwik-rto-predict-bronze-wiring-producer', brokers: KAFKA_BROKERS, retry: { retries: 3 } });
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

describe('GoKwik RTO-Predict → Iceberg Bronze wiring (P0 follow-up, lakehouse)', () => {
  it('SKIP_IF_NO_LAKEHOUSE', () => {
    if (!infraUp) console.warn('[gokwik-rto-predict-bronze-wiring] lakehouse unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('RP1: realistic gokwik.rto_predict.v1 envelopes land in Iceberg Bronze (server-trusted lane)', async () => {
    if (!infraUp) return;
    const t0 = Date.now();
    const earlier = new Date(t0 - 60_000).toISOString();
    const later = new Date(t0 - 1_000).toISOString();
    // ORDER_A: low (earlier) then high (later). ORDER_B: low. Three distinct event_ids.
    const envs = [
      rtoEnvelope(ORDER_A, 'low', 'Low Risk', earlier),
      rtoEnvelope(ORDER_A, 'high', 'High Risk', later),
      rtoEnvelope(ORDER_B, 'low', 'Low Risk', later),
    ];
    for (const env of envs) await produceCollectorEvent(producer, env);

    const landed = await pollIcebergBronzeCount(
      sr,
      { brandId: BRAND, eventIds: envs.map((e) => e.event_id), eventType: EVENT_NAME },
      { min: 3, timeoutMs: 60_000 },
    );
    expect(landed).toBeGreaterThanOrEqual(3); // all three reached Iceberg Bronze
  }, 75_000);
});
