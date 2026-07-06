// SPEC: WA.1.10 — golden dataset deterministic identifiers (§1.10)
//
// Every id in the golden dataset is a pure function of (seed, semantic parts):
// sha256 → UUID-shaped (version/variant bits set), mirroring the repo's
// hashToUuidShaped convention (@brain/connector-core) for deterministic event ids.

import { createHash } from 'node:crypto';

export function sha256HexOf(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Deterministic UUID-v4-shaped id from semantic parts. Same parts → same uuid.
 * Layout mirrors hashToUuidShaped: first 16 bytes of sha256, version nibble 4,
 * variant bits 10xx.
 */
export function deterministicUuid(...parts: string[]): string {
  const hex = sha256HexOf(`brain-golden||${parts.join('||')}`);
  const bytes = hex.slice(0, 32).split('');
  bytes[12] = '4'; // version 4
  bytes[16] = ((parseInt(bytes[16] as string, 16) & 0x3) | 0x8).toString(16); // variant 10xx
  const s = bytes.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * The pixel identify-bridge hash: PLAIN UNSALTED sha256 of trim+lowercase email —
 * byte-identical to the served /pixel.js `identify()` (pixel-asset.route.ts:284–294).
 * This intentionally reproduces today's hash-drift reality (pixel unsalted vs
 * connector salted): the golden baseline snapshots TODAY'S pipeline behavior.
 */
export function pixelIdentifyEmailHash(email: string): string {
  return sha256HexOf(email.trim().toLowerCase());
}
