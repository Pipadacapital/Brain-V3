/**
 * billing.api.v1.ts — shared BFF read contracts for the realized-GMV billing meter (P1).
 *
 * Source of truth for the billing read DTOs at the web↔core seam. The web parses BFF responses
 * against these (parseData) so a drift in the sealed-snapshot shape fails loudly at the boundary.
 *
 * MONEY INVARIANT (I-S07): metered_gmv_minor is a bigint-as-string in minor units via the single
 * MinorUnitsSchema primitive — NEVER z.number(), NEVER float, NEVER /100. (Realized GMV is a
 * non-negative sum, but the shared primitive permits the honest leading `-` by construction.)
 *
 * HONEST EMPTY (02-architecture.md): the period list is a discriminated union on `state` —
 * `no_data` (brand has never sealed a period) vs `has_data` — so the UI renders an honest
 * "not metered yet" state instead of a misleading empty table.
 */
import { z } from 'zod';
import { MinorUnitsSchema } from './_money.js';

/** 'YYYY-MM' billing period — matches realized_revenue_ledger.billing_posted_period (D-2). */
const BillingPeriodCodeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "billing_period must be 'YYYY-MM'");

/** ISO-4217 currency code (CHAR(3) paired with the minor-unit figure, I-S07). */
const CurrencyCodeSchema = z.string().length(3);

export const BillingPeriodSchema = z.object({
  billing_period: BillingPeriodCodeSchema,
  currency_code: CurrencyCodeSchema,
  metered_gmv_minor: MinorUnitsSchema,
  as_of_date: z.string(), // 'YYYY-MM-DD'
  ledger_row_count: z.number().int().nonnegative(),
  sealed_at: z.string(), // ISO instant
});
export type BillingPeriod = z.infer<typeof BillingPeriodSchema>;

export const BillingPeriodsSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({ state: z.literal('has_data'), periods: z.array(BillingPeriodSchema) }),
]);
export type BillingPeriods = z.infer<typeof BillingPeriodsSchema>;

// ── Inspectable bill (slice 2) ────────────────────────────────────────────────
// "How was this fee derived?" — fee = sealed realized-GMV basis × rate, itemized down to the
// per-event_type composition that reconciles to the basis. All money via MinorUnitsSchema
// (signed: refunds/reversals are honest negatives in the composition).

export const BillLineSchema = z.object({
  event_type: z.string(),
  amount_minor: MinorUnitsSchema,
});
export type BillLine = z.infer<typeof BillLineSchema>;

export const InspectableBillSchema = z.discriminatedUnion('state', [
  // Period not sealed yet → nothing to bill (honest).
  z.object({ state: z.literal('not_sealed'), billing_period: BillingPeriodCodeSchema }),
  z.object({
    state: z.literal('billed'),
    billing_period: BillingPeriodCodeSchema,
    currency_code: CurrencyCodeSchema,
    basis: z.object({
      metered_gmv_minor: MinorUnitsSchema,
      as_of_date: z.string(),
      ledger_row_count: z.number().int().nonnegative(),
      sealed_at: z.string(),
    }),
    rate: z.object({
      rate_bps: z.number().int().min(0).max(10_000),
      source: z.enum(['plan', 'default']),
    }),
    fee_minor: MinorUnitsSchema,
    rounding_adjustment_minor: MinorUnitsSchema,
    lines: z.array(BillLineSchema),
    reconciliation: z.object({
      sealed_basis_minor: MinorUnitsSchema,
      live_composition_minor: MinorUnitsSchema,
      reconciles: z.boolean(),
      drift_minor: MinorUnitsSchema,
    }),
  }),
]);
export type InspectableBill = z.infer<typeof InspectableBillSchema>;

// ── Issued GST invoice (slice 3) ──────────────────────────────────────────────
// The issued invoice is immutable, has a gapless number per legal-entity/FY, and carries GST.
// All money via MinorUnitsSchema (I-S07). Line items are self-explaining (basis/rate/source/SAC).

