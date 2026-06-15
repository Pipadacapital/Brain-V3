/**
 * Workspace REST routes.
 * All routes are protected with validateSession (NN-3).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  ListWorkspacesQuerySchema,
} from '@brain/contracts';
import type { AuthService } from '../../application/auth.service.js';
import type { WorkspaceService } from '../../application/workspace.service.js';
import { WorkspaceError } from '../../application/workspace.service.js';
import { validateSessionPreHandler, type AuthenticatedRequest } from './auth.routes.js';

export function registerWorkspaceRoutes(
  fastify: FastifyInstance,
  authService: AuthService,
  workspaceService: WorkspaceService,
): void {
  const sessionPreHandler = validateSessionPreHandler(authService);

  // ── POST /api/v1/workspaces ───────────────────────────────────────────────
  fastify.post(
    '/api/v1/workspaces',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      const parsed = CreateWorkspaceRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          request_id: requestId,
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed',
            fields: parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })) },
        });
      }

      try {
        const { organization } = await workspaceService.create(
          { ...parsed.data, ownerUserId: auth.userId },
          correlationId,
        );
        return reply.code(201).send({
          request_id: requestId,
          workspace: {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            owner_user_id: organization.ownerUserId,
            region_code: organization.regionCode,
            created_at: organization.createdAt.toISOString(),
            updated_at: organization.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof WorkspaceError) {
          return reply.code(err.statusCode).send({
            request_id: requestId,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  // ── GET /api/v1/workspaces ────────────────────────────────────────────────
  fastify.get(
    '/api/v1/workspaces',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      const workspaces = await workspaceService.listForUser(auth.userId, correlationId);
      return reply.send({
        request_id: requestId,
        workspaces: workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
          owner_user_id: w.ownerUserId,
          region_code: w.regionCode,
          created_at: w.createdAt.toISOString(),
          updated_at: w.updatedAt.toISOString(),
        })),
        next_cursor: null,
        has_more: false,
      });
    },
  );

  // ── GET /api/v1/workspaces/:id ────────────────────────────────────────────
  fastify.get(
    '/api/v1/workspaces/:id',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const { id } = request.params as { id: string };

      try {
        const workspace = await workspaceService.getById(id, auth.userId, correlationId);
        if (!workspace) {
          return reply.code(404).send({
            request_id: requestId,
            error: { code: 'NOT_FOUND', message: 'Workspace not found.' },
          });
        }
        return reply.send({
          request_id: requestId,
          workspace: {
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            owner_user_id: workspace.ownerUserId,
            region_code: workspace.regionCode,
            created_at: workspace.createdAt.toISOString(),
            updated_at: workspace.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof WorkspaceError) {
          return reply.code(err.statusCode).send({
            request_id: requestId,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  // ── PATCH /api/v1/workspaces/:id ──────────────────────────────────────────
  fastify.patch(
    '/api/v1/workspaces/:id',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const { id } = request.params as { id: string };

      const parsed = UpdateWorkspaceRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          request_id: requestId,
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed' },
        });
      }

      try {
        const workspace = await workspaceService.update(id, parsed.data, auth.userId, correlationId);
        return reply.send({
          request_id: requestId,
          workspace: {
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            owner_user_id: workspace.ownerUserId,
            region_code: workspace.regionCode,
            created_at: workspace.createdAt.toISOString(),
            updated_at: workspace.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof WorkspaceError) {
          return reply.code(err.statusCode).send({
            request_id: requestId,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );
}
