/**
 * Conversion-Feedback / CAPI page — server component shell (Phase 6, Track C).
 *
 * The stakeholder-visible surface for the Meta CAPI conversion-passback loop. It proves,
 * end-to-end and HONESTLY:
 *   - which realized conversions were PASSED BACK (matched + consent-gated through),
 *   - which were BLOCKED BY CONSENT (the SLO=0 / non_consented_sends made VISIBLE),
 *   - the match-quality proxy (avg Meta match keys present / 4),
 *   - retroactive DELETION requests (the ≤15-min consent-withdrawal path), and
 *   - the DEV BOUNDARY: in dev there are no live Meta CAPI credentials, so a matched &
 *     gated conversion is 'would_send_dev' — matched and gated, but NOT sent. A real
 *     send is a platform follow-up; nothing here is ever faked.
 *
 * BFF-only (I-ST01): every figure is read via /api/v1/feedback/capi/* (the CAPI passback
 * system-of-record over capi_passback_log + capi_deletion_log) — never the DB, never a
 * direct send path. No raw PII / no subject_hash is ever rendered.
 */
import { ConversionFeedbackContent } from './conversion-feedback-content';

export const metadata = { title: 'Conversion Feedback — Brain' };

export default function ConversionFeedbackPage() {
  return <ConversionFeedbackContent />;
}
