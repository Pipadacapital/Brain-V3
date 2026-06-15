/**
 * Organization (Workspace) domain entities.
 *
 * Product term "Workspace" maps to database table "organization" (D0.3).
 */

export interface Organization {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  regionCode: string;
  createdAt: Date;
  updatedAt: Date;
}
