/**
 * Identity / Customer-360 BFF routes (CQ-1 decomposition).
 *
 * Customer browse, Customer 360, vault coverage, erase (DPDP), merge-review
 * resolve, and unmerge. Reads/admin go through the identity module's PUBLIC
 * ports (IdentityReader / ContactPiiVaultService) — never module internals.
 * Brand from session (D-1); PII discipline (I-S02): counts + hashes only.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import {
  getCustomer360,
  listCustomers,
  eraseCustomer,
  listMergeReviews,
  resolveMergeReview,
  unmergeCustomer,
} from '../../../identity/index.js';
import type {
  Customer360 as ContractCustomer360,
  CustomerList as ContractCustomerList,
  VaultCoverage as ContractVaultCoverage,
  ErasureResult as ContractErasureResult,
  MergeReviewList as ContractMergeReviewList,
  MergeResolveResult as ContractMergeResolveResult,
  UnmergeResult as ContractUnmergeResult,
} from '@brain/contracts';
import {
  getCustomerScoresForBrainIds,
  getCustomerSegmentMembers,
  getCustomerAcquisitionSourceMembers,
  getCustomerOrders,
  getCustomerOrdersPage,
  isLifecycleSegment,
} from '@brain/metric-engine';
import type { BffDeps } from './_shared.js';

export function registerIdentityRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, identityReader, vaultService, identityUnmergeDirty, erasureEventPublisher } = deps;

  // ── GET /api/v1/identity/customers — customer BROWSE (discover front-door) ────
  /**
   * GET /api/v1/identity/customers?lifecycle=&search=&limit=&offset=
   *
   * Paginated, filterable list of the active brand's customers (the front-door into Customer 360 /
   * merge / unmerge / erase, all of which require a brain_id you otherwise have no way to discover).
   *
   * PII discipline (I-S02): returns counts + lifecycle/consent only — NO raw PII, not even hashed
   * identifier values. `search` is hashed server-side with the per-brand salt (raw term never stored,
   * never logged, never reaches Postgres). Brand from session (D-1): scope is auth.brandId, never the
   * request. Reads via the identity module → @brain/db DbPool (RLS-enforced under brain_app).
   */
  fastify.get(
    '/api/v1/identity/customers',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            lifecycle: { type: 'string', enum: ['anonymous', 'active', 'merged', 'split', 'erased'] },
            search: { type: 'string', maxLength: 320 },
            // Business-SEGMENT filter (RFM/lifecycle, sourced from gold_customer_scores). Validated
            // against the canonical lifecycle-segment set in the handler (isLifecycleSegment).
            segment: { type: 'string', maxLength: 32 },
            // Acquisition-SOURCE drilldown (P3): first-touch channel from gold_customer_360.acquisition_source
            // (e.g. 'google' / 'meta' / 'direct') — the UTM-source matrix links into the customers it acquired.
            acquisition_source: { type: 'string', maxLength: 128 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
            // Opaque keyset cursor from a previous page's next_cursor (Gap 4). Wins over offset
            // when both are sent; an unparseable value degrades to offset paging (never a 400).
            cursor: { type: 'string', maxLength: 512 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      const q = request.query as { lifecycle?: string; search?: string; segment?: string; acquisition_source?: string; limit?: number; offset?: number; cursor?: string };

      const limit = q.limit ?? 25;
      const offset = q.offset ?? 0;
      // A segment value not in the canonical set is ignored (treated as no filter) rather than 400ing a browse.
      const segment = q.segment && isLifecycleSegment(q.segment) ? q.segment : null;
      const acquisitionSource = q.acquisition_source && q.acquisition_source.trim().length > 0 ? q.acquisition_source.trim() : null;
      const empty: ContractCustomerList = {
        items: [],
        total: 0,
        limit,
        offset,
        searched: Boolean(q.search && q.search.trim().length > 0),
        next_cursor: null,
      };

      // Honest empty: no active brand / identity graph → no scope to browse.
      if (!auth.brandId || !identityReader) {
        return reply.send({ request_id: requestId, data: empty });
      }

      // Wire the Gold-scores enrichment + segment-membership resolvers only when the serving pool is
      // present (dev/fresh env without Trino → null enrichment + segment no-op; the working list stays).
      const srPool = deps.srPool;
      const enrichScores = srPool
        ? (brandId: string, brainIds: string[]) => getCustomerScoresForBrainIds(brandId, brainIds, { srPool })
        : undefined;
      const segmentMembers = srPool
        ? (brandId: string, seg: string) =>
            isLifecycleSegment(seg) ? getCustomerSegmentMembers(brandId, seg, { srPool }) : Promise.resolve([])
        : undefined;
      // P3 acquisition-source drilldown: resolve the acquired brain_ids from gold_customer_360 (Trino).
      const acquisitionSourceMembers = srPool
        ? (brandId: string, src: string) => getCustomerAcquisitionSourceMembers(brandId, src, { srPool })
        : undefined;

      const result: ContractCustomerList = await listCustomers(
        auth.brandId,
        { lifecycle: q.lifecycle ?? null, search: q.search ?? null, segment, acquisitionSource, limit, offset, cursor: q.cursor ?? null },
        requestId,
        { reader: identityReader, saltFn: deps.getCoreSaltHex, enrichScores, segmentMembers, acquisitionSourceMembers },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── GET /api/v1/identity/customer — Customer 360 read (P0-C, slice 1) ─────────
  /**
   * GET /api/v1/identity/customer?brain_id=<uuid>
   *
   * Returns the resolved customer profile (lifecycle + consent), its linked identifiers
   * (HASHED prefix only — never raw PII, I-S02), and merge history, for the active brand.
   *
   * Brand from session (D-1): brand_id comes from auth.brandId, NEVER from the request.
   * Reads via the identity module → @brain/db DbPool (RLS-enforced under brain_app).
   */
  fastify.get(
    '/api/v1/identity/customer',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            brain_id: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
          },
          required: ['brain_id'],
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_BRAIN_ID', message: 'brain_id must be a UUID.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      const { brain_id } = request.query as { brain_id: string };

      // Honest empty: no active brand → not_found (no brand to scope the lookup to).
      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: { state: 'not_found', brain_id },
        });
      }

      if (!identityReader) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Identity graph not available' },
        });
      }

      const srPool360 = deps.srPool;
      const ordersReader = srPool360
        ? async (brandId: string, brainId: string) => {
            const rows = await getCustomerOrders(brandId, brainId, { srPool: srPool360 });
            return rows.map((o) => ({
              order_id: o.orderId,
              lifecycle_state: o.lifecycleState,
              is_terminal: o.isTerminal,
              order_value_minor: o.orderValueMinor,
              currency_code: o.currencyCode,
              first_event_at: o.firstEventAt,
              state_effective_at: o.stateEffectiveAt,
            }));
          }
        : undefined;

      let result: ContractCustomer360;
      try {
        result = await getCustomer360(auth.brandId, brain_id, requestId, {
          reader: identityReader,
          ordersReader,
        });
      } catch {
        return reply.code(503).send({
          request_id: requestId,
          error: {
            code: 'IDENTITY_GRAPH_UNAVAILABLE',
            message: 'The identity service is temporarily unavailable. Please try again.',
          },
        });
      }

      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── GET /api/v1/identity/customer/orders — keyset-paged order list (AUD-SL-11) ─
  /**
   * GET /api/v1/identity/customer/orders?brain_id=<uuid>&limit=&cursor=
   *
   * ONE keyset page of the resolved customer's orders (latest lifecycle state each,
   * newest-first) — the paginated continuation of the Customer-360 "Orders" sub-tab,
   * which embeds only the first page. Opaque cursor (never OFFSET): pass a page's
   * `next_cursor` back to get the next (older) page; an invalid cursor degrades to the
   * first page (honest, never a 400). Brand from session (D-1); reads the
   * brain_serving.mv_silver_order_state Trino view through the ${BRAND_PREDICATE} seam.
   * Money (I-S07): order_value_minor is a SIGNED bigint minor-unit string + currency_code.
   */
  fastify.get(
    '/api/v1/identity/customer/orders',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            brain_id: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            cursor: { type: 'string', maxLength: 512 },
          },
          required: ['brain_id'],
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_BRAIN_ID', message: 'brain_id must be a UUID.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      const q = request.query as { brain_id: string; limit?: number; cursor?: string };

      // Honest empty: no active brand / no serving pool → nothing to page (never a 500).
      if (!auth.brandId || !deps.srPool) {
        return reply.send({ request_id: requestId, data: { rows: [], next_cursor: null } });
      }

      try {
        const page = await getCustomerOrdersPage(auth.brandId, q.brain_id, { srPool: deps.srPool }, {
          limit: q.limit,
          cursor: q.cursor ?? null,
        });
        return reply.send({
          request_id: requestId,
          data: {
            rows: page.rows.map((o) => ({
              order_id: o.orderId,
              lifecycle_state: o.lifecycleState,
              is_terminal: o.isTerminal,
              order_value_minor: o.orderValueMinor,
              currency_code: o.currencyCode,
              first_event_at: o.firstEventAt,
              state_effective_at: o.stateEffectiveAt,
            })),
            next_cursor: page.nextCursor,
          },
        });
      } catch {
        return reply.code(503).send({
          request_id: requestId,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'This data is temporarily unavailable. Please try again.',
          },
        });
      }
    },
  );

  // ── GET /api/v1/identity/vault-coverage — PII vault coverage (P0-C, slice 2) ──
  /**
   * GET /api/v1/identity/vault-coverage
   *
   * Returns counts-only coverage of the encrypted contact_pii vault for the active brand
   * (resolved vs vaulted customers, email/phone counts). NEVER returns raw PII. The vault
   * read uses the elevated send_service path inside the identity vault service.
   */
  fastify.get(
    '/api/v1/identity/vault-coverage',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      const empty: ContractVaultCoverage = {
        resolved_customers: 0,
        vaulted_customers: 0,
        coverage_pct: 0,
        email_count: 0,
        phone_count: 0,
      };

      if (!auth.brandId || !vaultService) {
        return reply.send({ request_id: requestId, data: empty });
      }

      const coverage: ContractVaultCoverage = await vaultService.getCoverage(auth.brandId);
      return reply.send({ request_id: requestId, data: coverage });
    },
  );

  // ── POST /api/v1/identity/customer/erase — DPDP right-to-deletion (P0-C) ──────
  /**
   * POST /api/v1/identity/customer/erase  body: { brain_id: <uuid> }
   *
   * Erases ONE customer for the active brand: hard-deletes the contact_pii vault rows,
   * tombstones identity_link, marks the customer 'erased', audits the action. State-changing
   * → CSRF-enforced via bffProtectedPreHandler. Brand from session (D-1) — a brain_id from
   * another brand erases nothing (the SECURITY DEFINER fn is scoped to brand_id + brain_id).
   *
   * AUD-OPS-036/039: the synchronous erase above is PARTIAL (immediate UX). On success we also
   * publish the canonical privacy.erasure.requested trigger (brain_id-addressed — the raw
   * subject is already hard-deleted here, so no email/phone exists to carry) so the
   * stream-worker orchestrator runs the FULL ordered sequence: DEK shred, pii_erasure_log,
   * surrogate brain_id, Gold re-projection, CAPI deletion. Fail-open: a publish failure never
   * fails this response (the publisher logs; the idempotent erase can be re-issued).
   */
  fastify.post(
    '/api/v1/identity/customer/erase',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          properties: {
            brain_id: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
          },
          required: ['brain_id'],
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_BRAIN_ID', message: 'brain_id must be a UUID.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      const { brain_id } = request.body as { brain_id: string };

      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand first.' },
        });
      }
      if (!identityReader) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Identity graph not available' },
        });
      }

      let result: ContractErasureResult;
      try {
        result = await eraseCustomer(auth.brandId, brain_id, identityReader);
      } catch {
        return reply.code(503).send({
          request_id: requestId,
          error: {
            code: 'IDENTITY_GRAPH_UNAVAILABLE',
            message: 'The identity service is temporarily unavailable. Please try again.',
          },
        });
      }
      // AUD-OPS-036: bridge to the async full-erasure orchestrator. Only for a REAL erase
      // (erased=false means the brain_id did not exist for this brand — nothing to trigger).
      if (result.erased && erasureEventPublisher) {
        await erasureEventPublisher.emitErasureRequested({
          brandId: auth.brandId,
          brainId: brain_id,
          source: 'identity.erase',
          correlationId: requestId,
        });
      }
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── GET /api/v1/identity/merge-reviews — pending merge candidates (P0-C) ──────
  fastify.get(
    '/api/v1/identity/merge-reviews',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      const empty: ContractMergeReviewList = { reviews: [] };
      if (!auth.brandId || !identityReader) {
        return reply.send({ request_id: requestId, data: empty });
      }
      const data: ContractMergeReviewList = await listMergeReviews(auth.brandId, requestId, { reader: identityReader });
      return reply.send({ request_id: requestId, data });
    },
  );

  // ── POST /api/v1/identity/merge-reviews/resolve — approve/reject a merge (P0-C) ─
  fastify.post(
    '/api/v1/identity/merge-reviews/resolve',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          properties: {
            review_id: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
            decision: { type: 'string', enum: ['merge', 'reject'] },
          },
          required: ['review_id', 'decision'],
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_INPUT', message: 'review_id (uuid) + decision (merge|reject) required.' },
        });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const { review_id, decision } = request.body as { review_id: string; decision: 'merge' | 'reject' };
      if (!auth.brandId || !identityReader) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand first.' },
        });
      }
      let result: ContractMergeResolveResult;
      try {
        result = await resolveMergeReview(auth.brandId, review_id, decision, identityReader);
      } catch {
        return reply.code(503).send({
          request_id: requestId,
          error: {
            code: 'IDENTITY_GRAPH_UNAVAILABLE',
            message: 'The identity service is temporarily unavailable. Please try again.',
          },
        });
      }
      return reply.send({ request_id: requestId, data: result });
    },
  );

  // ── POST /api/v1/identity/customer/unmerge — split a merged customer (P0-C) ───
  fastify.post(
    '/api/v1/identity/customer/unmerge',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          properties: {
            brain_id: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
            // SPEC: A.2.4 (WA-19) — optional operator reason for the reversible-decision-log (audited).
            reason: { type: 'string', maxLength: 500 },
          },
          required: ['brain_id'],
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_BRAIN_ID', message: 'brain_id must be a UUID.' },
        });
      }
      const auth = (request as AuthenticatedRequest).auth;
      const { brain_id, reason } = request.body as { brain_id: string; reason?: string };
      if (!auth.brandId || !identityReader) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand first.' },
        });
      }
      let result: ContractUnmergeResult;
      try {
        // SPEC: A.2.4 (WA-19) / ADR-0015 WS3 — actor = the auth principal (audited); onUnmerged
        // enqueues the restitch + journey-reversion dirty rows DIRECTLY into the PG queues the
        // Silver identity stage drains (replaces the retired identity.unmerged.v1 publish), fail-open.
        result = await unmergeCustomer(auth.brandId, brain_id, identityReader, {
          actor: auth.userId,
          reason,
          onUnmerged: identityUnmergeDirty
            ? (evt) =>
                identityUnmergeDirty.markUnmerged({
                  brandId: evt.brandId,
                  restoredBrainId: evt.restoredBrainId,
                  survivorBrainId: evt.survivorBrainId,
                  mergeEventId: evt.mergeEventId,
                  actor: evt.actor,
                  reason: evt.reason,
                  correlationId: requestId,
                })
            : undefined,
        });
      } catch {
        return reply.code(503).send({
          request_id: requestId,
          error: {
            code: 'IDENTITY_GRAPH_UNAVAILABLE',
            message: 'The identity service is temporarily unavailable. Please try again.',
          },
        });
      }
      return reply.send({ request_id: requestId, data: result });
    },
  );
}
