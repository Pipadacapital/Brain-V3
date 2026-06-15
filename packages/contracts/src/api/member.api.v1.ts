/**
 * member.api.v1 — Zod contracts for User / Member / Invite API endpoints.
 *
 * POST   /api/v1/invites
 * POST   /api/v1/invites/accept
 * GET    /api/v1/members
 * PATCH  /api/v1/members/:id/role
 * DELETE /api/v1/members/:id
 *
 * INVARIANTS:
 *  - All mutations require Idempotency-Key (I-ST04).
 *  - Lists use keyset/cursor pagination — no OFFSET.
 *  - role_code values: owner | brand_admin | manager | analyst (D0.2).
 *  - Sole-Owner guard enforced at service layer (cannot remove/demote last owner).
 */
import { z } from 'zod';
import { RoleCodeSchema } from './workspace.api.v1.js';

// ── Member ────────────────────────────────────────────────────────────────────

export const MemberSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  brand_id: z.string().uuid().nullable(),
  app_user_id: z.string().uuid(),
  role_code: RoleCodeSchema,
  email: z.string().email(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export type Member = z.infer<typeof MemberSchema>;

// ── Invite ────────────────────────────────────────────────────────────────────

export const InviteSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  brand_id: z.string().uuid().nullable(),
  email: z.string().email(),
  role_code: RoleCodeSchema,
  status: z.enum(['pending', 'accepted', 'expired', 'revoked']),
  expires_at: z.string().datetime({ offset: true }),
  created_at: z.string().datetime({ offset: true }),
});
export type Invite = z.infer<typeof InviteSchema>;

// ── Create Invite ─────────────────────────────────────────────────────────────

export const CreateInviteRequestSchema = z.object({
  organization_id: z.string().uuid(),
  brand_id: z.string().uuid().nullable().optional(),
  email: z.string().email().max(254),
  role_code: RoleCodeSchema,
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;

export const CreateInviteResponseSchema = z.object({
  request_id: z.string().uuid(),
  invite: InviteSchema,
});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>;

// ── Accept Invite ─────────────────────────────────────────────────────────────

export const AcceptInviteRequestSchema = z.object({
  token: z.string().min(32).max(128),
  /** Optional — if the invitee is not yet registered. */
  password: z
    .string()
    .min(8)
    .max(72)
    .optional(),
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>;

export const AcceptInviteResponseSchema = z.object({
  request_id: z.string().uuid(),
  membership: MemberSchema,
  /** Present if a new user was created during accept. */
  access_token: z.string().optional(),
});
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponseSchema>;

// ── List Members ──────────────────────────────────────────────────────────────

export const ListMembersQuerySchema = z.object({
  organization_id: z.string().uuid(),
  brand_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListMembersQuery = z.infer<typeof ListMembersQuerySchema>;

export const ListMembersResponseSchema = z.object({
  request_id: z.string().uuid(),
  members: z.array(MemberSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type ListMembersResponse = z.infer<typeof ListMembersResponseSchema>;

// ── Update Member Role ────────────────────────────────────────────────────────

export const UpdateMemberRoleRequestSchema = z.object({
  role_code: RoleCodeSchema,
});
export type UpdateMemberRoleRequest = z.infer<typeof UpdateMemberRoleRequestSchema>;

export const UpdateMemberRoleResponseSchema = z.object({
  request_id: z.string().uuid(),
  member: MemberSchema,
});
export type UpdateMemberRoleResponse = z.infer<typeof UpdateMemberRoleResponseSchema>;
