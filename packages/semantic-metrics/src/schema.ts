// SPEC:D.2
/**
 * @brain/semantic-metrics — metric DEFINITION schema (metrics-as-code).
 *
 * A metric is defined by ONE YAML file in `metrics/<name>.yaml`. This module is the
 * SOLE validator of that shape: the compiler refuses to emit SQL for a YAML that does
 * not parse here (fail-closed). Governance (PLAN-OF-RECORD §D.2): metric definitions
 * change ONLY via a YAML PR → the compiler regenerates `generated/**` → the compiled-SQL
 * snapshot test (D2.snapshot) pins each metric's SQL, so silent drift is impossible.
 *
 * The five semantic ENTITIES (Wave D.1) a metric may sit on. `expression`/`measures`
 * are SQL over these entities (resolved to physical Iceberg tables in entities.ts).
 *
 * @see knowledge-base/PLAN-OF-RECORD.md §PART 5 (D.2) + §1.11 (interactive pre-aggs)
 * @see knowledge-base/amendments/AMD-07-identity-map-bitemporality.md (D3 tenancy = ${BRAND_PREDICATE})
 */

import { z } from 'zod';

/** The Wave D.1 semantic entities. A metric's `entity` MUST be one of these. */
export const SEMANTIC_ENTITIES = [
  'semantic_customer',
  'semantic_order',
  'semantic_product',
  'semantic_campaign',
  'semantic_journey',
] as const;
export type SemanticEntity = (typeof SEMANTIC_ENTITIES)[number];

/**
 * Time grains a metric×grain view may be compiled at.
 *  - day/week/month — `date_trunc(<grain>, <time_column>)` time-bucketed rollups.
 *  - all            — a single whole-period rollup, NO time bucket. Used by entity-lifetime
 *                     metrics (ltv_realized, repeat_rate) and by CROSS-entity blended metrics
 *                     (mer/amer/cac) whose two entities share only (brand_id[, currency_code]) —
 *                     the semantic_campaign entity carries no time axis (SPEC:D.2 / AMD-25).
 */
export const TIME_GRAINS = ['day', 'week', 'month', 'all'] as const;
export type TimeGrain = (typeof TIME_GRAINS)[number];

/**
 * Money discipline (CLAUDE.md: bigint minor + currency, NEVER blended/float):
 *  - per_currency        — money measure; currency_code is ALWAYS a grouping key.
 *  - ratio_same_currency — a ratio of two same-currency money sums; currency_code grouped.
 *  - none                — counts / rates / grades; no currency column.
 */
export const CURRENCY_HANDLING = ['per_currency', 'ratio_same_currency', 'none'] as const;
export type CurrencyHandling = (typeof CURRENCY_HANDLING)[number];

/**
 * identity_basis (D.4.4): `deterministic_only` metrics provably EXCLUDE probabilistic
 * identity rows — the compiler injects `AND identity_basis = 'deterministic'` into the
 * pre-agg rollup (interactive) or the view CTE (slow). `any` tolerates all rows.
 */
export const IDENTITY_BASIS = ['deterministic_only', 'any'] as const;
export type IdentityBasis = (typeof IDENTITY_BASIS)[number];

/** A single additive base aggregate — the pre-agg-able building block of a metric. */
export const measureSchema = z
  .object({
    /** Measure name; referenced by `expression`. snake_case, [a-z0-9_]. */
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    /** The additive SQL aggregate over entity columns, e.g. `SUM(realized_revenue_minor)`. */
    agg: z.string().min(3),
  })
  .strict();
export type Measure = z.infer<typeof measureSchema>;

