/**
 * ShopfloHmac — value object that validates Shopflo HMAC-SHA256 webhook signatures.
 *
 * NN-4: HMAC validation MUST be the ABSOLUTE FIRST security operation in the webhook
 * receiver (after the body-parse needed only to resolve the per-connector secret).
 * Any failure returns HTTP 401 with zero side effects, zero writes.
 *
 * DEV-HONESTY: Shopflo's webhook HMAC scheme is UNDOCUMENTED (research open-question).
 * We adopt the Razorpay scheme as the honest, reversible default:
 *   signature = HMAC-SHA256(rawBody, webhook_secret) → lowercase hex digest.
 * The signature header NAME is config-driven (SHOPFLO_SIG_HEADER, default
 * 'x-shopflo-signature') so a later documented scheme is a one-line flip, not a
 * redesign. This is NOT a fabricated "live" guarantee — it is a clearly-labelled
 * reversible default mirroring the verified Razorpay handler.
 *
 * The webhook_secret is one key in the composite credential bundle stored under a
 * single secret_ref at connect time — it MUST NOT be logged at any level (I-S09).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default signature header — overridable via SHOPFLO_SIG_HEADER (lowercased). */
export const DEFAULT_SHOPFLO_SIG_HEADER = 'x-shopflo-signature';

export class ShopfloHmac {
  private constructor() {}

  /**
   * Resolve the configured signature header name (always lowercased — Fastify
   * normalizes header keys to lowercase).
   */
  static signatureHeaderName(): string {
    const configured = process.env.SHOPFLO_SIG_HEADER;
    return (configured && configured.trim().length > 0
      ? configured.trim()
      : DEFAULT_SHOPFLO_SIG_HEADER
    ).toLowerCase();
  }

  /**
   * Validate the Shopflo signature header over the raw body bytes.
   *
   * NN-4: this is the gating security operation — failure = 401, no processing,
   *       no write, no DB touch.
   *
   * @param rawBody         Raw request body bytes (Buffer).
   * @param signatureHeader Value of the configured signature header (hex digest).
   * @param webhookSecret   webhook_secret from the connector's composite secret bundle.
   *                        MUST NOT be logged at any level (I-S09).
   * @returns true if the signature is valid; false if tampered, missing, or wrong length.
   */
  static validateWebhook(
    rawBody: Buffer,
    signatureHeader: string,
    webhookSecret: string,
  ): boolean {
    if (!signatureHeader || !webhookSecret) {
      return false;
    }

    // HMAC-SHA256 with lowercase hex output (the reversible Razorpay-scheme default).
    const computed = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    try {
      const computedBuf = Buffer.from(computed, 'hex');
      const receivedBuf = Buffer.from(signatureHeader, 'hex');

      // Reject non-hex headers or length mismatch before the constant-time compare.
      if (computedBuf.length !== receivedBuf.length || receivedBuf.length === 0) {
        return false;
      }

      return timingSafeEqual(computedBuf, receivedBuf);
    } catch {
      return false;
    }
  }
}
