/**
 * CI GATE: consent-propagation + no-pii-schema-lint (R3 / COMPLIANCE.md:105,149 / ADR-2).
 *
 * This is a build-failing gate, NOT a behavioural unit test. It runs under `test:unit`
 * (vitest run) so a PR that drifts the collector envelope is REJECTED by CI.
 *
 * Two structural guarantees on the LIVE collector envelope (CollectorEventV1Schema):
 *
 *  1. consent-propagation — the customer-domain collector envelope MUST carry a
 *     first-class `consent_flags` field with the four COMPLIANCE.md booleans
 *     {analytics, marketing, personalization, ai_processing}. The downstream
 *     can_contact() chokepoint + this gate inspect a KNOWN field name, not an
 *     arbitrary properties key. Removing/renaming it FAILS the build.
 *
 *  2. no-pii-schema-lint — the envelope MUST NOT grow a top-level RAW-PII field
 *     (email, phone, name, address, …) and MUST NOT carry a per-brand salt (ADR-2:
 *     the browser sends NO raw PII + NO salt; canonical sha256(salt‖normalized) stays
 *     server-side in stream-worker). Only sha256-hashed / opaque identifiers are allowed.
 *
 * @see docs/data-collection-platform/05-architecture (Track A / R3)
 * @see .engineering-os/knowledge-base/COMPLIANCE.md:105
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { CollectorEventV1Schema } from './sample.collector.event.v1.js';

/** Reflect the top-level keys of the collector envelope ZodObject. */
function envelopeKeys(): string[] {
  const shape = (CollectorEventV1Schema as z.ZodObject<z.ZodRawShape>).shape;
  return Object.keys(shape);
}

/**
 * Raw-PII / salt field-name patterns that MUST NEVER appear as a top-level envelope
 * field (ADR-2). Hashed variants (hashed_user_id, hashed_session_id) are explicitly
 * allowed — the ban is on RAW identifiers + secrets, not on opaque hashes.
 */
const RAW_PII_PATTERNS: RegExp[] = [
  /^email$/i,
  /(^|_)email$/i,
  /^phone$/i,
  /(^|_)phone(_number)?$/i,
  /^(first|last|full)_?name$/i,
  /^name$/i,
  /^address$/i,
  /(^|_)address$/i,
  /^ip(_address)?$/i,
  /^dob$/i,
  /^date_of_birth$/i,
  /salt/i, // ADR-2: no per-brand salt ever rides the envelope
  /(^|_)pii(_|$)/i,
];

/** Hashed/opaque fields that are explicitly allowed despite matching no PII pattern. */
const ALLOWED_HASHED = new Set(['hashed_user_id', 'hashed_session_id']);

describe('CI GATE: consent-propagation (R3 / COMPLIANCE.md:105)', () => {
  it('the collector envelope carries a first-class consent_flags field', () => {
    const keys = envelopeKeys();
    expect(
      keys.includes('consent_flags'),
      'CollectorEventV1Schema MUST carry a top-level consent_flags field — ' +
        'the consent-propagation gate + can_contact() inspect this known name. ' +
        `Got envelope keys: ${keys.join(', ')}`,
    ).toBe(true);
  });

  it('consent_flags carries the four COMPLIANCE.md consent booleans', () => {
    // An event WITH all four flags must parse; the field shape is the contract.
    const withConsent = CollectorEventV1Schema.safeParse({
      event_id: '11111111-1111-4111-8111-111111111111',
      brand_id: '22222222-2222-4222-8222-222222222222',
      correlation_id: 'trace-1',
      event_name: 'page.viewed',
      occurred_at: '2026-06-18T12:00:00Z',
      consent_flags: {
        analytics: true,
        marketing: false,
        personalization: false,
        ai_processing: false,
      },
    });
    expect(withConsent.success).toBe(true);

    // A partial consent_flags (missing a required boolean) must be REJECTED —
    // the four flags are mandatory WHEN consent_flags is present.
    const partial = CollectorEventV1Schema.safeParse({
      event_id: '11111111-1111-4111-8111-111111111111',
      brand_id: '22222222-2222-4222-8222-222222222222',
      correlation_id: 'trace-1',
      event_name: 'page.viewed',
      occurred_at: '2026-06-18T12:00:00Z',
      consent_flags: { analytics: true },
    });
    expect(partial.success).toBe(false);
  });
});

describe('CI GATE: no-pii-schema-lint (ADR-2 — no raw PII / no salt on the wire)', () => {
  it('the envelope has NO top-level raw-PII or salt field', () => {
    const keys = envelopeKeys();
    const offenders = keys.filter(
      (k) =>
        !ALLOWED_HASHED.has(k) && RAW_PII_PATTERNS.some((re) => re.test(k)),
    );
    expect(
      offenders,
      `no-pii-schema-lint VIOLATION: the collector envelope grew raw-PII/salt field(s): ` +
        `${offenders.join(', ')}. ADR-2: the browser sends NO raw PII + NO salt; ` +
        `canonical sha256(salt‖normalized) stays server-side. Use a hashed_* field instead.`,
    ).toEqual([]);
  });
});
