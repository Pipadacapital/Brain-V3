/**
 * Invite domain entities.
 *
 * Product term "Invitation" maps to database table "invite" (D0.3).
 * brand_id nullable — org-level (NULL) or brand-level (NOT NULL).
 */

import type { RoleCode } from '../membership/entities.js';

export type InviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface Invite {
  id: string;
  organizationId: string;
  brandId: string | null;
  email: string;
  roleCode: RoleCode;
  /** sha256(crypto.randomBytes(32)) stored hash — never the raw token (NN-5 / I-S09). */
  tokenHash: string;
  invitedByUserId: string;
  status: InviteStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

/** Invite expiry: 7 days (NN-5). */
export const INVITE_EXPIRY_DAYS = 7;
