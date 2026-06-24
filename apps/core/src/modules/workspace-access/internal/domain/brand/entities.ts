/**
 * Brand domain entities.
 */

export type BrandStatus = 'active' | 'archived';
// Brand primary currency/timezone: GCC + India (expandable; DB source = tenancy.ref_currency/
// ref_timezone, migration 0107). The display layer (@brain/money) tolerates any order currency.
export type CurrencyCode = 'INR' | 'AED' | 'SAR' | 'QAR' | 'KWD' | 'BHD' | 'OMR';
export type BrandTimezone =
  | 'Asia/Kolkata' | 'Asia/Dubai' | 'Asia/Riyadh' | 'Asia/Kuwait' | 'Asia/Bahrain' | 'Asia/Muscat' | 'Asia/Qatar';
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
