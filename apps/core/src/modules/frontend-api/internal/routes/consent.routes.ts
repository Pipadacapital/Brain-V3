/**
 * Consent / Compliance BFF routes (CQ-1 decomposition).
 *
 * Brand-scoped reads behind /settings/consent: coverage, suppression summary, gate
 * activity, and the read-only permitted-hours window config. All read ONLY the consent
 * system-of-record through the analytics use-cases inside withBrandTxn (RLS-enforced).
 * Brand from session (D-1); for consent an empty SoR is the FAIL-CLOSED state.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import {
  getConsentCoverage,
  getConsentSuppressionSummary,
  getConsentGateActivity,
  getConsentWindowConfig,
} from '../../../analytics/index.js';
import type { BffDeps } from './_shared.js';

export function registerConsentRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, rawPool } = deps;

  // ── Consent / Compliance (D13 — feat-d13-consent-cancontact Track C) ──────────
  //
  // Four brand-scoped reads behind the per-brand /settings/consent surface. All read
  // ONLY the consent system-of-record (consent_record + consent_tombstone + audit_log)
  // through the analytics use-cases inside withBrandTxn (GUC per-txn, RLS-enforced).
  // Brand from session (D-1, NEVER body). Honest no_data (D-2) — for consent, an empty
  // SoR is the FAIL-CLOSED state: nothing is sendable, "blocked until consent recorded".
  // PII: counts + hashes only; no raw email/phone (I-S02 / COMPLIANCE.md). No money.

  /**
   * GET /api/v1/consent/coverage
   * Per-category granted/withdrawn subject counts (the consent posture at a glance).
   */
  fastify.get(
    '/api/v1/consent/coverage',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }
      const result = await getConsentCoverage(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/consent/suppression-summary
   * Marketing-suppression counts (the fail-closed denominator: tombstoned + no-consent).
   */
  fastify.get(
    '/api/v1/consent/suppression-summary',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }
      const result = await getConsentSuppressionSummary(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/consent/gate-activity
   * The last-N can_contact() gate decisions by reason (from audit_log) — makes the
   * DEFAULT-CLOSED posture VISIBLE (a 'block: consent_absent' row proves the gate denied).
   */
  fastify.get(
    '/api/v1/consent/gate-activity',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' } });
      }
      const result = await getConsentGateActivity(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/consent/window-config
   * The read-only 9am–9pm IST permitted-hours send window. SERVER-enforced at the queue
   * (TCCCPR/DLT) — surfaced here as display + a server-computed in_window_now / next-open
   * boundary (the UI never derives the window from a client clock). No DB read.
   */
  fastify.get(
    '/api/v1/consent/window-config',
    { preHandler: [bffProtectedPreHandler] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const result = getConsentWindowConfig();
      return reply.send({ request_id: requestId, data: result });
    },
  );
}
