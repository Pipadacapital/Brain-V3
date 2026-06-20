/**
 * Consent write + gate-probe routes (D13 — Track B, backend).
 *
 * Brand-scoped, session-guarded operator/API endpoints:
 *   POST /api/v1/consent/grant     — record a marketing consent grant (append-only SoR).
 *   POST /api/v1/consent/withdraw  — record a withdrawal (consent_record + tombstone).
 *   POST /api/v1/consent/check     — run the can_contact() gate for a recipient and
 *                                    return the decision (the gate-probe; audited like
 *                                    any real send, so it surfaces in gate-activity).
 *
 * Each handler:
 *   - asserts a session (preHandler) and resolves brandId from the JWT claims,
 *   - acquires a FRESH GUC-scoped DbClient per request (no GUC bleed),
 *   - hashes the raw recipient via identity-core (never persists/logs raw PII),
 *   - returns a request_id on every error (Stage-4 VETO surface),
 *   - is fail-closed: a missing salt HARD-CRASHES the request (500), never a silent allow.
 *
 * The raw recipient is accepted in the request body, hashed immediately, and never
 * stored. The consent SoR + send_log + audit payload carry subject_hash only (I-S02).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { DbPool } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { ConsentCategory } from '@brain/contracts';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import { CanContactEngine } from './can-contact.engine.js';
import { PgSuppressionQuery } from './suppression.query.js';
import { StubDltRegistry, StubNcprRegistry } from './stubs.js';
import { FunctionSaltPort } from './salt.adapter.js';
import { ConsentWriter } from './consent-write.js';
import type { ContactChannel, ContactPurpose } from './contact-types.js';

// ── Manual validation (no zod dep in core) ──────────────────────────────────
const CHANNELS: ContactChannel[] = [
  'transactional_email',
  'marketing_email',
  'whatsapp',
  'sms',
];
const CATEGORIES: ConsentCategory[] = [
  'analytics',
  'marketing',
  'personalization',
  'ai_processing',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function asChannel(v: unknown): ContactChannel | null {
  return typeof v === 'string' && (CHANNELS as string[]).includes(v)
    ? (v as ContactChannel)
    : null;
}
function asCategory(v: unknown): ConsentCategory | null {
  return typeof v === 'string' && (CATEGORIES as string[]).includes(v)
    ? (v as ConsentCategory)
    : null;
}
function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface ConsentRoutesDeps {
  pool: DbPool;
  audit: AuditWriter;
  saltFn: (brandId: string) => Promise<string>;
  /** Session-asserting preHandler (validateSessionPreHandler(authService)). */
  sessionPreHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

