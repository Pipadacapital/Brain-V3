/**
 * invoice-config.ts — issuance constants + the Indian-FY helper.
 *
 * These are platform-level billing facts (the SELLER's legal entity, GSTIN, the GST rate + SAC) plus
 * the BUYER's place of supply (which decides the GST regime). M1 defaults are env-overridable; they
 * are NOT secrets (the platform's own registration details). The regime (IGST vs CGST+SGST) is no
 * longer hard-coded — it is DERIVED from seller state (GSTIN) vs the buyer's place of supply (gst.ts).
 */

export interface InvoiceConfig {
  legalEntity: string;
  sellerGstin: string;
  /** The BUYER's place of supply ('NN-State') — decides intra- vs inter-state GST. */
  placeOfSupply: string;
  sac: string;
  gstRateBps: number;
  metricVersion: string;
}

/** Default issuance config (env-overridable). */
export function getInvoiceConfig(env: NodeJS.ProcessEnv = process.env): InvoiceConfig {
  return {
    legalEntity: env['BILLING_LEGAL_ENTITY'] ?? 'BRAIN',
    sellerGstin: env['BILLING_SELLER_GSTIN'] ?? '29AAAAA0000A1Z5',
    // Buyer place of supply — defaults to the seller's state (intra-state ⇒ CGST+SGST). Override
    // per deployment (or, later, per-brand) with a different state code to bill inter-state (IGST).
    placeOfSupply: env['BILLING_PLACE_OF_SUPPLY'] ?? '29-Karnataka',
    sac: env['BILLING_SAC_CODE'] ?? '998314', // SaaS / online information services
    gstRateBps: Number(env['BILLING_GST_RATE_BPS'] ?? 1800), // 18% GST
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
