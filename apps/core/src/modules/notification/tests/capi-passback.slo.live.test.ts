/**
 * capi-passback.slo.live.test.ts — THE CI-BLOCKING COMPLIANCE SLO GATE (Phase 6, Track B).
 *
 *   non_consented_sends = 0
 *
 * This is the single most load-bearing test in the feature. It runs the REAL
 * CapiPassbackService over a REAL Postgres (consent_record / consent_tombstone /
 * capi_passback_log, migration 0034), under SET ROLE brain_app (NOSUPERUSER, NOBYPASSRLS)
 * — the production security context. It asserts:
 *
 *   1. current_user='brain_app' AND is_superuser=false BEFORE any isolation/SLO assertion
 *      (superuser `brain` BYPASSES FORCE RLS → a false-pass; per MEMORY: dev-db-superuser
 *      -masks-rls). If this guard is removed, every probe below false-passes — so it runs
 *      first and the suite aborts if the role is wrong.
 *
 *   2. SLO=0 — a NEVER-consented advertising subject: the spy adapter `send` is called
 *      EXACTLY 0 times, exactly one `blocked_no_consent` row is written, and ZERO
 *      `sent`/`would_send_dev` rows exist. The "send called 0 times on a non-consented
 *      subject" assertion IS non_consented_sends = 0.
 *
 *   3. A WITHDRAWN (latest state != granted) subject → blocked (the spy `send` stays at 0).
 *
 *   4. A TOMBSTONED subject (retroactive erasure) → blocked, suppressed (spy `send` 0).
 *
 *   5. A GRANTED advertising subject in DEV → the adapter is reached and returns
 *      `would_send_dev` (default-closed dev stub) with ZERO real network — proving the
 *      gate ALLOWS a consented subject while the dev send remains honest (never `sent`).
 *
 *   6. Idempotency — replaying the same conversion 3× yields exactly ONE log row
 *      (deterministic event_id + ON CONFLICT DO NOTHING).
 *
 *   7. RLS NON-INERT — a brand-A GUC cannot read brand-B's passback rows.
 *
 * If a non-consented passback EVER reaches the adapter, assertion 2 fails and CI blocks.
 *
 * REQUIRES: Postgres on localhost:5432 with migration 0034 applied; brain_app role.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import type { DbClient, QueryContext } from '@brain/db';
import { CanContactEngine } from '../internal/compliance/can-contact.engine.js';
import { PgSuppressionQuery } from '../internal/compliance/suppression.query.js';
import {
  CapiPassbackService,
  computeCapiEventId,
  type CapiConversion,
  type MatchPiiPort,
} from '../internal/capi-passback.service.js';
import type {
  CapiAdapter,
  CapiSendResult,
  CapiDeletionResult,
  CapiEventPayload,
  CapiDeletionPayload,
} from '../internal/capi-adapter.js';
import type { DltRegistryPort, NcprRegistryPort, SaltPort } from '../internal/compliance/ports.js';

// ── Config ────────────────────────────────────────────────────────────────────
const SUPERUSER_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'aaaaa034-0034-0034-0034-000000000001';
const BRAND_B = 'aaaaa034-0034-0034-0034-000000000002';

// 64-hex identity-core subject hashes (the consent key) — never raw PII.
const sub = (seed: string) =>
  createHash('sha256').update(seed).digest('hex');

let superPool: pg.Pool;
let appPool: pg.Pool;

// ── A brain_app-backed DbClient: runs every query inside a per-call transaction
//    with the brand GUC set (RLS FORCE enforced — the production read/write path).
//    This is what makes the test NON-INERT: the engine's PgSuppressionQuery reads
//    consent under brain_app+GUC, and the service writes capi_passback_log under it.
function brainAppDbClient(pool: pg.Pool): DbClient {
  return {
    async query<R = unknown>(ctx: QueryContext, sql: string, params: unknown[] = []) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (ctx.brandId) {
          await client.query("SELECT set_config('app.current_brand_id', $1, true)", [
            ctx.brandId,
          ]);
        }
        const r = await client.query(sql, params);
        await client.query('COMMIT');
        return { rows: r.rows as R[], rowCount: r.rowCount };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    release() {
      /* pool-managed */
    },
  };
}

