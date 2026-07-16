/**
 * Saved-segments BFF routes (P2) — CRUD + preview over ops.saved_segment.
 *
 * A saved segment is a user-authored customer-segment DEFINITION (the RFM / lifecycle / affinity /
 * churn rule tree). It is operational state in PostgreSQL (the `ops` schema, migration 0120), NOT an
 * Iceberg/Trino fact — the medallion is the system of record for facts; a segment is a mutable,
 * brand-scoped query definition. The `definition` JSONB is OPAQUE to the API (validated only as a
 * JSON object; re-evaluated at run time over the serving spine — no member materialization).
 *
 * brand_id is ALWAYS from the session (D-1: auth.brandId), NEVER from the request body/header; the
 * authoring actor is auth.userId. ops.saved_segment is FORCE-RLS with a born-secure brand_id
 * isolation policy, so writes are pinned to the session brand and reads only see it. All access runs
 * through withBrandTxn (sets the brand GUC + brain_app role) inside the query layer.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import {
  listSavedSegments,
  createSavedSegment,
  updateSavedSegment,
  deleteSavedSegment,
  previewSegment,
} from '../../../analytics/index.js';
import type {
  SavedSegmentList as ContractSavedSegmentList,
  SegmentPreviewResult as ContractSegmentPreviewResult,
} from '@brain/contracts';
import type { BffDeps } from './_shared.js';

export function registerSegmentsRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, rawPool, srPool } = deps;

  /**
   * GET /api/v1/segments — the brand's saved segments (newest first). Brand from session (D-1).
   * Honest-empty: an empty list (a brand legitimately has no segments) — never a fabricated row.
   */
  fastify.get(
    '/api/v1/segments',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) return reply.send({ request_id: requestId, data: { segments: [] } });
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'operational store not available' } });
      }
      const segments = await listSavedSegments(auth.brandId, { pool: rawPool });
      const result: ContractSavedSegmentList = { segments };
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/segments — create one segment. brand + actor from session; definition opaque JSON.
   */
  fastify.post(
    '/api/v1/segments',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['name', 'definition'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            definition: { type: 'object' }, // opaque rule tree (validated shape only)
          },
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'name (1–200) and a definition object are required.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) return reply.code(409).send({ request_id: requestId, error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand first.' } });
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'operational store not available' } });
      }
      const body = request.body as { name: string; definition: Record<string, unknown> };
      try {
        const segment = await createSavedSegment(auth.brandId, auth.userId, body, { pool: rawPool });
        return reply.code(201).send({ request_id: requestId, data: segment });
      } catch (err) {
        request.log.error({ err }, 'saved segment create failed');
        return reply.code(500).send({ request_id: requestId, error: { code: 'INTERNAL_ERROR', message: 'Could not save segment.' } });
      }
    },
  );

  /**
   * PUT /api/v1/segments/:id — rename and/or edit the rule tree. RLS scopes to the session brand;
   * a cross-brand or unknown id → 404. At least one of name/definition must be provided.
   */
  fastify.put(
    '/api/v1/segments/:id',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
          additionalProperties: false,
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            definition: { type: 'object' },
          },
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'id must be a UUID; name/definition must be valid when present.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) return reply.code(409).send({ request_id: requestId, error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand first.' } });
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'operational store not available' } });
      }
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; definition?: Record<string, unknown> };
      if (body.name === undefined && body.definition === undefined) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'Provide name and/or definition to update.' } });
      }
      try {
        const segment = await updateSavedSegment(auth.brandId, id, body, { pool: rawPool });
        if (!segment) {
          return reply.code(404).send({ request_id: requestId, error: { code: 'SEGMENT_NOT_FOUND', message: 'Segment not found.' } });
        }
        return reply.send({ request_id: requestId, data: segment });
      } catch (err) {
        request.log.error({ err }, 'saved segment update failed');
        return reply.code(500).send({ request_id: requestId, error: { code: 'INTERNAL_ERROR', message: 'Could not update segment.' } });
      }
    },
  );

  /**
   * DELETE /api/v1/segments/:id — remove a segment. RLS scopes to the session brand; unknown id → 404.
   */
  fastify.delete(
    '/api/v1/segments/:id',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'id must be a UUID.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) return reply.code(409).send({ request_id: requestId, error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand first.' } });
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'operational store not available' } });
      }
      const { id } = request.params as { id: string };
      const deleted = await deleteSavedSegment(auth.brandId, id, { pool: rawPool });
      if (!deleted) {
        return reply.code(404).send({ request_id: requestId, error: { code: 'SEGMENT_NOT_FOUND', message: 'Segment not found.' } });
      }
      return reply.code(204).send();
    },
  );

  /**
   * POST /api/v1/segments/preview — count the customers a definition would match WITHOUT persisting.
   * Reuses the customer-base count path (gold_customer_360 via the metric-engine). Brand from session.
   * Honest no_data when the brand has no customers (never a fabricated zero).
   */
  fastify.post(
    '/api/v1/segments/preview',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['definition'],
          properties: { definition: { type: 'object' } },
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'A definition object is required.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (duckdb-serving) not available' } });
      }
      const body = request.body as { definition: Record<string, unknown> };
      const result: ContractSegmentPreviewResult = await previewSegment(auth.brandId, body.definition, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );
}
