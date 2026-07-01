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
// ISOMORPHIC — deliberately zero imports. @brain/contracts is bundled into the web CLIENT
// (lib/api/client.ts → contracts barrel → this file), and webpack cannot bundle `node:crypto`
// (UnhandledSchemeError). The sha256 below is a small pure-TS implementation used ONLY for the
// rare non-UUID fallback; its output is byte-identical to node:crypto/hashlib (locked by the
// brain-ref.test.ts parity test), so the Python mirror contract is unchanged.

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

// ── Pure-TS SHA-256 (FIPS 180-4) — browser-safe; parity with node:crypto locked in the test ──

// prettier-ignore
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** sha256 over the UTF-8 bytes of `input` → 32 raw bytes. */
function sha256Utf8(input: string): Uint8Array {
  const msg = new TextEncoder().encode(input);
  const len = msg.length;
  // Pad: 0x80, zeros, then the 64-bit big-endian bit length; total a multiple of 64 bytes.
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000), false);
  dv.setUint32(padded.length - 4, (len << 3) >>> 0, false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0; H[1] = (H[1]! + b) >>> 0; H[2] = (H[2]! + c) >>> 0; H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0; H[5] = (H[5]! + f) >>> 0; H[6] = (H[6]! + g) >>> 0; H[7] = (H[7]! + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]!, false);
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
  return sha256Utf8(s).subarray(0, 16);
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
