/**
 * Conversion-Feedback / CAPI BFF routes (CQ-1 decomposition).
 *
 * Brand-scoped reads behind /analytics/conversion-feedback: passback summary, the
 * passback event log, and the deletion-request log. All read ONLY the CAPI passback
 * system-of-record through the analytics use-cases inside withBrandTxn (RLS-enforced).
 * Brand from session (D-1); honest no_data; PII = truncated event_id (sha256) only.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import {
  getCapiFeedbackSummary,
  getCapiFeedbackEvents,
  getCapiFeedbackDeletions,
} from '../../../analytics/index.js';
import type { BffDeps } from './_shared.js';

export function registerFeedbackRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, rawPool } = deps;

  // ── Conversion-Feedback / CAPI (Phase 6 — feat-capi-conversion-feedback Track C) ──────
  //
  // Three brand-scoped reads behind the stakeholder-visible Conversion-Feedback surface
  // (/analytics/conversion-feedback). All read ONLY the CAPI passback system-of-record
  // (capi_passback_log + capi_deletion_log, migration 0034) through the analytics use-cases
  // inside withBrandTxn (GUC per-txn, RLS-enforced, NON-INERT under brain_app). Brand from
  // session (D-1, NEVER body). Honest no_data (D-2) — fail-closed when 0034 is not yet
  // migrated (nothing passed back yet). PII: counts + a TRUNCATED event_id (sha256, never
  // PII) only; NO subject_hash, NO raw email/phone (those never existed in these tables).
  // Money is BIGINT minor + currency_code (value formatted minor→major in the web layer).
  // The blocked_by_consent count is the SLO=0 (non_consented_sends) made VISIBLE; the
  // would_send_dev count + dev_boundary flag drive the honest "would-send in dev" banner.

  /**
   * GET /api/v1/feedback/capi/summary
   * Passed-back vs BLOCKED-BY-CONSENT counts, deletion-request count, and the
   * match-quality proxy (avg Meta match keys / 4) — the SLO=0 made visible.
   */
  fastify.get(
    '/api/v1/feedback/capi/summary',
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
      const result = await getCapiFeedbackSummary(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/feedback/capi/events
   * The last-N passback log rows (truncated event_id, status, value minor+currency,
   * match_key_count, occurred_at). A 'blocked_no_consent' row proves the gate denied
   * a non-consented passback; a 'would_send_dev' row is the honest dev boundary.
   */
  fastify.get(
    '/api/v1/feedback/capi/events',
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
      const result = await getCapiFeedbackEvents(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/feedback/capi/deletions
   * The last-N retroactive-deletion requests (status, event_count, requested/completed,
   * latency seconds) — proof the ≤15-min consent-withdrawal deletion path works.
   */
  fastify.get(
    '/api/v1/feedback/capi/deletions',
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
      const result = await getCapiFeedbackDeletions(auth.brandId, { pool: rawPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );
}
