/**
 * gst.ts — pure GST place-of-supply logic (Indian GST, intra- vs inter-state).
 *
 * The GST regime is decided by comparing the SELLER's state (from its GSTIN — the first two
 * characters are the state code) with the BUYER's place-of-supply state code:
 *   - intra-state (same state)  → CGST + SGST, each at HALF the GST rate
 *   - inter-state (diff. state) → IGST, the full rate
 *
 * Money is bigint-minor (I-S07). The total GST is computed once (banker's rounding, D-7, by the
 * caller) and the CGST/SGST split is exact: cgst = total/2 (floor), sgst = total - cgst, so
 * cgst + sgst == total to the minor unit (never a rounding leak). IGST = the full total.
 */

export type GstRegime = 'igst' | 'cgst_sgst';

export interface GstBreakdown {
  regime: GstRegime;
  /** Full GST amount (cgst+sgst for intra, igst for inter). */
  tax_minor: bigint;
  cgst_minor: bigint;
  sgst_minor: bigint;
  igst_minor: bigint;
}

/** The two-digit state code at the head of a GSTIN or a 'NN-Name' place-of-supply string. */
export function stateCode(gstinOrPlace: string): string {
  const m = gstinOrPlace.trim().match(/^(\d{2})/);
  return m ? m[1]! : '';
}

/**
 * Split a pre-computed total GST into the correct regime given seller + buyer state codes.
 * Intra-state ⇒ CGST+SGST (each half, exact remainder to SGST); inter-state ⇒ IGST.
 */
export function computeGstBreakdown(
  totalTaxMinor: bigint,
  sellerStateCode: string,
  buyerStateCode: string,
): GstBreakdown {
  const intraState = sellerStateCode !== '' && sellerStateCode === buyerStateCode;
  if (intraState) {
    const cgst = totalTaxMinor / 2n; // floor (bigint division)
    const sgst = totalTaxMinor - cgst; // remainder to SGST — invariant cgst+sgst == total
    return { regime: 'cgst_sgst', tax_minor: totalTaxMinor, cgst_minor: cgst, sgst_minor: sgst, igst_minor: 0n };
  }
  return { regime: 'igst', tax_minor: totalTaxMinor, cgst_minor: 0n, sgst_minor: 0n, igst_minor: totalTaxMinor };
}
