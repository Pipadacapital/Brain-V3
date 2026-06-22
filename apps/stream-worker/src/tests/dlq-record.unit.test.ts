/**
 * dlq-record.unit.test.ts — Unit tests for connector_dlq_record born-secure RLS invariant
 * and idempotent DLQ persistence (migration 0094 / DlqRecordRepository).
 *
 * Two test suites:
 *
 * 1. Born-secure invariant (static schema assertion):
 *    Verifies that the DlqRecordRepository's INSERT path always sets the brand GUC before
 *    writing, and that a second insert with the same (source_topic, partition, kafka_offset)
 *    returns { inserted: false } (idempotency). Uses a mock pg.Pool that intercepts queries
 *    and asserts the correct set_config call precedes every INSERT.
 *
 * 2. DlqRedriver persistence wiring:
 *    Verifies that when DlqRedriver scans a DLQ message, it calls dlqRecordRepo.persist()
 *    with the correct fields — idempotent on the Kafka address triple, errors swallowed.
 *
 * No live database required — all pg and Kafka seams are mocked.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { DlqRecordRepository, deriveDlqId, type DlqRecordInput } from '../infrastructure/pg/DlqRecordRepository.js';
import {
  DlqRedriver,
  H_ORIGINAL_TOPIC,
  H_DLQ_REASON,
} from '../infrastructure/kafka/DlqRedriver.js';
import type { IHeaders } from 'kafkajs';

// ── Helpers ───────────────────────────────────────────────────────────────────

function h(o: Record<string, string>): IHeaders {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
}

type QueryCall = { sql: string; params: unknown[] };

/**
 * Build a mock pg.PoolClient that records every query call and returns configurable
 * results for INSERT queries.
 */
function buildMockClient(insertRowCount: number): {
  client: PoolClient;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];

  const client = {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push({ sql: typeof sql === 'string' ? sql : String(sql), params: params ?? [] });
      // The INSERT returns rowCount to signal dedup hit vs new row.
      if (typeof sql === 'string' && sql.trimStart().toUpperCase().startsWith('INSERT')) {
        return { rowCount: insertRowCount, rows: insertRowCount > 0 ? [{ dlq_id: 'test-uuid' }] : [], command: 'INSERT', oid: 0, fields: [] } as QueryResult;
}
      return { rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  return { client, calls };
}

function buildMockPool(insertRowCount: number): { pool: Pool; calls: QueryCall[] } {
  const { client, calls } = buildMockClient(insertRowCount);
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, calls };
}

// ── Suite 1: DlqRecordRepository — RLS GUC discipline + idempotency ──────────

