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
  sac_hsn_code: string;
  tax_rate_bps: number;
  seller_gstin: string;
  place_of_supply: string;
  status: string;
  issued_at: string;
  lines: InvoiceLine[];
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
      tax: { regime?: string; sac_hsn_code?: string; rate_bps?: number };
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
      sac_hsn_code: inv.tax?.sac_hsn_code ?? '',
      tax_rate_bps: inv.tax?.rate_bps ?? 0,
      seller_gstin: inv.seller_gstin,
      place_of_supply: inv.place_of_supply,
      status: inv.status,
      issued_at: toIso(inv.issued_at),
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
