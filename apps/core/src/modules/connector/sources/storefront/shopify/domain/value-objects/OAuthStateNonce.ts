/**
 * OAuthStateNonce — value object for the OAuth state parameter.
 *
 * NN-4: state nonce must be:
 *   - Generated with crypto.randomBytes(16) minimum
 *   - Stored server-side keyed to (brand_id, state)
 *   - Single-use (consumed on callback)
 *   - ≤ 15-min TTL
 *
 * The nonce is never embedded in the DB — it lives in a short-lived store
 * (Redis / in-process Map for dev) with TTL enforcement.
 */
import { randomBytes } from 'node:crypto';

export class OAuthStateNonce {
  static readonly TTL_SECONDS = 900; // 15 minutes

  private constructor(
    public readonly value: string,
    public readonly brandId: string,
    public readonly expiresAt: Date,
  ) {}

  static generate(brandId: string): OAuthStateNonce {
    const value = randomBytes(16).toString('hex'); // 128-bit nonce
    const expiresAt = new Date(Date.now() + OAuthStateNonce.TTL_SECONDS * 1000);
    return new OAuthStateNonce(value, brandId, expiresAt);
  }

  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }

  /** Storage key for the nonce store: `shopify:oauth:state:{brandId}:{value}` */
  storageKey(): string {
    return `shopify:oauth:state:${this.brandId}:${this.value}`;
  }
}
