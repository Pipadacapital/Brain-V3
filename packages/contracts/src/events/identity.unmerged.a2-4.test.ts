/**
 * SPEC: A.2.4 (WA-19) — identity.unmerged.v1 wire contract.
 *
 * The admin unmerge (merge-reversal) event: AMD-08's ONE convention-following sibling on the live
 * {env}.identity.*.v1 lane (no existing topic fits an unmerge). Asserts the payload shape, that the
 * event is in IDENTITY_EVENT_SCHEMAS, the topic suffix follows {domain}.{name}.v{N}, and that the
 * AMD-03 JSON Schema governance artifact exists on disk with the same required-field surface.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IdentityUnmergedEventSchema,
  IdentityUnmergedPayloadSchema,
  IDENTITY_UNMERGED_TOPIC_SUFFIX,
  IDENTITY_UNMERGED_JSON_SCHEMA_SUBJECT,
  IDENTITY_EVENT_SCHEMAS,
} from './identity.events.v1.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const MERGE = '22222222-2222-2222-2222-222222222222';
const SURVIVOR = '33333333-3333-3333-3333-333333333333';
const RESTORED = '44444444-4444-4444-4444-444444444444';

function validEnvelope() {
  return {
    schema_version: '1' as const,
    event_id: '55555555-5555-5555-5555-555555555555',
    brand_id: BRAND,
    correlation_id: 'corr-1',
    event_name: 'identity.unmerged' as const,
    occurred_at: '2026-07-06T00:00:00Z',
    partition_key: BRAND,
    payload: {
      brand_id: BRAND,
      merge_id: MERGE,
      canonical_brain_id: SURVIVOR,
      restored_brain_id: RESTORED,
      rule_version: 'v1-admin-unmerge',
      actor: 'user-abc',
    },
  };
}

describe('A2.4 identity.unmerged.v1 — payload', () => {
  it('accepts a minimal valid payload (reason optional)', () => {
    const p = IdentityUnmergedPayloadSchema.parse(validEnvelope().payload);
    expect(p.canonical_brain_id).toBe(SURVIVOR);
    expect(p.restored_brain_id).toBe(RESTORED);
    expect(p.reason).toBeUndefined();
  });

  it('accepts an optional operator reason', () => {
    const p = IdentityUnmergedPayloadSchema.parse({
      ...validEnvelope().payload,
      reason: 'operator determined the two customers are different people',
    });
    expect(p.reason).toContain('different people');
  });

  it('rejects a missing actor (audit is mandatory)', () => {
    const { actor, ...noActor } = validEnvelope().payload;
    void actor;
    expect(IdentityUnmergedPayloadSchema.safeParse(noActor).success).toBe(false);
  });

  it('rejects a non-uuid brain_id', () => {
    expect(
      IdentityUnmergedPayloadSchema.safeParse({ ...validEnvelope().payload, restored_brain_id: 'nope' }).success,
    ).toBe(false);
  });
});

describe('A2.4 identity.unmerged.v1 — envelope + lane wiring', () => {
  it('parses on the doc-07 envelope with event_name literal', () => {
    const e = IdentityUnmergedEventSchema.parse(validEnvelope());
    expect(e.event_name).toBe('identity.unmerged');
    expect(e.partition_key).toBe(e.brand_id); // identity.* MUST key on brand_id
  });

  it('is registered in IDENTITY_EVENT_SCHEMAS as a 6th identity event', () => {
    expect(IDENTITY_EVENT_SCHEMAS['identity.unmerged']).toBe(IdentityUnmergedEventSchema);
    expect(Object.keys(IDENTITY_EVENT_SCHEMAS)).toContain('identity.unmerged');
  });

  it('topic suffix follows the {domain}.{name}.v{N} convention (AMD-08)', () => {
    expect(IDENTITY_UNMERGED_TOPIC_SUFFIX).toBe('identity.unmerged.v1');
  });
});

describe('A2.4 identity.unmerged.v1 — AMD-03 JSON Schema governance artifact', () => {
  it('the registered JSON Schema artifact exists with a matching required-field surface', () => {
    const p = fileURLToPath(
      new URL('../../generated/json-schema/brain.identity.unmerged.v1.json', import.meta.url),
    );
    const schema = JSON.parse(readFileSync(p, 'utf-8')) as {
      $id: string;
      required: string[];
    };
    expect(schema.$id).toBe(`brain.${IDENTITY_UNMERGED_JSON_SCHEMA_SUBJECT}`);
    // The zod payload's required keys (reason is optional) must be exactly the artifact's `required`.
    expect(new Set(schema.required)).toEqual(
      new Set(['brand_id', 'merge_id', 'canonical_brain_id', 'restored_brain_id', 'rule_version', 'actor']),
    );
  });
});
