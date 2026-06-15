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

      const parsed = CreateBrandRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          request_id: requestId,
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed',
            fields: parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })) },
        });
      }

      try {
        const brand = await brandService.create(
          {
            organizationId: parsed.data.workspace_id,
            displayName: parsed.data.display_name,
            domain: parsed.data.domain ?? null,
            requestingUserId: auth.userId,
            requestingRole: (auth.role ?? 'analyst') as 'owner' | 'brand_admin' | 'manager' | 'analyst',
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
        const brand = await brandService.update(id, parsed.data, auth.userId, workspaceId, correlationId);
        return reply.send({
          request_id: requestId,
          brand: {
            id: brand.id,
            organization_id: brand.organizationId,
            display_name: brand.displayName,
            domain: brand.domain,
            status: brand.status,
            region_code: brand.regionCode,
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
