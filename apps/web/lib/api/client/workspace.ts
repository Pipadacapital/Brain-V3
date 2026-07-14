// AUD-IMPL-006: extracted VERBATIM from the former 2,640-line apps/web/lib/api/client.ts
// (per-domain decomposition mirroring the backend CQ-1 split). Import from '@/lib/api/client'
// — the index re-exports this module's public surface unchanged.
import type {
  OkResponse,
  CreateWorkspaceRequest,
  WorkspaceResponse,
  WorkspaceListResponse,
  CreateBrandRequest,
  BrandResponse,
  BrandArchiveResponse,
  MemberResponse,
  InviteResponse,
  InviteMemberRequest,
  UpdateMemberRoleRequest,
  PaginatedResponse,
  AcceptInviteRequest,
  SetBrandResponse,
  ProvisionOnboardingRequest,
  ProvisionOnboardingResponse,
} from '../types';
import { bffFetch, generateRequestId } from './core';

// ── Onboarding (merged workspace+brand provisioning — feat-onboarding-ux) ───────

export const onboardingApi = {
  /**
   * POST /v1/bff/onboarding/provision — provisions organization + first brand
   * (with website→pixel) in ONE server transaction. Replaces the non-atomic
   * client-side chain (workspace create → brand create) that caused the orphan-org
   * Back-button bug. The slug is derived server-side (never sent/shown by the client).
   *
   * Idempotent per user: if the caller already has an org membership the server returns
   * the existing { organization_id, brand_id } with 200 — so a double-submit or a
   * Back→resubmit never creates a duplicate.
   */
  provision: (body: ProvisionOnboardingRequest) =>
    bffFetch<ProvisionOnboardingResponse>('/v1/bff/onboarding/provision', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),
};

// ── Workspace ─────────────────────────────────────────────────────────────────

