/**
 * workspace.api.v1 — Zod contracts for Workspace (organization) API endpoints.
 *
 * POST  /api/v1/workspaces
 * GET   /api/v1/workspaces
 * GET   /api/v1/workspaces/:id
 * PATCH /api/v1/workspaces/:id
 *
 * INVARIANTS:
 *  - All mutations require Idempotency-Key (I-ST04).
 *  - Lists use keyset/cursor pagination — no OFFSET.
 *  - role_code values: owner | brand_admin | manager | analyst (D0.2, ADR-006).
 *  - Product term "Workspace" maps to database table "organization" (D0.3).
 */
import { z } from 'zod';

// ── Role codes (canon ADR-006) ────────────────────────────────────────────────

export const RoleCodeSchema = z.enum(['owner', 'brand_admin', 'manager', 'analyst']);
export type RoleCode = z.infer<typeof RoleCodeSchema>;

// ── Workspace (organization) ──────────────────────────────────────────────────

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(63).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  owner_user_id: z.string().uuid(),
  region_code: z.string().length(2).default('IN'),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

// ── Create Workspace ──────────────────────────────────────────────────────────

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const CreateWorkspaceResponseSchema = z.object({
  request_id: z.string().uuid(),
  workspace: WorkspaceSchema,
});
export type CreateWorkspaceResponse = z.infer<typeof CreateWorkspaceResponseSchema>;

// ── Get Workspace ─────────────────────────────────────────────────────────────

export const GetWorkspaceResponseSchema = z.object({
  request_id: z.string().uuid(),
  workspace: WorkspaceSchema,
});
export type GetWorkspaceResponse = z.infer<typeof GetWorkspaceResponseSchema>;

// ── Update Workspace ──────────────────────────────────────────────────────────

export const UpdateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

export const UpdateWorkspaceResponseSchema = z.object({
  request_id: z.string().uuid(),
  workspace: WorkspaceSchema,
});
export type UpdateWorkspaceResponse = z.infer<typeof UpdateWorkspaceResponseSchema>;

// ── List Workspaces ───────────────────────────────────────────────────────────
// Keyset pagination — no OFFSET (ADR-001 / anti-pattern).

export const ListWorkspacesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListWorkspacesQuery = z.infer<typeof ListWorkspacesQuerySchema>;

export const ListWorkspacesResponseSchema = z.object({
  request_id: z.string().uuid(),
  workspaces: z.array(WorkspaceSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type ListWorkspacesResponse = z.infer<typeof ListWorkspacesResponseSchema>;
