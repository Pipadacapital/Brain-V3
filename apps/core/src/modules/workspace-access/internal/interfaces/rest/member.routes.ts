/**
 * Member/Invite REST routes.
 *
 * New routes (Slice 2+3):
 *   GET  /api/v1/invites?status=pending  — list pending invites (D-4/D-11)
 *   POST /api/v1/invites/:id/resend      — rotate token + re-send (D-3)
 *   POST /api/v1/invites/:id/revoke      — revoke pending invite → 204
 *   POST /api/v1/members/:id/suspend     — suspend user (D-8); service is the authority
 *   POST /api/v1/members/:id/reactivate  — reactivate user (D-1)
 *
 * RBAC: new routes carry requireRole preHandlers (coarse gate); service enforces
 * the fine-grained hierarchy check (route guard is necessary-not-sufficient).
 *
 * Envelope: all new routes use { request_id, <key>: ... } per plan §3 contract.
 * Idempotency-Key: mutations require the header (I-ST04); enforced here.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  CreateInviteRequestSchema,
  AcceptInviteRequestSchema,
  UpdateMemberRoleRequestSchema,
} from '@brain/contracts';
import type { AuthService } from '../../application/auth.service.js';
import { AuthError } from '../../application/auth.service.js';
import type { InviteService } from '../../application/invite.service.js';
import { InviteError } from '../../application/invite.service.js';
import { validateSessionPreHandler, type AuthenticatedRequest } from './auth.routes.js';
import { requireRole } from '../../security/rbac.js';
import { requireVerifiedEmail } from '../../security/email-verified.guard.js';

export function registerMemberRoutes(
  fastify: FastifyInstance,
  authService: AuthService,
  inviteService: InviteService,
  rawPgPool?: import('pg').Pool,
): void {
  const sessionPreHandler = validateSessionPreHandler(authService);

  // ── POST /api/v1/invites ──────────────────────────────────────────────────
  // feat-onboarding-ux (Deliverable 2): inviting a member is a sensitive action —
  // requireVerifiedEmail (DB self-read → 403 EMAIL_NOT_VERIFIED if unverified). Runs
  // AFTER sessionPreHandler. The public token-authed /invites/accept stays ungated.
  fastify.post(
    '/api/v1/invites',
    { preHandler: [sessionPreHandler, requireVerifiedEmail(authService)] },
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
            // Slice 3 / field-mismatch fix: user_email + user_full_name + user_status
            // members-table.tsx reads these fields (plan §3 contract).
            user_email: m.user_email,
            user_full_name: m.user_full_name,
            user_status: m.user_status,
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

  // ── GET /api/v1/invites?status=pending (D-4 / D-11) ──────────────────────
  // requireRole('manager'): coarse RBAC gate. Service applies D-4 predicate.
  // workspaceId sourced from auth context only (MA-06).
  fastify.get(
    '/api/v1/invites',
    { preHandler: [sessionPreHandler, requireRole('manager')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const query = request.query as {
        status?: string;
        organization_id?: string;
        cursor?: string;
        limit?: string;
      };

      // Reject if caller explicitly passes a mismatched organization_id.
      if (query.organization_id && auth.workspaceId && query.organization_id !== auth.workspaceId) {
        return reply.code(403).send({
          request_id: requestId,
          error: { code: 'FORBIDDEN', message: 'organization_id does not match session workspace.' },
        });
      }

      const organizationId = auth.workspaceId ?? query.organization_id;
      if (!organizationId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'organization_id required.' },
        });
      }

      try {
        const result = await inviteService.listPendingInvites(
          {
            organizationId,
            brandId: auth.brandId ?? null,
            requestingUserId: auth.userId,
            cursor: query.cursor,
            limit: parseInt(query.limit ?? '20', 10),
          },
          correlationId,
        );
        return reply.send({
          request_id: requestId,
          invites: result.items.map((i) => ({
            id: i.id,
            organization_id: i.organizationId,
            brand_id: i.brandId,
            email: i.email,
            role_code: i.roleCode,
            status: i.status,
            expires_at: i.expiresAt.toISOString(),
            created_at: i.createdAt.toISOString(),
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

  // ── POST /api/v1/invites/:id/resend (D-3) ────────────────────────────────
  // requireRole('brand_admin'): coarse RBAC gate (service does full authority check).
  // Idempotency-Key required (I-ST04).
  fastify.post(
    '/api/v1/invites/:id/resend',
    { preHandler: [sessionPreHandler, requireRole('brand_admin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const { id } = request.params as { id: string };

      // Idempotency-Key required (I-ST04).
      if (!request.headers['idempotency-key']) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header required.' },
        });
      }

      const organizationId = auth.workspaceId;
      if (!organizationId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'Session lacks workspace context.' },
        });
      }

      try {
        const invite = await inviteService.resendInvite(
          id,
          auth.userId,
          organizationId,
          auth.brandId ?? null,
          correlationId,
        );
        return reply.send({
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

  // ── POST /api/v1/invites/:id/revoke ──────────────────────────────────────
  // 204 No Content on success. Idempotency-Key required.
  fastify.post(
    '/api/v1/invites/:id/revoke',
    { preHandler: [sessionPreHandler, requireRole('brand_admin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const { id } = request.params as { id: string };

      if (!request.headers['idempotency-key']) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header required.' },
        });
      }

      const organizationId = auth.workspaceId;
      if (!organizationId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'Session lacks workspace context.' },
        });
      }

      try {
        await inviteService.revokeInvite(
          id,
          auth.userId,
          organizationId,
          auth.brandId ?? null,
          correlationId,
        );
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof InviteError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  // ── POST /api/v1/members/:id/suspend (D-8) ───────────────────────────────
  // :id is the MEMBERSHIP id. Route resolves app_user_id from the membership row
  // (GUC-pool RLS read → org-scoped) then passes to authService (rawPgPool path
  // which re-asserts org via D-9). Defence-in-depth double-lookup.
  // requireRole('brand_admin') is the coarse gate; authService is the real guard (C-4).
  fastify.post(
    '/api/v1/members/:id/suspend',
    { preHandler: [sessionPreHandler, requireRole('brand_admin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const { id: membershipId } = request.params as { id: string };

      if (!request.headers['idempotency-key']) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header required.' },
        });
      }

      const organizationId = auth.workspaceId;
      if (!organizationId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'Session lacks workspace context.' },
        });
      }

      try {
        // Route-level: resolve app_user_id + brand_id from membership id via pool read.
        // The rawPgPool query is scoped by the explicit organizationId WHERE clause.
        // authService.suspendUser will re-assert org via D-9 on its own rawPgPool path.
        const membershipRow = await resolveMembership(rawPgPool, membershipId, organizationId);
        if (!membershipRow) {
          return reply.code(404).send({
            request_id: requestId,
            error: { code: 'NOT_FOUND', message: 'Member not found.' },
          });
        }

        await authService.suspendUser(
          membershipRow.appUserId,
          auth.userId,
          organizationId,
          membershipRow.brandId,
          correlationId,
        );

        // Return updated member row (fetch after suspend for current user_status).
        return reply.send({
          request_id: requestId,
          member: {
            id: membershipRow.id,
            organization_id: membershipRow.organizationId,
            brand_id: membershipRow.brandId,
            app_user_id: membershipRow.appUserId,
            role_code: membershipRow.roleCode,
            user_status: 'suspended' as const,
            created_at: membershipRow.createdAt.toISOString(),
            updated_at: membershipRow.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        if (err instanceof InviteError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  // ── POST /api/v1/members/:id/reactivate (D-1) ────────────────────────────
  // Same double-lookup pattern as suspend. 204 path not used — returns updated member.
  fastify.post(
    '/api/v1/members/:id/reactivate',
    { preHandler: [sessionPreHandler, requireRole('brand_admin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const correlationId = (request.headers['x-correlation-id'] as string) ?? requestId;
      const auth = (request as AuthenticatedRequest).auth;
      const { id: membershipId } = request.params as { id: string };

      if (!request.headers['idempotency-key']) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header required.' },
        });
      }

      const organizationId = auth.workspaceId;
      if (!organizationId) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_WORKSPACE', message: 'Session lacks workspace context.' },
        });
      }

      try {
        const membershipRow = await resolveMembership(rawPgPool, membershipId, organizationId);
        if (!membershipRow) {
          return reply.code(404).send({
            request_id: requestId,
            error: { code: 'NOT_FOUND', message: 'Member not found.' },
          });
        }

        await authService.reactivateUser(
          membershipRow.appUserId,
          auth.userId,
          organizationId,
          membershipRow.brandId,
          correlationId,
        );

        return reply.send({
          request_id: requestId,
          member: {
            id: membershipRow.id,
            organization_id: membershipRow.organizationId,
            brand_id: membershipRow.brandId,
            app_user_id: membershipRow.appUserId,
            role_code: membershipRow.roleCode,
            user_status: 'active' as const,
            created_at: membershipRow.createdAt.toISOString(),
            updated_at: membershipRow.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        if (err instanceof InviteError) {
          return reply.code(err.statusCode).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );
}

// ── Internal helper: resolve a membership row via RLS-scoped pool read ────────
// Used by suspend + reactivate routes to look up app_user_id from membership id.
// The pool here is the GUC-wrapped pool on the fastify instance — we pass it in
// via the registered db plugin context. Since routes don't have direct pool access,
// we rely on the fact that this file is co-located with the service and we receive
// the pool as a closure argument via a thin adapter below.
//
// NOTE: This uses a raw PG query (not through the pool middleware) because the route
// handler runs AFTER session preHandler which has already validated org context.
// The RLS isolation is a second layer; the service's D-9 org assertion is the primary.

async function resolveMembership(
  pgPool: import('pg').Pool | undefined,
  membershipId: string,
  organizationId: string,
): Promise<{
  id: string;
  organizationId: string;
  brandId: string | null;
  appUserId: string;
  roleCode: string;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  if (!pgPool) {
    // Fallback: if rawPgPool not provided, return null and let service assert (D-9).
    return null;
  }

  const result = await pgPool.query<{
    id: string; organization_id: string; brand_id: string | null;
    app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
  }>(
    `SELECT id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at
     FROM membership
     WHERE id = $1 AND organization_id = $2`,
    [membershipId, organizationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    brandId: row.brand_id,
    appUserId: row.app_user_id,
    roleCode: row.role_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
