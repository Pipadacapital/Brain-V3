/**
 * Durability + Edge acceptance tests (Slice 3 — Track B)
 *
 * REQUIRES: live Postgres on DATABASE_URL + live Redpanda on KAFKA_BROKERS.
 * Run with: pnpm --filter @brain/collector test:unit (or vitest run tests/)
 *
 * These tests prove the two core Track B invariants:
 *
 * TEST 1 — ACK ordering proof (D-1 / I-ST02):
 *   POST /collect → HTTP 200 → row in collector_spool with status='pending'
 *   The spool INSERT commits BEFORE the HTTP reply is sent.
 *
 * TEST 2 — Redpanda-down durability proof (D-1 / F-3 / I-ST02):
 *   With Redpanda unreachable (bad broker address):
 *     POST /collect → HTTP 200 (ACK) → row in spool (pending)
 *     Drainer attempts produce → fails → row stays 'pending' (spool holds)
 *     On Redpanda recovery (real broker) → drainer drains → row becomes 'drained'
 *
 * NOTE: the isolation test (bronze_events RLS) is Track A (stream-worker / data-engineer).
 * The Redpanda-down test does NOT mock the produce — it uses a bad broker address so the
 * real kafkajs connect/send path fails, proving the spool hold code path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { PgSpoolRepository } from '../src/infrastructure/pg-spool.repository.js';
import { CollectorKafkaProducer } from '../src/infrastructure/kafka-producer.js';
import { AcceptEventUseCase } from '../src/application/accept-event.usecase.js';
import { DrainEventsUseCase } from '../src/application/drain-events.usecase.js';
import { registerCollectRoute } from '../src/interfaces/rest/collect.route.js';
import { registerHealthRoutes } from '../src/interfaces/rest/health.route.js';
import pg from 'pg';

const { Pool } = pg;

// ── Test config ───────────────────────────────────────────────────────────────

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://brain:brain@localhost:5432/brain';

const KAFKA_BROKERS =
  process.env['KAFKA_BROKERS'] ?? 'localhost:9092';

const DEAD_BROKER = 'localhost:19999'; // guaranteed-unreachable broker

const TOPIC = 'dev.collector.event.v1';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSyntheticEvent() {
  return {
    event_id: crypto.randomUUID(),
    brand_id: crypto.randomUUID(),
    correlation_id: `test-${crypto.randomUUID()}`,
    event_name: 'page.viewed',
    occurred_at: new Date().toISOString(),
    schema_version: '1',
  };
}

async function buildTestServer(spool: PgSpoolRepository): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const acceptUseCase = new AcceptEventUseCase(spool);
  registerHealthRoutes(app, spool);
  registerCollectRoute(app, acceptUseCase);
  await app.ready();
  return app;
}

async function getSpoolRow(
  pool: pg.Pool,
  spoolId: string,
): Promise<{ status: string; raw_body: Record<string, unknown> } | null> {
  const result = await pool.query<{ status: string; raw_body: Record<string, unknown> }>(
    'SELECT status, raw_body FROM collector_spool WHERE id = $1',
    [spoolId],
  );
  return result.rows[0] ?? null;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Track B — Accept-before-validate + Durability', () => {
  let spool: PgSpoolRepository;
  let rawPool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    spool = new PgSpoolRepository(DATABASE_URL);
    rawPool = new Pool({ connectionString: DATABASE_URL });
    app = await buildTestServer(spool);
  });

  afterAll(async () => {
    await app.close();
    await (spool as PgSpoolRepository & { end(): Promise<void> }).end();
    await rawPool.end();
  });

  // ── TEST 1: ACK ordering — POST → 200 → spool row present ───────────────────
  describe('ACK ordering proof (D-1)', () => {
    it('POST /collect returns HTTP 200 and the row is in collector_spool BEFORE any Kafka produce', async () => {
      const event = makeSyntheticEvent();

      // Send POST using Fastify inject (in-process, no real network needed for this test).
      const response = await app.inject({
        method: 'POST',
        url: '/collect',
        headers: { 'content-type': 'application/json', 'x-correlation-id': event.correlation_id },
        payload: event,
      });

      // ACK must be HTTP 200
      expect(response.statusCode).toBe(200);
      const body = response.json<{ accepted: boolean; received_at: string }>();
      expect(body.accepted).toBe(true);
      expect(body.received_at).toBeTruthy();

      // spool_id is returned in the header — verify the row exists
      const spoolId = response.headers['x-spool-id'];
      expect(spoolId).toBeTruthy();

      // Verify the row is in collector_spool
      const row = await getSpoolRow(rawPool, String(spoolId));
      expect(row).not.toBeNull();
      expect(row!.status).toBe('pending');
      // The raw_body must contain the original event fields
      expect(row!.raw_body['event_id']).toBe(event.event_id);
      expect(row!.raw_body['brand_id']).toBe(event.brand_id);
    });

    it('POST /v1/events returns HTTP 202 and row is in spool', async () => {
      const event = makeSyntheticEvent();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: { 'content-type': 'application/json' },
        payload: event,
      });

      expect(response.statusCode).toBe(202);
      const spoolId = response.headers['x-spool-id'];
      expect(spoolId).toBeTruthy();

      const row = await getSpoolRow(rawPool, String(spoolId));
      expect(row).not.toBeNull();
      expect(row!.status).toBe('pending');
    });
  });

  // ── TEST 2: Redpanda-down durability ─────────────────────────────────────────
  describe('Redpanda-down durability proof (D-1 / F-3 / I-ST02)', () => {
    it('event is ACKd (200) and spool row stays pending when Redpanda is unreachable', async () => {
      const event = makeSyntheticEvent();

      // Step 1: POST and get ACK — Redpanda is not involved in this path at all (D-1).
      const response = await app.inject({
        method: 'POST',
        url: '/collect',
        headers: { 'content-type': 'application/json' },
        payload: event,
      });

      // ACK: must be 200 regardless of Redpanda state.
      expect(response.statusCode).toBe(200);
      const spoolId = response.headers['x-spool-id'];
      expect(spoolId).toBeTruthy();

      // Step 2: Verify row is in spool (pending).
      const row = await getSpoolRow(rawPool, String(spoolId));
      expect(row).not.toBeNull();
      expect(row!.status).toBe('pending');
      expect(row!.raw_body['event_id']).toBe(event.event_id);

      // Step 3: Attempt to drain via a BAD broker — producer will fail.
      const deadProducer = new CollectorKafkaProducer({
        brokers: [DEAD_BROKER],
        clientId: 'test-dead-producer',
        topic: TOPIC,
      });

      // DrainEventsUseCase will catch the produce error and leave row pending (F-3).
      const drainWithDeadBroker = new DrainEventsUseCase(spool, deadProducer, 10);
      const drained = await drainWithDeadBroker.execute();

      // Row must still be pending — the drainer HOLDS, does NOT drop.
      expect(drained).toBe(0);
      const rowAfterDeadDrain = await getSpoolRow(rawPool, String(spoolId));
      expect(rowAfterDeadDrain!.status).toBe('pending');

      // Step 4: "Recover" Redpanda — drain with the real broker.
      const liveProducer = new CollectorKafkaProducer({
        brokers: KAFKA_BROKERS.split(',').map((b) => b.trim()),
        clientId: 'test-live-producer',
        topic: TOPIC,
      });

      try {
        await liveProducer.connect();
        const drainWithLiveBroker = new DrainEventsUseCase(spool, liveProducer, 10);
        const drainedOnRecovery = await drainWithLiveBroker.execute();

        // On recovery, the row must be drained (may drain other pending rows too, >= 1).
        expect(drainedOnRecovery).toBeGreaterThanOrEqual(1);

        // Our specific row must now be 'drained'.
        const rowAfterRecovery = await getSpoolRow(rawPool, String(spoolId));
        expect(rowAfterRecovery!.status).toBe('drained');
        expect(rowAfterRecovery!.raw_body['event_id']).toBe(event.event_id);
      } finally {
        await liveProducer.disconnect();
      }
    });
  });

  // ── TEST 2b: Row-claim isolation (AUD-PERF-006) ──────────────────────────────
  describe('claimPending row-claim (FOR UPDATE SKIP LOCKED)', () => {
    it('two concurrent claims never see the same spool row; rollback leaves rows pending', async () => {
      // Spool 4 events directly (same path as the HTTP handler).
      const acceptUseCase = new AcceptEventUseCase(spool);
      const ourIds: bigint[] = [];
      for (let i = 0; i < 4; i++) {
        const { spoolId } = await acceptUseCase.execute(makeSyntheticEvent());
        ourIds.push(spoolId);
      }

      // Claim concurrently — the second claim must SKIP the first claim's locked rows.
      const claimA = await spool.claimPending(2);
      const claimB = await spool.claimPending(10_000);
      try {
        const idsA = new Set(claimA.entries.map((e) => e.id.toString()));
        const idsB = new Set(claimB.entries.map((e) => e.id.toString()));
        for (const id of idsA) expect(idsB.has(id)).toBe(false); // disjoint — no double-produce
        // Every one of our rows is visible to exactly one claimer (none lost, none duplicated).
        for (const id of ourIds) {
          const inA = idsA.has(id.toString());
          const inB = idsB.has(id.toString());
          expect(inA !== inB).toBe(true);
        }
      } finally {
        await claimA.rollback();
        await claimB.rollback();
      }

      // Rollback released the claims without touching status — all rows still pending.
      for (const id of ourIds) {
        const row = await getSpoolRow(rawPool, id.toString());
        expect(row!.status).toBe('pending');
      }

      // Cleanup: drain our synthetic rows out of the pending set (mark drained + commit).
      const cleanup = await spool.claimPending(10_000);
      await cleanup.markDrained(cleanup.entries.map((e) => e.id));
      await cleanup.commit();
    });
  });

  // ── TEST 3: Health endpoint ──────────────────────────────────────────────────
  describe('Health endpoints', () => {
    it('GET /healthz returns 200 alive', async () => {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ status: string }>().status).toBe('alive');
    });

    it('GET /readyz returns 200 when spool DB is reachable', async () => {
      const response = await app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ status: string }>().status).toBe('ready');
    });
  });
});
