/**
 * Brand REST routes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  CreateBrandRequestSchema,
  UpdateBrandRequestSchema,
} from '@brain/contracts';
import type { AuthService } from '../../application/auth.service.js';
import type { BrandService } from '../../application/brand.service.js';
import { BrandError } from '../../application/brand.service.js';
import { validateSessionPreHandler, type AuthenticatedRequest } from './auth.routes.js';

export function registerBrandRoutes(
  fastify: FastifyInstance,
  authService: AuthService,
  brandService: BrandService,
): void {
  const sessionPreHandler = validateSessionPreHandler(authService);

  fastify.post(
    '/api/v1/brands',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      // SEC MB-1: workspaceId MUST come from the authenticated JWT (auth.workspaceId),
      // never from the request body — prevents cross-org brand creation by spoofing
      // workspace_id while holding a token scoped to a different org (MA-02 principle).
      if (!auth.workspaceId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'No active workspace in session. Set an org first.' },
        });
      }

      const parsed = CreateBrandRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          request_id: requestId,
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed',
            fields: parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })) },
        });
      }

      try {
        // SEC MB-1: organizationId sourced from auth.workspaceId (JWT), NOT parsed.data.workspace_id.
        // The body workspace_id field is ignored — body.workspace_id must never govern which org
        // a brand is created in. requestingRole is intentionally omitted: BrandService.create()
        // re-derives role from the DB membership row (brand.service.ts:68), making any JWT-carried
        // role claim irrelevant (and a potential confusion/injection vector).
        const brand = await brandService.create(
          {
            organizationId: auth.workspaceId,
            displayName: parsed.data.display_name,
            domain: parsed.data.domain ?? null,
            requestingUserId: auth.userId,
            // SEC: requestingRole is authoritative from the DB membership row inside
            // BrandService.create (brand.service.ts:68-70); pass a stub value —
            // the service ignores it and re-checks against the actual membership.
            requestingRole: 'analyst',
            currencyCode: parsed.data.currency_code,
            timezone: parsed.data.timezone,
            revenueDefinition: parsed.data.revenue_definition,
          },
          correlationId,
        );
        return reply.code(201).send({
          request_id: requestId,
          brand: {
            id: brand.id,
            organization_id: brand.organizationId,
            display_name: brand.displayName,
            domain: brand.domain,
            status: brand.status,
            region_code: brand.regionCode,
            currency_code: brand.currencyCode,
            timezone: brand.timezone,
            revenue_definition: brand.revenueDefinition,
            created_at: brand.createdAt.toISOString(),
            updated_at: brand.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof BrandError) {
          return reply.code(err.statusCode).send({
            request_id: requestId,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  fastify.get(
    '/api/v1/brands/:id',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const { id } = request.params as { id: string };
      const workspaceId = auth.workspaceId ?? (request.query as { workspace_id?: string }).workspace_id;

      if (!workspaceId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'workspace_id required.' },
        });
      }

      try {
        const brand = await brandService.getById(id, auth.userId, workspaceId, correlationId);
        if (!brand) {
          return reply.code(404).send({ request_id: requestId, error: { code: 'NOT_FOUND', message: 'Brand not found.' } });
        }
        return reply.send({
          request_id: requestId,
          brand: {
            id: brand.id,
            organization_id: brand.organizationId,
            display_name: brand.displayName,
            domain: brand.domain,
            status: brand.status,
            region_code: brand.regionCode,
            currency_code: brand.currencyCode,
            timezone: brand.timezone,
            revenue_definition: brand.revenueDefinition,
            created_at: brand.createdAt.toISOString(),
            updated_at: brand.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof BrandError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  fastify.get(
    '/api/v1/brands',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as { workspace_id?: string; cursor?: string; limit?: string };
      const workspaceId = query.workspace_id ?? auth.workspaceId;

      if (!workspaceId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'workspace_id required.' },
        });
      }

      try {
        const result = await brandService.list(
          workspaceId,
          auth.userId,
          query.cursor,
          parseInt(query.limit ?? '20', 10),
          correlationId,
        );
        return reply.send({
          request_id: requestId,
          brands: result.items.map((b) => ({
            id: b.id,
            organization_id: b.organizationId,
            display_name: b.displayName,
            domain: b.domain,
            status: b.status,
            region_code: b.regionCode,
            currency_code: b.currencyCode,
            timezone: b.timezone,
            revenue_definition: b.revenueDefinition,
            created_at: b.createdAt.toISOString(),
            updated_at: b.updatedAt.toISOString(),
          })),
          next_cursor: result.nextCursor,
          has_more: result.hasMore,
        });
      } catch (err) {
        if (err instanceof BrandError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  fastify.patch(
    '/api/v1/brands/:id',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const { id } = request.params as { id: string };
      const workspaceId = auth.workspaceId ?? (request.query as { workspace_id?: string }).workspace_id;

      if (!workspaceId) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_WORKSPACE', message: 'workspace_id required.' } });
      }

      const parsed = UpdateBrandRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({ request_id: requestId, error: { code: 'VALIDATION_ERROR', message: 'Validation failed' } });
      }

      try {
        const brand = await brandService.update(
          id,
          {
            displayName: parsed.data.display_name,
            domain: parsed.data.domain,
            status: parsed.data.status,
            currencyCode: parsed.data.currency_code,
            timezone: parsed.data.timezone,
            revenueDefinition: parsed.data.revenue_definition,
          },
          auth.userId,
          workspaceId,
          correlationId,
        );
        return reply.send({
          request_id: requestId,
          brand: {
            id: brand.id,
            organization_id: brand.organizationId,
            display_name: brand.displayName,
            domain: brand.domain,
            status: brand.status,
            region_code: brand.regionCode,
            currency_code: brand.currencyCode,
            timezone: brand.timezone,
            revenue_definition: brand.revenueDefinition,
            created_at: brand.createdAt.toISOString(),
            updated_at: brand.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof BrandError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );
}
