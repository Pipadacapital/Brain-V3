/**
 * brain-ref.ts — the deterministic, collision-free PUBLIC customer reference derived from brain_id.
 *
 * brain_id stays a UUID internally (typed `uuid` across ~12 PG tables + the z.uuid() fields in decision.ts).
 * This adds a HUMAN-READABLE surrogate `customer_ref` the UI / APIs surface INSTEAD of the raw UUID, with
 * NO storage or contract change:
 *
 *     brainRef('9f2c1a4e-7b33-4c9a-8e21-b4d7f0a10000')  ->  'BRN-KWP1MKKV6D69N3H1PKBZ188000'
 *
 * This is the byte-for-byte TypeScript mirror of db/iceberg/spark/_identity_ref.py (brain_ref): same
 * Crockford base32 alphabet, same MSB-first bit packing, same sha256[:16] fallback for a non-UUID input.
 * The Spark mart writes customer_ref via the Python fn; the API/UI compute it via this fn; they MUST agree.
 * Golden vectors in brain-ref.test.ts == _identity_ref_test.py lock the two together.
 *
 *   - DETERMINISTIC : pure fn of brain_id — no lookup, no state.
 *   - INJECTIVE     : encodes the FULL 128 bits (never truncated) → distinct brain_ids → distinct refs.
 *   - PATTERNED     : 'BRN-' + 26 Crockford chars (alphabet omits I/L/O/U → read-aloud safe).
 */
import { createHash } from 'node:crypto';

// Crockford base32 — uppercase, excludes I L O U. 32 symbols. MUST match _identity_ref.py._CROCKFORD.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const REF_PREFIX = 'BRN-';

/** MSB-first Crockford base32 of raw bytes. 16 bytes (128 bits) → 26 chars (final char pads 3 low bits). */
function crockfordB32(data: Uint8Array): string {
  let bits = 0;
  let nbits = 0;
  let out = '';
  for (const byte of data) {
    bits = (bits << 8) | byte;
    nbits += 8;
    while (nbits >= 5) {
      nbits -= 5;
      out += CROCKFORD[(bits >>> nbits) & 0x1f];
    }
  }
  if (nbits > 0) {
    out += CROCKFORD[(bits << (5 - nbits)) & 0x1f];
  }
  return out;
}

/** A UUID → its 16 raw bytes (dashes stripped, case-insensitive). A non-UUID → sha256(input)[:16], so the
 * function is total + deterministic (identical fallback to the Python mirror). */
function to16Bytes(brainId: string): Uint8Array {
  const s = brainId.trim();
  const hex = s.replace(/-/g, '').toLowerCase();
  if (hex.length === 32 && /^[0-9a-f]{32}$/.test(hex)) {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  return Uint8Array.from(createHash('sha256').update(s, 'utf8').digest()).subarray(0, 16);
}

/**
 * brain_id (UUID string) → the public 'BRN-' + Crockford-base32(128 bits) reference.
 * null/undefined/empty → null (a NULL brain_id stays NULL — honest-empty, never a fabricated ref).
 */
export function brainRef(brainId: string | null | undefined): string | null {
  if (brainId == null) return null;
  const s = String(brainId).trim();
  if (!s) return null;
  return REF_PREFIX + crockfordB32(to16Bytes(s));
}
