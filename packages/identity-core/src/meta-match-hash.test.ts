/**
 * meta-match-hash.test.ts — the Meta CAPI advanced-matching hash (Phase 6, Track B).
 *
 * Proves metaMatchHash is the Meta-mandated UNSALTED sha256-of-normalized format and is
 * NOT a second hasher: it reuses the SAME normalizeIdentifier() as hashIdentifier, only
 * omitting the per-brand salt (which Meta cannot match against).
 *
 *   (1) UNSALTED — metaMatchHash(value) === sha256(normalize(value)); it is INDEPENDENT of
 *       any salt and DIFFERS from the salted internal subject_hash (hashIdentifier). A
 *       salted hash would have 0% Meta match quality (Meta hashes their own copy unsalted).
 *   (2) NORMALIZATION shared — email lowercased+trimmed; phone E.164-normalized. The SAME
 *       normalization as the internal hash, so "User@Example.COM" and "user@example.com"
 *       collapse to one Meta hash (consistent matching).
 *   (3) DETERMINISTIC + 64-hex — replay-stable; never raw PII (a hex digest, not the value).
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  metaMatchHash,
  hashIdentifier,
  normalizeIdentifier,
} from './index.js';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('metaMatchHash — UNSALTED sha256 of the normalized value (Meta match spec)', () => {
  it('email: equals sha256(normalize(email)) with NO salt', () => {
    const raw = '  User@Example.COM ';
    const expected = sha256(normalizeIdentifier(raw, 'email')); // 'user@example.com'
    expect(metaMatchHash(raw, 'email')).toBe(expected);
    expect(metaMatchHash(raw, 'email')).toBe(sha256('user@example.com'));
  });

  it('phone: equals sha256(normalize(phone)) — E.164 normalized, NO salt', () => {
    const raw = '98765 43210'; // bare 10-digit IN → +919876543210
    const normalized = normalizeIdentifier(raw, 'phone', 'IN');
    expect(normalized).toBe('+919876543210');
    expect(metaMatchHash(raw, 'phone', 'IN')).toBe(sha256('+919876543210'));
  });

  it('is INDEPENDENT of salt — DIFFERS from the salted internal subject_hash', () => {
    const email = 'user@example.com';
    const meta = metaMatchHash(email, 'email');
    // The internal hash salts with a per-brand secret → a DIFFERENT digest.
    const internalA = hashIdentifier(email, 'email', 'a'.repeat(64));
    const internalB = hashIdentifier(email, 'email', 'b'.repeat(64));
    expect(meta).not.toBe(internalA);
    expect(meta).not.toBe(internalB);
    // The Meta hash never changes with the salt (there is none) — Meta-matchable.
    expect(meta).toBe(metaMatchHash(email, 'email'));
  });

  it('is DETERMINISTIC, 64-hex, and reuses the SAME normalization (case/space-insensitive)', () => {
    const a = metaMatchHash('USER@EXAMPLE.COM', 'email');
    const b = metaMatchHash('user@example.com', 'email');
    expect(a).toBe(b); // shared normalization → one match key
    expect(a).toMatch(/^[0-9a-f]{64}$/); // a hex digest, never raw PII
    expect(metaMatchHash('user@example.com', 'email')).toBe(a); // replay-stable
  });
});
