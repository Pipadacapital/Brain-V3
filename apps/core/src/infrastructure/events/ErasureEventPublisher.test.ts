/**
 * ErasureEventPublisher.test.ts — AUD-OPS-036 (the RTBF erasure-trigger bridge),
 * ADR-0015 WS4 PG request-driven lane.
 *
 * Pure unit tests over a fake pg pool. Proves:
 *   1. The trigger row lands in ops.erasure_request_queue keyed by (id=event_id, brand_id)
 *      with ON CONFLICT DO NOTHING, and the stored payload VALIDATES against
 *      CollectorEventV1Schema (the envelope shape is UNCHANGED from the Kafka lane — the
 *      worker feeds it byte-identically to EraseSubjectUseCase).
 *   2. The payload satisfies the stream-worker orchestrator's trigger predicate — mirrored
 *      here exactly like a2-4-merge-unmerge-roundtrip mirrors derive_unmerge_pairs (the
 *      cross-layer handoff contract): consent_flags present, event_name contains 'erasure',
 *      subject extractable (email / phone / direct brain_id).
 *   3. Tenant-first + addressability guards: no brand_id or no subject → log-and-skip
 *      (never a tenantless or dead row).
 *   4. FAIL-OPEN: an INSERT failure never throws into the calling route/webhook.
 *   5. No raw PII in the publisher's own logs (I-S02) — presence booleans only; and
 *      subject_ref is NEVER the raw identifier (digest/brain_id only).
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CollectorEventV1Schema } from '@brain/contracts';
import {
  createErasureEventPublisher,
  ERASURE_REQUESTED_EVENT_NAME,
  type ErasureEmit,
} from './ErasureEventPublisher.js';

const BRAND = '11111111-1111-4111-8111-111111111111';
const BRAIN_ID = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'subject@example.com';
const PHONE = '+919999999999';

// ── Orchestrator trigger-predicate MIRROR ─────────────────────────────────────
// TS mirror of stream-worker EraseSubjectUseCase's parse/extractFlags/isErasure/
// extractSubject/extractDirectBrainId gates (apps/stream-worker/src/application/
// EraseSubjectUseCase.ts — exhaustively unit-tested in erasure-orchestrator.unit.test.ts).
// Kept intentionally tiny: it asserts the payload THIS module enqueues is exactly what the
// orchestrator accepts — the cross-layer handoff AUD-OPS-036 is about.
function orchestratorAccepts(wire: Record<string, unknown>): {
  triggered: boolean;
  subject: { type: string; value: string } | null;
  directBrainId: string | null;
} {
  const brandId = typeof wire['brand_id'] === 'string' ? wire['brand_id'] : null;
  const eventId = typeof wire['event_id'] === 'string' ? wire['event_id'] : null;
  if (!brandId || !eventId) return { triggered: false, subject: null, directBrainId: null };

  const payload = (wire['payload'] as Record<string, unknown>) ?? wire;
  const flags =
    (wire['consent_flags'] as Record<string, unknown> | undefined) ??
    (payload['consent_flags'] as Record<string, unknown> | undefined);
  if (!flags || typeof flags !== 'object') return { triggered: false, subject: null, directBrainId: null };

  const eventName =
    typeof wire['event_name'] === 'string' ? wire['event_name'] :
    typeof payload['event_name'] === 'string' ? (payload['event_name'] as string) : '';
  const reason =
    typeof wire['reason'] === 'string' ? wire['reason'] :
    typeof payload['reason'] === 'string' ? (payload['reason'] as string) : '';
  if (!eventName.includes('erasure') && reason !== 'erasure') {
    return { triggered: false, subject: null, directBrainId: null };
  }

  const props = (payload['properties'] as Record<string, unknown>) ?? {};
  const rawBrainId = props['brain_id'];
  const directBrainId =
    typeof rawBrainId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawBrainId)
      ? rawBrainId
      : null;

  let subject: { type: string; value: string } | null = null;
  if (typeof props['email'] === 'string') subject = { type: 'email', value: props['email'] as string };
  else if (typeof props['phone'] === 'string') subject = { type: 'phone', value: props['phone'] as string };

  return { triggered: subject !== null || directBrainId !== null, subject, directBrainId };
}

/** The publisher's unsalted ops-handle digest (subject_ref parity assertion). */
function digest(raw: string): string {
  return createHash('sha256').update(raw.trim().toLowerCase()).digest('hex');
}

