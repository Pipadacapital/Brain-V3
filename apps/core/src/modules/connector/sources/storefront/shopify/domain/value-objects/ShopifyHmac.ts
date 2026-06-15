/**
 * ShopifyHmac — value object that validates Shopify HMAC signatures.
 *
 * NN-4: HMAC validation MUST be the first operation in the OAuth callback
 * handler. Any failure returns HTTP 401 with no further processing.
 *
 * Algorithm (per Shopify OAuth docs):
 *   1. Remove `hmac` from the query parameters.
 *   2. Percent-encode each key=value pair, sort them, join with `&`.
 *   3. Compute HMAC-SHA256 of the message using the client_secret.
 *   4. Timing-safe compare the computed digest against the received hmac.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export class ShopifyHmac {
  private constructor() {}

  /**
   * Validate the HMAC embedded in Shopify OAuth callback query parameters.
   *
   * @param query   Raw query params from the callback URL (all key-value pairs).
   * @param clientSecret  Shopify app client secret (fetched from Secrets Manager — never env).
   * @returns true if valid; false if tampered or missing.
   *
   * NN-4: This must be the FIRST operation in the callback handler.
   */
  static validateOAuthCallback(
    query: Record<string, string | string[] | undefined>,
    clientSecret: string,
  ): boolean {
    const receivedHmac = query['hmac'];
    if (!receivedHmac || typeof receivedHmac !== 'string') {
      return false;
    }

    // Build message: exclude hmac, encode, sort, join
    const message = Object.entries(query)
      .filter(([key]) => key !== 'hmac')
      .map(([key, value]) => {
        const v = Array.isArray(value) ? value[0] ?? '' : (value ?? '');
        return `${encodeURIComponent(key)}=${encodeURIComponent(v)}`;
      })
      .sort()
      .join('&');

    const computed = createHmac('sha256', clientSecret).update(message).digest('hex');

    // Timing-safe comparison to prevent timing attacks
    try {
      const computedBuf = Buffer.from(computed, 'hex');
      const receivedBuf = Buffer.from(receivedHmac, 'hex');
      if (computedBuf.length !== receivedBuf.length) {
        return false;
      }
      return timingSafeEqual(computedBuf, receivedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Validate the HMAC header on Shopify webhook payloads.
   *
   * NN-4: Webhook callbacks must also HMAC-validate before any processing.
   *
   * @param rawBody       Raw request body bytes.
   * @param hmacHeader    Value of X-Shopify-Hmac-Sha256 header (base64).
   * @param clientSecret  Shopify app client secret (from Secrets Manager).
   */
  static validateWebhook(
    rawBody: Buffer,
    hmacHeader: string,
    clientSecret: string,
  ): boolean {
    if (!hmacHeader) {
      return false;
    }

    const computed = createHmac('sha256', clientSecret).update(rawBody).digest('base64');

    try {
      const computedBuf = Buffer.from(computed, 'base64');
      const receivedBuf = Buffer.from(hmacHeader, 'base64');
      if (computedBuf.length !== receivedBuf.length) {
        return false;
      }
      return timingSafeEqual(computedBuf, receivedBuf);
    } catch {
      return false;
    }
  }
}
