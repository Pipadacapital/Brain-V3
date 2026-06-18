/**
 * redact-question.test.ts — the PII-corpus proof for deterministic redaction (D4).
 *
 * THE INVARIANT: the RAW question is NEVER persisted/logged — only redactQuestion(raw) is.
 * This test asserts that after redaction NO email / phone / long-digit run / URL survives,
 * and that redaction is deterministic (same input → same output). If redaction regresses,
 * this test fails loud (it is the canary for a PII leak into ai_provenance / logs).
 */

import { describe, it, expect } from 'vitest';
import { redactQuestion } from './redact-question.js';

// Patterns that MUST NOT appear in any redacted output.
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const URL = /(https?:\/\/|www\.)/i;
const LONG_DIGITS = /\d{5,}/;
const PHONE = /\+?\d[\d\s().-]{6,}\d/;

const PII_CORPUS: string[] = [
  'what is the realized revenue for jane.doe@example.com last week',
  'show me ad spend, my order number is 100200300400',
  'call me at +1 (415) 555-2671 about blended roas',
  'check https://shop.example.com/orders/AB12345 for cod rto rate',
  'card 4111 1111 1111 1111 was charged — what is provisional revenue',
  'pincode 560001 phone 9876543210 — order_status_mix please',
  'my email is RISH+test@brain.io and revenue dropped',
  'www.competitor.com beat us — checkout funnel for june',
];

describe('redactQuestion — deterministic PII strip (D4)', () => {
  it('strips ALL emails / URLs / phones / long-digit runs across a PII corpus', () => {
    for (const raw of PII_CORPUS) {
      const out = redactQuestion(raw);
      expect(out, `email leaked: "${out}"`).not.toMatch(EMAIL);
      expect(out, `url leaked: "${out}"`).not.toMatch(URL);
      expect(out, `long-digit leaked: "${out}"`).not.toMatch(LONG_DIGITS);
      expect(out, `phone leaked: "${out}"`).not.toMatch(PHONE);
    }
  });

  it('is deterministic — same input yields byte-identical output', () => {
    for (const raw of PII_CORPUS) {
      expect(redactQuestion(raw)).toBe(redactQuestion(raw));
    }
  });

  it('retains coarse intent words (auditable) while replacing PII with tokens', () => {
    const out = redactQuestion('what is the realized revenue for jane@example.com');
    expect(out).toContain('realized revenue');
    expect(out).toContain('[email]');
    expect(out).not.toContain('jane@example.com');
  });

  it('never returns an empty string (NOT NULL column guarantee)', () => {
    expect(redactQuestion('')).toBe('[redacted]');
    expect(redactQuestion('   ')).toBe('[redacted]');
    expect(redactQuestion('12345')).not.toBe('');
  });

  it('does not leak the raw question verbatim when it contains PII', () => {
    const raw = 'revenue for account 998877665544';
    const out = redactQuestion(raw);
    expect(out).not.toBe(raw.toLowerCase());
    expect(out).not.toContain('998877665544');
  });
});
