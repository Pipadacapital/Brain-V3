/**
 * issueCreditNote — correct an ISSUED invoice with an immutable credit note (P1, GST refinements).
 *
 * Issued invoices are immutable (0042) — a correction is a credit note, never an edit. The credit
 * amount defaults to the FULL invoice fee (full reversal) or a partial taxable value the caller
 * passes; GST is recomputed on that taxable at the invoice's rate and split into the invoice's
 * regime (CGST+SGST intra-state / IGST inter-state). issue_credit_note() atomically allocates a
 * gapless CN number and posts the reversing tax_ledger rows; it caps cumulative credits at the
 * invoice total (no over-crediting).
 *
 * Money is bigint-minor (I-S07); GST uses banker's rounding (D-7). brand_id is the session brand.
 */

import type { DbPool, QueryContext } from '@brain/db';
import { roundToMinorBankers } from '@brain/money';
import { getInvoice } from './queries/get-invoice.js';
import { computeGstBreakdown, stateCode } from './gst.js';

export type IssueCreditNoteResult =
  | { state: 'invoice_not_found'; period: string }
  | { state: 'rejected'; reason: string; already_credited_minor?: string; invoice_total_minor?: string }
  | {
      state: 'issued';
      credit_note_id: string;
      credit_note_number: string;
      taxable_minor: string;
      tax_minor: string;
      total_minor: string;
    };

export interface IssueCreditNoteDeps {
  pool: DbPool;
}

export async function issueCreditNote(
  brandId: string,
  period: string,
  reason: string,
  correlationId: string,
  deps: IssueCreditNoteDeps,
  opts?: { taxableMinor?: bigint },
): Promise<IssueCreditNoteResult> {
  // Read the immutable invoice (its rate/regime/identity drive the credit-note figures).
  const inv = await getInvoice(brandId, period, correlationId, { pool: deps.pool });
  if (inv.state !== 'issued') {
    return { state: 'invoice_not_found', period };
  }

  const taxableMinor = opts?.taxableMinor ?? BigInt(inv.fee_minor);
  const { minor: taxMinor } = roundToMinorBankers(taxableMinor * BigInt(inv.tax_rate_bps), 10_000n);
  const gst = computeGstBreakdown(taxMinor, stateCode(inv.seller_gstin), stateCode(inv.place_of_supply));

  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    const res = await client.query<{ issue_credit_note: IssueCreditNoteFnResult }>(
      ctx,
      `SELECT issue_credit_note(
         $1::uuid, $2::uuid, $3::text, $4::bigint, $5::int, $6::bigint, $7::text, $8::text,
         $9::bigint, $10::bigint, $11::bigint
       ) AS issue_credit_note`,
      [
        brandId,
        inv.invoice_id,
        reason,
        taxableMinor.toString(),
        inv.tax_rate_bps,
        taxMinor.toString(),
        gst.regime,
        inv.sac_hsn_code,
        gst.cgst_minor.toString(),
        gst.sgst_minor.toString(),
        gst.igst_minor.toString(),
      ],
    );

    const r = res.rows[0]?.issue_credit_note;
    if (!r || !r.issued) {
      return {
        state: 'rejected',
        reason: r?.reason ?? 'unknown',
        already_credited_minor: r?.already_credited_minor != null ? String(r.already_credited_minor) : undefined,
        invoice_total_minor: r?.invoice_total_minor != null ? String(r.invoice_total_minor) : undefined,
      };
    }

    return {
      state: 'issued',
      credit_note_id: r.credit_note_id!,
      credit_note_number: r.credit_note_number!,
      taxable_minor: String(r.taxable_minor),
      tax_minor: String(r.tax_minor),
      total_minor: String(r.total_minor),
    };
  } finally {
    client.release();
  }
}

/** Raw shape returned by the issue_credit_note() DB function (jsonb). */
interface IssueCreditNoteFnResult {
  issued: boolean;
  reason?: string;
  credit_note_id?: string;
  credit_note_number?: string;
  taxable_minor?: number | string;
  tax_minor?: number | string;
  total_minor?: number | string;
  already_credited_minor?: number | string;
  invoice_total_minor?: number | string;
}
