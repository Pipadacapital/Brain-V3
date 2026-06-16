/**
 * @brain/metric-engine — public API surface.
 *
 * The SOLE emitter of realized_revenue and provisional_revenue metrics.
 * Tier-0 deterministic — zero model calls, $0/mo, 0 tokens/day.
 * All money values are bigint minor units + CurrencyCode (no floats, I-S07).
 *
 * @see METRICS.md — metric definitions and rules
 * @see STACK.md locked choice 4 — "the only place a number is computed"
 */

// Re-export registry (D-1)
export {
  METRIC_REGISTRY,
  resolveMetric,
  type MetricId,
  type MetricVersion,
  type MetricDefinition,
} from './registry.js';

// Re-export deps (D-7, F-SEC-02)
export { type EngineDeps, withBrandTxn } from './deps.js';

// Re-export compute functions (D-5)
export { computeRealizedRevenue } from './realized-revenue.js';
export { computeProvisionalRevenue } from './provisional-revenue.js';