// ── A spy adapter — the SLO probe. `send` MUST be called 0 times on a blocked subject. ──
function spyAdapter(devStatus: 'would_send_dev' = 'would_send_dev'): CapiAdapter & {
  sendSpy: ReturnType<typeof vi.fn>;
} {
  const sendSpy = vi.fn(async (_p: CapiEventPayload): Promise<CapiSendResult> => {
    return { status: devStatus };
  });
  return {
    sendSpy,
    send: sendSpy as unknown as CapiAdapter['send'],
    async delete(_p: CapiDeletionPayload): Promise<CapiDeletionResult> {
      return { status: 'would_delete_dev' };
    },
  };
}

// PII port: no vaulted PII in this test (match falls back to click-ids / none); the gate
// decision — not the match payload — is what the SLO asserts.
const noPii: MatchPiiPort = { getMatchPii: async () => null };

// Salt/DLT/NCPR ports — unused on the precomputed-subjectHash path but required by ctor.
const saltOk: SaltPort = { saltHexForBrand: async () => 'a'.repeat(64) };
const dltBlock: DltRegistryPort = { isTemplateApproved: async () => false };
const ncprBlock: NcprRegistryPort = { dndStatus: async () => 'unknown' };

function buildEngine(db: DbClient): CanContactEngine {
  return new CanContactEngine({
    salt: saltOk,
    suppression: new PgSuppressionQuery(db),
    dlt: dltBlock,
    ncpr: ncprBlock,
  });
}

function mkConversion(subjectHash: string, brandId = BRAND_A): CapiConversion {
  const orderId = `order-${randomUUID()}`;
  return {
    brandId,
    orderId,
    ledgerEventId: createHash('sha256').update(`${brandId}:${orderId}:fin`).digest('hex'),
    subjectHash,
    valueMinor: 199900n,
    currencyCode: 'INR',
    occurredAt: new Date('2026-06-18T10:00:00.000Z'),
    fbc: null,
    fbp: null,
    correlationId: `corr-${randomUUID()}`,
  };
}

async function seedGranted(brandId: string, subjectHash: string): Promise<void> {
  await superPool.query(
    `INSERT INTO consent_record (brand_id, subject_hash, category, state, source, policy_version, effective_at)
     VALUES ($1, $2, 'advertising', 'granted', 'collector', 'v1', NOW())
     ON CONFLICT DO NOTHING`,
    [brandId, subjectHash],
  );
}
async function seedWithdrawn(brandId: string, subjectHash: string): Promise<void> {
  // Earlier grant then a LATER withdrawal — latest state != granted → suppressed.
  await superPool.query(
    `INSERT INTO consent_record (brand_id, subject_hash, category, state, source, policy_version, effective_at)
     VALUES ($1, $2, 'advertising', 'granted', 'collector', 'v1', NOW() - INTERVAL '1 day')
     ON CONFLICT DO NOTHING`,
    [brandId, subjectHash],
  );
  await superPool.query(
    `INSERT INTO consent_record (brand_id, subject_hash, category, state, source, policy_version, effective_at)
     VALUES ($1, $2, 'advertising', 'withdrawn', 'consent_manager', 'v1', NOW())
     ON CONFLICT DO NOTHING`,
    [brandId, subjectHash],
  );
}
async function seedTombstone(brandId: string, subjectHash: string): Promise<void> {
  // A grant on file + a tombstone (retroactive erasure) → suppressed regardless.
  await seedGranted(brandId, subjectHash);
  await superPool.query(
    `INSERT INTO consent_tombstone (tombstone_id, brand_id, subject_hash, category, reason, source, tombstoned_at, source_event_id)
     VALUES (gen_random_uuid(), $1, $2, 'advertising', 'withdrawal', 'consent_manager', NOW(), $3)
     ON CONFLICT DO NOTHING`,
    [brandId, subjectHash, randomUUID()],
  );
}

