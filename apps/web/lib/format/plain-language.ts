/**
 * plain-language — the SINGLE merchant-jargon → plain-language dictionary for raw metric/
 * column keys the UI surfaces (rto_rate_pct, cm1, gmv_at_risk_minor, roas, …), so no raw
 * backend code ever reaches the DOM (plain-language rule 3).
 *
 * These are the keys the plain-language audit found leaking as-is into cards, tooltips, and
 * table headers. `plainLabel()` NEVER returns a raw code: an unknown key is Title-Cased with
 * unit suffixes (`_pct`, `_minor`, `_share`, …) stripped, so a NEW metric key still renders as
 * readable English instead of `foo_bar_pct`.
 *
 * `plainConfidence()` maps a confidence grade/level (A/B/C/D or high/medium/low) to the plain
 * phrase we show shoppers-of-data ("We're confident" / "Rough estimate") — matching Brain's
 * "confidence before decisions" rule.
 *
 * Pure module (no React, no JSX) — safe to import from server or client components.
 */

/**
 * Curated raw-key → plain-language label. Keys are matched case-insensitively (see plainLabel).
 * Money keys drop the `_minor` unit — the value is still bigint minor units + currency_code
 * downstream; this only names the field.
 */
const PLAIN_LABELS: Record<string, string> = {
  // ── Delivery / returns ───────────────────────────────────────────────────────
  rto_rate_pct: 'Return-to-origin rate',
  rto_rate: 'Return-to-origin rate',
  rto: 'Returned undelivered',
  cod: 'Cash on delivery',

  // ── Revenue at risk / settlement ─────────────────────────────────────────────
  gmv_at_risk_minor: 'Revenue at risk',
  gmv_at_risk: 'Revenue at risk',
  gmv: 'Total sales',
  unsettled_share_pct: 'Share of revenue still settling',
  unsettled_share: 'Share of revenue still settling',
  unsettled_minor: 'Revenue still settling',
  unsettled: 'Revenue still settling',
  order_count: 'Orders affected',
  orders_affected: 'Orders affected',

  // ── Profit / contribution margin ─────────────────────────────────────────────
  cm1: 'Profit before marketing',
  cm1_minor: 'Profit before marketing',
  cm1_pct: 'Profit before marketing',
  cm2: 'Profit after everything',
  cm2_minor: 'Profit after everything',
  cm2_pct: 'Profit after everything',
  contribution_margin_1: 'Profit before marketing',
  contribution_margin_2: 'Profit after everything',

  // ── Marketing efficiency ─────────────────────────────────────────────────────
  roas: 'Return on ad spend',
  aov: 'Average order value',
  aov_minor: 'Average order value',
  ltv: 'Customer lifetime value',
  ltv_minor: 'Customer lifetime value',

  // ── Identifiers ──────────────────────────────────────────────────────────────
  brain_id: 'Customer',
  customer_ref: 'Customer',
  form_id: 'Form',
  metric_id: 'Metric',
};

/** Uppercase variants (CM1/CM2/ROAS/AOV/LTV) resolve via the case-insensitive lookup below. */

/**
 * Title-Case a raw snake/kebab key once known labels miss: strip a trailing unit suffix
 * (_pct / _minor / _share / _rate / _count / _id), split on `_`/`-`, upper-case each word.
 * e.g. 'settled_amount_minor' → 'Settled Amount'. Never returns the raw code.
 */
function titleCaseFallback(key: string): string {
  const stripped = key
    .replace(/_(pct|percent|minor|share|rate|count|id)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const base = stripped.length > 0 ? stripped : key.replace(/[_-]+/g, ' ').trim();
  return base
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Plain-language label for a raw metric/column key. Case-insensitive; unknown keys fall back
 * to a Title-Cased, unit-suffix-stripped form so the raw code NEVER renders.
 *
 * @example plainLabel('rto_rate_pct')       // → 'Return-to-origin rate'
 * @example plainLabel('CM1')                // → 'Profit before marketing'
 * @example plainLabel('settled_amount_minor') // → 'Settled Amount'
 */
export function plainLabel(key: string | null | undefined): string {
  const raw = (key ?? '').trim();
  if (!raw) return '';
  const known = PLAIN_LABELS[raw] ?? PLAIN_LABELS[raw.toLowerCase()];
  if (known) return known;
  return titleCaseFallback(raw);
}

/**
 * Plain-language confidence phrase for a grade (A/B/C/D) or level (high/medium/low).
 * high | A            → "We're confident"
 * medium | B          → "Fairly confident"
 * low | C | D         → "Rough estimate"
 * Unknown/empty       → "" (caller decides — honest-empty, don't fabricate a confidence).
 *
 * @example plainConfidence('A')      // → "We're confident"
 * @example plainConfidence('medium') // → 'Fairly confident'
 */
export function plainConfidence(gradeOrLevel: string | null | undefined): string {
  const v = (gradeOrLevel ?? '').trim().toLowerCase();
  if (!v) return '';
  switch (v) {
    case 'high':
    case 'a':
      return "We're confident";
    case 'medium':
    case 'med':
    case 'b':
      return 'Fairly confident';
    case 'low':
    case 'c':
    case 'd':
      return 'Rough estimate';
    default:
      return '';
  }
}
