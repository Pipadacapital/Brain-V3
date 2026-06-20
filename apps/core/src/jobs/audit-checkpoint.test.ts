/**
 * audit-checkpoint.test.ts — the WORM checkpoint job orchestration (R-19).
 *
 * Verifies the read-head → chain-prior → seal → put flow against a FAKE Postgres pool and a FAKE
 * sink — no AWS, no DB. The seal math itself is pinned in @brain/audit's audit-checkpoint.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { verifyAuditCheckpoint } from '@brain/audit';
import { writeAuditCheckpoint, runAuditCheckpoint, type CheckpointSink } from './audit-checkpoint.js';

/** Minimal pg.Pool stand-in: routes the head + count queries to scripted rows. */
function fakePool(head: { id: string; entry_hash: string } | null, count: string): pg.Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('count(*)')) return { rows: [{ n: count }], rowCount: 1 };
      return { rows: head ? [head] : [], rowCount: head ? 1 : 0 };
    },
  } as unknown as pg.Pool;
}

class FakeSink implements CheckpointSink {
  puts: Array<{ key: string; body: string }> = [];
  constructor(private latest: string | null = null) {}
  async readLatestHash(): Promise<string | null> {
    return this.latest;
  }
  async put(key: string, body: string): Promise<void> {
    this.puts.push({ key, body });
  }
}

const NOW = '2026-06-20T11:00:00.000Z';

describe('writeAuditCheckpoint', () => {
  it('seals the chain head and writes a verifiable, timestamped checkpoint', async () => {
    const pool = fakePool({ id: '1042', entry_hash: 'a'.repeat(64) }, '1042');
    const sink = new FakeSink(null);

    const res = await writeAuditCheckpoint(pool, sink, NOW);

    expect(res.written).toBe(true);
    expect(res.checkpoint?.headId).toBe('1042');
    expect(res.checkpoint?.rowCount).toBe('1042');
    expect(res.checkpoint?.prevCheckpointHash).toBeNull();
    expect(sink.puts).toHaveLength(1);
    // Key is under checkpoints/, timestamped (no ':' or '.'), ends with the head id.
    expect(sink.puts[0]?.key).toBe('checkpoints/2026-06-20T11-00-00-000Z-1042.json');
    // The written body is a verifiable checkpoint.
    const written = JSON.parse(sink.puts[0]?.body ?? '{}');
    expect(verifyAuditCheckpoint(written)).toBe(true);
  });

  it('chains to the prior checkpoint hash returned by the sink', async () => {
    const pool = fakePool({ id: '2000', entry_hash: 'c'.repeat(64) }, '2000');
    const sink = new FakeSink('priorhash999');
    const res = await writeAuditCheckpoint(pool, sink, NOW);
    expect(res.checkpoint?.prevCheckpointHash).toBe('priorhash999');
    expect(verifyAuditCheckpoint(res.checkpoint!)).toBe(true);
  });

  it('still anchors when the prior-hash read fails (best-effort chaining)', async () => {
    const pool = fakePool({ id: '7', entry_hash: 'e'.repeat(64) }, '7');
    const sink = new FakeSink(null);
    sink.readLatestHash = async () => {
      throw new Error('AccessDenied: s3:ListBucket');
    };
    const res = await writeAuditCheckpoint(pool, sink, NOW);
    expect(res.written).toBe(true);
    expect(res.checkpoint?.prevCheckpointHash).toBeNull(); // anchored without back-link
    expect(sink.puts).toHaveLength(1); // the WORM write still happened
  });

  it('handles an empty audit_log (genesis checkpoint, head hash null)', async () => {
    const pool = fakePool(null, '0');
    const sink = new FakeSink(null);
    const res = await writeAuditCheckpoint(pool, sink, NOW);
    expect(res.checkpoint?.headId).toBe('0');
    expect(res.checkpoint?.headEntryHash).toBeNull();
    expect(verifyAuditCheckpoint(res.checkpoint!)).toBe(true);
  });
});

describe('runAuditCheckpoint — env gate', () => {
  it('no-ops (no_bucket) when AUDIT_CHECKPOINT_BUCKET is unset and no sink injected', async () => {
    const prev = process.env['AUDIT_CHECKPOINT_BUCKET'];
    delete process.env['AUDIT_CHECKPOINT_BUCKET'];
    try {
      const res = await runAuditCheckpoint();
      expect(res).toEqual({ written: false, reason: 'no_bucket' });
    } finally {
      if (prev !== undefined) process.env['AUDIT_CHECKPOINT_BUCKET'] = prev;
    }
  });

  it('runs with an injected sink even without a bucket env (test path)', async () => {
    const pool = fakePool({ id: '5', entry_hash: 'd'.repeat(64) }, '5');
    const sink = new FakeSink(null);
    const res = await runAuditCheckpoint({ pool, sink, nowIso: NOW });
    expect(res.written).toBe(true);
    expect(sink.puts).toHaveLength(1);
  });
});