async function countStatus(brandId: string, subjectHash: string, status: string): Promise<number> {
  const r = await superPool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM capi_passback_log
     WHERE brand_id = $1 AND subject_hash = $2 AND status = $3`,
    [brandId, subjectHash, status],
  );
  return Number(r.rows[0]?.cnt ?? '0');
}

async function clearBrand(brandId: string): Promise<void> {
  await superPool.query(`DELETE FROM capi_passback_log WHERE brand_id = $1`, [brandId]);
  await superPool.query(`DELETE FROM consent_tombstone WHERE brand_id = $1`, [brandId]);
  await superPool.query(`DELETE FROM consent_record WHERE brand_id = $1`, [brandId]);
}

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 5 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 5 });
  await superPool.query('SELECT 1');
  await appPool.query('SELECT 1');
  await clearBrand(BRAND_A);
  await clearBrand(BRAND_B);
});

afterAll(async () => {
  await clearBrand(BRAND_A);
  await clearBrand(BRAND_B);
  await superPool.end().catch(() => {});
  await appPool.end().catch(() => {});
});

// ── GUARD: the test is meaningless as superuser. Run this FIRST. ────────────────
describe('0. security-context guard — brain_app, NON-INERT', () => {
  it('current_user=brain_app and is_superuser=false (else every probe false-passes)', async () => {
    const r = await appPool.query<{ current_user: string; is_superuser: boolean }>(
      `SELECT current_user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
    );
    expect(r.rows[0]!.current_user).toBe('brain_app');
    expect(r.rows[0]!.is_superuser).toBe(false);
  });
});

// ── THE SLO GATE: non_consented_sends = 0 ───────────────────────────────────────
describe('1. SLO non_consented_sends=0 — a non-consented passback is BLOCKED (adapter send called 0 times)', () => {
  it('NEVER-consented advertising subject → 0 send calls, exactly 1 blocked_no_consent row, 0 sent', async () => {
    const subjectHash = sub('never-consented');
    const db = brainAppDbClient(appPool);
    const adapter = spyAdapter();
    const svc = new CapiPassbackService({
      engine: buildEngine(db),
      adapter,
      pii: noPii,
      db,
    });

    const conv = mkConversion(subjectHash);
    const out = await svc.passback(conv);

    // THE SLO: the adapter was NEVER reached.
    expect(adapter.sendSpy).toHaveBeenCalledTimes(0);
    expect(out.status).toBe('blocked_no_consent');

    // Exactly one audit row, status blocked_no_consent; ZERO sent / would_send_dev.
    expect(await countStatus(BRAND_A, subjectHash, 'blocked_no_consent')).toBe(1);
    expect(await countStatus(BRAND_A, subjectHash, 'sent')).toBe(0);
    expect(await countStatus(BRAND_A, subjectHash, 'would_send_dev')).toBe(0);
  });

  it('WITHDRAWN advertising subject → blocked, adapter send called 0 times', async () => {
    const subjectHash = sub('withdrawn-subject');
    await seedWithdrawn(BRAND_A, subjectHash);
    const db = brainAppDbClient(appPool);
    const adapter = spyAdapter();
    const svc = new CapiPassbackService({ engine: buildEngine(db), adapter, pii: noPii, db });

    const out = await svc.passback(mkConversion(subjectHash));
    expect(adapter.sendSpy).toHaveBeenCalledTimes(0);
    expect(out.status).toBe('blocked_no_consent');
    expect(await countStatus(BRAND_A, subjectHash, 'blocked_no_consent')).toBe(1);
    expect(await countStatus(BRAND_A, subjectHash, 'sent')).toBe(0);
  });

  it('TOMBSTONED subject (retroactive erasure) → suppressed, adapter send called 0 times', async () => {
    const subjectHash = sub('tombstoned-subject');
    await seedTombstone(BRAND_A, subjectHash);
    const db = brainAppDbClient(appPool);
    const adapter = spyAdapter();
    const svc = new CapiPassbackService({ engine: buildEngine(db), adapter, pii: noPii, db });

    const out = await svc.passback(mkConversion(subjectHash));
    expect(adapter.sendSpy).toHaveBeenCalledTimes(0);
    expect(out.status).toBe('blocked_no_consent');
    expect(await countStatus(BRAND_A, subjectHash, 'sent')).toBe(0);
  });
});