/**
 * A CROSS-entity companion aggregate (SPEC:D.2 blended metrics / AMD-25).
 *
 * mer/amer/cac are ratios of a value on one entity (order revenue / new customers) over a
 * value on ANOTHER (campaign spend). The semantic layer fixes 5 entities and semantic_campaign
 * carries no time axis, so blended marketing efficiency is a whole-period join on
 * (brand_id[, currency_code]). A metric may declare ONE `cross` block: a second grain-aligned
 * aggregate over `entity`, joined to the primary base on (brand_id[, currency_code]). Its
 * measure names are ALSO referenceable in `expression`. The compiler injects ${BRAND_PREDICATE}
 * into BOTH sides (tenancy is compiled into every leg — never post-hoc).
 */
export const crossSchema = z
  .object({
    entity: z.enum(SEMANTIC_ENTITIES),
    measures: z.array(measureSchema).min(1),
  })
  .strict();
export type Cross = z.infer<typeof crossSchema>;

/**
 * The metric definition — the exact shape of `metrics/<name>.yaml`.
 * `.strict()` → an unknown key is a validation error (typos cannot slip a field in).
 */
export const metricSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    version: z.string().regex(/^v\d+$/),
    entity: z.enum(SEMANTIC_ENTITIES),
    /** The entity timestamp column bucketed by grain (e.g. conversion_at). Ignored at grain `all`. */
    time_column: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    grain: z.array(z.enum(TIME_GRAINS)).min(1),
    dimensions_allowed: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)),
    measures: z.array(measureSchema).min(1),
    /** OPTIONAL cross-entity companion aggregate (blended mer/amer/cac; AMD-25). */
    cross: crossSchema.optional(),
    /** The metric VALUE expression over measure names (non-additive OK — derived at read). */
    expression: z.string().min(1),
    currency_handling: z.enum(CURRENCY_HANDLING),
    identity_basis: z.enum(IDENTITY_BASIS),
    /** §1.11: true → Spark pre-agg at declared grains; false → raw-entity scan (slow lane). */
    interactive: z.boolean(),
    owner: z.string().min(1),
    description: z.string().min(1),
    examples: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((m, ctx) => {
    // per_currency / ratio_same_currency must NOT list currency_code as a free dimension —
    // it is a mandatory grouping key, not an optional dimension (never blended).
    if (m.currency_handling === 'none' && m.dimensions_allowed.includes('currency_code')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'currency_handling=none cannot expose currency_code dimension' });
    }
    // Every bareword identifier in the expression that looks like a measure ref MUST be defined
    // (across primary + cross measures). SQL keywords/functions are ignored. This makes a typo in
    // `expression` a fail-closed validation error, not silent bad SQL.
    const names = new Set<string>([
      ...m.measures.map((x) => x.name),
      ...(m.cross?.measures.map((x) => x.name) ?? []),
    ]);
    const SQL_WORDS = /^(case|when|then|else|end|null|and|or|not|cast|as|nullif|coalesce|double|bigint|decimal)$/;
    for (const ref of m.expression.match(/[a-z][a-z0-9_]{0,63}/g) ?? []) {
      if (SQL_WORDS.test(ref)) continue;
      if (!names.has(ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expression references undefined measure '${ref}' (define it under measures/cross.measures)`,
        });
      }
    }
    // A cross-entity metric is a whole-period blend — it may only be compiled at grain `all`.
    if (m.cross && (m.grain.length !== 1 || m.grain[0] !== 'all')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a metric with a `cross` block must declare grain: [all] (blended whole-period join; AMD-25)',
      });
    }
    // Interactive pre-aggs are time-bucketed rollups — grain `all` alone cannot be a pre-agg.
    if (m.interactive && !m.grain.some((g) => g !== 'all')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interactive: true requires at least one time-bucketed grain (day|week|month) to pre-aggregate',
      });
    }
  });

export type MetricDefinition = z.infer<typeof metricSchema>;

/** Parse+validate a raw YAML object → a typed MetricDefinition (throws on invalid). */
export function parseMetric(raw: unknown, sourceFile: string): MetricDefinition {
  const result = metricSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `[semantic-metrics] invalid metric definition in ${sourceFile}:\n` +
        result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }
  return result.data;
}
