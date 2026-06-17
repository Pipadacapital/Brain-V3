/**
 * RazorpayHmac — value object that validates Razorpay HMAC-SHA256 webhook signatures.
 *
 * NN-4: HMAC validation MUST be the ABSOLUTE FIRST operation in the webhook receiver.
 * Any failure returns HTTP 401 with zero side effects, zero writes.
 *
 * Algorithm (per Razorpay webhook docs):
 *   X-Razorpay-Signature = HMAC-SHA256(rawBody, webhook_secret)
 *   Output: lowercase hex digest.
 *
 * C2: webhook_secret is one key in the composite credential bundle —
 *     independently rotatable without touching key_id/key_secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export class RazorpayHmac {
  private constructor() {}

  /**
   * Validate the X-Razorpay-Signature header on Razorpay webhook payloads.
   *
   * NN-4: This MUST be the first operation in the webhook handler.
   *       Failure = 401, no processing, no write, no DB touch.
   *
   * @param rawBody         Raw request body bytes (Buffer).
   * @param signatureHeader Value of X-Razorpay-Signature header (hex digest).
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

    // Razorpay uses HMAC-SHA256 with hex output (NOT base64 like Shopify)
    const computed = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    try {
      const computedBuf = Buffer.from(computed, 'hex');
      const receivedBuf = Buffer.from(signatureHeader, 'hex');

      // If received header is not valid hex or wrong length → reject
      if (computedBuf.length !== receivedBuf.length || receivedBuf.length === 0) {
        return false;
      }

      return timingSafeEqual(computedBuf, receivedBuf);
    } catch {
      return false;
    }
  }
}