// ── Harness ───────────────────────────────────────────────────────────────────

interface CapturedInsert {
  sql: string;
  params: unknown[];
}

function makeHarness() {
  const inserts: CapturedInsert[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      inserts.push({ sql, params });
      return { rowCount: 1, rows: [] };
    }),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const publisher = createErasureEventPublisher({ pool: pool as never, log });
  /** Parsed row shape: [id, brand_id, subject_kind, subject_ref, source, payload-json]. */
  const rowOf = (i = 0) => {
    const p = inserts[i]!.params;
    return {
      id: p[0] as string,
      brandId: p[1] as string,
      subjectKind: p[2] as string,
      subjectRef: p[3] as string,
      source: p[4] as string,
      payload: JSON.parse(p[5] as string) as Record<string, unknown>,
    };
  };
  return { publisher, pool, inserts, log, rowOf };
}

async function emit(harness: ReturnType<typeof makeHarness>, evt: Partial<ErasureEmit>): Promise<void> {
  await harness.publisher.emitErasureRequested({
    brandId: BRAND,
    source: 'consent.withdraw',
    ...evt,
  } as ErasureEmit);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ErasureEventPublisher — queue-row contract (ops.erasure_request_queue)', () => {
  it('INSERTs into ops.erasure_request_queue keyed (id=event_id, brand_id) ON CONFLICT DO NOTHING, and the payload validates against CollectorEventV1Schema', async () => {
    const h = makeHarness();
    await emit(h, { subjectEmail: EMAIL, correlationId: 'corr-1' });

    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]!.sql).toContain('ops.erasure_request_queue');
    expect(h.inserts[0]!.sql).toContain('ON CONFLICT (id) DO NOTHING');

    const row = h.rowOf();
    expect(row.brandId).toBe(BRAND);
    expect(row.source).toBe('consent.withdraw');
    // The stored envelope is the UNCHANGED Kafka-lane wire shape — the worker must be able
    // to feed it to EraseSubjectUseCase byte-identically.
    const parsed = CollectorEventV1Schema.safeParse(row.payload);
    expect(parsed.success).toBe(true);
    expect(row.payload['brand_id']).toBe(BRAND);
    expect(row.payload['event_id']).toBe(row.id); // PK = envelope event_id (idempotency key)
    expect(row.payload['event_name']).toBe(ERASURE_REQUESTED_EVENT_NAME);
    expect(row.payload['correlation_id']).toBe('corr-1');
    // An erasure request withdraws EVERYTHING — all-false consent flags.
    expect(row.payload['consent_flags']).toEqual({
      analytics: false,
      marketing: false,
      personalization: false,
      ai_processing: false,
    });
    const props = row.payload['properties'] as Record<string, unknown>;
    expect(props['reason']).toBe('erasure');
    expect(props['source']).toBe('consent.withdraw');
  });

  it('passes region_code through top-level (orchestrator hash-parity seam)', async () => {
    const h = makeHarness();
    await emit(h, { subjectEmail: EMAIL, regionCode: 'IN' });
    expect(h.rowOf().payload['region_code']).toBe('IN');
  });

  it('subject_ref is NEVER raw PII — email/phone are stored as unsalted sha256 digests', async () => {
    const h = makeHarness();
    await emit(h, { subjectEmail: EMAIL });
    await emit(h, { subjectPhone: PHONE });
    expect(h.rowOf(0).subjectKind).toBe('email');
    expect(h.rowOf(0).subjectRef).toBe(digest(EMAIL));
    expect(h.rowOf(1).subjectKind).toBe('phone');
    expect(h.rowOf(1).subjectRef).toBe(digest(PHONE));
    expect(h.rowOf(0).subjectRef).not.toContain('@');
  });

  it('brain_id-only trigger stores subject_kind=brain_id with the UUID as subject_ref', async () => {
    const h = makeHarness();
    await emit(h, { brainId: BRAIN_ID, source: 'identity.erase' });
    expect(h.rowOf().subjectKind).toBe('brain_id');
    expect(h.rowOf().subjectRef).toBe(BRAIN_ID);
  });
});

