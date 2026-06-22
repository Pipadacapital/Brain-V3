/**
 * IRtoPredictClient — synchronous at-checkout RTO-Predict API contract seam.
 *
 * This interface defines the contract between Brain's checkout capture path and
 * GoKwik's RTO-Predict synchronous API. It is the single seam where a live GoKwik
 * partner credential is required.
 *
 * HONESTY CONTRACT (Brain rules: no empty charts, revenue truth):
 *   - A connected+credentialed implementation calls the GoKwik RTO-Predict endpoint.
 *   - A disconnected/unconfigured implementation MUST throw RtoPredictNotConnectedError.
 *   - NEVER fabricate a prediction, risk score, or risk_flag.
 *   - The risk_flag is ALWAYS categorical (High / Medium / Low / Control) — no numeric score
 *     (GoKwik does not expose one — research finding 1 in @brain/gokwik-mapper).
 *
 * EXTERNAL BLOCKER:
 *   The live GoKwik RTO-Predict API shape and AWB live client need GoKwik partner
 *   credentials. Until credentials are available, only the NotConnectedRtoPredictClient
 *   guard implementation is used. The interface surface is locked here for type safety.
 */

/**
 * RTO-Predict request — the at-checkout payload Brain sends to GoKwik.
 *
 * NOTE: The exact API field names must be confirmed against GoKwik partner docs
 * (EXTERNAL BLOCKER — needs GoKwik partner credentials). These are the canonical
 * Brain-side field names; the live adapter translates to GoKwik's wire format.
 */
export interface RtoPredictRequest {
  /** Brain brand UUID — used for routing + per-brand model lookup. */
  brandId: string;
  /** Order identifier (the ledger spine key). */
  orderId: string;
  /** GoKwik request_id for idempotency (caller generates; deterministic UUID preferred). */
  requestId: string;
  /** Destination pincode — used in GoKwik's RTO-by-pincode model (research finding 4). */
  pincode?: string | null;
  /** Payment method at checkout — 'cod' | 'prepaid'. */
  paymentMethod?: 'cod' | 'prepaid' | null;
  /** Customer mobile hash (sha256(salt||phone)) — PII hash only, raw NEVER sent (I-S02). */
  customerMobileHash?: string | null;
  /** Order value in minor units (paise). */
  orderValueMinor?: number | null;
}

/**
 * RTO-Predict response — the canonical shape Brain expects back from GoKwik.
 *
 * risk_flag is ALWAYS categorical — NEVER a numeric score (research finding 1).
 * The verbatim GoKwik string is preserved in risk_flag_raw; risk_flag is
 * normalized to the closed set by @brain/gokwik-mapper normalizeRiskFlag().
 */
export interface RtoPredictResponse {
  /** GoKwik request_id echoed back — for correlation. */
  requestId: string;
  /** Normalized risk flag — categorical closed set from @brain/gokwik-mapper. */
  riskFlag: 'high' | 'medium' | 'low' | 'control' | 'unknown';
  /** Verbatim GoKwik risk_flag string (never a numeric score). */
  riskFlagRaw: string | null;
  /** Free-text reason from GoKwik (may be null). */
  riskReason: string | null;
  /** ISO-8601 timestamp of the prediction. */
  occurredAt: string;
}

/**
 * Error thrown by the not-connected guard implementation.
 * Callers MUST catch this and surface 'not connected' to the UI — never fabricate data.
 */
export class RtoPredictNotConnectedError extends Error {
  readonly code = 'RTO_PREDICT_NOT_CONNECTED';

  constructor(brandId: string) {
    super(
      `GoKwik RTO-Predict connector is not configured for brand ${brandId}. ` +
      `Connect the GoKwik connector with valid credentials before requesting predictions.`,
    );
    this.name = 'RtoPredictNotConnectedError';
  }
}

/**
 * IRtoPredictClient — the boundary interface.
 * All callers program to this interface; the concrete implementation is injected.
 */
export interface IRtoPredictClient {
  /**
   * Request an RTO risk prediction for a checkout order.
   *
   * @throws {RtoPredictNotConnectedError} when connector is not configured.
   * @throws {Error} on network / API errors from the GoKwik endpoint.
   */
  predict(req: RtoPredictRequest): Promise<RtoPredictResponse>;
}
