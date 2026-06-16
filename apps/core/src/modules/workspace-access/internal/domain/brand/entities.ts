/**
 * Brand domain entities.
 */

export type BrandStatus = 'active' | 'archived';
export type CurrencyCode = 'INR' | 'AED' | 'SAR';
export type BrandTimezone = 'Asia/Kolkata' | 'Asia/Dubai' | 'Asia/Riyadh';
export type RevenueDefinition = 'realized' | 'delivered';
// MA-12: 'placed' is EXCLUDED — no placed_revenue metric in METRICS.md.

export interface Brand {
  id: string;
  organizationId: string;
  displayName: string;
  domain: string | null;
  status: BrandStatus;
  regionCode: string;
  currencyCode: CurrencyCode;
  timezone: BrandTimezone;
  revenueDefinition: RevenueDefinition;
  createdAt: Date;
  updatedAt: Date;
}
