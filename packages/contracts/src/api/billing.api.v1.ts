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
