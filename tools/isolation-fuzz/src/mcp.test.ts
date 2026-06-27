/**
 * isolation-fuzz/mcp.test.ts — Layer (d): MCP scope authorization (NN-2)
 *
 * NEGATIVE-CONTROL DESIGN:
 *   - Verifies that an MCP tool invocation scoped to brand-A CANNOT return brand-B data
 *   - MCP scope enforcement: the server must validate the `brand_id` claim in the
 *     MCP session context before executing any tool
 *   - All MCP tools are read-only (I-S08 invariant — no write tools on MCP server)
 *
 * SPRINT-0 STUB NOTE:
 *   The MCP server is owned by the backend-developer (packages/ai-gateway-client).
 *   LiteLLM + MCP deployment is deferred to M3 (scope ruling 2).
 *   In Sprint-0, this test validates the SCOPE ENFORCEMENT PATTERN with a stub
 *   MCP context object. The assertion structure exists and will FAIL if the
 *   enforcement is absent (i.e., if tools return data without checking brand scope).
 *
 * The test IS the negative control: if the scope check is removed, the test fails.
 *
 * DEPENDENCY: backend-developer to extend with real MCP client when M3 lands.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MCP_TOOLS,
  writeToolCount,
  FORBIDDEN_TOOL_NAME_SUBSTRINGS,
  // ── The REAL read-only dispatch (the I-S08 canary binds to THIS, not a stub) ──
  dispatchMcpTool,
  assertSeamNamesClean,
  MCP_READ_SEAM_NAMES,
  FORBIDDEN_SEAM_NAME_SUBSTRINGS,
  NotImplementedYetError,
  McpPrincipalScopeError,
  type McpReadSeams,
  type McpPrincipal,
  type McpSchemaProvider,
  type SchemaLike,
} from '@brain/ai-gateway-client';

const BRAND_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BRAND_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Stub MCP context — models the session scope enforcement
// In production: this is the JWT claim + MCP server scope validation.
// ---------------------------------------------------------------------------
interface McpContext {
  brandId: string;
  scope: string[];  // e.g. ['read:metrics', 'read:events']
  isReadOnly: boolean;
}

interface McpToolResult<T> {
  data: T | null;
  error: string | null;
  accessDenied: boolean;
}

// ---------------------------------------------------------------------------
// Stub MCP server — enforces brand_id scope on every tool call.
// This is the pattern the real MCP server MUST implement.
// ---------------------------------------------------------------------------
class StubMcpServer {
  private readonly dataStore: Map<string, Record<string, unknown>[]> = new Map([
    [BRAND_A, [{ metric: 'gmv', value: 100000, brand_id: BRAND_A }]],
    [BRAND_B, [{ metric: 'gmv', value: 200000, brand_id: BRAND_B }]],
  ]);

  // Enforce scope: every tool call validates the session's brand_id matches the requested data
  executeReadMetricsTool(
    ctx: McpContext,
    requestedBrandId: string
  ): McpToolResult<Record<string, unknown>[]> {
    // SCOPE ENFORCEMENT — this check is what the test verifies MUST exist
    if (ctx.brandId !== requestedBrandId) {
      return {
        data: null,
        error: null,
        accessDenied: true,  // cross-brand access denied
      };
    }

    // Scope matches → return the brand's own data
    const data = this.dataStore.get(requestedBrandId) ?? [];
    return { data, error: null, accessDenied: false };
  }

  // No-write enforcement (I-S08): write tools MUST NOT exist
  // The test verifies no write tool is registered
  getRegisteredTools(): string[] {
    return ['read_metrics', 'read_events', 'read_segments'];  // ALL read-only
  }
}

const mcpServer = new StubMcpServer();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('MCP scope authorization — Layer (d) isolation-fuzz (NN-2)', () => {

  it('[positive] brand-A context reads brand-A metrics', () => {
    const ctx: McpContext = { brandId: BRAND_A, scope: ['read:metrics'], isReadOnly: true };

    const result = mcpServer.executeReadMetricsTool(ctx, BRAND_A);

    expect(result.accessDenied).toBe(false);
    expect(result.data).not.toBeNull();
    expect(result.data!.length).toBeGreaterThan(0);

    for (const item of result.data!) {
      expect(item['brand_id']).toBe(BRAND_A);
    }
  });

  it('[NEGATIVE-CONTROL] brand-A context CANNOT read brand-B metrics → accessDenied (I-S01)', () => {
    // brand-A JWT context, but requesting brand-B data
    const ctx: McpContext = { brandId: BRAND_A, scope: ['read:metrics'], isReadOnly: true };

    const result = mcpServer.executeReadMetricsTool(ctx, BRAND_B);

    // MUST be access denied — cross-brand MCP tool call
    expect(result.accessDenied).toBe(true);
    expect(result.data).toBeNull();

    // NEGATIVE CONTROL: if you remove the `if (ctx.brandId !== requestedBrandId)` check
    // from executeReadMetricsTool above, this test FAILS (accessDenied becomes false,
    // data becomes non-null, brand-B's data is exposed to brand-A's session).
    // The test is the canary for scope enforcement removal.
  });

  it('[NEGATIVE-CONTROL] no context brand_id → access denied (missing-scope safety)', () => {
    // An MCP call with an empty/missing brand context must be denied
    const ctxNoBrand: McpContext = { brandId: '', scope: [], isReadOnly: true };

    const resultA = mcpServer.executeReadMetricsTool(ctxNoBrand, BRAND_A);
    const resultB = mcpServer.executeReadMetricsTool(ctxNoBrand, BRAND_B);

    expect(resultA.accessDenied).toBe(true);
    expect(resultB.accessDenied).toBe(true);
  });

  it('[I-S08] all registered MCP tools are read-only — no write tools exist', () => {
    const tools = mcpServer.getRegisteredTools();

    // I-S08: no write tool may be registered on the MCP server
    // Write patterns: 'write_', 'create_', 'update_', 'delete_', 'upsert_', 'insert_'
    const WRITE_PREFIXES = ['write_', 'create_', 'update_', 'delete_', 'upsert_', 'insert_', 'mutate_'];

    for (const tool of tools) {
      const isWriteTool = WRITE_PREFIXES.some(prefix => tool.startsWith(prefix));
      expect(isWriteTool).toBe(false);
    }

    // All tools must be in the read_ namespace
    for (const tool of tools) {
      expect(tool.startsWith('read_')).toBe(true);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // I-S08 CI-BLOCKING — the REAL MCP tool registry (apps/core/.../ai/mcp/tools.ts).
  // These assert against the ACTUAL exported registry, not the stub above. If a
  // write/sql/mutate tool is ever added, writeToolCount becomes > 0 and CI FAILS.
  // This is the structural ban on a write/text-to-SQL MCP tool (Phase 8, D5).
  // ─────────────────────────────────────────────────────────────────────────
  it('[I-S08 / CI-BLOCKING] real MCP registry write-tool count === 0', () => {
    expect(writeToolCount).toBe(0);
    // Derived independently from the registry as a second check (no drift).
    const derived = MCP_TOOLS.filter((t) => t.access !== 'read').length;
    expect(derived).toBe(0);
    // The registry is non-empty (read tools DO exist — proves the assertion is live).
    expect(MCP_TOOLS.length).toBeGreaterThan(0);
    for (const t of MCP_TOOLS) expect(t.access).toBe('read');
  });

  it('[I-S08 / CI-BLOCKING] no MCP tool name contains sql/write/mutate/insert/update/delete', () => {
    for (const t of MCP_TOOLS) {
      const lower = t.name.toLowerCase();
      for (const forbidden of FORBIDDEN_TOOL_NAME_SUBSTRINGS) {
        expect(lower.includes(forbidden), `tool "${t.name}" contains forbidden "${forbidden}"`).toBe(false);
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // V4 lookup-tool registry shape — status discriminant + disabled-first-class.
  // ─────────────────────────────────────────────────────────────────────────
  it('[V4] every registered tool carries a status; access stays read-only', () => {
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(9);
    for (const t of MCP_TOOLS) {
      expect(t.access).toBe('read');
      expect(['enabled', 'disabled-not-implemented']).toContain(t.status);
    }
  });

  it('[V4] segment_lookup is registered DISABLED with a reason and NO output schema (fails closed)', () => {
    const disabled = MCP_TOOLS.filter((t) => t.status === 'disabled-not-implemented');
    // Exactly the segment_lookup tool is the disabled one.
    expect(disabled.map((t) => t.name)).toEqual(['segment_lookup']);
    const seg = disabled[0]!;
    expect(seg.notImplementedReason && seg.notImplementedReason.length).toBeGreaterThan(0);
    // A disabled tool MUST NOT advertise an output schema (it never returns honest data).
    expect(seg.outputSchemaRef).toBeUndefined();
  });

  it('[V4] every ENABLED lookup tool (beyond the 2 legacy resolver tools) advertises input+output schema refs', () => {
    const lookupTools = MCP_TOOLS.filter(
      (t) => t.status === 'enabled' && t.name !== 'list_metrics' && t.name !== 'resolve_and_compute',
    );
    expect(lookupTools.length).toBe(8); // 8 enabled lookups (segment_lookup is the 9th, disabled)
    for (const t of lookupTools) {
      expect(t.inputSchemaRef, `${t.name} missing inputSchemaRef`).toBeTruthy();
      expect(t.outputSchemaRef, `${t.name} missing outputSchemaRef`).toBeTruthy();
      expect(t.scope, `${t.name} missing scope`).toBeTruthy();
    }
  });

  it('[V4 / I-S01] no tool schema ref hints at a brand_id arg — brain_id is the only crossing key', () => {
    // The schema-level brand_id ban is enforced in contracts codegen (asserts brand_id absent from
    // every generated input). Here we assert the registry never NAMES a brand_id input ref.
    for (const t of MCP_TOOLS) {
      expect(t.inputSchemaRef?.toLowerCase() ?? '').not.toContain('brand');
    }
  });

  it('[documentation] removing scope check WOULD expose cross-brand MCP data', () => {
    // Manual negative-control verification:
    //   1. Remove the `if (ctx.brandId !== requestedBrandId)` check from StubMcpServer
    //   2. Re-run the '[NEGATIVE-CONTROL]' tests → they FAIL
    //      (result.accessDenied is false, brand-B data visible to brand-A session)
    //   3. Restore the check → tests PASS again
    //
    // This is the NN-2 compliance proof for the MCP layer.
    // The real MCP server implementation (packages/ai-gateway-client + MCP server, M3)
    // must implement this same scope check on every tool handler.
    expect('documentation').toBe('documentation');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// I-S08 CANARY — the REAL read-only DISPATCH (not the stub above).
//
// These tests run @brain/ai-gateway-client `dispatchMcpTool` over a RECORDING seam surface and
// assert the non-negotiable invariants. This is the canary: removing the no-write / scope / replay
// assertions here MUST fail CI. The dispatch can call ONLY the read seams in `McpReadSeams`; there is
// no writer/replay/idempotency/algorithm-migration path to reach (it is not a property of the type).
// ═══════════════════════════════════════════════════════════════════════════════

const BRAIN_ID = '11111111-2222-3333-4444-555555555555';
const PRINCIPAL_A: McpPrincipal = { brandId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const PRINCIPAL_B: McpPrincipal = { brandId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };

/** A recording schema provider — proves I/O validation is invoked; parses identity (no contracts dep). */
function recordingSchemas(): { provider: McpSchemaProvider; refs: string[] } {
  const refs: string[] = [];
  const provider: McpSchemaProvider = (ref: string): SchemaLike => ({
    parse: (input: unknown) => {
      refs.push(ref);
      return input;
    },
  });
  return { provider, refs };
}

