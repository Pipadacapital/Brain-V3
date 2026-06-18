/**
 * EnvSaltPort — core-side per-brand salt adapter for the compliance gate.
 *
 * Mirrors the webhook getSaltHex pattern in main.ts (env var
 * IDENTITY_SALT_<BRAND_UUID_NO_DASHES>, a 64-hex / 32-byte value). HARD-CRASHES on a
 * missing or wrong-length salt (D-2) — the gate treats a throw here as a stop-the-world
 * crash, never a silent allow. In prod this is replaced by a KMS-backed adapter behind
 * the same SaltPort with zero engine change.
 */

import type { SaltPort } from './ports.js';

export class EnvSaltPort implements SaltPort {
  async saltHexForBrand(brandId: string): Promise<string> {
    const envKey = `IDENTITY_SALT_${brandId.replace(/-/g, '').toUpperCase()}`;
    const salt = process.env[envKey] ?? '';
    if (!salt || salt.length !== 64) {
      throw new Error(
        `[can_contact] salt for brand ${brandId} is missing or wrong length ` +
          `(expected 64 hex chars) — refusing to hash with empty/default salt (D-2)`,
      );
    }
    return salt;
  }
}

/**
 * FunctionSaltPort — wraps an existing async salt-fetch function (e.g. the
 * getWebhookSaltHex already wired in main.ts, or a stream-worker SaltProvider) into
 * the SaltPort seam. Single-Primitive: reuse one salt source, don't add a second.
 */
export class FunctionSaltPort implements SaltPort {
  constructor(private readonly fn: (brandId: string) => Promise<string>) {}
  async saltHexForBrand(brandId: string): Promise<string> {
    return this.fn(brandId);
  }
}
