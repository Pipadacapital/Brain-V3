/**
 * getInvoice — read the issued invoice for a sealed period (P1, slice 3).
 *
 * Returns an honest union: 'not_issued' (sealed but not yet invoiced, or no seal) vs 'issued'
 * with the full invoice header + line items + GST breakdown. Reads invoice + invoice_line via
 * @brain/db's RLS-enforced pool (brain_app SELECT only — the tables are immutable). brand_id is
 * the session brand (BFF). Money is bigint-minor (I-S07).
 */

import type { DbPool, QueryContext } from '@brain/db';

const PERIOD_RE = /^\d{4}-\d{2}$/;

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export interface InvoiceLine {
  line_no: number;
  line_type: string;
  description: string;
  basis_gmv_minor: string;
  rate_bps: number;
  metric_definition_version: string;
  source_billing_period: string;
  sac_hsn_code: string;
  taxable_minor: string;
  tax_rate_bps: number;
  tax_minor: string;
  amount_minor: string;
}

export interface Invoice {
  invoice_id: string;
  invoice_number: string;
  billing_period: string;
  legal_entity: string;
  fy: string;
  currency_code: string;
  basis_gmv_minor: string;
  rate_bps: number;
  fee_minor: string;
  tax_minor: string;
  total_minor: string;
  regime: string;
  /** GST split (bigint-minor strings) — cgst+sgst for intra-state, igst for inter-state. */
  cgst_minor: string;
  sgst_minor: string;
  igst_minor: string;
  sac_hsn_code: string;
  tax_rate_bps: number;
  seller_gstin: string;
  place_of_supply: string;
  status: string;
  issued_at: string;
  lines: InvoiceLine[];
  credit_notes: CreditNote[];
  /** Invoice total minus the sum of credit notes (bigint-minor string). */
  net_total_minor: string;
}

/** An issued credit note that corrects this invoice (immutable). Magnitudes are positive. */
export interface CreditNote {
  credit_note_id: string;
  credit_note_number: string;
  reason: string;
  regime: string;
  taxable_minor: string;
  tax_minor: string;
  total_minor: string;
  cgst_minor: string;
  sgst_minor: string;
  igst_minor: string;
  issued_at: string;
}

export type InvoiceResult =
  | { state: 'not_issued'; billing_period: string }
  | ({ state: 'issued' } & Invoice);

export interface InvoiceReadDeps {
  pool: DbPool;
}

