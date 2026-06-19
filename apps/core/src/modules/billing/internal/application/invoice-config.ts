/**
 * invoice-config.ts — issuance constants + the Indian-FY helper.
 *
 * These are platform-level billing facts (the SELLER's legal entity, GSTIN, place of supply, the
 * GST rate + SAC). M1 defaults are env-overridable; they are NOT secrets (the platform's own
 * registration details). GST is modelled as IGST 18% (the inter-state common case for a SaaS
 * platform billing pan-India) — the intra-state CGST+SGST split is a documented follow-up.
 */

export interface InvoiceConfig {
  legalEntity: string;
  sellerGstin: string;
  placeOfSupply: string;
  sac: string;
  gstRateBps: number;
  regime: string;
  metricVersion: string;
}

/** Default issuance config (env-overridable). */
export function getInvoiceConfig(env: NodeJS.ProcessEnv = process.env): InvoiceConfig {
  return {
    legalEntity: env['BILLING_LEGAL_ENTITY'] ?? 'BRAIN',
    sellerGstin: env['BILLING_SELLER_GSTIN'] ?? '29AAAAA0000A1Z5',
    placeOfSupply: env['BILLING_PLACE_OF_SUPPLY'] ?? '29-Karnataka',
    sac: env['BILLING_SAC_CODE'] ?? '998314', // SaaS / online information services
    gstRateBps: Number(env['BILLING_GST_RATE_BPS'] ?? 1800), // 18% IGST
    regime: env['BILLING_GST_REGIME'] ?? 'igst',
    metricVersion: 'realized_gmv_as_of/v1',
  };
}

/**
 * Indian financial year for a 'YYYY-MM' billing period — Apr..Mar.
 * e.g. '2099-04' → '2099-2100'; '2099-03' → '2098-2099'.
 */
export function financialYear(period: string): string {
  const [yStr, mStr] = period.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}
