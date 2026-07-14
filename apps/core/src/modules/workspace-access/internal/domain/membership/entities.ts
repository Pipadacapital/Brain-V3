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