export async function getInvoice(
  brandId: string,
  period: string,
  correlationId: string,
  deps: InvoiceReadDeps,
): Promise<InvoiceResult> {
  if (!PERIOD_RE.test(period)) {
    return { state: 'not_issued', billing_period: period };
  }

  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    const invRes = await client.query<{
      invoice_id: string;
      invoice_number: string;
      billing_period: string;
      legal_entity: string;
      fy: string;
      currency_code: string;
      basis_gmv_minor: string;
      rate_bps: number;
      fee_minor: string;
      tax_minor: string;
      total_minor: string;
      tax: {
        regime?: string;
        sac_hsn_code?: string;
        rate_bps?: number;
        cgst_minor?: number | string;
        sgst_minor?: number | string;
        igst_minor?: number | string;
      };
      seller_gstin: string;
      place_of_supply: string;
      status: string;
      issued_at: Date;
    }>(
      ctx,
      `SELECT invoice_id, invoice_number, billing_period, legal_entity, fy, currency_code,
              basis_gmv_minor::text AS basis_gmv_minor, rate_bps,
              fee_minor::text AS fee_minor, tax_minor::text AS tax_minor,
              total_minor::text AS total_minor, tax, seller_gstin, place_of_supply, status, issued_at
         FROM invoice
        WHERE brand_id = $1 AND billing_period = $2`,
      [brandId, period],
    );

    if (invRes.rows.length === 0) {
      return { state: 'not_issued', billing_period: period };
    }
    const inv = invRes.rows[0]!;

    const lineRes = await client.query<{
      line_no: number;
      line_type: string;
      description: string;
      basis_gmv_minor: string;
      rate_bps: number;
      metric_definition_version: string;
      source_billing_period: string;
      sac_hsn_code: string;
      taxable_minor: string;
      tax_rate_bps: number;
      tax_minor: string;
      amount_minor: string;
    }>(
      ctx,
      `SELECT line_no, line_type, description,
              basis_gmv_minor::text AS basis_gmv_minor, rate_bps, metric_definition_version,
              source_billing_period, sac_hsn_code, taxable_minor::text AS taxable_minor,
              tax_rate_bps, tax_minor::text AS tax_minor, amount_minor::text AS amount_minor
         FROM invoice_line
        WHERE invoice_id = $1 AND brand_id = $2
        ORDER BY line_no ASC`,
      [inv.invoice_id, brandId],
    );

    // Credit notes correcting this invoice (immutable; positive magnitudes).
    const cnRes = await client.query<{
      credit_note_id: string;
      credit_note_number: string;
      reason: string;
      regime: string;
      taxable_minor: string;
      tax_minor: string;
      total_minor: string;
      tax: { cgst_minor?: number | string; sgst_minor?: number | string; igst_minor?: number | string };
      issued_at: Date;
    }>(
      ctx,
      `SELECT credit_note_id, credit_note_number, reason, regime,
              taxable_minor::text AS taxable_minor, tax_minor::text AS tax_minor,
              total_minor::text AS total_minor, tax, issued_at
         FROM credit_note
        WHERE invoice_id = $1 AND brand_id = $2
        ORDER BY issued_at ASC`,
      [inv.invoice_id, brandId],
    );

    const creditedMinor = cnRes.rows.reduce((acc, c) => acc + BigInt(c.total_minor), 0n);
    const netTotalMinor = BigInt(inv.total_minor) - creditedMinor;

    return {
      state: 'issued',
      invoice_id: inv.invoice_id,
      invoice_number: inv.invoice_number,
      billing_period: inv.billing_period,
      legal_entity: inv.legal_entity,
      fy: inv.fy,
      currency_code: inv.currency_code.trim(),
      basis_gmv_minor: inv.basis_gmv_minor,
      rate_bps: inv.rate_bps,
      fee_minor: inv.fee_minor,
      tax_minor: inv.tax_minor,
      total_minor: inv.total_minor,
      regime: inv.tax?.regime ?? 'igst',
      cgst_minor: String(inv.tax?.cgst_minor ?? '0'),
      sgst_minor: String(inv.tax?.sgst_minor ?? '0'),
      igst_minor: String(inv.tax?.igst_minor ?? inv.tax_minor),
      sac_hsn_code: inv.tax?.sac_hsn_code ?? '',
      tax_rate_bps: inv.tax?.rate_bps ?? 0,
      seller_gstin: inv.seller_gstin,
      place_of_supply: inv.place_of_supply,
      status: inv.status,
      issued_at: toIso(inv.issued_at),
      net_total_minor: netTotalMinor.toString(),
      credit_notes: cnRes.rows.map((c) => ({
        credit_note_id: c.credit_note_id,
        credit_note_number: c.credit_note_number,
        reason: c.reason,
        regime: c.regime,
        taxable_minor: c.taxable_minor,
        tax_minor: c.tax_minor,
        total_minor: c.total_minor,
        cgst_minor: String(c.tax?.cgst_minor ?? '0'),
        sgst_minor: String(c.tax?.sgst_minor ?? '0'),
        igst_minor: String(c.tax?.igst_minor ?? '0'),
        issued_at: toIso(c.issued_at),
      })),
      lines: lineRes.rows.map((l) => ({
        line_no: l.line_no,
        line_type: l.line_type,
        description: l.description,
        basis_gmv_minor: l.basis_gmv_minor,
        rate_bps: l.rate_bps,
        metric_definition_version: l.metric_definition_version,
        source_billing_period: l.source_billing_period,
        sac_hsn_code: l.sac_hsn_code,
        taxable_minor: l.taxable_minor,
        tax_rate_bps: l.tax_rate_bps,
        tax_minor: l.tax_minor,
        amount_minor: l.amount_minor,
      })),
    };
  } finally {
    client.release();
  }
}
