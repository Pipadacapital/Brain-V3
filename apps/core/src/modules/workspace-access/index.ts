/**
 * @module workspace-access
 *
 * Public API for the workspace-access module.
 * Owns: auth (register/verify/login/logout/reset), organization/brand/membership/invite, RBAC.
 *
 * All implementation is under ./internal/ — only this barrel is imported by other modules.
 */

export { AuthService, AuthError, assertArgon2Params } from './internal/application/auth.service.js';
export { WorkspaceService, WorkspaceError } from './internal/application/workspace.service.js';
export { BrandService, BrandError } from './internal/application/brand.service.js';
export { InviteService, InviteError } from './internal/application/invite.service.js';
export { OnboardingService, OnboardingError } from './internal/application/onboarding.service.js';

export { registerAuthRoutes, validateSessionPreHandler } from './internal/interfaces/rest/auth.routes.js';
export { registerWorkspaceRoutes } from './internal/interfaces/rest/workspace.routes.js';
export { registerBrandRoutes } from './internal/interfaces/rest/brand.routes.js';
export { registerMemberRoutes } from './internal/interfaces/rest/member.routes.js';

// Infrastructure primitives the composition root (frontend-api BFF) wires into routes.
// Exposed via the barrel so consumers go through the public surface, not module internals
// (I-E05 — the no-restricted-imports reach-around guard now enforces this).
export { OrganizationRepository, MembershipRepository } from './internal/infrastructure/repositories.js';
export {
  RateLimiter,
  loginFailKeySync,
  loginIpKey,
  registerIpKey,
} from './internal/infrastructure/rate-limiter.js';

export type { AuthenticatedRequest } from './internal/interfaces/rest/auth.routes.js';
export type { RoleCode } from './internal/domain/membership/entities.js';
export type { OnboardingStatus } from './internal/domain/organization/entities.js';
