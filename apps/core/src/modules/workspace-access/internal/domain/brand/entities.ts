/**
 * Brand domain entities.
 */

export type BrandStatus = 'active' | 'archived';

export interface Brand {
  id: string;
  organizationId: string;
  displayName: string;
  domain: string | null;
  status: BrandStatus;
  regionCode: string;
  createdAt: Date;
  updatedAt: Date;
}
