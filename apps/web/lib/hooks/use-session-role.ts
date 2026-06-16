'use client';

/**
 * Resolves the current session user's role from the TanStack Query cache
 * for the /auth/me response (already fetched by RequireSession / useCurrentUser).
 *
 * The role is sourced from `auth.role` in the LoginResponse / /me response.
 * Falls back to 'analyst' (most restrictive) when not yet available — the
 * server is always the source of truth; this is UI-only gating.
 */

import { useQueryClient } from '@tanstack/react-query';
import type { RoleCode } from '@/lib/api/types';
import { AUTH_QUERY_KEY } from '@/lib/hooks/use-auth';

// /auth/me response shape — the auth field is present on the full LoginResponse
// and is stored in the query cache from the login flow.
interface AuthMeCache {
  request_id?: string;
  user?: { id: string; email: string };
  auth?: { role?: string | null; workspace_id?: string | null; brand_id?: string | null };
}

const VALID_ROLES = new Set<RoleCode>(['owner', 'brand_admin', 'manager', 'analyst']);

function toRoleCode(raw: string | null | undefined): RoleCode {
  if (raw && VALID_ROLES.has(raw as RoleCode)) return raw as RoleCode;
  return 'analyst'; // most restrictive fallback
}

/**
 * Returns the current actor's role from the session cache.
 * Safe to call in any client component; uses the existing /auth/me cache entry.
 */
export function useSessionRole(): RoleCode {
  const queryClient = useQueryClient();
  const cached = queryClient.getQueryData<AuthMeCache>(AUTH_QUERY_KEY);
  return toRoleCode(cached?.auth?.role);
}

/**
 * Returns the current user's app_user id from the session cache.
 * Used to hide self-action buttons in the members table.
 */
export function useSessionUserId(): string | null {
  const queryClient = useQueryClient();
  const cached = queryClient.getQueryData<AuthMeCache>(AUTH_QUERY_KEY);
  return cached?.user?.id ?? null;
}
