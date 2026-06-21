/**
 * WooCommerceHmac — validates WooCommerce webhook signatures.
 *
 * NN-4: HMAC validation is the ABSOLUTE FIRST security operation in the receiver (after the
 * header read needed only to resolve the per-connector secret). Failure → HTTP 401, zero writes.
 *
 * VERIFIED SCHEME (public WooCommerce docs): the X-WC-Webhook-Signature header is the
 * BASE64-encoded HMAC-SHA256 of the raw request body, keyed with the webhook secret
 * (which defaults to the API user's consumer secret if the merchant left it blank). This is the
 * SAME algorithm Shopify uses (base64), distinct from the Shopflo/Razorpay hex scheme.
 *
 * The webhook_secret is one key in the composite credential bundle stored under a single
 * secret_ref at connect time — it MUST NOT be logged at any level (I-S09).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** WooCommerce's fixed signature header (Fastify lowercases header keys). */
export const WOOCOMMERCE_SIG_HEADER = 'x-wc-webhook-signature';

export class WooCommerceHmac {
  private constructor() {}

  static signatureHeaderName(): string {
    return WOOCOMMERCE_SIG_HEADER;
  }

  /**
   * Validate the X-WC-Webhook-Signature header (base64 HMAC-SHA256) over the raw body bytes.
   *
   * @param rawBody         Raw request body bytes (Buffer).
   * @param signatureHeader Value of the X-WC-Webhook-Signature header (base64 digest).
   * @param webhookSecret   webhook_secret from the connector's composite secret bundle (never logged).
   * @returns true iff the signature is valid; false if tampered, missing, or wrong length.
   */
  static validateWebhook(
    rawBody: Buffer,
    signatureHeader: string,
    webhookSecret: string,
  ): boolean {
    if (!signatureHeader || !webhookSecret) {
      return false;
    }

    // base64(HMAC-SHA256(rawBody, secret)) — the documented WooCommerce scheme.
    const computed = createHmac('sha256', webhookSecret).update(rawBody).digest('base64');

    try {
      const computedBuf = Buffer.from(computed, 'base64');
      const receivedBuf = Buffer.from(signatureHeader, 'base64');
      if (computedBuf.length !== receivedBuf.length || receivedBuf.length === 0) {
        return false;
      }
      return timingSafeEqual(computedBuf, receivedBuf);
    } catch {
      return false;
    }
  }
}
