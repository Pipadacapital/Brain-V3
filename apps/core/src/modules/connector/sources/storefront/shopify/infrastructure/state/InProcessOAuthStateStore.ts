/**
 * InProcessOAuthStateStore — dev/test implementation of IOAuthStateStore.
 *
 * Uses an in-process Map with manual TTL. NOT suitable for multi-instance production
 * deployments (use Redis-backed store instead).
 *
 * NN-4: single-use nonce — consumeAndGetBrandId deletes on first use.
 * MED-CALLBACK-01: brandId is stored IN the record so the callback derives it
 * from the server side, never from the attacker-controlled query string.
 *
 * Key scheme: `shopify:oauth:state:{state}` (state value is the lookup key).
 * Value: { brandId, expiresAt } — brandId is authoritative from this record.
 */
import type { IOAuthStateStore } from './IOAuthStateStore.js';
import { OAuthStateNonce } from '../../domain/value-objects/OAuthStateNonce.js';

interface StoredNonce {
  brandId: string;
  expiresAt: Date;
}

export class InProcessOAuthStateStore implements IOAuthStateStore {
  private readonly store = new Map<string, StoredNonce>();

  async set(brandId: string, state: string, ttlSeconds: number): Promise<void> {
    // Key is state-only; brandId is stored as part of the value (MED-CALLBACK-01).
    const key = `shopify:oauth:state:${state}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    this.store.set(key, { brandId, expiresAt });
  }

  /**
   * Consume a state nonce by the state value alone.
   * Returns the server-trusted brandId if the nonce is valid and not expired,
   * then deletes it (single-use — NN-4).
   * Returns null if not found, expired, or already consumed.
   *
   * MED-CALLBACK-01: the caller must NOT supply brandId; this method is the
   * authoritative source.
   */
  async consumeAndGetBrandId(state: string): Promise<{ brandId: string } | null> {
    const key = `shopify:oauth:state:${state}`;
    const entry = this.store.get(key);

    if (!entry) {
      return null; // not found or already consumed
    }

    // Delete immediately (single-use — NN-4)
    this.store.delete(key);

    if (new Date() > entry.expiresAt) {
      return null; // expired
    }

    return { brandId: entry.brandId };
  }

  /** Expose TTL constant for use in handler. */
  static readonly TTL_SECONDS = OAuthStateNonce.TTL_SECONDS;
}
