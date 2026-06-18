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
import { CurrencyCodeSchema, BrandTimezoneSchema, RevenueDefinitionSchema } from './brand.api.v1.js';

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
  // feat-onboarding-ux (Deliverable 4): slug is now OPTIONAL. Derived server-side
  // (slugify(name)+suffix) when absent. RELAXING an existing constraint is additive /
  // non-breaking per api-discipline — callers that still send a slug keep working.
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
    .optional(),
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

// ── Merged onboarding provision (feat-onboarding-ux, Deliverable 3) ─────────────
// POST /api/v1/bff/onboarding/provision — provisions workspace + first brand in ONE
// transaction. NO slug field (derived server-side, Deliverable 4). The website→pixel
// path from feat-onboarding-website is preserved (domain → canonical host → pixel).

export const ProvisionOnboardingRequestSchema = z.object({
  workspace_name: z.string().min(1).max(255),
  brand_display_name: z.string().min(1).max(255),
  // Brand website (optional / skip-for-now). Server canonicalizes via normalizeBrandHost;
  // a non-empty value triggers per-brand pixel_installation auto-provision.
  domain: z.string().max(253).nullable().optional(),
  currency_code: CurrencyCodeSchema.optional(),
  timezone: BrandTimezoneSchema.optional(),
  revenue_definition: RevenueDefinitionSchema.optional(),
});
export type ProvisionOnboardingRequest = z.infer<typeof ProvisionOnboardingRequestSchema>;

export const ProvisionOnboardingResponseSchema = z.object({
  request_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  brand_id: z.string().uuid(),
  onboarding_status: z.enum(['pending', 'org_created', 'brand_created', 'integration_selected', 'complete']),
  // true when this call provisioned new rows; false when it returned the caller's
  // existing org/brand (idempotent Back-safety, Deliverable 5).
  created: z.boolean(),
});
export type ProvisionOnboardingResponse = z.infer<typeof ProvisionOnboardingResponseSchema>;