// ── The positive (consented) path stays HONEST in dev: would_send_dev, no real send. ──
describe('2. granted advertising subject → gate ALLOWS; dev adapter returns would_send_dev (never sent)', () => {
  it('granted → adapter reached exactly once, status would_send_dev, ZERO real network', async () => {
    const subjectHash = sub('granted-subject');
    await seedGranted(BRAND_A, subjectHash);
    const db = brainAppDbClient(appPool);
    const adapter = spyAdapter('would_send_dev');
    const svc = new CapiPassbackService({ engine: buildEngine(db), adapter, pii: noPii, db });

    const out = await svc.passback(mkConversion(subjectHash));
    expect(out.status).toBe('would_send_dev');
    expect(adapter.sendSpy).toHaveBeenCalledTimes(1);
    expect(await countStatus(BRAND_A, subjectHash, 'would_send_dev')).toBe(1);
    expect(await countStatus(BRAND_A, subjectHash, 'sent')).toBe(0); // dev NEVER fakes sent
  });
});

// ── Idempotency: 3× replay → one row (deterministic event_id + ON CONFLICT DO NOTHING). ──
describe('3. idempotency — replay 3× yields exactly one passback-log row', () => {
  it('same conversion 3× → 1 row, identical event_id', async () => {
    const subjectHash = sub('idempotent-subject');
    await seedGranted(BRAND_A, subjectHash);
    const db = brainAppDbClient(appPool);
    const adapter = spyAdapter('would_send_dev');
    const svc = new CapiPassbackService({ engine: buildEngine(db), adapter, pii: noPii, db });

    const conv = mkConversion(subjectHash);
    const expectedId = computeCapiEventId(conv.brandId, conv.orderId, conv.ledgerEventId);

    await svc.passback(conv);
    await svc.passback(conv);
    await svc.passback(conv);

    const r = await superPool.query<{ cnt: string; event_id: string }>(
      `SELECT COUNT(*) AS cnt, MIN(event_id) AS event_id FROM capi_passback_log
       WHERE brand_id = $1 AND order_id = $2`,
      [BRAND_A, conv.orderId],
    );
    expect(Number(r.rows[0]!.cnt)).toBe(1);
    expect(r.rows[0]!.event_id).toBe(expectedId);
  });
});

// ── RLS NON-INERT: brand-A GUC cannot read brand-B passback rows. ───────────────
describe('4. RLS isolation NON-INERT under brain_app — cross-brand read = 0', () => {
  it('a brand-A scoped read cannot see a brand-B passback row', async () => {
    // Write a brand-B blocked row via the service (brand-B GUC path).
    const subjectHash = sub('brand-b-subject');
    const db = brainAppDbClient(appPool);
    const adapter = spyAdapter();
    const svc = new CapiPassbackService({ engine: buildEngine(db), adapter, pii: noPii, db });
    await svc.passback(mkConversion(subjectHash, BRAND_B)); // never-consented → blocked row in B

    // Now read under brand-A GUC: brand-B rows must be invisible (FORCE RLS).
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      const r = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM capi_passback_log WHERE brand_id = $1`,
        [BRAND_B],
      );
      await client.query('COMMIT');
      expect(Number(r.rows[0]!.cnt)).toBe(0); // cross-brand read = 0 (isolation holds)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }

    // And the brand-B row DOES exist (visible to superuser) — proving the read was
    // blocked by RLS, not merely absent (the NON-INERT proof).
    const exists = await superPool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM capi_passback_log WHERE brand_id = $1`,
      [BRAND_B],
    );
    expect(Number(exists.rows[0]!.cnt)).toBeGreaterThan(0);
  });
});
