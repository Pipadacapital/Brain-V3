/**
 * Membership domain entities.
 *
 * Single table for org-level and brand-level membership (D0.3).
 * brand_id IS NULL = org-level (workspace member).
 * brand_id IS NOT NULL = brand-level (brand member).
 *
 * role_code values (D0.2 — canon ADR-006):
 *   owner       → UI: Owner
 *   brand_admin → UI: Admin
 *   manager     → UI: Manager
 *   analyst     → UI: Analyst
 */

export type RoleCode = 'owner' | 'brand_admin' | 'manager' | 'analyst';

export interface Membership {
  id: string;
  organizationId: string;
  brandId: string | null;
  appUserId: string;
  roleCode: RoleCode;
  createdAt: Date;
  updatedAt: Date;
}

// ── Role capability checks ────────────────────────────────────────────────────

/**
 * Role code ordered by capability level (higher index = more capable).
 */
export const ROLE_HIERARCHY: RoleCode[] = ['analyst', 'manager', 'brand_admin', 'owner'];

/**
 * Returns true if the given role meets or exceeds the minimum required role.
 */
export function hasMinimumRole(roleCode: RoleCode, minimum: RoleCode): boolean {
  return ROLE_HIERARCHY.indexOf(roleCode) >= ROLE_HIERARCHY.indexOf(minimum);
}

/**
 * Returns true if the role can manage members (invite, change role, remove).
 * owner and brand_admin can manage members.
 */
export function canManageMembers(roleCode: RoleCode): boolean {
  return roleCode === 'owner' || roleCode === 'brand_admin';
}

/**
 * UI label for a role code.
 */
export const ROLE_LABELS: Record<RoleCode, string> = {
  owner: 'Owner',
  brand_admin: 'Admin',
  manager: 'Manager',
  analyst: 'Analyst',
};
