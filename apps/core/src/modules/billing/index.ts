/**
 * Public interface for the `billing` module (core monolith bounded context).
 * RULE: only this file may be imported by other modules — enforced by the ESLint
 * boundary rule. All implementation lives under ./internal/ and is private.
 *
 * Scope (P1, slice 1 — the realized-GMV meter): seal a billing period into an immutable
 * gmv_meter_snapshot (the bill's reproducible basis) and read a brand's sealed periods.
 * Billing is on realized GMV via the realized_gmv_as_of() seam — NOT attribution (doc 10).
 * The inspectable bill + GST invoice are downstream slices that read these sealed snapshots.
 */
export { sealBillingPeriod } from './internal/application/seal-billing-period.js';
export type { SealResult, BillingDeps } from './internal/application/seal-billing-period.js';
export { getBillingPeriods } from './internal/application/queries/get-billing-periods.js';
export type {
  BillingPeriods,
  BillingPeriod,
} from './internal/application/queries/get-billing-periods.js';
export {
  getInspectableBill,
  DEFAULT_RATE_BPS,
} from './internal/application/queries/get-inspectable-bill.js';
export type {
  InspectableBillResult,
  InspectableBill,
  BillLine,
} from './internal/application/queries/get-inspectable-bill.js';
export { issueInvoice } from './internal/application/issue-invoice.js';
export type { IssueInvoiceResult } from './internal/application/issue-invoice.js';
export { getInvoice } from './internal/application/queries/get-invoice.js';
export type { InvoiceResult, Invoice, InvoiceLine } from './internal/application/queries/get-invoice.js';