export const workspaceApi = {
  // BFF returns { request_id, workspace: {...} } — unwrap to flat WorkspaceResponse.
  create: async (body: CreateWorkspaceRequest): Promise<WorkspaceResponse> => {
    const res = await bffFetch<{ request_id: string; workspace: WorkspaceResponse }>('/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    return res.workspace;
  },

  get: async (id: string): Promise<WorkspaceResponse> => {
    const res = await bffFetch<{ request_id: string; workspace: WorkspaceResponse }>(`/v1/workspaces/${id}`);
    return res.workspace;
  },

  list: (cursor?: string) =>
    bffFetch<WorkspaceListResponse>(
      `/v1/workspaces${cursor ? `?cursor=${cursor}` : ''}`,
    ),
};

// ── Brand ─────────────────────────────────────────────────────────────────────

export const brandApi = {
  // Core returns { request_id, brand: {...} } — unwrap to the flat BrandResponse so
  // consumers can read newBrand.id / .display_name directly. Without this, the
  // create→switch flow called switchBrand(undefined) → empty body {} → 400.
  create: async (body: CreateBrandRequest): Promise<BrandResponse> => {
    const res = await bffFetch<{ request_id: string; brand: BrandResponse }>('/v1/brands', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    return res.brand;
  },

  // BFF returns { request_id, brand: {...} } — unwrap to flat BrandResponse.
  get: async (id: string): Promise<BrandResponse> => {
    const res = await bffFetch<{ request_id: string; brand: BrandResponse }>(`/v1/brands/${id}`);
    return res.brand;
  },

  // BFF returns { request_id, brands: [...], next_cursor, has_more } — remap `brands`
  // to the PaginatedResponse `data` field the callers expect.
  list: async (cursor?: string): Promise<PaginatedResponse<BrandResponse>> => {
    const res = await bffFetch<{
      request_id: string;
      brands: BrandResponse[];
      next_cursor: string | null;
      has_more: boolean;
    }>(`/v1/brands${cursor ? `?cursor=${cursor}` : ''}`);
    return { data: res.brands, next_cursor: res.next_cursor, has_more: res.has_more };
  },

  // B1: repoint to the new set-brand BFF route (AC-1/SD-1).
  // The old /v1/brands/:id/switch had no backing route — this is the correct target.
  switchBrand: (id: string) =>
    bffFetch<SetBrandResponse>('/v1/bff/session/set-brand', {
      method: 'POST',
      body: JSON.stringify({ brand_id: id }),
      idempotencyKey: generateRequestId(),
    }),

  // Edit the brand profile (safe fields only — display_name/domain/timezone/region_code). PATCH
  // /api/v1/brands/:id; the server enforces owner/brand_admin + currency immutability. Returns the
  // updated flat BrandResponse (unwrapped from { request_id, brand }).
  update: async (
    id: string,
    body: Partial<Pick<BrandResponse, 'display_name' | 'domain' | 'timezone' | 'region_code'>>,
  ): Promise<BrandResponse> => {
    const res = await bffFetch<{ request_id: string; brand: BrandResponse }>(`/v1/brands/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    return res.brand;
  },

  // Archive (soft-delete) a brand created by mistake → DELETE /api/v1/brands/:id. The brand drops
  // out of lists and its ingest stops; reversible server-side. Owner / brand_admin only.
  remove: (id: string) =>
    bffFetch<{ request_id: string; data: BrandArchiveResponse }>(`/v1/brands/${id}`, {
      method: 'DELETE',
      idempotencyKey: generateRequestId(),
    }),
};

// ── Members ───────────────────────────────────────────────────────────────────

export const membersApi = {
  // BFF returns { request_id, members: [...], next_cursor, has_more } — remap `members`
  // to the PaginatedResponse `data` field the table reads (data?.data). Without this the
  // members table always renders empty.
  list: async (cursor?: string): Promise<PaginatedResponse<MemberResponse>> => {
    const res = await bffFetch<{
      request_id: string;
      members: MemberResponse[];
      next_cursor: string | null;
      has_more: boolean;
    }>(`/v1/members${cursor ? `?cursor=${cursor}` : ''}`);
    return { data: res.members, next_cursor: res.next_cursor ?? null, has_more: res.has_more ?? false };
  },

  invite: (body: InviteMemberRequest) =>
    bffFetch<OkResponse>('/v1/invites', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  acceptInvite: (body: AcceptInviteRequest) =>
    bffFetch<OkResponse>('/v1/invites/accept', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  updateRole: (memberId: string, body: UpdateMemberRoleRequest) =>
    bffFetch<OkResponse>(`/v1/members/${memberId}/role`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  remove: (memberId: string) =>
    bffFetch<OkResponse>(`/v1/members/${memberId}`, {
      method: 'DELETE',
      idempotencyKey: generateRequestId(),
    }),

  // D-4/D-11: BFF returns { request_id, invites: [...], next_cursor, has_more }
  // Unwrap `invites` → PaginatedResponse<InviteResponse>.
  listPendingInvites: async (cursor?: string): Promise<PaginatedResponse<InviteResponse>> => {
    const res = await bffFetch<{
      request_id: string;
      invites: InviteResponse[];
      next_cursor: string | null;
      has_more: boolean;
    }>(`/v1/invites?status=pending${cursor ? `&cursor=${cursor}` : ''}`);
    return { data: res.invites, next_cursor: res.next_cursor ?? null, has_more: res.has_more ?? false };
  },

  // D-3: BFF returns { request_id, invite: InviteResponse } — unwrap `invite`.
  resendInvite: async (inviteId: string): Promise<InviteResponse> => {
    const res = await bffFetch<{ request_id: string; invite: InviteResponse }>(
      `/v1/invites/${inviteId}/resend`,
      {
        method: 'POST',
        idempotencyKey: generateRequestId(),
      },
    );
    return res.invite;
  },

  // Revoke returns 204 No Content — void.
  revokeInvite: (inviteId: string): Promise<void> =>
    bffFetch<void>(`/v1/invites/${inviteId}/revoke`, {
      method: 'POST',
      idempotencyKey: generateRequestId(),
    }),

  // D-8: BFF returns { request_id, member: { ..., user_status: 'suspended' } } — unwrap `member`.
  suspendMember: async (memberId: string): Promise<MemberResponse> => {
    const res = await bffFetch<{ request_id: string; member: MemberResponse }>(
      `/v1/members/${memberId}/suspend`,
      {
        method: 'POST',
        idempotencyKey: generateRequestId(),
      },
    );
    return res.member;
  },

  // D-1: BFF returns { request_id, member: { ..., user_status: 'active' } } — unwrap `member`.
  reactivateMember: async (memberId: string): Promise<MemberResponse> => {
    const res = await bffFetch<{ request_id: string; member: MemberResponse }>(
      `/v1/members/${memberId}/reactivate`,
      {
        method: 'POST',
        idempotencyKey: generateRequestId(),
      },
    );
    return res.member;
  },
};
