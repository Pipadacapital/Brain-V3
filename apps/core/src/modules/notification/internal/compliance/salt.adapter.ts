/**
 * Salt adapters for the compliance gate — thin implementations of the SaltPort seam.
 */

import type { SaltPort } from './ports.js';

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