export function registerConsentRoutes(
  fastify: FastifyInstance,
  deps: ConsentRoutesDeps,
): void {
  const salt = new FunctionSaltPort(deps.saltFn);

  function requireBrand(
    request: FastifyRequest,
    reply: FastifyReply,
    requestId: string,
  ): string | null {
    const auth = (request as AuthenticatedRequest).auth;
    if (!auth?.brandId) {
      reply.code(400).send({
        request_id: requestId,
        error: { code: 'NO_BRAND_CONTEXT', message: 'No brand in session context.' },
      });
      return null;
    }
    return auth.brandId;
  }

  /**
   * T2-7 / I-ST04: consent writes are state-changing, so they require an Idempotency-Key header —
   * a client that retries a grant/withdraw (network blip, double-submit) sends the SAME key and the
   * action is recorded once. The underlying writes are already idempotent (consent_record /
   * consent_tombstone INSERT ... ON CONFLICT DO NOTHING); the key makes the SAFE-RETRY contract
   * explicit and ties retries to one audit entry. Mirrors the member-mutation enforcement.
   * Returns the key, or null after sending a 400 (caller must `return` on null).
   */
  function requireIdempotencyKey(
    request: FastifyRequest,
    reply: FastifyReply,
    requestId: string,
  ): string | null {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      reply.code(400).send({
        request_id: requestId,
        error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header required.' },
      });
      return null;
    }
    return key;
  }

  // ── POST /api/v1/consent/grant ──────────────────────────────────────────────
  fastify.post(
    '/api/v1/consent/grant',
    { preHandler: [deps.sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId =
        (request.headers['x-correlation-id'] as string) ?? requestId;
      const brandId = requireBrand(request, reply, requestId);
      if (!brandId) return;
      const idempotencyKey = requireIdempotencyKey(request, reply, requestId);
      if (!idempotencyKey) return;
      const auth = (request as AuthenticatedRequest).auth;

      const body = isRecord(request.body) ? request.body : {};
      const recipient = nonEmptyString(body['recipient']);
      const channel = asChannel(body['channel']);
      const category = asCategory(body['category'] ?? 'marketing');
      const policyVersion =
        typeof body['policy_version'] === 'string'
          ? (body['policy_version'] as string)
          : undefined;
      if (!recipient || !channel || !category) {
        return reply.code(422).send({
          request_id: requestId,
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed' },
        });
      }

      const client = await deps.pool.connect();
      try {
        const writer = new ConsentWriter({ db: client, salt, audit: deps.audit });
        const { subjectHash } = await writer.grant({
          brandId,
          recipient,
          channel,
          category,
          source: 'operator',
          policyVersion,
          actorId: auth.userId,
          actorRole: auth.role ?? 'operator',
          correlationId,
          idempotencyKey,
        });
        return reply.code(201).send({
          request_id: requestId,
          subject_hash: subjectHash,
          category,
          state: 'granted',
        });
      } catch (err) {
        request.log.error({ err, requestId }, '[consent] grant failed');
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'CONSENT_WRITE_FAILED', message: 'Could not record consent.' },
        });
      } finally {
        client.release();
      }
    },
  );

  // ── POST /api/v1/consent/withdraw ───────────────────────────────────────────
  fastify.post(
    '/api/v1/consent/withdraw',
    { preHandler: [deps.sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId =
        (request.headers['x-correlation-id'] as string) ?? requestId;
      const brandId = requireBrand(request, reply, requestId);
      if (!brandId) return;
      const idempotencyKey = requireIdempotencyKey(request, reply, requestId);
      if (!idempotencyKey) return;
      const auth = (request as AuthenticatedRequest).auth;

      const body = isRecord(request.body) ? request.body : {};
      const recipient = nonEmptyString(body['recipient']);
      const channel = asChannel(body['channel']);
      // category null = withdraw all; an explicit invalid string is rejected.
      const rawCategory = body['category'];
      const category =
        rawCategory === null || rawCategory === undefined
          ? null
          : asCategory(rawCategory);
      const reason =
        body['reason'] === 'erasure'
          ? ('erasure' as const)
          : ('withdrawal' as const);
      if (
        !recipient ||
        !channel ||
        (rawCategory !== null && rawCategory !== undefined && category === null)
      ) {
        return reply.code(422).send({
          request_id: requestId,
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed' },
        });
      }

      const client = await deps.pool.connect();
      try {
        const writer = new ConsentWriter({ db: client, salt, audit: deps.audit });
        const { subjectHash } = await writer.withdraw({
          brandId,
          recipient,
          channel,
          category,
          reason,
          source: 'operator',
          actorId: auth.userId,
          actorRole: auth.role ?? 'operator',
          correlationId,
          idempotencyKey,
        });
        return reply.code(201).send({
          request_id: requestId,
          subject_hash: subjectHash,
          category,
          state: 'withdrawn',
        });
      } catch (err) {
        request.log.error({ err, requestId }, '[consent] withdraw failed');
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'CONSENT_WRITE_FAILED', message: 'Could not record withdrawal.' },
        });
      } finally {
        client.release();
      }
    },
  );

  // ── POST /api/v1/consent/check (the can_contact gate probe) ─────────────────
  fastify.post(
    '/api/v1/consent/check',
    { preHandler: [deps.sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const brandId = requireBrand(request, reply, requestId);
      if (!brandId) return;

      const body = isRecord(request.body) ? request.body : {};
      const recipient = nonEmptyString(body['recipient']);
      const channel = asChannel(body['channel']);
      const purpose =
        body['purpose'] === 'transactional' || body['purpose'] === 'marketing'
          ? (body['purpose'] as ContactPurpose)
          : null;
      if (!recipient || !channel || !purpose) {
        return reply.code(422).send({
          request_id: requestId,
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed' },
        });
      }

      const client = await deps.pool.connect();
      try {
        const engine = new CanContactEngine({
          salt,
          suppression: new PgSuppressionQuery(client),
          dlt: new StubDltRegistry(),
          ncpr: new StubNcprRegistry(),
        });
        const decision = await engine.evaluate({
          brandId,
          recipient,
          channel,
          purpose,
        });

        // Audit the probe like any gate decision (hashed subject only, no PII) so it
        // surfaces in the gate-activity feed — making default-closed VISIBLE.
        try {
          await deps.audit.append({
            brand_id: brandId,
            actor_id: null,
            actor_role: 'system',
            action: 'notification.can_contact',
            entity_type: 'consent_record',
            entity_id: decision.subjectHash ?? 'transactional',
            payload: {
              decision: decision.decision,
              reason: decision.reason,
              channel,
              purpose,
              subject_hash: decision.subjectHash,
              release_after: decision.releaseAfter ?? null,
            },
          });
        } catch (auditErr) {
          request.log.error({ err: auditErr, requestId }, '[consent] gate audit failed');
        }

        return reply.code(200).send({
          request_id: requestId,
          decision: decision.decision,
          reason: decision.reason,
          release_after: decision.releaseAfter ?? null,
        });
      } catch (err) {
        request.log.error({ err, requestId }, '[consent] gate check failed');
        return reply.code(500).send({
          request_id: requestId,
          error: { code: 'GATE_CHECK_FAILED', message: 'Could not evaluate the gate.' },
        });
      } finally {
        client.release();
      }
    },
  );
}