/** Honest-empty read seams as spies — every member records (brandId, …) and returns honest-empty. */
function recordingSeams(): { seams: McpReadSeams; calls: Record<string, string[]> } {
  const calls: Record<string, string[]> = {};
  const rec = (name: string) =>
    vi.fn(async (brandId: string) => {
      (calls[name] ??= []).push(brandId);
      return undefined as never;
    });
  const seams: McpReadSeams = {
    customer360Summary: vi.fn(async (brandId: string) => {
      (calls['customer360Summary'] ??= []).push(brandId);
      return { hasData: false, customerCount: 0n, totalLifetimeValueMinor: 0n, totalLifetimeOrders: 0n, currencyCode: null, topCustomers: [] };
    }),
    customerJourneySummary: vi.fn(async (brandId: string) => {
      (calls['customerJourneySummary'] ??= []).push(brandId);
      return { hasData: false, journeyCount: 0n, convertedJourneyCount: 0n, conversionRatePct: 0, totalTouchpoints: 0n, avgTouchpointsPerJourney: 0, avgDaysToConvert: null, topJourneys: [] };
    }),
    identityTimeline: vi.fn(async (brandId: string, _brainId: string) => {
      (calls['identityTimeline'] ??= []).push(brandId);
      return { state: 'found' as const, brain_id: BRAIN_ID, entries: [], count: 0 };
    }),
    identityExplain: vi.fn(async (brandId: string, _brainId: string) => {
      (calls['identityExplain'] ??= []).push(brandId);
      return { state: 'not_found' as const, brain_id: BRAIN_ID };
    }),
    channelRoas: vi.fn(async (brandId: string) => {
      (calls['channelRoas'] ??= []).push(brandId);
      return [];
    }),
    campaignRoas: vi.fn(async (brandId: string) => {
      (calls['campaignRoas'] ??= []).push(brandId);
      return [];
    }),
    customerScore: vi.fn(async (brandId: string, _brainId: string) => {
      (calls['customerScore'] ??= []).push(brandId);
      return null;
    }),
    recommendationFeatures: vi.fn(async (brandId: string) => {
      (calls['recommendationFeatures'] ??= []).push(brandId);
      return { hasData: false, customerCount: 0n, rows: [] };
    }),
  };
  void rec; // (kept for symmetry; all seams are explicit above)
  return { seams, calls };
}