export const InvoiceLineSchema = z.object({
  line_no: z.number().int().positive(),
  line_type: z.string(),
  description: z.string(),
  basis_gmv_minor: MinorUnitsSchema,
  rate_bps: z.number().int().min(0).max(10_000),
  metric_definition_version: z.string(),
  source_billing_period: BillingPeriodCodeSchema,
  sac_hsn_code: z.string(),
  taxable_minor: MinorUnitsSchema,
  tax_rate_bps: z.number().int().min(0).max(10_000),
  tax_minor: MinorUnitsSchema,
  amount_minor: MinorUnitsSchema,
});
export type InvoiceLine = z.infer<typeof InvoiceLineSchema>;

/** A credit note correcting an issued invoice (immutable; positive magnitudes). */
export const CreditNoteSchema = z.object({
  credit_note_id: z.string(),
  credit_note_number: z.string(),
  reason: z.string(),
  regime: z.string(),
  taxable_minor: MinorUnitsSchema,
  tax_minor: MinorUnitsSchema,
  total_minor: MinorUnitsSchema,
  cgst_minor: MinorUnitsSchema,
  sgst_minor: MinorUnitsSchema,
  igst_minor: MinorUnitsSchema,
  issued_at: z.string(),
});
export type CreditNote = z.infer<typeof CreditNoteSchema>;

export const InvoiceSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_issued'), billing_period: BillingPeriodCodeSchema }),
  z.object({
    state: z.literal('issued'),
    invoice_id: z.string(),
    invoice_number: z.string(),
    billing_period: BillingPeriodCodeSchema,
    legal_entity: z.string(),
    fy: z.string(),
    currency_code: CurrencyCodeSchema,
    basis_gmv_minor: MinorUnitsSchema,
    rate_bps: z.number().int().min(0).max(10_000),
    fee_minor: MinorUnitsSchema,
    tax_minor: MinorUnitsSchema,
    total_minor: MinorUnitsSchema,
    regime: z.string(),
    cgst_minor: MinorUnitsSchema,
    sgst_minor: MinorUnitsSchema,
    igst_minor: MinorUnitsSchema,
    sac_hsn_code: z.string(),
    tax_rate_bps: z.number().int().min(0).max(10_000),
    seller_gstin: z.string(),
    place_of_supply: z.string(),
    status: z.string(),
    issued_at: z.string(),
    lines: z.array(InvoiceLineSchema),
    credit_notes: z.array(CreditNoteSchema),
    net_total_minor: MinorUnitsSchema,
  }),
]);
export type Invoice = z.infer<typeof InvoiceSchema>;

/** Result of issuing — `issued: false` means an invoice already existed (idempotent). */
export const IssueInvoiceResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_sealed'), billing_period: BillingPeriodCodeSchema }),
  z.object({
    state: z.literal('issued'),
    issued: z.boolean(),
    billing_period: BillingPeriodCodeSchema,
    invoice_id: z.string(),
    invoice_number: z.string(),
    currency_code: CurrencyCodeSchema,
    fee_minor: MinorUnitsSchema,
    tax_minor: MinorUnitsSchema,
    total_minor: MinorUnitsSchema,
  }),
]);
export type IssueInvoiceResult = z.infer<typeof IssueInvoiceResultSchema>;

/** Result of issuing a credit note against an issued invoice. */
export const IssueCreditNoteResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('invoice_not_found'), period: BillingPeriodCodeSchema }),
  z.object({
    state: z.literal('rejected'),
    reason: z.string(),
    already_credited_minor: MinorUnitsSchema.optional(),
    invoice_total_minor: MinorUnitsSchema.optional(),
  }),
  z.object({
    state: z.literal('issued'),
    credit_note_id: z.string(),
    credit_note_number: z.string(),
    taxable_minor: MinorUnitsSchema,
    tax_minor: MinorUnitsSchema,
    total_minor: MinorUnitsSchema,
  }),
]);
export type IssueCreditNoteResult = z.infer<typeof IssueCreditNoteResultSchema>;

/** Result of sealing (metering) a period — `sealed: false` means it was already sealed (idempotent). */
export const SealPeriodResultSchema = z.object({
  sealed: z.boolean(),
  billing_period: BillingPeriodCodeSchema,
  currency_code: CurrencyCodeSchema,
  metered_gmv_minor: MinorUnitsSchema,
  as_of_date: z.string(),
  ledger_row_count: z.number().int().nonnegative(),
});
export type SealPeriodResult = z.infer<typeof SealPeriodResultSchema>;
