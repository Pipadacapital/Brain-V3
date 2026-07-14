// SPEC: H
/**
 * @brain/decision-policies — CERTIFIED METRIC REFERENCE SET.
 *
 * A decision policy's constraints (guardrails) and each candidate's expected-value proxy may
 * reference CERTIFIED metrics ONLY — and ONLY BY NAME (e.g. `cm2_pct >= 0.20`). This is precisely
 * WHY Wave D (semantic metric registry) precedes Wave H runtime: a policy that constrains on
 * `cm2_pct` is only meaningful once `cm2_pct` is a certified, brand-scoped, single-definition metric.
 *
 * SOURCE OF TRUTH (deferred): when `packages/semantic-metrics` (Wave D) ships, its compiled metric
 * catalog becomes the authoritative certified set and this list is REPLACED by an import from it
 * (see CONTRACT-H.md "Deferred"). Until then, this const mirrors the Wave D LAUNCH SET verbatim
 * (PLAN-OF-RECORD §D.2) so the compiler skeleton can validate that every constraint/EV metric
 * reference names a metric that WILL exist — a typo can never compile.
 *
 * This is a NAME registry only. It carries NO expressions, NO SQL, NO values — the decision-policies
 * package never computes a metric (that is the evaluation engine, DEFERRED).
 */

/** Wave D launch-set certified metric names (PLAN-OF-RECORD §D.2). Names only — no logic. */
export const CERTIFIED_METRICS = [
  'net_revenue',
  'gross_revenue',
  'refund_amount',
  'orders',
  'aov',
  'mer',
  'amer',
  'roas',
  'cac',
  'cac_new',
  'cm1',
  'cm2',
  'cm3',
  'cm2_pct',
  'cm3_pct',
  'rto_rate',
  'return_rate',
  'repeat_rate',
  'ltv_realized',
  'identified_purchase_rate',
] as const;

export type CertifiedMetric = (typeof CERTIFIED_METRICS)[number];

/** True iff `name` is a certified metric the semantic layer will define. Unknown names never compile. */
export function isCertifiedMetric(name: string): name is CertifiedMetric {
  return (CERTIFIED_METRICS as readonly string[]).includes(name);
}
