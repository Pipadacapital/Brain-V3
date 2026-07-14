/**
 * ErasureEventPublisher.test.ts — AUD-OPS-036 (the RTBF erasure-trigger bridge).
 *
 * Pure unit tests over a fake kafka producer. Proves:
 *   1. The wire event lands on {env}.collector.event.v1, keyed brand_id, and VALIDATES against
 *      CollectorEventV1Schema (never an invalid produce onto the live collector lane).
 *   2. The wire event satisfies the stream-worker orchestrator's trigger predicate — mirrored
 *      here exactly like a2-4-merge-unmerge-roundtrip mirrors derive_unmerge_pairs (the
 *      cross-layer handoff contract): consent_flags present, event_name contains 'erasure',
 *      subject extractable (email / phone / direct brain_id).
 *   3. Tenant-first + addressability guards: no brand_id or no subject → log-and-skip
 *      (never a tenantless or dead event).
 *   4. FAIL-OPEN: a producer failure never throws into the calling route/webhook.
 *   5. No raw PII in the publisher's own logs (I-S02) — presence booleans only.
 */
import { describe, it, expect, vi } from 'vitest';
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
// Kept intentionally tiny: it asserts the event THIS module emits is exactly what the
// orchestrator's consumer group accepts — the cross-layer handoff AUD-OPS-036 is about.
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

// ── Harness ───────────────────────────────────────────────────────────────────

function makeHarness() {
  const sends: Array<{
    topic: string;
    messages: Array<{ key?: string; value: Buffer; headers?: Record<string, string | Buffer> }>;
  }> = [];
  const producer = {
    send: vi.fn(async (rec: (typeof sends)[number]) => { sends.push(rec); }),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const publisher = createErasureEventPublisher({ producer: producer as never, env: 'dev', log });
  const wireOf = (i = 0): Record<string, unknown> =>
    JSON.parse(sends[i]!.messages[0]!.value.toString('utf8')) as Record<string, unknown>;
  return { publisher, producer, sends, log, wireOf };
}

async function emit(harness: ReturnType<typeof makeHarness>, evt: Partial<ErasureEmit>): Promise<void> {
  await harness.publisher.emitErasureRequested({
    brandId: BRAND,
    source: 'consent.withdraw',
    ...evt,
  } as ErasureEmit);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ErasureEventPublisher — wire contract (collector lane)', () => {
  it('publishes to {env}.collector.event.v1 keyed brand_id, and the envelope validates against CollectorEventV1Schema', async () => {
    const h = makeHarness();
    await emit(h, { subjectEmail: EMAIL, correlationId: 'corr-1' });

    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.topic).toBe('dev.collector.event.v1');
    expect(h.sends[0]!.messages[0]!.key).toBe(BRAND);

    const wire = h.wireOf();
    // The live collector lane must never receive an invalid envelope.
    const parsed = CollectorEventV1Schema.safeParse(wire);
    expect(parsed.success).toBe(true);
    expect(wire['brand_id']).toBe(BRAND);
    expect(wire['event_name']).toBe(ERASURE_REQUESTED_EVENT_NAME);
    expect(wire['correlation_id']).toBe('corr-1');
    // An erasure request withdraws EVERYTHING — all-false consent flags.
    expect(wire['consent_flags']).toEqual({
      analytics: false,
      marketing: false,
      personalization: false,
      ai_processing: false,
    });
    const props = wire['properties'] as Record<string, unknown>;
    expect(props['reason']).toBe('erasure');
    expect(props['source']).toBe('consent.withdraw');
  });

  it('carries the event_name + correlation_id Kafka headers (consumer routing/trace parity)', async () => {
    const h = makeHarness();
    await emit(h, { subjectEmail: EMAIL, correlationId: 'corr-2' });
    const headers = h.sends[0]!.messages[0]!.headers!;
    expect(String(headers['event_name'])).toBe(ERASURE_REQUESTED_EVENT_NAME);
    expect(String(headers['correlation_id'])).toBe('corr-2');
  });

  it('passes region_code through top-level (orchestrator hash-parity seam)', async () => {
    const h = makeHarness();
    await emit(h, { subjectEmail: EMAIL, regionCode: 'IN' });
    expect(h.wireOf()['region_code']).toBe('IN');
  });
});

describe('ErasureEventPublisher — orchestrator trigger-predicate handoff (the AUD-OPS-036 bridge)', () => {
  it('email subject (consent.withdraw): the orchestrator predicate accepts and extracts the email', async () => {
    const h = makeHarness();
    await emit(h, { subjectEmail: EMAIL, source: 'consent.withdraw' });
    const verdict = orchestratorAccepts(h.wireOf());
    expect(verdict.triggered).toBe(true);
    expect(verdict.subject).toEqual({ type: 'email', value: EMAIL });
  });

  it('phone subject (consent.withdraw via whatsapp/sms): predicate accepts and extracts the phone', async () => {
    const h = makeHarness();
    await emit(h, { subjectPhone: PHONE, source: 'consent.withdraw' });
    const verdict = orchestratorAccepts(h.wireOf());
    expect(verdict.triggered).toBe(true);
    expect(verdict.subject).toEqual({ type: 'phone', value: PHONE });
  });

  it('brain_id-only subject (identity.erase — raw identifier already hard-deleted): predicate accepts via direct addressing', async () => {
    const h = makeHarness();
    await emit(h, { brainId: BRAIN_ID, source: 'identity.erase' });
    const verdict = orchestratorAccepts(h.wireOf());
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
    const verdict = orchestratorAccepts(h.wireOf());
    expect(verdict.triggered).toBe(true);
    expect(verdict.subject).toEqual({ type: 'email', value: EMAIL }); // email wins (orchestrator order)
    expect(verdict.directBrainId).toBe(BRAIN_ID);
    expect((h.wireOf()['properties'] as Record<string, unknown>)['source']).toBe('shopify.customers_redact');
  });
});

describe('ErasureEventPublisher — guards (I-S01 tenant-first + addressability)', () => {
  it('missing/invalid brand_id → NOT emitted (warn, no send)', async () => {
    const h = makeHarness();
    await emit(h, { brandId: 'not-a-uuid', subjectEmail: EMAIL } as Partial<ErasureEmit>);
    expect(h.sends).toHaveLength(0);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
  });

  it('no subject address at all (no email/phone/brain_id) → NOT emitted (dead event)', async () => {
    const h = makeHarness();
    await emit(h, {});
    expect(h.sends).toHaveLength(0);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
  });

  it('malformed brain_id with no other subject → NOT emitted (never a garbage key)', async () => {
    const h = makeHarness();
    await emit(h, { brainId: 'garbage' });
    expect(h.sends).toHaveLength(0);
  });

  it('blank-string email/phone are treated as absent', async () => {
    const h = makeHarness();
    await emit(h, { subjectEmail: '  ', subjectPhone: '' });
    expect(h.sends).toHaveLength(0);
  });
});

describe('ErasureEventPublisher — fail-open + log hygiene', () => {
  it('producer failure does NOT throw into the caller (synchronous erase already durable) and logs an error', async () => {
    const producer = { send: vi.fn(async () => { throw new Error('kafka down'); }) };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const publisher = createErasureEventPublisher({ producer: producer as never, env: 'dev', log });

    await expect(
      publisher.emitErasureRequested({ brandId: BRAND, subjectEmail: EMAIL, source: 'identity.erase' }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
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
