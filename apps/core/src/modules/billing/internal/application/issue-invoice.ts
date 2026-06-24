/**
 * issueInvoice — turn a sealed period's inspectable bill into an ISSUED GST invoice (P1, slice 3).
 *
 * Computes the fee (sealed basis × rate, D-7 banker's rounding) and GST (fee × gst_rate, D-7) the
 * SAME way the inspectable bill does — so the preview equals the issued document — then calls the
 * issue_invoice() DB function, which atomically allocates a GAPLESS invoice_number per
 * (legal_entity, FY) and writes invoice + invoice_line + tax_ledger in one transaction. Issuance
 * is idempotent on (brand, period): a re-issue returns the existing invoice and consumes no number.
 *
 * Money is bigint-minor (I-S07). brand_id is the session brand (BFF), never the request.
 */

import type { DbPool, QueryContext } from '@brain/db';
import type { SilverPool } from '@brain/metric-engine';
import { roundToMinorBankers } from '@brain/money';
import { getInspectableBill } from './queries/get-inspectable-bill.js';
import { getInvoiceConfig, financialYear, type InvoiceConfig } from './invoice-config.js';
import { computeGstBreakdown, stateCode } from './gst.js';

export type IssueInvoiceResult =
  | { state: 'not_sealed'; billing_period: string }
  | {
      state: 'issued';
      /** true if this call newly issued; false if an invoice already existed (idempotent). */
      issued: boolean;
      billing_period: string;
      invoice_id: string;
      invoice_number: string;
      currency_code: string;
      fee_minor: string;
      tax_minor: string;
      total_minor: string;
    };

export interface IssueInvoiceDeps {
  pool: DbPool;
  /** StarRocks Silver/Gold pool — the bill composition reads the lakehouse ledger (Epic 1 / B). */
  srPool: SilverPool;
}

export async function issueInvoice(
  brandId: string,
  period: string,
  correlationId: string,
  deps: IssueInvoiceDeps,
  configOverride?: Partial<InvoiceConfig>,
): Promise<IssueInvoiceResult> {
  const cfg = { ...getInvoiceConfig(), ...configOverride };

  // Compute the fee on the sealed basis via the SAME path as the inspectable bill (preview == issued).
  const bill = await getInspectableBill(brandId, period, correlationId, {
    pool: deps.pool,
    srPool: deps.srPool,
  });
  if (bill.state !== 'billed') {
    return { state: 'not_sealed', billing_period: period };
  }

  const feeMinor = BigInt(bill.fee_minor);
  // GST on the fee — banker's rounding (D-7). value in 1/10000 minor units.
  const { minor: taxMinor } = roundToMinorBankers(feeMinor * BigInt(cfg.gstRateBps), 10_000n);
  // Regime + CGST/SGST/IGST split from seller state (GSTIN) vs buyer place of supply.
  const gst = computeGstBreakdown(taxMinor, stateCode(cfg.sellerGstin), stateCode(cfg.placeOfSupply));

  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    const res = await client.query<{ issue_invoice: IssueInvoiceFnResult }>(
      ctx,
      `SELECT issue_invoice(
         $1::uuid, $2::char(7), $3::text, $4::text, $5::text, $6::text,
         $7::int, $8::bigint, $9::text, $10::int, $11::bigint, $12::text, $13::text,
         $14::bigint, $15::bigint, $16::bigint
       ) AS issue_invoice`,
      [
        brandId,
        period,
        cfg.legalEntity,
        financialYear(period),
        cfg.sellerGstin,
        cfg.placeOfSupply,
        bill.rate.rate_bps,
        feeMinor.toString(),
        cfg.sac,
        cfg.gstRateBps,
        taxMinor.toString(),
        gst.regime,
        cfg.metricVersion,
        gst.cgst_minor.toString(),
        gst.sgst_minor.toString(),
        gst.igst_minor.toString(),
      ],
    );

    const r = res.rows[0]?.issue_invoice;
    if (!r || r.reason === 'not_sealed') {
      return { state: 'not_sealed', billing_period: period };
    }

    // issued:true → newly issued (figures in the result); issued:false → already issued (re-read).
    if (r.issued) {
      return {
        state: 'issued',
        issued: true,
        billing_period: period,
        invoice_id: r.invoice_id!,
        invoice_number: r.invoice_number!,
        currency_code: bill.currency_code,
        fee_minor: String(r.fee_minor),
        tax_minor: String(r.tax_minor),
        total_minor: String(r.total_minor),
      };
    }

    // Already issued — return the existing identity; figures come from the read path if needed.
    return {
      state: 'issued',
      issued: false,
      billing_period: period,
      invoice_id: r.invoice_id!,
      invoice_number: r.invoice_number!,
      currency_code: bill.currency_code,
      fee_minor: feeMinor.toString(),
      tax_minor: taxMinor.toString(),
      total_minor: (feeMinor + taxMinor).toString(),
    };
  } finally {
    client.release();
  }
}

/** Raw shape returned by the issue_invoice() DB function (jsonb). */
interface IssueInvoiceFnResult {
  issued: boolean;
  reason?: 'not_sealed' | 'already_issued';
  invoice_id?: string;
  invoice_number?: string;
  fee_minor?: number | string;
  tax_minor?: number | string;
  total_minor?: number | string;
}
