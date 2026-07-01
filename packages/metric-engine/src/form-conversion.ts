/**
 * @brain/metric-engine — computeFormConversion (lead-form submission rollup, Gold tier).
 *
 * The SOLE reader of the Gold mart gold_conversion_feedback, served through the Trino serving view
 * brain_serving.mv_gold_conversion_feedback via withSilverBrand (I-ST01 — the engine is the only Gold
 * reader; the UI never queries the lakehouse directly). The mart is keyed
 * (brand_id, feedback_date, form_id) and holds the daily form-submission volume + session/journey
 * reach plus a DAY-LEVEL payment.succeeded reach (the conversion side of the lead→payment loop).
 *
 * PII-SAFE: STRUCTURAL form_id + counts only — ZERO of the data a visitor typed (no email/phone/name).
 * NO MONEY (a lead/intent + payment-reach counter; every measure is a count).
 *
 * Two reads (both end the WHERE on ${BRAND_PREDICATE} → fail-closed isolation):
 *   1. per-form breakdown — GROUP BY form_id: Σ submissions / sessions / journeys over the window.
 *   2. per-day series     — GROUP BY feedback_date: Σ submissions/sessions + the day payments value.
 *      payments_succeeded is BROADCAST identically onto every form_id row of a day, so summing it
 *      across the per-form rows would MULTIPLY-COUNT it; we take the day value with MAX(...) per
 *      feedback_date (all equal) and sum ACROSS days → the honest brand window payment reach.
 *
 * Rates (integer-basis-point, NO float): submission_rate = submissions/sessions (intent per visit);
 * null when the denominator is 0 (honest, never 0/∞). Honest no_data: hasData=false on zero rows.
 *
 * @see db/iceberg/spark/gold/gold_conversion_feedback.py + db/trino/views/mv_gold_conversion_feedback.sql
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface FormConversionRange {
  /** Inclusive lower feedback_date bound (YYYY-MM-DD). */
  fromStr: string;
  /** Inclusive upper feedback_date bound (YYYY-MM-DD). */
  toStr: string;
}

/** One form's window rollup (a row in the forms table). */
export interface FormBucket {
  /** STRUCTURAL form id ('unknown' when the source form_id was blank). PII-safe. */
  formId: string;
  /** Σ form.submitted events over the window. */
  submissions: bigint;
  /** Σ session-day reach over the window (distinct per day, summed across days). */
  sessions: bigint;
  /** Σ journey-day reach over the window (distinct per day, summed across days). */
  journeys: bigint;
  /** submissions/sessions as a 2dp string; null when sessions = 0 (honest, never 0/∞). */
  submissionRatePct: string | null;
}

/** One day of the submission series (drives the Sparkline). */
export interface FormDayBucket {
  /** feedback_date, YYYY-MM-DD. */
  date: string;
  /** Σ submissions across forms in the day. */
  submissions: bigint;
  /** Day-level payment.succeeded reach (broadcast value, taken once per day). */
  paymentsSucceeded: bigint;
}

export interface FormConversionResult {
  /** True iff the brand has any form-submission rows in the window (honest no_data). */
  hasData: boolean;
  /** Σ submissions over the window (all forms). */
  submissions: bigint;
  /** Σ session-day reach over the window (all forms). */
  sessions: bigint;
  /** Σ day-level payment.succeeded over the window (de-broadcast: counted once per day). */
  paymentsSucceeded: bigint;
  /** submissions/sessions as a 2dp string; null when sessions = 0. */
  submissionRatePct: string | null;
  /** Per-form breakdown (submissions desc). */
  forms: FormBucket[];
  /** Per-day series (feedback_date asc) for the Sparkline. */
  days: FormDayBucket[];
}

interface FormRow {
  form_id: string;
  submissions: string | number;
  sessions: string | number;
  journeys: string | number;
}

interface DayRow {
  feedback_date: string;
  submissions: string | number;
  payments_succeeded: string | number;
}

/** Coerce a Trino numeric (string|number) to bigint, dropping any fractional tail. */
function toBig(v: string | number | null | undefined): bigint {
  return BigInt(String(v ?? '0').split('.')[0] || '0');
}

/** Integer-basis-point rate as a 2dp string; null when the denominator ≤ 0 (honest, never 0/∞). */
function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

/**
 * computeFormConversion — lead-form submission volume + reach + payment-reach over [from,to].
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Gold serving pool (gold_conversion_feedback via mv_gold_conversion_feedback).
 * @param range   - The feedback_date window [fromStr, toStr] (inclusive).
 */
export async function computeFormConversion(
  brandId: string,
  deps: { srPool: SilverPool },
  range: FormConversionRange,
): Promise<FormConversionResult> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // (1) per-form breakdown — ${BRAND_PREDICATE} LAST → binds positionally to its single `?`.
    const formRows = await scope.runScoped<FormRow>(
      `SELECT form_id,
              SUM(submissions) AS submissions,
              SUM(sessions)    AS sessions,
              SUM(journeys)    AS journeys
         FROM brain_serving.mv_gold_conversion_feedback
        WHERE feedback_date BETWEEN ? AND ?
          AND ${BRAND_PREDICATE}
        GROUP BY form_id
        -- ORDER BY the OUTPUT ALIAS submissions (== SUM(submissions)), NOT a re-wrapped SUM(submissions):
        -- Trino resolves submissions inside ORDER BY to the output projection (already an aggregate), so
        -- ORDER BY SUM(submissions) becomes a nested aggregate -> "Invalid reference to output projection
        -- attribute from ORDER BY aggregation" (code 47). StarRocks bound it to the base column; Trino does not.
        ORDER BY submissions DESC`,
      [range.fromStr, range.toStr],
    );

    if (formRows.length === 0) {
      return {
        hasData: false,
        submissions: 0n,
        sessions: 0n,
        paymentsSucceeded: 0n,
        submissionRatePct: null,
        forms: [],
        days: [],
      };
    }

    // (2) per-day series — MAX(payments_succeeded) de-broadcasts the day value (all form rows equal).
    const dayRows = await scope.runScoped<DayRow>(
      `SELECT feedback_date,
              SUM(submissions)        AS submissions,
              MAX(payments_succeeded) AS payments_succeeded
         FROM brain_serving.mv_gold_conversion_feedback
        WHERE feedback_date BETWEEN ? AND ?
          AND ${BRAND_PREDICATE}
        GROUP BY feedback_date
        ORDER BY feedback_date ASC`,
      [range.fromStr, range.toStr],
    );

    const forms: FormBucket[] = formRows.map((r) => {
      const submissions = toBig(r.submissions);
      const sessions = toBig(r.sessions);
      return {
        formId: String(r.form_id),
        submissions,
        sessions,
        journeys: toBig(r.journeys),
        submissionRatePct: ratePct(submissions, sessions),
      };
    });

    const days: FormDayBucket[] = dayRows.map((r) => ({
      date: String(r.feedback_date).split('T')[0] as string,
      submissions: toBig(r.submissions),
      paymentsSucceeded: toBig(r.payments_succeeded),
    }));

    const submissions = forms.reduce((acc, f) => acc + f.submissions, 0n);
    const sessions = forms.reduce((acc, f) => acc + f.sessions, 0n);
    const paymentsSucceeded = days.reduce((acc, d) => acc + d.paymentsSucceeded, 0n);

    return {
      hasData: true,
      submissions,
      sessions,
      paymentsSucceeded,
      submissionRatePct: ratePct(submissions, sessions),
      forms,
      days,
    };
  });
}
