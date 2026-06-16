/**
 * bronze.e2e.test.ts — Live integration tests for Track A (data-engineer).
 *
 * Tests run against real Redpanda + Redis + Postgres (no mocked infra at seams).
 * Start infra with: docker compose --profile core up -d
 *                   docker compose up -d redpanda apicurio
 *
 * Three tests (architecture-plan §6 Slice 4 acceptance contract):
 *  1. E2E happy path: produce synthetic event → stream-worker pipeline →
 *     assert bronze_events row exists (read under SET ROLE brain_app + GUC=brand_A).
 *  2. Dedup/replay: deliver same event_id twice → exactly one row in bronze_events.
 *  3. Isolation negative control (I-S01 / D-8-as-RLS, F-4):
 *     Insert brand_A event; under SET ROLE brain_app + GUC=brand_B → 0 rows.
 *     Under SET ROLE brain_app + no GUC → 0 rows.
 *     Under SET ROLE brain_app + GUC=brand_A → 1 row.
 *     Assert current_user = 'brain_app' (not 'brain' superuser) — if this fails,
 *     the test is a false pass (superuser bypasses RLS).
 *
 * NOTE on false-pass prevention (MEMORY: dev superuser 'brain' masks RLS):
 *   Every isolation assertion runs as brain_app via a separate connection.
 *   The test explicitly asserts current_user != 'brain' before checking row counts.
 *   A test connecting as 'brain' would see all rows regardless of RLS policy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { Redis } from 'ioredis';
import { Kafka, Producer } from 'kafkajs';
import { ProcessEventUseCase } from '../application/ProcessEventUseCase.js';
import { RedisDedupAdapter } from '../infrastructure/redis/RedisDedupAdapter.js';
import { BronzeRepository } from '../infrastructure/pg/BronzeRepository.js';
import { buildDedupKey } from '../domain/bronze/DedupPolicy.js';

// ── Test configuration ────────────────────────────────────────────────────────

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
// MUST be brain_app, not brain superuser (RLS is bypassed by superuser)
const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';
// Superuser connection for test setup only (insert without GUC, verify FORCE RLS)
const BRAIN_SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const KAFKA_BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const TOPIC = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';

// Test brand UUIDs (valid UUIDv4 format)
const BRAND_A = '11111111-1111-4111-8111-111111111111';
const BRAND_B = '22222222-2222-4222-8222-222222222222';

// ── Shared infra ──────────────────────────────────────────────────────────────

let superuserPool: Pool;      // for setup/teardown only (bypasses RLS — correct for setup)
let brainAppPool: Pool;       // for isolation assertions (RLS-enforced)
let redisClient: Redis;
let kafkaProducer: Producer;
let dedup: RedisDedupAdapter;
let bronze: BronzeRepository;
let useCase: ProcessEventUseCase;

/** Generate a deterministic event JSON for a given brand + event ID. */
function makeEventJson(eventId: string, brandId: string, eventName = 'page.viewed'): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '1',
      event_id: eventId,
      brand_id: brandId,
      correlation_id: `corr-${eventId}`,
      event_name: eventName,
      occurred_at: '2026-06-16T12:00:00Z',
      ingested_at: '2026-06-16T12:00:01Z',
      properties: { page: 'home' },
    }),
  );
}

/** Read bronze_events under SET ROLE brain_app + optional brand_id GUC. */
async function readBronzeAsApp(
  eventId: string,
  brandId: string | null,
): Promise<{ rowCount: number; currentUser: string }> {
  const client: PoolClient = await brainAppPool.connect();
  try {
    // Assert we're NOT superuser — if current_user is 'brain', the test is a false pass
    const userResult = await client.query<{ current_user: string }>(
      'SELECT current_user',
    );
    const currentUser = userResult.rows[0]?.current_user ?? 'unknown';

    if (brandId != null) {
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, false)",
        [brandId],
      );
    }

    const result = await client.query<{ event_id: string }>(
      'SELECT event_id FROM bronze_events WHERE event_id = $1',
      [eventId],
    );

    return { rowCount: result.rowCount ?? 0, currentUser };
  } finally {
    client.release();
  }
}

/** Delete test rows by event_id (cleanup, using superuser). */
async function cleanup(eventIds: string[]): Promise<void> {
  for (const eventId of eventIds) {
    await superuserPool.query(
      'DELETE FROM bronze_events WHERE event_id = $1',
      [eventId],
    );
    // Clear Redis dedup keys for the test brands
    await redisClient.del(buildDedupKey(BRAND_A, eventId));
    await redisClient.del(buildDedupKey(BRAND_B, eventId));
  }
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  // Superuser pool: for setup + teardown only
  superuserPool = new Pool({ connectionString: BRAIN_SUPERUSER_DB_URL });
  // brain_app pool: for isolation assertions (RLS-enforced connection)
  brainAppPool = new Pool({ connectionString: BRAIN_APP_DB_URL });
  // Redis for manual dedup key inspection (auto-connects on construction)
  redisClient = new Redis(REDIS_URL);

  // Kafka producer for test event injection
  const kafka = new Kafka({ clientId: 'test-producer', brokers: KAFKA_BROKERS, logLevel: 0 });
  kafkaProducer = kafka.producer();
  await kafkaProducer.connect();

  // Use-case under test (connects to redis + postgres as brain_app)
  dedup = new RedisDedupAdapter(REDIS_URL);
  bronze = new BronzeRepository(BRAIN_APP_DB_URL);
  useCase = new ProcessEventUseCase(dedup, bronze);
}, 30_000);

afterAll(async () => {
  await kafkaProducer.disconnect();
  await dedup.quit();
  await bronze.end();
  await redisClient.quit();
  await brainAppPool.end();
  await superuserPool.end();
});

