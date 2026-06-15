/**
 * RBAC guards for workspace-access routes.
 *
 * Role codes: owner | brand_admin | manager | analyst (D0.2 / ADR-006).
 * No custom roles, groups, or teams (scope-defer).
 *
 * NN-3: validateSession preHandler must be called BEFORE rbacGuard on every protected route.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RoleCode } from '../domain/membership/entities.js';
import { ROLE_HIERARCHY } from '../domain/membership/entities.js';

export interface AuthenticatedRequest {
  userId: string;
  jti: string;
  brandId: string | null;
  workspaceId: string | null;
  role: RoleCode | null;
}

/**
 * Check if the request's role meets the minimum required role.
 * Returns true if the role code is at or above the minimum in the hierarchy.
 */
export function meetsMinimumRole(actual: RoleCode, minimum: RoleCode): boolean {
  return ROLE_HIERARCHY.indexOf(actual) >= ROLE_HIERARCHY.indexOf(minimum);
}

/**
 * Fastify preHandler factory: assert minimum role in the JWT claims.
 * Must be called AFTER validateSessionPreHandler (NN-3).
 */
export function requireRole(minimum: RoleCode) {
  return async function rbacGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = (request as FastifyRequest & { auth?: AuthenticatedRequest }).auth;
    if (!auth) {
      return reply.code(401).send({
        request_id: crypto.randomUUID(),
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }

    const role = auth.role;
    if (!role || !meetsMinimumRole(role, minimum)) {
      return reply.code(403).send({
        request_id: crypto.randomUUID(),
        error: {
          code: 'FORBIDDEN',
          message: `Requires ${minimum} role or higher.`,
        },
      });
    }
  };
}

/**
 * Assert tenant membership. Verifies the request's workspaceId matches
 * the resource's organization_id (cross-tenant guard).
 */
export function assertWorkspaceMembership(
  auth: AuthenticatedRequest,
  organizationId: string,
): void {
  if (auth.workspaceId !== organizationId) {
    throw new RbacError('FORBIDDEN', 'Not a member of this workspace.');
  }
}

export class RbacError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RbacError';
  }
}
