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

/** Minimal pg.Pool stand-in: routes the head + count queries to scripted rows.
 *
 * Since the RLS hardening (2b322aa1, migration 0067 — audit.audit_log FORCEs RLS), readAuditHead
 * claims the `app.role = 'audit_reader'` escape for the global chain walk. Since the pgbouncer
 * fix (prod 2026-07-12 uuid-cast fatal), it does so with `SET LOCAL` inside ONE transaction
 * (BEGIN … COMMIT) so transaction pooling can't split the GUC from the reads. The fake mirrors
 * that shape: connect() hands out a client whose query() answers the txn/GUC statements + the
 * head/count reads, and RECORDS every statement so tests can assert the txn pinning. */
function fakePool(
  head: { id: string; entry_hash: string } | null,
  count: string,
): pg.Pool & { statements: string[] } {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.startsWith('SET ') || sql.startsWith('RESET ')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('count(*)')) return { rows: [{ n: count }], rowCount: 1 };
      return { rows: head ? [head] : [], rowCount: head ? 1 : 0 };
    },
    release() {
      /* no-op */
    },
  };
  return {
    connect: async () => client,
    statements,
  } as unknown as pg.Pool & { statements: string[] };
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

  it('skips cleanly on an empty audit_log (no rows yet → no-op, no WORM write)', async () => {
    // Fresh deployment: zero audit rows → there is no chain head to anchor. The job must NO-OP
    // honestly (empty_chain, exit-0 semantics) instead of writing meaningless genesis checkpoints
    // or crashing (prod 2026-07-12: the empty/fresh env surfaced the RLS uuid-cast fatal).
    const pool = fakePool(null, '0');
    const sink = new FakeSink(null);
    const res = await writeAuditCheckpoint(pool, sink, NOW);
    expect(res.written).toBe(false);
    expect(res.reason).toBe('empty_chain');
    expect(res.checkpoint).toBeUndefined();
    expect(sink.puts).toHaveLength(0); // nothing anchored — no false/empty anchor in the WORM bucket
  });

  it('claims the audit_reader escape with SET LOCAL inside ONE transaction (pgbouncer-safe)', async () => {
    // Prod runs through pgbouncer in TRANSACTION pooling mode: a bare session-level SET can land on
    // a different server connection than the reads (losing the RLS escape), and a pooled connection
    // can carry app.current_brand_id = '' (RESET on a placeholder GUC), which the 0067 policy casts
    // to uuid — the `invalid input syntax for type uuid: ""` fatal. The fix pins one txn + SET LOCAL
    // + a nil-uuid brand GUC. This test locks that shape.
    const pool = fakePool({ id: '9', entry_hash: 'f'.repeat(64) }, '9');
    const sink = new FakeSink(null);
    await writeAuditCheckpoint(pool, sink, NOW);

    const stmts = pool.statements;
    const begin = stmts.findIndex((s) => s.startsWith('BEGIN'));
    const setRole = stmts.findIndex((s) => s.includes(`SET LOCAL app.role = 'audit_reader'`));
    const setBrand = stmts.findIndex((s) =>
      s.includes(`SET LOCAL app.current_brand_id = '00000000-0000-0000-0000-000000000000'`),
    );
    const headRead = stmts.findIndex((s) => s.includes('FROM audit_log'));
    const commit = stmts.findIndex((s) => s.startsWith('COMMIT'));

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(setRole).toBeGreaterThan(begin); // escape is txn-local, AFTER BEGIN
    expect(setBrand).toBeGreaterThan(begin); // brand GUC pinned to a castable uuid, AFTER BEGIN
    expect(headRead).toBeGreaterThan(setRole); // reads ride the SAME txn as the escape
    expect(commit).toBeGreaterThan(headRead); // txn closed before release
    expect(stmts.some((s) => /^SET app\.role/.test(s))).toBe(false); // no session-level SET (leaks via pgbouncer)
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