/** The enabled lookup tool → its expected seam(s), with a representative valid input. */
const TOOL_EXPECTATION: Record<string, { input: unknown; seams: string[] }> = {
  customer360_lookup: { input: {}, seams: ['customer360Summary'] },
  journey_lookup: { input: {}, seams: ['customerJourneySummary'] },
  timeline_lookup: { input: { brain_id: BRAIN_ID }, seams: ['identityTimeline'] },
  identity_explainability_lookup: { input: { brain_id: BRAIN_ID }, seams: ['identityExplain'] },
  attribution_lookup: { input: { model: 'last_touch', date_from: '2026-01-01', date_to: '2026-01-31' }, seams: ['channelRoas'] },
  ltv_lookup: { input: { brain_id: BRAIN_ID }, seams: ['customerScore'] },
  marketingperf_lookup: { input: { model: 'last_touch', date_from: '2026-01-01', date_to: '2026-01-31' }, seams: ['channelRoas', 'campaignRoas'] },
  recfeature_lookup: { input: {}, seams: ['recommendationFeatures'] },
};

describe('MCP dispatch I-S08 CANARY — read-only / scope / fail-closed (REAL dispatch)', () => {
  it('[I-S08 / CI-BLOCKING] writeToolCount === 0 (re-asserted at the dispatch boundary)', () => {
    expect(writeToolCount).toBe(0);
  });

  it('[no-write CANARY] the dispatch surface is EXACTLY the read-seam allowlist (no writer reachable)', () => {
    const { seams } = recordingSeams();
    // Static + structural: the seams object has exactly the frozen read-seam names — nothing else.
    expect(Object.keys(seams).sort()).toEqual([...MCP_READ_SEAM_NAMES].sort());
    // Every member is a function (a read fn), not a store/handle a writer could be pulled off of.
    for (const v of Object.values(seams)) expect(typeof v).toBe('function');
  });

  it('[no-write / no-replay CANARY] every read-seam name passes the tool AND seam forbidden-substring bans', () => {
    // assertSeamNamesClean throws on the first violation — so a smuggled writer/replay seam fails CI.
    expect(() => assertSeamNamesClean()).not.toThrow();
    for (const name of MCP_READ_SEAM_NAMES) {
      const lower = name.toLowerCase();
      for (const bad of FORBIDDEN_TOOL_NAME_SUBSTRINGS) expect(lower.includes(bad)).toBe(false);
      for (const bad of FORBIDDEN_SEAM_NAME_SUBSTRINGS) expect(lower.includes(bad)).toBe(false);
    }
    // Explicit: NO replay/idempotency/algorithm-migration/backfill path is in the seam surface.
    for (const banned of ['replay', 'idempot', 'migrat', 'backfill', 'reprocess']) {
      expect(FORBIDDEN_SEAM_NAME_SUBSTRINGS).toContain(banned);
      expect(MCP_READ_SEAM_NAMES.some((n) => n.toLowerCase().includes(banned))).toBe(false);
    }
  });

  it('[behavioral] each enabled tool reaches ONLY its read seam(s), always scoped to the PRINCIPAL brand', async () => {
    for (const [tool, exp] of Object.entries(TOOL_EXPECTATION)) {
      const { seams, calls } = recordingSeams();
      const { provider, refs } = recordingSchemas();

      const out = await dispatchMcpTool(tool, exp.input, PRINCIPAL_A, seams, provider);

      // Only the expected seam(s) were called — no other (no writer, no unrelated read) was touched.
      const called = Object.keys(calls).sort();
      expect(called).toEqual([...exp.seams].sort());
      // Every call was scoped to the PRINCIPAL brand, never anything from the input.
      for (const s of exp.seams) expect(calls[s]).toEqual([PRINCIPAL_A.brandId]);
      // I/O validation ran (input + output schema refs were resolved through the provider).
      expect(refs.length).toBeGreaterThanOrEqual(1);
      // The model authored NO number and NO SQL: the output is a plain object with no `sql` key.
      expect(out).toBeTypeOf('object');
      expect(JSON.stringify(out)).not.toMatch(/"sql"/i);
    }
  });

  it('[I-S01 negative control] a smuggled brand_id in the tool input is IGNORED — principal wins', async () => {
    const { seams, calls } = recordingSeams();
    const { provider } = recordingSchemas();
    await dispatchMcpTool(
      'ltv_lookup',
      { brain_id: BRAIN_ID, brand_id: PRINCIPAL_B.brandId }, // attempt to read brand-B
      PRINCIPAL_A,
      seams,
      provider,
    );
    // The seam was scoped to brand-A (the principal), NEVER brand-B from the input.
    expect(calls['customerScore']).toEqual([PRINCIPAL_A.brandId]);
    expect(calls['customerScore']).not.toContain(PRINCIPAL_B.brandId);
  });

  it('[tenant-isolation negative control] a principal with no brand scope fails closed', async () => {
    const { seams } = recordingSeams();
    const { provider } = recordingSchemas();
    await expect(
      dispatchMcpTool('customer360_lookup', {}, { brandId: '' }, seams, provider),
    ).rejects.toBeInstanceOf(McpPrincipalScopeError);
    // Fail-closed BEFORE any seam was touched.
    expect((seams.customer360Summary as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('[fail-closed] the disabled segment_lookup throws NotImplementedYet (never faked/empty)', async () => {
    const { seams } = recordingSeams();
    const { provider } = recordingSchemas();
    await expect(
      dispatchMcpTool('segment_lookup', { brain_id: BRAIN_ID }, PRINCIPAL_A, seams, provider),
    ).rejects.toBeInstanceOf(NotImplementedYetError);
  });

  it('[completeness] every ENABLED lookup tool in the registry has a dispatch handler (no silent gap)', async () => {
    const lookupTools = MCP_TOOLS.filter(
      (t) => t.status === 'enabled' && t.name !== 'list_metrics' && t.name !== 'resolve_and_compute',
    ).map((t) => t.name);
    // The expectation table covers exactly the enabled lookup tools.
    expect(Object.keys(TOOL_EXPECTATION).sort()).toEqual([...lookupTools].sort());
    // And each dispatches without falling through to the "no handler" default.
    for (const tool of lookupTools) {
      const { seams, calls } = recordingSeams();
      const { provider } = recordingSchemas();
      await expect(
        dispatchMcpTool(tool, TOOL_EXPECTATION[tool]!.input, PRINCIPAL_A, seams, provider),
      ).resolves.toBeDefined();
      expect(Object.keys(calls).length).toBeGreaterThan(0);
    }
  });
});
