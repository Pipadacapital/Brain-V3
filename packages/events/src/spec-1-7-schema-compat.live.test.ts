// SPEC: 1.7
/**
 * SPEC 1.7 / AMD-03 — schema-governance compat check, LIVE against Apicurio (:8080).
 *
 * Proves end-to-end on the REAL registry (2.6.x) that a BREAKING schema change actually
 * FAILS the check now (the pre-fix code silently passed everything: it hit a nonexistent
 * endpoint and read the 404 as "compatible"). Uses a scratch artifact + the AMD-03
 * idempotent COMPATIBILITY rule boot step; cleans up after itself.
 *
 * Cleanly SKIPs (guarded) when the registry is unreachable — never a hard suite failure
 * on a down stack (repo live-test convention).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  registerSchema,
  ensureCompatibilityRule,
  validateSchemaCompatibility,
  type ApicurioConfig,
} from './index.js';

const BASE = process.env['APICURIO_URL'] ?? 'http://localhost:8080';
const CFG: ApicurioConfig = { baseUrl: BASE, groupId: 'brain', artifactId: 'wa02.compat.live.v1' };

const SCHEMA_V1 = JSON.stringify({
  type: 'record',
  name: 'Wa02CompatLive',
  namespace: 'brain.wa02',
  fields: [
    { name: 'event_id', type: 'string' },
    { name: 'brand_id', type: 'string' },
  ],
});
// BREAKING under FULL_TRANSITIVE: brand_id changes type string → int.
const SCHEMA_BREAKING = JSON.stringify({
  type: 'record',
  name: 'Wa02CompatLive',
  namespace: 'brain.wa02',
  fields: [
    { name: 'event_id', type: 'string' },
    { name: 'brand_id', type: 'int' },
  ],
});
// COMPATIBLE under FULL_TRANSITIVE: additive optional field with default.
const SCHEMA_ADDITIVE = JSON.stringify({
  type: 'record',
  name: 'Wa02CompatLive',
  namespace: 'brain.wa02',
  fields: [
    { name: 'event_id', type: 'string' },
    { name: 'brand_id', type: 'string' },
    { name: 'extra', type: ['null', 'string'], default: null },
  ],
});

let registryUp = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE}/apis/registry/v2/system/info`, { signal: AbortSignal.timeout(2000) });
    registryUp = res.ok;
  } catch {
    registryUp = false;
  }
});

afterAll(async () => {
  if (!registryUp) return;
  await fetch(`${BASE}/apis/registry/v2/groups/${CFG.groupId}/artifacts/${CFG.artifactId}`, {
    method: 'DELETE',
  }).catch(() => undefined);
});

describe('SPEC 1.7 / AMD-03 — live Apicurio compatibility enforcement', () => {
  it('SPEC 1.7: a BREAKING schema change FAILS validateSchemaCompatibility against the live registry', async () => {
    if (!registryUp) {
      console.warn(`[spec-1-7 live] Apicurio unreachable at ${BASE} — skipping (guarded PENDING)`);
      return;
    }
    // Boot: register v1 + ensure the FULL_TRANSITIVE rule (AMD-03 idempotent boot step).
    const reg = await registerSchema(CFG, SCHEMA_V1);
    expect(reg.artifactId).toBe(CFG.artifactId);
    await ensureCompatibilityRule(CFG); // 204 first run
    await ensureCompatibilityRule(CFG); // 409 → idempotent success

    // THE FIX UNDER TEST: pre-fix this returned { compatible: true } for ANY schema.
    const breaking = await validateSchemaCompatibility(CFG, SCHEMA_BREAKING);
    expect(breaking.compatible).toBe(false);
    expect(breaking.reason).toMatch(/not compatible/i);

    // And a genuinely additive change still passes.
    const additive = await validateSchemaCompatibility(CFG, SCHEMA_ADDITIVE);
    expect(additive).toEqual({ compatible: true });
  });

  it('SPEC 1.7: a missing artifact reads as first-version compatible (real 404 semantics)', async () => {
    if (!registryUp) return;
    const res = await validateSchemaCompatibility(
      { ...CFG, artifactId: 'wa02.compat.live.does-not-exist' },
      SCHEMA_V1,
    );
    expect(res).toEqual({ compatible: true });
  });
});