describe('ErasureEventPublisher — orchestrator trigger-predicate handoff (the AUD-OPS-036 bridge)', () => {
  it('email subject (consent.withdraw): the orchestrator predicate accepts and extracts the email', async () => {
    const h = makeHarness();
    await emit(h, { subjectEmail: EMAIL, source: 'consent.withdraw' });
    const verdict = orchestratorAccepts(h.rowOf().payload);
    expect(verdict.triggered).toBe(true);
    expect(verdict.subject).toEqual({ type: 'email', value: EMAIL });
  });

  it('phone subject (consent.withdraw via whatsapp/sms): predicate accepts and extracts the phone', async () => {
    const h = makeHarness();
    await emit(h, { subjectPhone: PHONE, source: 'consent.withdraw' });
    const verdict = orchestratorAccepts(h.rowOf().payload);
    expect(verdict.triggered).toBe(true);
    expect(verdict.subject).toEqual({ type: 'phone', value: PHONE });
  });

  it('brain_id-only subject (identity.erase — raw identifier already hard-deleted): predicate accepts via direct addressing', async () => {
    const h = makeHarness();
    await emit(h, { brainId: BRAIN_ID, source: 'identity.erase' });
    const verdict = orchestratorAccepts(h.rowOf().payload);
    expect(verdict.triggered).toBe(true);
    expect(verdict.subject).toBeNull();
    expect(verdict.directBrainId).toBe(BRAIN_ID);
  });

  it('shopify.customers_redact carries BOTH the raw subject and the resolved brain_id', async () => {
    const h = makeHarness();
    await emit(h, {
      subjectEmail: EMAIL,
      subjectPhone: PHONE,
      brainId: BRAIN_ID,
      source: 'shopify.customers_redact',
    });
    const verdict = orchestratorAccepts(h.rowOf().payload);
    expect(verdict.triggered).toBe(true);
    expect(verdict.subject).toEqual({ type: 'email', value: EMAIL }); // email wins (orchestrator order)
    expect(verdict.directBrainId).toBe(BRAIN_ID);
    expect((h.rowOf().payload['properties'] as Record<string, unknown>)['source']).toBe('shopify.customers_redact');
  });
});

describe('ErasureEventPublisher — guards (I-S01 tenant-first + addressability)', () => {
  it('missing/invalid brand_id → NOT enqueued (warn, no insert)', async () => {
    const h = makeHarness();
    await emit(h, { brandId: 'not-a-uuid', subjectEmail: EMAIL } as Partial<ErasureEmit>);
    expect(h.inserts).toHaveLength(0);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
  });

  it('no subject address at all (no email/phone/brain_id) → NOT enqueued (dead row)', async () => {
    const h = makeHarness();
    await emit(h, {});
    expect(h.inserts).toHaveLength(0);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
  });

  it('malformed brain_id with no other subject → NOT enqueued (never a garbage key)', async () => {
    const h = makeHarness();
    await emit(h, { brainId: 'garbage' });
    expect(h.inserts).toHaveLength(0);
  });

  it('blank-string email/phone are treated as absent', async () => {
    const h = makeHarness();
    await emit(h, { subjectEmail: '  ', subjectPhone: '' });
    expect(h.inserts).toHaveLength(0);
  });
});

describe('ErasureEventPublisher — fail-open + log hygiene', () => {
  it('INSERT failure does NOT throw into the caller (synchronous erase already durable) and logs an error', async () => {
    const pool = { query: vi.fn(async () => { throw new Error('pg down'); }) };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const publisher = createErasureEventPublisher({ pool: pool as never, log });

    await expect(
      publisher.emitErasureRequested({ brandId: BRAND, subjectEmail: EMAIL, source: 'identity.erase' }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('duplicate enqueue (ON CONFLICT rowCount=0) still logs success with enqueued=false (idempotent re-issue)', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const publisher = createErasureEventPublisher({ pool: pool as never, log });
    await publisher.emitErasureRequested({ brandId: BRAND, subjectEmail: EMAIL, source: 'consent.withdraw' });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]![0]).toMatchObject({ enqueued: false });
  });

  it('success log carries NO raw PII (presence booleans only — I-S02)', async () => {
    const h = makeHarness();
    await emit(h, { subjectEmail: EMAIL, subjectPhone: PHONE });
    expect(h.log.info).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(h.log.info.mock.calls[0]![0]);
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain(PHONE);
    expect(h.log.info.mock.calls[0]![0]).toMatchObject({ has_email: true, has_phone: true });
  });
});
