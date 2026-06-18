# Requirement: Shared web↔core BFF read contracts (kill the BigInt(undefined) drift class)

| Field | Value |
|-------|-------|
| **req_id** | `feat-shared-bff-read-contracts` |
| **Title** | Make `@brain/contracts` the single source of truth for the drift-prone analytics/dashboard/ai READ DTOs (Zod), have core BFF routes validate against them, have web derive its types from them (z.infer) + parse responses at the boundary — so a core↔web field mismatch fails LOUD + CLEAR at the seam instead of crashing deep as `BigInt(undefined)` |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-18 |
| **Lane** | standard→high_stakes (touches money DTO shapes + the BFF read boundary across many surfaces; no auth/PII/multi-tenancy change) |
| **Why** | Every phase this session had a contract-drift near-miss: web `lib/api/types.ts` is hand-maintained separately from core's actual BFF return types, so a renamed/missing field (e.g. `cells`→`grades`, `attributed_minor`→`attributed_gmv_minor`, `order_id`→`brain_anon_id`, phantom `currency_code`, `real_touch_count`) slips past tsc + `next build` and crashes at runtime as `Cannot convert undefined to a BigInt`. The audit fixed the *instances*; this fixes the *class*. |

## Current state (verified)
- `@brain/contracts` ALREADY is "Zod-as-source-of-truth for API request/response schemas" with `src/api/*.api.v1.ts` covering auth/brand/connector/member/pixel/workspace (the WRITE + simple surfaces). It is NOT applied to the **analytics / dashboard / attribution / journey / data-quality / ask** READ surfaces — exactly the money/bigint ones that crash.
- `apps/web/lib/api/types.ts` (1309 lines) hand-mirrors those read DTOs — the drift source.
- `apps/web/lib/api/client.ts` `bffFetch<T>` does `return response.json() as Promise<T>` (line 214) — a BLIND cast, NO runtime validation, so drift is invisible until a component does `BigInt(x)` on a missing field.
- Core defines the real DTOs in metric-engine / the analytics use-cases / `ai/internal/ask-brain.ts` (e.g. `RevenueMetricsResult`, `AttributionByChannelResult`, `JourneyTimelineResult`, `DataQualitySummaryResult`, `AskBrainResult`).

## Deliverables (smallest valuable slice — cover the drift-prone money surfaces, establish the mechanism)
1. **Shared Zod response schemas in `@brain/contracts/src/api`** (the single source of truth) for the highest-risk READ endpoints — at minimum: `analytics.api.v1.ts` (revenue-metrics, kpi-summary, attribution by-channel/reconciliation/channel-roas, journey first-touch-mix/timeline/stitch-rate, order-status-mix), `dataquality.api.v1.ts` (data-quality summary), `ask.api.v1.ts` (ask-brain), and the `dashboard` summaries. **Money = bigint-as-string (`/^-?\d+$/`) + `currency_code`; NO float; honest-empty discriminated unions (`{state:'no_data'} | {state:'has_data', …}` / `{kind:…}`) preserved exactly.** Mirror the existing `api/*.v1.ts` style; export both the schema and the `z.infer` type.
2. **Core is the enforced source** — the core BFF route (or the use-case return) for each covered endpoint is typed by / validated against its schema, so core literally cannot ship a shape the contract forbids. Prefer: assert the route's response satisfies the schema type at compile time (a `satisfies` / typed handler), and (where cheap) `schema.parse()` the payload in dev/test. The schema must MATCH core's CURRENT real output (read the actual use-case return — do not invent fields).
3. **Web derives from the contract, not by hand** — replace the hand-written definitions in `apps/web/lib/api/types.ts` for the covered surfaces with re-exports of the `z.infer` types from `@brain/contracts`. **Add runtime validation to the web boundary**: `bffFetch` (or the per-endpoint client fn) `schema.parse()`s the response so a drift throws a CLEAR error naming the offending field at the seam — NEVER a deep `BigInt(undefined)`. Un-migrated endpoints keep their current hand-types (incremental).
4. **A CI-enforceable alignment guard** — a test that core's real DTO ⊆ the schema (round-trips a representative core payload through `schema.parse()` and through the web consumer) so a future field rename FAILS the build at the contract, not in the browser. At least one NEGATIVE test: a drifted payload (renamed/removed money field) is REJECTED by `schema.parse` with a field-named error.
5. **Stakeholder-visible outcome (the "UI ships"):** every existing analytics/dashboard/ask page still renders identically (same data, same money formatting) AND a deliberately-drifted BFF response now surfaces a clear, contained boundary error instead of a white-screen `BigInt(undefined)` crash — demonstrated.

## Constraints
- **No user-facing behavior change** — identical data, identical money formatting (minor-unit bigint strings via `formatMoneyDisplay`, never `/100`, never float). This is a safety refactor, not a redesign.
- The schema is the SOLE source of truth: core and web both DERIVE from it (`z.infer`); neither hand-redeclares a covered DTO. `@brain/contracts` CODEOWNERS / I-E01 (no contract change without codegen) honored — note any codegen step.
- Preserve the honest-empty discriminated unions EXACTLY (no widening `{state}` to optional fields). Preserve `null`-able fields (e.g. `currency_code: string | null` where core sends null).
- Migrate ONLY the listed drift-prone surfaces in this slice; do NOT churn the already-stable auth/brand/connector contracts. Leave un-migrated web types untouched (incremental, low-risk).
- tsc green across @brain/contracts + apps/core + apps/web; web `next build` green; no new runtime dep beyond zod (already used).

## Non-goals (follow-on)
- Migrating EVERY analytics endpoint (cover the money/bigint drift-prone ones now; the rest follow the established pattern incrementally).
- OpenAPI generation from the schemas (the package mentions it; not required here).
- Changing the BFF envelope (`{request_id, data}`) or any endpoint's behavior/shape — only formalizing the existing shape as a contract.
- Request-body contracts for these reads (they're GETs / simple POSTs); focus on RESPONSE drift.

## Build tracks (the architect will bind)
@backend-developer (the Zod response schemas in `@brain/contracts/api` matching core's ACTUAL current DTOs + wiring core BFF routes/use-cases to be typed-by/validated-against them + the alignment guard test incl. the negative drift test) ∥ @frontend-web-developer (replace the hand-written web `types.ts` defs for the covered surfaces with `z.infer` re-exports from `@brain/contracts` + add the runtime `schema.parse()` at the `bffFetch`/client boundary so drift throws a clear field-named error, not `BigInt(undefined)`; prove every covered page still renders + a drifted response is contained). Verify: schema == core's real output for each covered endpoint; web types are now derived (no hand red=declaration); a drifted money field is REJECTED at the seam with a clear error; all covered pages render unchanged; tsc + next build green across the 3 packages.
