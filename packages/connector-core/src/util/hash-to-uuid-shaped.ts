/**
 * hashToUuidShaped — the SINGLE shared implementation of the deterministic
 * "sha256 → UUIDv5-shaped string" algorithm (I-ST04).
 *
 * Previously this exact algorithm was verbatim-duplicated across all seven mapper packages
 * (shopify / woocommerce / razorpay / shiprocket / shopflo / gokwik / ad-spend). This is the
 * Single-Primitive Rule applied: ONE implementation, consumed by every mapper.
 *
 * The output is byte-for-byte identical to the prior per-mapper copies — same input string
 * yields the same id, so deterministic event_ids (and the Bronze dedup that depends on them)
 * are unchanged. Do NOT alter the byte layout without an Architect-approved migration.
 */
import { createHash } from 'node:crypto';

/**
 * Format the first 16 bytes of a sha256 hash as a UUIDv5-shaped string.
 * Sets version nibble = 5 and RFC-4122 variant bits.
 *
 * @param input  the namespace string to hash (e.g. `${brandId}:${orderId}:order.live.v1`)
 * @returns      a UUIDv5-shaped string (deterministic in `input`)
 */
export function hashToUuidShaped(input: string): string {
  const hash = createHash('sha256').update(input, 'utf8').digest();
  const bytes = Buffer.alloc(16);
  hash.copy(bytes, 0, 0, 16);

  // Version nibble = 5
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  // Variant bits = RFC 4122 (10xx xxxx)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