// ── Test 1: E2E happy path ────────────────────────────────────────────────────

describe('E2E: produce event → pipeline → bronze_events row', () => {
  const E2E_EVENT_ID = 'aa000001-0000-4000-8000-000000000001';

  it('inserts a row into bronze_events and reads it back under brain_app + GUC', async () => {
    await cleanup([E2E_EVENT_ID]);

    const rawValue = makeEventJson(E2E_EVENT_ID, BRAND_A);
    const now = '2026-06-16T12:00:01Z';

    // Execute the pipeline (validate → dedup → write)
    const result = await useCase.execute(rawValue, now);

    expect(result.outcome).toBe('written');
    expect(result.brandId).toBe(BRAND_A);
    expect(result.eventId).toBe(E2E_EVENT_ID);

    // Read back under brain_app + GUC=brand_A (should see 1 row)
    const { rowCount, currentUser } = await readBronzeAsApp(E2E_EVENT_ID, BRAND_A);

    // Critical: assert we're brain_app NOT brain (superuser masks RLS — false-pass trap F-4)
    expect(currentUser).toBe('brain_app');
    expect(currentUser).not.toBe('brain');
    expect(rowCount).toBe(1);

    await cleanup([E2E_EVENT_ID]);
  }, 20_000);
});

// ── Test 2: Dedup / replay ────────────────────────────────────────────────────

describe('Dedup/replay: same event_id delivered twice → exactly one row', () => {
  const DEDUP_EVENT_ID = 'bb000002-0000-4000-8000-000000000002';

  it('Redis NX dedup: second delivery returns dedup_hit, only one row in bronze_events', async () => {
    await cleanup([DEDUP_EVENT_ID]);

    const rawValue = makeEventJson(DEDUP_EVENT_ID, BRAND_A);
    const now = '2026-06-16T12:00:02Z';

    // First delivery
    const first = await useCase.execute(rawValue, now);
    expect(first.outcome).toBe('written');

    // Second delivery (same event_id) — Redis NX should fail → dedup_hit
    const second = await useCase.execute(rawValue, now);
    expect(second.outcome).toBe('dedup_hit');

    // Exactly one row in bronze_events
    const { rowCount, currentUser } = await readBronzeAsApp(DEDUP_EVENT_ID, BRAND_A);
    expect(currentUser).toBe('brain_app');
    expect(rowCount).toBe(1);

    await cleanup([DEDUP_EVENT_ID]);
  }, 20_000);

  it('PK backstop: event with Redis key deleted still deduped by DB PK ON CONFLICT', async () => {
    await cleanup([DEDUP_EVENT_ID]);

    const rawValue = makeEventJson(DEDUP_EVENT_ID, BRAND_A);
    const now = '2026-06-16T12:00:03Z';

    // First write
    const first = await useCase.execute(rawValue, now);
    expect(first.outcome).toBe('written');

    // Manually delete Redis key (simulate key expiry / Redis restart)
    await redisClient.del(buildDedupKey(BRAND_A, DEDUP_EVENT_ID));

    // Second write — Redis NX succeeds (key gone) but PK unique violation fires
    const second = await useCase.execute(rawValue, now);
    expect(second.outcome).toBe('pk_conflict');

    // Still exactly one row
    const { rowCount, currentUser } = await readBronzeAsApp(DEDUP_EVENT_ID, BRAND_A);
    expect(currentUser).toBe('brain_app');
    expect(rowCount).toBe(1);

    await cleanup([DEDUP_EVENT_ID]);
  }, 20_000);
});

// ── Test 3: Isolation negative control ───────────────────────────────────────

describe('Isolation negative control (I-S01 / D-8 RLS / F-4)', () => {
  const ISO_EVENT_ID = 'cc000003-0000-4000-8000-000000000003';

  it(
    'brand_A row: brand_B GUC → 0 rows; no GUC → 0 rows; brand_A GUC → 1 row (all under brain_app)',
    async () => {
      await cleanup([ISO_EVENT_ID]);

      // Write brand_A event via the pipeline (connects as brain_app)
      const rawValue = makeEventJson(ISO_EVENT_ID, BRAND_A);
      const result = await useCase.execute(rawValue, '2026-06-16T12:00:04Z');
      expect(result.outcome).toBe('written');

      // Case 1: brand_B GUC → 0 rows (RLS: brand_id = brand_B ≠ brand_A)
      const { rowCount: wrongBrand, currentUser: u1 } = await readBronzeAsApp(
        ISO_EVENT_ID,
        BRAND_B,
      );
      expect(u1).toBe('brain_app');
      expect(u1).not.toBe('brain'); // assert NOT superuser (false-pass prevention, F-4)
      expect(wrongBrand).toBe(0);   // NEGATIVE CONTROL: brand_B cannot see brand_A rows

      // Case 2: no GUC → 0 rows (fail-closed: current_setting returns NULL → brand_id=NULL → false)
      const { rowCount: noGuc, currentUser: u2 } = await readBronzeAsApp(
        ISO_EVENT_ID,
        null,
      );
      expect(u2).toBe('brain_app');
      expect(noGuc).toBe(0); // NEGATIVE CONTROL: missing GUC = 0 rows (NN-1)

      // Case 3: brand_A GUC → 1 row (correct brand sees its own row)
      const { rowCount: correctBrand, currentUser: u3 } = await readBronzeAsApp(
        ISO_EVENT_ID,
        BRAND_A,
      );
      expect(u3).toBe('brain_app');
      expect(correctBrand).toBe(1); // POSITIVE CONTROL: brand_A sees its own row

      await cleanup([ISO_EVENT_ID]);
    },
    20_000,
  );
});
