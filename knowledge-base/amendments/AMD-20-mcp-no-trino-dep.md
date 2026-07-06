<!-- SPEC: 0.4 -->
# AMD-20 — MCP "no Trino client dependency" contract (CONTRACT-F / §F)

**Status:** FILED · RESOLVED — R1 adopted now, R2 deferred to post-D.2 (BINDING)
**Date:** 2026-07-06
**Blocks:** CONTRACT-F, MCP dependency-graph test

## Conflicting spec text
> §F "Tool registry = MCP: every copilot tool over the semantic layer + Journey/Feature APIs. Tools NEVER query Trino/raw tables — **contract test: MCP server package has no Trino client dependency**."

## Ground truth (delta-plan evidence)
The literal test is **false-by-construction**: ai-gateway-client's sole dependency IS metric-engine, which contains trino-adapter — so the MCP package transitively depends on a Trino client and always will under the sanctioned architecture. The REAL tested invariant already holds: 11 read-only tools (mcp-tools.ts:76–191), brand from McpPrincipal, zod I/O, CI `writeToolCount===0`, **no SQL emission** — Trino is reached only transitively through certified metric-engine read seams.

## Candidate resolutions
### R1 — Restate the contract as seam-only + dependency-graph test (adopted now)
CONTRACT-F's invariant becomes: "MCP tools emit no SQL and reach Trino ONLY through certified metric-engine read seams" — enforced by a dependency-graph test (allowed import path: mcp → ai-gateway-client → metric-engine certified seams; anything else fails).
- Trade-offs: subtler invariant than a package-dependency ban; requires a real graph test, not a package.json grep.

### R2 — Re-home MCP over compiled semantic views (post-D.2)
Once the D.2 metric registry compiles views + JSON catalog, MCP tools can be regenerated over the semantic layer, at which point the literal no-Trino-dependency property may become achievable.
- Trade-offs: impossible before Wave D; scheduling it now would block CONTRACT-F.

## RECOMMENDED resolution (BINDING)
**R1 now, R2 later** — restate the contract truthfully today (invariant-preserving: the enforced property is the one that actually protects tenancy/certification), and revisit the literal dependency ban after D.2 ships.
