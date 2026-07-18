/**
 * dlq-record.unit.test.ts — Unit tests for connector_dlq_record born-secure RLS invariant
 * and idempotent DLQ persistence (migration 0094 / DlqRecordRepository).
 *
 * Born-secure invariant (static schema assertion):
 * Verifies that the DlqRecordRepository's INSERT path always sets the brand GUC before
 * writing, and that a second insert with the same (source_topic, partition, kafka_offset)
 * returns { inserted: false } (idempotency). Uses a mock pg.Pool that intercepts queries
 * and asserts the correct SET LOCAL brand-GUC statement precedes every INSERT.
 *
 * (The former Suite 2 — DlqRedriver persistence wiring — is gone with the Kafka DLQ redrive
 * machinery: ADR-0015 WS4 removed the last stream-worker Kafka consumer, so no `.dlq` Kafka
 * topics remain. DlqRecordRepository itself STAYS: it is the PG dead-letter sink of the
 * generic ingestion-backfill framework — connectors.connector_dlq_record.)
 *
 * No live database required — the pg seam is mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { DlqRecordRepository, deriveDlqId, type DlqRecordInput } from '../infrastructure/pg/DlqRecordRepository.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── DlqRecordRepository — RLS GUC discipline + idempotency ───────────────────

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

  it('sets the brand GUC (SET LOCAL) BEFORE the INSERT in the same transaction', async () => {
    const { pool, calls } = buildMockPool(1);
    const repo = new DlqRecordRepository(pool);

    await repo.persist(validInput);

    // BEGIN is first.
    expect(calls[0]?.sql.trim().toUpperCase()).toBe('BEGIN');

    // The brand-GUC write must appear before INSERT. The repository builds it via
    // @brain/db buildContextGucSql, which emits `SET LOCAL app.current_brand_id = '<uuid>'`
    // (SET LOCAL cannot be parameterised — the UUID-validated value is inlined).
    const setGucIdx = calls.findIndex(
      (c) => c.sql.includes('SET LOCAL') && c.sql.includes('app.current_brand_id'),
    );
    const insertIdx = calls.findIndex(
      (c) => c.sql.trimStart().toUpperCase().startsWith('INSERT'),
    );
    expect(setGucIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(setGucIdx).toBeLessThan(insertIdx);

    // The GUC statement carries the correct brand_id (inlined, not a bind param).
    const setGucCall = calls[setGucIdx];
    expect(setGucCall?.sql).toContain(validInput.brandId);

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
