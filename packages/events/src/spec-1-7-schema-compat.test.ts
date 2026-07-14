// SPEC: 1.7
/**
 * SPEC 1.7 / AMD-03 — schema-governance compat check, UNIT (stubbed fetch).
 *
 * The bug (delta-plan / AMD-03): validateSchemaCompatibility POSTed to
 * `/versions/latest/compatibility` — an endpoint that does not exist in Apicurio Registry
 * v2 (2.6.x) — then treated the 404 as "compatible", so the check was a silent no-op.
 * These tests pin the FIXED behavior: the dry-run rule-test endpoint
 * (`PUT …/artifacts/{id}/test`) is called, and a 409 RuleViolationException maps to
 * { compatible: false } with the violation causes as the reason.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { validateSchemaCompatibility, ensureCompatibilityRule, type ApicurioConfig } from './index.js';

const CFG: ApicurioConfig = { baseUrl: 'http://registry.test:8080', groupId: 'brain', artifactId: 'collector.event.v1' };
const AVSC = '{"type":"record","name":"T","fields":[]}';

function stubFetch(status: number, body: unknown = '') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  // 204 is a null-body status — the Response constructor rejects a body for it.
  const spy = vi.fn(async () =>
    status === 204
      ? new Response(null, { status })
      : new Response(text, { status, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('SPEC 1.7 — validateSchemaCompatibility uses the real Apicurio 2.6 API', () => {
  it('SPEC 1.7: calls PUT …/artifacts/{id}/test (NOT the nonexistent /versions/latest/compatibility)', async () => {
    const spy = stubFetch(204);
    await validateSchemaCompatibility(CFG, AVSC);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://registry.test:8080/apis/registry/v2/groups/brain/artifacts/collector.event.v1/test');
    expect(url).not.toContain('/versions/latest/compatibility');
    expect(init.method).toBe('PUT');
  });

  it('SPEC 1.7: 409 RuleViolationException → compatible:false with the violation causes as reason', async () => {
    stubFetch(409, {
      detail: 'RuleViolationException: Incompatible artifact',
      causes: [{ context: '/fields/1/type', description: 'reader type: INT not compatible with writer type: STRING' }],
    });
    const res = await validateSchemaCompatibility(CFG, AVSC);
    expect(res.compatible).toBe(false);
    expect(res.reason).toContain('reader type: INT not compatible with writer type: STRING');
    expect(res.reason).toContain('/fields/1/type');
  });

  it('SPEC 1.7: 204 (rules pass) → compatible:true', async () => {
    stubFetch(204);
    await expect(validateSchemaCompatibility(CFG, AVSC)).resolves.toEqual({ compatible: true });
  });

  it('SPEC 1.7: 404 now means ARTIFACT missing (first version) → compatible:true — no longer an endpoint-missing mask', async () => {
    const spy = stubFetch(404, { message: 'No artifact with ID collector.event.v1' });
    await expect(validateSchemaCompatibility(CFG, AVSC)).resolves.toEqual({ compatible: true });
    // The 404 is trustworthy ONLY because the endpoint itself is live-verified to exist —
    // pinned here by asserting the /test path (the old endpoint 404'd unconditionally).
    expect((spy.mock.calls[0] as unknown as [string])[0]).toMatch(/\/test$/);
  });

  it('SPEC 1.7: unexpected statuses throw (transport honesty — never silently compatible)', async () => {
    stubFetch(500, 'boom');
    await expect(validateSchemaCompatibility(CFG, AVSC)).rejects.toThrow(/Compatibility check failed \(500\)/);
  });
});

describe('SPEC 1.7 / AMD-03 — ensureCompatibilityRule (idempotent boot step)', () => {
  it('SPEC 1.7: POSTs the COMPATIBILITY rule to the artifact rules endpoint (FULL_TRANSITIVE default)', async () => {
    const spy = stubFetch(204);
    await ensureCompatibilityRule(CFG);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://registry.test:8080/apis/registry/v2/groups/brain/artifacts/collector.event.v1/rules');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ type: 'COMPATIBILITY', config: 'FULL_TRANSITIVE' });
  });

  it('SPEC 1.7: 409 (rule already exists) is idempotent success', async () => {
    stubFetch(409, { message: 'A rule named COMPATIBILITY already exists' });
    await expect(ensureCompatibilityRule(CFG)).resolves.toBeUndefined();
  });

  it('SPEC 1.7: other failures throw', async () => {
    stubFetch(500, 'boom');
    await expect(ensureCompatibilityRule(CFG)).rejects.toThrow(/Failed to ensure COMPATIBILITY rule \(500\)/);
  });
});
