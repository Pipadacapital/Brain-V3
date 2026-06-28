/**
 * pixel-sdk/uuid — UUIDv7 generator (RFC 9562 / draft-ietf-uuidrev-rfc4122bis).
 *
 * Layout (128 bits):
 *   ┌─ 48-bit big-endian Unix-ms timestamp ─┐┌ ver(4)=0x7 ┐┌─ 12 rand ─┐┌ var(2)=10 ┐┌─ 62 rand ─┐
 *   → 48-bit timestamp + 74 random bits, version nibble 0x7, RFC-4122 variant.
 *
 * event_id moved v4→v7 so ids are TIME-ORDERED (sort ≈ creation order) while staying globally
 * unique — that helps Bronze compaction / debugging without leaking anything (the ms timestamp is
 * the same occurred_at already on the event). PURE + deterministic given (unixMs, rnd) so the shape
 * is unit-testable; the browser entry supplies crypto.getRandomValues and falls back to a v4 id
 * ENTIRELY only when crypto is unavailable (see browser-entry).
 */

/**
 * Render a UUIDv7 from a 48-bit ms timestamp + ≥10 random bytes.
 * @param unixMs Unix epoch milliseconds (floored; clamped ≥0).
 * @param rnd at least 10 bytes of randomness (bytes 6..15 of the uuid; ver/var bits overwritten).
 */
export function uuidV7(unixMs: number, rnd: Uint8Array): string {
  const bytes = new Uint8Array(16);
  // 48-bit big-endian timestamp into bytes[0..5] — use modulo (NOT bitwise; ms > 2^31 overflows int32).
  let t = Math.max(0, Math.floor(unixMs));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  // Random fill bytes[6..15].
  for (let i = 6; i < 16; i++) bytes[i] = rnd[i - 6] ?? 0;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7 in the high nibble
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 variant (10xx) in the high bits
  let hex = '';
  for (let i = 0; i < 16; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
