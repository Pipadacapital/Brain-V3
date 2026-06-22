/**
 * HmacConfig — ONE primitive replacing the 4 bespoke *Hmac value-objects.
 *
 * Parameterised by (header, algorithm, encoding):
 *   Shopify:     header='x-shopify-hmac-sha256', algorithm='sha256', encoding='base64'
 *   Razorpay:    header='x-razorpay-signature',  algorithm='sha256', encoding='hex'
 *   WooCommerce: header='x-wc-webhook-signature', algorithm='sha256', encoding='base64'
 *   Shopflo:     header=configurable (env SHOPFLO_SIG_HEADER), algorithm='sha256', encoding='hex'
 *
 * SECURITY CONTRACT (NN-4):
 *   validateWebhook() is timing-safe (timingSafeEqual on equal-length buffers).
 *   Empty header → false (reject). Empty secret → false (reject).
 *   Callers MUST call this BEFORE any write / DB touch.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type HmacEncoding = 'base64' | 'hex';
export type HmacAlgorithm = 'sha256' | 'sha512';

export interface HmacConfigOptions {
  /** Lowercased HTTP header name carrying the signature (Fastify normalises headers to lowercase). */
  header: string;
  /** HMAC algorithm — 'sha256' for all current providers. */
  algorithm: HmacAlgorithm;
  /** Output encoding of the digest: 'base64' (Shopify/WooCommerce) or 'hex' (Razorpay/Shopflo). */
  encoding: HmacEncoding;
}

export class HmacConfig {
  readonly header: string;
  private readonly algorithm: HmacAlgorithm;
  private readonly encoding: HmacEncoding;

  constructor(opts: HmacConfigOptions) {
    this.header = opts.header.toLowerCase();
    this.algorithm = opts.algorithm;
    this.encoding = opts.encoding;
  }

  /**
   * Validate the signature header over the raw body bytes.
   *
   * NN-4: failure = reject, no processing, no write.
   * Byte-compatible with each legacy *Hmac VO — the algorithm is identical.
   *
   * @param rawBody         Raw request body Buffer.
   * @param signatureHeader Value of the configured header from the request.
   * @param secret          webhook_secret / client_secret (NEVER logged — I-S09).
   * @returns true if valid; false if tampered, missing, wrong length, or empty secret.
   */
  validateWebhook(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
    if (!signatureHeader || !secret) return false;

    const computed = createHmac(this.algorithm, secret)
      .update(rawBody)
      .digest(this.encoding);

    try {
      const computedBuf = Buffer.from(computed, this.encoding);
      const receivedBuf = Buffer.from(signatureHeader, this.encoding);
      if (computedBuf.length !== receivedBuf.length || receivedBuf.length === 0) {
        return false;
      }
      return timingSafeEqual(computedBuf, receivedBuf);
    } catch {
      return false;
    }
  }
}

// ── Pre-built configs for the 4 current providers ────────────────────────────

/**
 * Shopify webhook HMAC config.
 * Algorithm: base64(HMAC-SHA256(rawBody, clientSecret)).
 * Header: X-Shopify-Hmac-Sha256.
 * Verified byte-compatible with ShopifyHmac.validateWebhook().
 */
export const SHOPIFY_HMAC_CONFIG = new HmacConfig({
  header: 'x-shopify-hmac-sha256',
  algorithm: 'sha256',
  encoding: 'base64',
});

/**
 * Razorpay webhook HMAC config.
 * Algorithm: hex(HMAC-SHA256(rawBody, webhookSecret)).
 * Header: X-Razorpay-Signature.
 * Verified byte-compatible with RazorpayHmac.validateWebhook().
 */
export const RAZORPAY_HMAC_CONFIG = new HmacConfig({
  header: 'x-razorpay-signature',
  algorithm: 'sha256',
  encoding: 'hex',
});

/**
 * WooCommerce webhook HMAC config.
 * Algorithm: base64(HMAC-SHA256(rawBody, webhookSecret)).
 * Header: X-WC-Webhook-Signature.
 * Verified byte-compatible with WooCommerceHmac.validateWebhook().
 */
export const WOOCOMMERCE_HMAC_CONFIG = new HmacConfig({
  header: 'x-wc-webhook-signature',
  algorithm: 'sha256',
  encoding: 'base64',
});

/**
 * Shopflo webhook HMAC config (config-driven header for the undocumented scheme).
 * Algorithm: hex(HMAC-SHA256(rawBody, webhookSecret)) — the reversible Razorpay-scheme default.
 * Header: env SHOPFLO_SIG_HEADER (default 'x-shopflo-signature').
 * Verified byte-compatible with ShopfloHmac.validateWebhook() + signatureHeaderName().
 */
export function buildShopfloHmacConfig(): HmacConfig {
  const configured = process.env['SHOPFLO_SIG_HEADER'];
  const header = (configured && configured.trim().length > 0
    ? configured.trim()
    : 'x-shopflo-signature'
  ).toLowerCase();
  return new HmacConfig({ header, algorithm: 'sha256', encoding: 'hex' });
}
