/**
 * _money.ts — the SINGLE money primitive for the shared BFF read contracts.
 *
 * Single-Primitive: every covered read schema (analytics / dataquality / ask) imports
 * `MinorUnitsSchema` + `MoneyRecordSchema` from HERE — there is exactly one money string
 * regex + one per-currency map shape across all schema files, so a money rule cannot drift.
 *
 * INVARIANTS (NON-NEGOTIABLE — 02-architecture.md §3):
 *  - Money is ALWAYS a bigint-as-string in minor units — NEVER z.number(), NEVER float,
 *    NEVER /100. JSON has no bigint; core serializes `String(bigint)` end-to-end (I-S07/D-1).
 *  - Negative is ALLOWED — clawbacks / net-of-refund are HONEST negatives (e.g. cod_net_minor),
 *    so the regex is `^-?\d+$`, not `^\d+$`.
 *  - `MoneyRecord` is a per-currency map (e.g. { INR: '123450' }) for the multi-currency
 *    revenue snapshot (#1) and the Ask-Brain computed number (#11).
 */
import { z } from 'zod';

/**
 * A bigint minor-unit value serialized to a decimal string. Optional leading `-` for honest
 * negatives (clawbacks). One or more digits; no decimal point, no float, no separators.
 * e.g. '123450' = INR 1234.50 (paise); '-500' = a -5.00 clawback; '0' = an honest net-zero.
 */
export const MinorUnitsSchema = z
  .string()
  .regex(/^-?\d+$/, 'minor-units must be an integer string (bigint-as-string, no float)');
export type MinorUnits = z.infer<typeof MinorUnitsSchema>;

/**
 * Per-currency map of minor-unit bigint strings — the JSON-safe serialization of the
 * engine's Map<CurrencyCode, bigint>. Keys are ISO-4217 currency codes; values are
 * MinorUnits strings. An empty map `{}` is valid (e.g. no provisional rows).
 */
export const MoneyRecordSchema = z.record(z.string(), MinorUnitsSchema);
export type MoneyRecord = z.infer<typeof MoneyRecordSchema>;

// ── Shared enum mirrors (mirror the EXACT literal sets from the core/engine types) ──

/** Mirrors `AttributionModelId` — packages/metric-engine/src/attribution-models.ts. */
export const AttributionModelIdSchema = z.enum([
  'first_touch',
  'last_touch',
  'linear',
  'position_based',
  'data_driven',
]);
export type AttributionModelId = z.infer<typeof AttributionModelIdSchema>;

/** Mirrors `JourneyChannel` — packages/metric-engine/src/journey-mix.ts:49. */
export const JourneyChannelSchema = z.enum([
  'paid_meta',
  'paid_google',
  'paid_tiktok',
  'paid',
  'email',
  'organic_social',
  'referral',
  'direct',
]);
export type JourneyChannel = z.infer<typeof JourneyChannelSchema>;

/** Mirrors `LifecycleState` — packages/metric-engine/src/order-status-mix.ts:38. */
export const LifecycleStateSchema = z.enum([
  'placed',
  'confirmed',
  'delivered',
  'cancelled',
  'rto',
  'refunded',
]);
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;

/** Mirrors `DqLetterGrade` — packages/metric-engine/src/cost-confidence.ts:24. */
export const DqLetterGradeSchema = z.enum(['A+', 'A', 'B', 'C', 'D']);
export type DqLetterGrade = z.infer<typeof DqLetterGradeSchema>;

/** Mirrors `TrustTier` (engine casing) — packages/metric-engine/src/quality-gate.ts:23. */
export const EngineTrustTierSchema = z.enum(['trusted', 'estimated', 'untrusted']);
export type EngineTrustTier = z.infer<typeof EngineTrustTierSchema>;

/** Source-honesty flag (synthetic vs live) — shared across the analytics read DTOs. */
export const DataSourceSchema = z.enum(['synthetic', 'live']);
export type DataSource = z.infer<typeof DataSourceSchema>;