describe('DlqRecordRepository — born-secure RLS + idempotent insert', () => {
  const validInput: DlqRecordInput = {
    brandId:     'aaaa0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sourceTopic: 'dev.collector.event.v1.dlq',
    partition:   0,
    kafkaOffset: 42n,
    provider:    'shopify',
    payload:     { schema_version: '1', event_type: 'page.viewed' },
    errorClass:  'max_retry_exceeded',
    errorDetail: 'max_retry_exceeded: ECONNREFUSED postgres',
  };

  it('sets the brand GUC (set_config) BEFORE the INSERT in the same transaction', async () => {
    const { pool, calls } = buildMockPool(1);
    const repo = new DlqRecordRepository(pool);

    await repo.persist(validInput);

    // BEGIN is first.
    expect(calls[0]?.sql.trim().toUpperCase()).toBe('BEGIN');

    // set_config must appear before INSERT.
    const setConfigIdx = calls.findIndex(
      (c) => c.sql.includes('set_config') && c.sql.includes('app.current_brand_id'),
    );
    const insertIdx = calls.findIndex(
      (c) => c.sql.trimStart().toUpperCase().startsWith('INSERT'),
    );
    expect(setConfigIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(setConfigIdx).toBeLessThan(insertIdx);

    // set_config receives the correct brand_id.
    const setConfigCall = calls[setConfigIdx];
    expect(setConfigCall?.params[0]).toBe(validInput.brandId);

    // COMMIT is last.
    const lastSql = calls[calls.length - 1]?.sql.trim().toUpperCase();
    expect(lastSql).toBe('COMMIT');
  });

  it('returns { inserted: true } when the row is new (rowCount=1)', async () => {
    const { pool } = buildMockPool(1);
    const repo = new DlqRecordRepository(pool);
    const result = await repo.persist(validInput);
    expect(result.inserted).toBe(true);
    // dlqId must be the deterministic UUID v5 for this Kafka address.
    const expected = deriveDlqId(validInput.sourceTopic, validInput.partition, validInput.kafkaOffset);
    expect(result.dlqId).toBe(expected);
  });

  it('returns { inserted: false } on an idempotency hit (rowCount=0 from ON CONFLICT DO NOTHING)', async () => {
    // Second call — same Kafka address, same calendar day → ON CONFLICT fires.
    const { pool } = buildMockPool(0);
    const repo = new DlqRecordRepository(pool);
    const result = await repo.persist(validInput);
    expect(result.inserted).toBe(false);
  });

  it('deriveDlqId is deterministic — same inputs always produce the same UUID', () => {
    const id1 = deriveDlqId('dev.collector.event.v1.dlq', 0, 42n);
    const id2 = deriveDlqId('dev.collector.event.v1.dlq', 0, 42n);
    const id3 = deriveDlqId('dev.collector.event.v1.dlq', 0, 43n);
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    // Must be a valid UUID format.
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('passes kafka_offset as a string (bigint serialisation, I-S07)', async () => {
    const { pool, calls } = buildMockPool(1);
    const repo = new DlqRecordRepository(pool);
    await repo.persist({ ...validInput, kafkaOffset: 99999999999999n });

    const insertCall = calls.find((c) => c.sql.trimStart().toUpperCase().startsWith('INSERT'));
    expect(insertCall).toBeDefined();
    // params: $1=dlqId, $2=brandId, $3=sourceTopic, $4=partition, $5=kafkaOffset (as string)
    expect(insertCall?.params[4]).toBe('99999999999999');
  });

  it('rolls back and rethrows on a non-conflict error', async () => {
    // Track all SQL calls — including ROLLBACK — via a fresh spy that throws on INSERT.
    const sqlCalls: string[] = [];
    const rollbackSpy = vi.fn();

    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        const upper = (typeof sql === 'string' ? sql : String(sql)).trim().toUpperCase();
        sqlCalls.push(upper);
        if (upper === 'ROLLBACK') rollbackSpy();
        if (upper.startsWith('INSERT')) {
          throw new Error('connection terminated');
        }
        return { rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] } as QueryResult;
      }),
      release: vi.fn(),
    } as unknown as PoolClient;

    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const repo = new DlqRecordRepository(pool);

    await expect(repo.persist(validInput)).rejects.toThrow('connection terminated');

    // ROLLBACK must have been called.
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Suite 2: DlqRedriver — persistence wiring ────────────────────────────────

describe('DlqRedriver — dlqRecordRepo persistence wiring', () => {
  /**
   * Build a minimal KafkaJS mock that exposes a deliverMessage helper.
   */
  function buildKafkaMock() {
    let messageHandler: ((p: {
      topic: string;
      partition: number;
      message: {
        offset: string;
        key: Buffer | null;
        value: Buffer | null;
        headers?: IHeaders;
      };
    }) => Promise<void>) | null = null;

    const consumer = {
      connect:     vi.fn().mockResolvedValue(undefined),
      disconnect:  vi.fn().mockResolvedValue(undefined),
      subscribe:   vi.fn().mockResolvedValue(undefined),
      stop:        vi.fn().mockResolvedValue(undefined),
      commitOffsets: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockImplementation(
        async (opts: { eachMessage: typeof messageHandler }) => {
          messageHandler = opts.eachMessage;
        },
      ),
    };

    const producer = {
      connect:    vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send:       vi.fn().mockResolvedValue(undefined),
    };

    const kafka = {
      consumer: vi.fn().mockReturnValue(consumer),
      producer: vi.fn().mockReturnValue(producer),
    };

    return {
      kafka: kafka as unknown as import('kafkajs').Kafka,
      producer: producer as unknown as import('kafkajs').Producer,
      async deliver(payload: {
        topic: string;
        partition: number;
        message: {
          offset: string;
          key: Buffer | null;
          value: Buffer | null;
          headers?: IHeaders;
        };
      }): Promise<void> {
        if (!messageHandler) throw new Error('run() not called yet');
        await messageHandler(payload);
      },
    };
  }

  it('calls dlqRecordRepo.persist() for each scanned message with correct fields', async () => {
    const persistSpy = vi.fn().mockResolvedValue({ inserted: true });
    const mockRepo = { persist: persistSpy } as unknown as DlqRecordRepository;

    const { kafka, producer, deliver } = buildKafkaMock();
    const redriver = new DlqRedriver(
      kafka,
      producer,
      'test-group',
      () => '2026-06-22T00:00:00.000Z',
      mockRepo,
    );

    const dlqTopic = 'dev.collector.event.v1.dlq';
    const brandId = 'aaaa0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const payload = { brand_id: brandId, schema_version: '1', event_type: 'page.viewed' };

    // Start the redrive session (will idle-timeout after 10ms).
    const redrivePromise = redriver.redrive(dlqTopic, {
      dryRun: true,
      idleMs: 10,
      groupId: 'test-group',
    });

    // Yield to the microtask queue so redrive()'s async inits (connect/subscribe/run) execute
    // before we attempt to deliver a message (run() must be called first to register the handler).
    await new Promise<void>((r) => setTimeout(r, 0));

    // Deliver a synthetic DLQ message.
    await deliver({
      topic: dlqTopic,
      partition: 2,
      message: {
        offset: '77',
        key: null,
        value: Buffer.from(JSON.stringify(payload)),
        headers: h({
          [H_ORIGINAL_TOPIC]: 'dev.collector.event.v1',
          [H_DLQ_REASON]: 'max_retry_exceeded: ECONNREFUSED',
        }),
      },
    });

    await redrivePromise;

    // persist must have been called exactly once.
    expect(persistSpy).toHaveBeenCalledTimes(1);
    const call = persistSpy.mock.calls[0]?.[0] as DlqRecordInput;
    expect(call.brandId).toBe(brandId);
    expect(call.sourceTopic).toBe(dlqTopic);
    expect(call.partition).toBe(2);
    expect(call.kafkaOffset).toBe(77n);
    expect(call.errorClass).toBe('max_retry_exceeded');
  });

  it('does NOT throw when dlqRecordRepo.persist() rejects (fire-and-forget)', async () => {
    const persistSpy = vi.fn().mockRejectedValue(new Error('DB down'));
    const mockRepo = { persist: persistSpy } as unknown as DlqRecordRepository;

    const { kafka, producer, deliver } = buildKafkaMock();
    const redriver = new DlqRedriver(
      kafka,
      producer,
      'test-group',
      () => '2026-06-22T00:00:00.000Z',
      mockRepo,
    );

    const dlqTopic = 'dev.collector.event.v1.dlq';

    const redrivePromise = redriver.redrive(dlqTopic, { dryRun: true, idleMs: 10 });

    // Let async inits run before delivering.
    await new Promise<void>((r) => setTimeout(r, 0));

    await deliver({
      topic: dlqTopic,
      partition: 0,
      message: {
        offset: '1',
        key: null,
        value: Buffer.from(JSON.stringify({ brand_id: 'bbbb0001-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })),
        headers: h({ [H_DLQ_REASON]: 'max_retry_exceeded' }),
      },
    });

    // Must not throw even though persist() rejected.
    await expect(redrivePromise).resolves.toBeDefined();
  });

  it('skips persistence when no dlqRecordRepo is provided (backward compat)', async () => {
    // No repo supplied — redriver must still work normally.
    const { kafka, producer, deliver } = buildKafkaMock();
    const redriver = new DlqRedriver(
      kafka,
      producer,
      'test-group',
      () => '2026-06-22T00:00:00.000Z',
      // No repo
    );

    const dlqTopic = 'dev.collector.event.v1.dlq';
    const redrivePromise = redriver.redrive(dlqTopic, { dryRun: true, idleMs: 10 });

    // Let async inits run before delivering.
    await new Promise<void>((r) => setTimeout(r, 0));

    await deliver({
      topic: dlqTopic,
      partition: 0,
      message: { offset: '1', key: null, value: Buffer.from('{}'), headers: {} },
    });

    const report = await redrivePromise;
    expect(report.scanned).toBe(1);
  });
});
