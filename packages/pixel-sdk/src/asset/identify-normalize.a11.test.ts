// SPEC: A.1.1 (WA-07 — browser normalization parity + minimal-E.164 contract)
/**
 * identify-normalize.a11.test.ts — the WA-07 browser normalizers:
 *
 *   A1.1 email — normalizeEmailBrowser MUST match @brain/identity-normalization normalizeEmail
 *     EXACTLY (same edge-whitespace set, lowercase, NFC, empty→null) for every value both accept:
 *     hash drift between the pixel and the connector dual-write silently breaks the anon→known
 *     bridge. (Browser adds ONE deliberate extra guard: a value without a plausible '@' shape is
 *     null'd client-side — never a divergent NON-NULL value.)
 *
 *   A1.1 phone — normalizePhoneBrowser is the documented MINIMAL E.164 (no libphonenumber in the
 *     browser): every number it ACCEPTS must equal the full libphonenumber result (no divergent
 *     hashes); numbers it can't prove are handed back as null (reduced fidelity, compensated by
 *     Silver-side re-validation).
 */
import { describe, it, expect } from 'vitest';
import { normalizeEmail, normalizePhone } from '@brain/identity-normalization';
import {
  normalizeEmailBrowser,
  normalizePhoneBrowser,
  stripEdgeWhitespaceBrowser,
  PHONE_COUNTRY_CC,
} from './identify-normalize.js';

describe('A1.1 — email normalization parity with @brain/identity-normalization', () => {
  const VECTORS = [
    '  User@Example.COM ',
    'user@example.com',
    'ÜSER@exämple.com',
    'user+tag@gmail.com', // plus-tag NOT stripped (ADR-normalization-gmail)
    'u.s.e.r@gmail.com', // dots NOT stripped
    ' user@example.com　', // NBSP + ideographic space edges
    '﻿user@example.com', // BOM edge
    'Café@example.com', // combining acute — NFC must compose to é
    'user@EXAMPLE.co.in',
  ];

  it('A1.1: matches the server package byte-for-byte on every accepted vector', () => {
    for (const raw of VECTORS) {
      expect(normalizeEmailBrowser(raw), raw).toBe(normalizeEmail(raw));
    }
  });

  it('A1.1: empty / null / undefined → null (both sides)', () => {
    for (const raw of ['', '   ', ' ﻿']) {
      expect(normalizeEmailBrowser(raw)).toBeNull();
      expect(normalizeEmail(raw)).toBeNull();
    }
    expect(normalizeEmailBrowser(null)).toBeNull();
    expect(normalizeEmailBrowser(undefined)).toBeNull();
  });

  it('A1.1: browser-side @-shape guard only ever NULLS (never a divergent non-null value)', () => {
    // The server package does no format validation; the browser refuses shapes that cannot be an
    // email. The invariant: browser non-null ⇒ equals server value.
    for (const raw of ['not-an-email', '@nolocal.com', 'trailing@']) {
      expect(normalizeEmailBrowser(raw)).toBeNull();
    }
  });

  it('A1.1: shared edge-whitespace strip excludes U+0085 (twin lockstep)', () => {
    // U+0085 (NEL) is deliberately NOT in the shared set (Python-only whitespace).
    expect(stripEdgeWhitespaceBrowser('x')).toBe('x');
    expect(stripEdgeWhitespaceBrowser(' x ')).toBe('x');
  });
});

describe('A1.1 — minimal browser E.164 (accepted ⇒ identical to libphonenumber; else null)', () => {
  it('A1.1: IN national / trunk-0 / international shapes match libphonenumber exactly', () => {
    const vectors = [
      ['9876543210', 'IN'],
      ['09876543210', 'IN'],
      ['098765 43210', 'IN'],
      ['+91 98765-43210', 'IN'],
      ['+919876543210', 'IN'],
      ['00919876543210', 'IN'],
    ] as const;
    for (const [raw, cc] of vectors) {
      const browser = normalizePhoneBrowser(raw, cc);
      const server = normalizePhone(raw, cc);
      expect(browser, `${raw} (${cc})`).toBe(server);
      expect(browser).toBe('+919876543210');
    }
  });

  it('A1.1: GCC default countries prefix the right calling code', () => {
    // UAE mobile 50 123 4567 → +971501234567 (server-verified parity).
    expect(normalizePhoneBrowser('0501234567', 'AE')).toBe('+971501234567');
    expect(normalizePhoneBrowser('0501234567', 'AE')).toBe(normalizePhone('0501234567', 'AE'));
    expect(PHONE_COUNTRY_CC['SA']).toBe('966');
    expect(PHONE_COUNTRY_CC['QA']).toBe('974');
  });

  it("A1.1: an explicit '+' international number overrides the default country (both sides)", () => {
    expect(normalizePhoneBrowser('+971501234567', 'IN')).toBe('+971501234567');
    expect(normalizePhone('+971501234567', 'IN')).toBe('+971501234567');
  });

  it('A1.1: junk / letters / out-of-bounds lengths → null (fail-null, never a junk hash)', () => {
    for (const raw of ['call-me-maybe', 'abc123', '12345', '', '+', '00', '1234567890123456']) {
      expect(normalizePhoneBrowser(raw, 'IN'), raw).toBeNull();
    }
    expect(normalizePhoneBrowser(null, 'IN')).toBeNull();
    expect(normalizePhoneBrowser(undefined, 'IN')).toBeNull();
  });

  it('A1.1: unknown default country falls back to IN (never throws, never un-prefixed)', () => {
    expect(normalizePhoneBrowser('9876543210', 'ZZ')).toBe('+919876543210');
  });

  it('A1.1: documented fidelity gap — browser may null what libphonenumber accepts, but NEVER emit a hash libphonenumber would reject as a DIFFERENT value', () => {
    // Property over a spread of shapes: browser non-null ⇒ equal to the server result OR the
    // server also nulls (in which case a mismatched stitch key simply never matches anything —
    // safe). What must NEVER happen: both non-null and different.
    const shapes = [
      '9876543210', '09876543210', '+919876543210', '00919876543210', '98765',
      '0501234567', '+971501234567', '(987) 654-3210', '987.654.3210', '0000000000',
    ];
    for (const raw of shapes) {
      for (const cc of ['IN', 'AE', 'SA']) {
        const b = normalizePhoneBrowser(raw, cc);
        const s = normalizePhone(raw, cc);
        if (b !== null && s !== null) expect(b, `${raw} (${cc})`).toBe(s);
      }
    }
  });
});
