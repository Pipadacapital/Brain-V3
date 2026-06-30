/**
 * getFormConversion — analytics use-case (ADR-002 sole-read-path, Gold tier).
 *
 * @effort deterministic
 *
 * Thin wrapper around computeFormConversion (metric engine) — a read of gold_conversion_feedback via
 * the withSilverBrand seam: per-form submission counts/rates + day-level payment reach. NO ad-hoc
 * COUNT here (D-3); the seam owns the aggregation. Serializes bigint → string (D-1), echoes the
 * range, shapes the honest no_data discriminant. NO MONEY (lead/intent + payment-reach counters).
 * PII-SAFE: structural form_id + counts only.
 *
 * I-ST01: metric-engine is the SOLE Gold reader; the UI reaches Gold only through BFF → this
 * use-case → withSilverBrand. brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/form-conversion.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeFormConversion } from '@brain/metric-engine';

export interface FormBucketDto {
  form_id: string;
  submissions: string; // bigint → string
  sessions: string; // bigint → string
  journeys: string; // bigint → string
  submission_rate_pct: string | null; // 2dp; null when sessions = 0
}

export interface FormDayBucketDto {
  date: string;
  submissions: string; // bigint → string
  payments_succeeded: string; // bigint → string
}

export type FormConversionResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;
      to: string;
      submissions: string;
      sessions: string;
      payments_succeeded: string;
      submission_rate_pct: string | null;
      forms: FormBucketDto[];
      days: FormDayBucketDto[];
      data_source: 'synthetic' | 'live';
    };

export interface FormConversionParams {
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getFormConversion(
  brandId: string,
  deps: { srPool: SilverPool },
  params: FormConversionParams,
): Promise<FormConversionResult> {
  const r = await computeFormConversion(brandId, deps, {
    fromStr: params.fromStr,
    toStr: params.toStr,
  });

  if (!r.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    submissions: String(r.submissions),
    sessions: String(r.sessions),
    payments_succeeded: String(r.paymentsSucceeded),
    submission_rate_pct: r.submissionRatePct,
    forms: r.forms.map((f) => ({
      form_id: f.formId,
      submissions: String(f.submissions),
      sessions: String(f.sessions),
      journeys: String(f.journeys),
      submission_rate_pct: f.submissionRatePct,
    })),
    days: r.days.map((d) => ({
      date: d.date,
      submissions: String(d.submissions),
      payments_succeeded: String(d.paymentsSucceeded),
    })),
    data_source: params.dataSource,
  };
}
