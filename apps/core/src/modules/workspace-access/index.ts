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

export { registerAuthRoutes, validateSessionPreHandler } from './internal/interfaces/rest/auth.routes.js';
export { registerWorkspaceRoutes } from './internal/interfaces/rest/workspace.routes.js';
export { registerBrandRoutes } from './internal/interfaces/rest/brand.routes.js';
export { registerMemberRoutes } from './internal/interfaces/rest/member.routes.js';

export type { AuthenticatedRequest } from './internal/interfaces/rest/auth.routes.js';
export type { RoleCode } from './internal/domain/membership/entities.js';
