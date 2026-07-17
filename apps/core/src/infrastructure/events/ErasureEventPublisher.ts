/**
 * ErasureEventPublisher (AUD-OPS-036 → ADR-0015 WS4 completion) — the canonical RTBF
 * erasure-trigger bridge, now PG REQUEST-DRIVEN (the Kafka publish is retired).
 *
 * BEFORE (Kafka lane): this module published a privacy.erasure.requested CollectorEventV1
 *   envelope onto {env}.collector.event.v1; the stream-worker ErasureOrchestratorConsumer
 *   (the LAST stream-worker Kafka consumer) drove the crypto-shred sequence off it.
 *
 * NOW: the SAME envelope (unchanged shape — still validated against CollectorEventV1Schema)
 *   is INSERTed durably into ops.erasure_request_queue (migration 0140). The stream-worker
 *   erasure poll lane (jobs/erasure-orchestrator/run.ts) claims rows and feeds the payload
 *   byte-identically to the UNCHANGED EraseSubjectUseCase. No Kafka hop, no consumer group —
 *   the last streaming exception to the ADR-0015 batch doctrine is gone.
 *
 * Still the ONE producer module (audit-prescribed) reused by all three RTBF entry points:
 *   1. POST /api/v1/consent/withdraw with reason='erasure'  (compliance consent.routes.ts)
 *   2. POST /api/v1/identity/customer/erase                 (BFF identity.routes.ts)
 *   3. Shopify customers/redact webhook                      (ShopifyWebhookStrategy)
 * Each entry point KEEPS its existing synchronous erase for immediate UX (AUD-OPS-039); the
 * queue row is the completeness guarantee that drives the full ordered sequence.
 *
 * ENVELOPE SHAPE (must satisfy the orchestrator's trigger predicate — EraseSubjectUseCase):
 *   - top-level brand_id + event_id (strings)          → parse guard
 *   - top-level consent_flags (all-false withdrawal)   → extractFlags
 *   - event_name contains 'erasure'                    → isErasure
 *   - properties.email / properties.phone (raw)        → extractSubject → salt-hash → brain_id
 *   - properties.brain_id (already-resolved UUID)      → direct addressing for entry points that
 *     hold no raw identifier (the UI erase route knows only the brain_id; contact_pii is already
 *     hard-deleted by the synchronous path, so the raw subject cannot be re-derived).
 * An erasure IS a full consent withdrawal: the worker lane also folds the all-false envelope
 * through ProjectConsentUseCase (the projection the retired ConsentSuppressor lane / Bronze→
 * Silver transit of this event used to provide).
 *
 * PII NOTE (deliberate, audit-ratified — carried over from the Kafka envelope): the raw subject
 * email/phone rides payload.properties when the entry point holds it — the envelope shape the
 * orchestrator (and the CAPI deletion hasher) was DESIGNED to consume. The worker clears the
 * payload on completion (the Kafka copy used to age out with retention; and the trigger event
 * no longer transits the log/Bronze at all — strictly LESS raw-PII spread than before).
 * subject_ref is never raw PII: brain_id, or an unsalted sha256 digest used only as an
 * ops/dedup handle. Never add any OTHER raw PII.
 *
 * INVARIANTS:
 *   - Queue: ops.erasure_request_queue via the raw brain_app pool (cross-brand trusted-ETL
 *     table, no brand GUC — same posture as PgIdentityUnmergeDirtyRepository).
 *   - Idempotency: PK id = event_id, ON CONFLICT DO NOTHING (re-INSERT of the same envelope
 *     no-ops — the produce-side dedup the idempotent Kafka producer gave this lane).
 *   - Envelope validated against CollectorEventV1Schema before INSERT (never an invalid row —
 *     the worker's 'invalid' → dead path exists only for defense in depth).
 *   - Tenant-first: no brandId (or no subject at all) → log-and-skip, never a tenantless row.
 *   - FAIL-OPEN: a PG blip must NOT fail the user-facing erase/withdraw/webhook-ack — the
 *     synchronous partial erase is already durable (the EXACT contract the Kafka publish had;
 *     see PgIdentityUnmergeDirtyRepository for the ratified precedent). Log loudly; the
 *     operator can re-issue the (idempotent) request to re-enqueue, and the orchestrator
 *     itself is replay-safe (D-4). A local PG INSERT is strictly MORE durable than the
 *     cross-network produce it replaces.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CollectorEventV1Schema } from '@brain/contracts';

/** Minimal logger shape (Fastify's pino instance satisfies this). */
export interface ErasureEventPublisherLog {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** The three sanctioned RTBF entry points (recorded in properties.source for audit). */
export type ErasureTriggerSource =
  | 'consent.withdraw'
  | 'identity.erase'
  | 'shopify.customers_redact';

export interface ErasureEmit {
  brandId: string;
  /** Which RTBF entry point fired this trigger (audit trail in the row itself). */
  source: ErasureTriggerSource;
  /** Raw subject email — orchestrator salt-hashes it (never stored outside payload). */
  subjectEmail?: string;
  /** Raw subject phone — orchestrator salt-hashes it (never stored outside payload). */
  subjectPhone?: string;
  /** Already-resolved brain_id — direct addressing when no raw identifier exists. */
  brainId?: string;
  correlationId?: string;
  /** Region code for hash derivation parity (defaults to 'IN' downstream when absent). */
  regionCode?: string;
}

export interface ErasureEventPublisher {
  emitErasureRequested(evt: ErasureEmit): Promise<void>;
}

export interface ErasureEventPublisherDeps {
  /**
   * Raw pg.Pool connected as the app role (core main.ts rawPgPool) —
   * ops.erasure_request_queue is a cross-brand trusted-ETL queue, no brand GUC.
   */
  pool: pg.Pool;
  log: ErasureEventPublisherLog;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The canonical erasure-trigger event name — MUST contain 'erasure' (orchestrator predicate). */
export const ERASURE_REQUESTED_EVENT_NAME = 'privacy.erasure.requested' as const;

/**
 * Unsalted SHA-256 of a normalized raw identifier — the subject_ref ops/dedup handle.
 * NOT an identity-resolution hash (that always uses the per-brand salt, in the worker):
 * this exists only so the queue row never carries raw PII outside the payload column.
 */
function subjectRefDigest(raw: string): string {
  return createHash('sha256').update(raw.trim().toLowerCase()).digest('hex');
}

export function createErasureEventPublisher(deps: ErasureEventPublisherDeps): ErasureEventPublisher {
  const { pool, log } = deps;

  return {
    async emitErasureRequested(evt: ErasureEmit): Promise<void> {
      // Tenant-first guard (I-S01): never enqueue a tenantless erasure trigger.
      if (!evt.brandId || !UUID_RE.test(evt.brandId)) {
        log.warn(
          { source: evt.source },
          '[core] erasure trigger NOT enqueued — missing/invalid brand_id (synchronous erase already durable)',
        );
        return;
      }
      // Addressability guard: without email/phone/brain_id the orchestrator could never
      // resolve the subject — skip (and say so) rather than enqueue a dead row.
      const brainId = evt.brainId && UUID_RE.test(evt.brainId) ? evt.brainId : undefined;
      const email = evt.subjectEmail?.trim() || undefined;
      const phone = evt.subjectPhone?.trim() || undefined;
      if (!brainId && !email && !phone) {
        log.warn(
          { brand_id: evt.brandId, source: evt.source },
          '[core] erasure trigger NOT enqueued — no subject address (email/phone/brain_id)',
        );
        return;
      }

      const correlationId = evt.correlationId ?? 'system';
      const eventId = randomUUID();
      const envelope = {
        schema_version: '1' as const,
        event_id: eventId,
        brand_id: evt.brandId,
        correlation_id: correlationId,
        event_name: ERASURE_REQUESTED_EVENT_NAME,
        occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        // All-false = full consent withdrawal: an erasure request withdraws everything. This is
        // BOTH the orchestrator's extractFlags gate and the signal the worker lane's consent
        // projection (ProjectConsentUseCase reuse) folds.
        consent_flags: {
          analytics: false,
          marketing: false,
          personalization: false,
          ai_processing: false,
        },
        properties: {
          source: evt.source,
          reason: 'erasure',
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(brainId ? { brain_id: brainId } : {}),
        },
      };

      // Contract stability: the queue payload keeps the EXACT CollectorEventV1 wire shape the
      // Kafka lane carried, so EraseSubjectUseCase parses it unchanged. Never an invalid row.
      const parsed = CollectorEventV1Schema.safeParse(envelope);
      if (!parsed.success) {
        log.error(
          { brand_id: evt.brandId, source: evt.source, issues: parsed.error.issues },
          '[core] erasure trigger NOT enqueued — envelope failed collector contract validation',
        );
        return;
      }

      // Region code is not a CollectorEventV1 field but the orchestrator honours a top-level
      // region_code for hash parity — additive to the stored JSON, absent from the Zod contract.
      const payload: Record<string, unknown> = {
        ...parsed.data,
        ...(evt.regionCode ? { region_code: evt.regionCode } : {}),
      };

      // Primary subject address (mirrors the orchestrator's resolution precedence: raw email
      // first, then phone, then direct brain_id). subject_ref is an ops handle, never raw PII.
      const [subjectKind, subjectRef] = email
        ? (['email', subjectRefDigest(email)] as const)
        : phone
          ? (['phone', subjectRefDigest(phone)] as const)
          : (['brain_id', brainId as string] as const);

      try {
        const result = await pool.query(
          `INSERT INTO ops.erasure_request_queue
             (id, brand_id, subject_kind, subject_ref, source, payload,
              status, attempts, next_attempt_at, requested_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'requested', 0, now(), now(), now())
           ON CONFLICT (id) DO NOTHING`,
          [eventId, evt.brandId, subjectKind, subjectRef, evt.source, JSON.stringify(payload)],
        );
        // NO raw PII in logs (I-S02): brand_id/event_id/source + presence booleans only.
        log.info(
          {
            queue: 'ops.erasure_request_queue',
            event_id: eventId,
            brand_id: evt.brandId,
            source: evt.source,
            has_email: Boolean(email),
            has_phone: Boolean(phone),
            brain_id: brainId ?? null,
            enqueued: (result.rowCount ?? 0) > 0,
          },
          '[core] privacy.erasure.requested enqueued (RTBF trigger — PG request-driven lane)',
        );
      } catch (err) {
        // FAIL-OPEN — the synchronous partial erase is already durable; log LOUDLY so the miss
        // is operationally visible (the request is idempotent and can be re-issued to re-enqueue).
        log.error(
          { queue: 'ops.erasure_request_queue', brand_id: evt.brandId, source: evt.source, err },
          '[core] privacy.erasure.requested enqueue FAILED — full RTBF sequence NOT triggered; re-issue the erase/withdraw to retry',
        );
      }
    },
  };
}
