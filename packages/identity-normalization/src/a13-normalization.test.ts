// SPEC: A.1.3
/**
 * a13-normalization.test.ts — SPEC §A.1.3 normalization + AMD-01 dual-hash semantics (WA-06).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashIdentifier, normalizePhone as legacyNormalizePhone } from '@brain/identity-core';
import {
  BRAND_DEFAULT_COUNTRIES,
  emailInternalHash,
  emailInteropHash,
  internalHash,
  interopHash,
  normalizeEmail,
  normalizePhone,
  phoneInternalHash,
  phoneInteropHash,
  stripEdgeWhitespace,
} from './index.js';

const SALT = 'a'.repeat(64);
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('A.1.3 email — trim, lowercase, NFC', () => {
  it('trims, lowercases', () => {
    expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com');
  });

  it('strips the explicit edge-whitespace set incl BOM/NBSP/ideographic space', () => {
    expect(normalizeEmail('﻿ 　a@b.co\t\n')).toBe('a@b.co');
    expect(stripEdgeWhitespace('  x ')).toBe('x');
  });

  it('NFC-normalizes: NFD and NFC spellings hash identically', () => {
    const nfd = 'cafe\u0301@ex.com'; // e + COMBINING ACUTE ACCENT (NFD)
    const nfc = 'caf\u00e9@ex.com'; // e-acute precomposed (NFC)
    expect(normalizeEmail(nfd)).toBe(normalizeEmail(nfc));
    expect(emailInteropHash(nfd)).toBe(emailInteropHash(nfc));
  });

  it('does NOT strip gmail dots or plus-tags (ADR-normalization-gmail.md)', () => {
    expect(normalizeEmail('f.irst.last+tag@gmail.com')).toBe('f.irst.last+tag@gmail.com');
    expect(emailInteropHash('a.b@gmail.com')).not.toBe(emailInteropHash('ab@gmail.com'));
    expect(emailInteropHash('a+t@gmail.com')).not.toBe(emailInteropHash('a@gmail.com'));
  });

  it('empty after trim -> null (no identifier)', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('  ﻿ ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(emailInteropHash(' ')).toBeNull();
    expect(emailInternalHash(' ', SALT)).toBeNull();
  });
});

describe('A.1.3 phone — E.164 via libphonenumber, brand default country', () => {
  it('supports the 7 brand default countries', () => {
    expect(BRAND_DEFAULT_COUNTRIES).toEqual(['IN', 'AE', 'SA', 'QA', 'BH', 'KW', 'OM']);
  });

  it('IN: bare 10-digit, trunk-0, formatted, +91 all -> +91XXXXXXXXXX', () => {
    for (const raw of ['9876543210', '09876543210', '098765 43210', '+91 98765-43210']) {
      expect(normalizePhone(raw, 'IN')).toBe('+919876543210');
    }
  });

  it('GCC defaults parse national mobiles to E.164 incl "+"', () => {
    expect(normalizePhone('0501234567', 'AE')).toBe('+971501234567');
    expect(normalizePhone('0551234567', 'SA')).toBe('+966551234567');
    expect(normalizePhone('55123456', 'QA')).toBe('+97455123456');
    expect(normalizePhone('36001234', 'BH')).toBe('+97336001234');
    expect(normalizePhone('50012345', 'KW')).toBe('+96550012345');
    expect(normalizePhone('92123456', 'OM')).toBe('+96892123456');
  });

  it('raw "+CC…" overrides the default country', () => {
    expect(normalizePhone('+971501234567', 'IN')).toBe('+971501234567');
  });

  it('unparseable/invalid -> null (NO cleaned-digits fallback)', () => {
    for (const raw of ['not a phone', '12', '', ' ', '+', '98765', '9'.repeat(20), null, undefined]) {
      expect(normalizePhone(raw as string | null | undefined, 'IN')).toBeNull();
    }
    expect(phoneInteropHash('garbage', 'IN')).toBeNull();
    expect(phoneInternalHash('garbage', 'IN', SALT)).toBeNull();
  });

  it('hash is over the E.164 INCLUDING the "+"', () => {
    expect(phoneInteropHash('9876543210', 'IN')).toBe(sha256('+919876543210'));
  });
});

describe('AMD-01 dual convention — interop (plain) vs internal (salted, identity-core delegated)', () => {
  it('interopHash = plain sha256(normalized), 64-hex lowercase', () => {
    expect(interopHash('user@example.com')).toBe(sha256('user@example.com'));
    expect(interopHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('internalHash = sha256(salt||"||"||normalized) — byte-identical to identity-core', () => {
    expect(internalHash('user@example.com', SALT)).toBe(sha256(`${SALT}||user@example.com`));
    // ONE source of truth: matches identity-core hashIdentifier for values where the
    // legacy normalization agrees (ASCII email; IN 10-digit phone).
    expect(emailInternalHash(' User@Example.com ', SALT)).toBe(
      hashIdentifier(' User@Example.com ', 'email', SALT),
    );
    expect(phoneInternalHash('9876543210', 'IN', SALT)).toBe(
      hashIdentifier('9876543210', 'phone', SALT, 'IN'),
    );
    expect(legacyNormalizePhone('9876543210', 'IN').normalized).toBe(
      normalizePhone('9876543210', 'IN'),
    );
  });

  it('the two spaces never collide for the same value', () => {
    expect(emailInteropHash('a@b.co')).not.toBe(emailInternalHash('a@b.co', SALT));
  });

  it('internal space is per-brand-salt separated (cross-brand uncorrelatability)', () => {
    expect(internalHash('a@b.co', 'a'.repeat(64))).not.toBe(internalHash('a@b.co', 'b'.repeat(64)));
  });
});
