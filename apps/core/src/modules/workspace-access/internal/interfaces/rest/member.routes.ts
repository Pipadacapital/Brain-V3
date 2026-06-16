/**
 * Member/Invite REST routes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  CreateInviteRequestSchema,
  AcceptInviteRequestSchema,
  UpdateMemberRoleRequestSchema,
} from '@brain/contracts';
import type { AuthService } from '../../application/auth.service.js';
import type { InviteService } from '../../application/invite.service.js';
import { InviteError } from '../../application/invite.service.js';
import { validateSessionPreHandler, type AuthenticatedRequest } from './auth.routes.js';

export function registerMemberRoutes(
  fastify: FastifyInstance,
  authService: AuthService,
  inviteService: InviteService,
): void {
  const sessionPreHandler = validateSessionPreHandler(authService);

  // ── POST /api/v1/invites ──────────────────────────────────────────────────
  fastify.post(
    '/api/v1/invites',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;

      const parsed = CreateInviteRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          request_id: requestId,
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed',
            fields: parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })) },
        });
      }

      try {
        const invite = await inviteService.createInvite(
          {
            organizationId: parsed.data.organization_id,
            brandId: parsed.data.brand_id ?? null,
            email: parsed.data.email,
            roleCode: parsed.data.role_code,
            invitedByUserId: auth.userId,
          },
          correlationId,
        );
        return reply.code(201).send({
          request_id: requestId,
          invite: {
            id: invite.id,
            organization_id: invite.organizationId,
            brand_id: invite.brandId,
            email: invite.email,
            role_code: invite.roleCode,
            status: invite.status,
            expires_at: invite.expiresAt.toISOString(),
            created_at: invite.createdAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof InviteError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  // ── POST /api/v1/invites/accept (public — token is the auth) ─────────────
  fastify.post(
    '/api/v1/invites/accept',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;

      const parsed = AcceptInviteRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          request_id: requestId,
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed' },
        });
      }

      try {
        const result = await inviteService.acceptInvite(parsed.data.token, correlationId);
        return reply.send({
          request_id: requestId,
          membership: {
            id: result.membership.id,
            organization_id: result.membership.organizationId,
            brand_id: result.membership.brandId,
            app_user_id: result.membership.appUserId,
            role_code: result.membership.roleCode,
            created_at: result.membership.createdAt.toISOString(),
            updated_at: result.membership.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof InviteError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  // ── GET /api/v1/members ───────────────────────────────────────────────────
  fastify.get(
    '/api/v1/members',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as { organization_id?: string; brand_id?: string; cursor?: string; limit?: string };

      const organizationId = query.organization_id ?? auth.workspaceId;
      if (!organizationId) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_WORKSPACE', message: 'organization_id required.' } });
      }

      // AC-8 / MA-06: If the caller explicitly provides organization_id, it MUST match the
      // session's workspace_id. A mismatch means the client is trying to list another
      // workspace's members — reject immediately (fail-closed, no info leak).
      if (query.organization_id && auth.workspaceId && query.organization_id !== auth.workspaceId) {
        return reply.code(403).send({
          request_id: requestId,
          error: { code: 'FORBIDDEN', message: 'organization_id does not match session workspace.' },
        });
      }

      try {
        const result = await inviteService.listMembers(
          {
            organizationId,
            brandId: query.brand_id,
            requestingUserId: auth.userId,
            cursor: query.cursor,
            limit: parseInt(query.limit ?? '20', 10),
          },
          correlationId,
        );
        return reply.send({
          request_id: requestId,
          members: result.items.map((m) => ({
            id: m.id,
            organization_id: m.organizationId,
            brand_id: m.brandId,
            app_user_id: m.appUserId,
            role_code: m.roleCode,
            email: m.email,
            created_at: m.createdAt.toISOString(),
            updated_at: m.updatedAt.toISOString(),
          })),
          next_cursor: result.nextCursor,
          has_more: result.hasMore,
        });
      } catch (err) {
        if (err instanceof InviteError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  // ── PATCH /api/v1/members/:id/role ────────────────────────────────────────
  fastify.patch(
    '/api/v1/members/:id/role',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const { id } = request.params as { id: string };
      const query = request.query as { organization_id?: string };

      // SEC-AOF-M1: Use auth.workspaceId as sole source of truth (AC-8 / MA-06).
      // If organization_id is supplied in the query and differs from the session workspace, reject immediately.
      // The org switch is done via set-org (which re-mints the JWT), not per-request params.
      if (query.organization_id && auth.workspaceId && query.organization_id !== auth.workspaceId) {
        return reply.code(403).send({
          request_id: requestId,
          error: { code: 'FORBIDDEN', message: 'organization_id does not match session workspace.' },
        });
      }

      const organizationId = auth.workspaceId ?? query.organization_id;

      if (!organizationId) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_WORKSPACE', message: 'organization_id required.' } });
      }

      const parsed = UpdateMemberRoleRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({ request_id: requestId, error: { code: 'VALIDATION_ERROR', message: 'Validation failed' } });
      }

      try {
        const updated = await inviteService.updateMemberRole(id, parsed.data.role_code, auth.userId, organizationId, correlationId);
        return reply.send({
          request_id: requestId,
          member: {
            id: updated.id,
            organization_id: updated.organizationId,
            brand_id: updated.brandId,
            app_user_id: updated.appUserId,
            role_code: updated.roleCode,
            created_at: updated.createdAt.toISOString(),
            updated_at: updated.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof InviteError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  // ── DELETE /api/v1/members/:id ────────────────────────────────────────────
  fastify.delete(
    '/api/v1/members/:id',
    { preHandler: [sessionPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const { id } = request.params as { id: string };
      const query = request.query as { organization_id?: string };

      // SEC-AOF-M1: Use auth.workspaceId as sole source of truth (AC-8 / MA-06).
      // If organization_id is supplied in the query and differs from the session workspace, reject immediately.
      if (query.organization_id && auth.workspaceId && query.organization_id !== auth.workspaceId) {
        return reply.code(403).send({
          request_id: requestId,
          error: { code: 'FORBIDDEN', message: 'organization_id does not match session workspace.' },
        });
      }

      const organizationId = auth.workspaceId ?? query.organization_id;

      if (!organizationId) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_WORKSPACE', message: 'organization_id required.' } });
      }

      try {
        await inviteService.removeMember(id, auth.userId, organizationId, correlationId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof InviteError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );
}
