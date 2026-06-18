# 02 — Architecture Plan: Shared web↔core BFF read contracts (kill the `BigInt(undefined)` drift class)

**req_id:** `feat-shared-bff-read-contracts` · **Stage:** 2 (Architect, binding) · **Lane:** standard→high_stakes
**Paradigm:** deterministic (Zod schema validation — NO model/statistical call; pure type-system + runtime `parse`). Justification: this is a contract-drift safety refactor; the cheapest sufficient effort is a declarative schema (single source of truth) + a `parse()` at the seam. Any ML/model here would be absurd.

---

## 1. The drift class, the seam, the fix (grounded)

- **Source of truth today:** `@brain/contracts/src/api/*.api.v1.ts` already is Zod-as-truth for the WRITE/simple surfaces (auth/brand/connector/member/pixel/workspace), each exporting `XSchema` + `type X = z.infer<typeof XSchema>` (see `packages/contracts/src/api/pixel.api.v1.ts:17-62` — the exact style to mirror).
- **The hole:** `apps/web/lib/api/client.ts:214` — `return response.json() as Promise<T>` is a BLIND cast. No runtime validation. Drift is invisible until a component does `BigInt(missingField)` → `Cannot convert undefined to a BigInt`.
- **The drift source:** `apps/web/lib/api/types.ts` (1309 lines) HAND-mirrors core's read DTOs. Field renames (`cells`→`grades`, `attributed_minor`→`attributed_gmv_minor`, `order_id`→`brain_anon_id`, phantom `currency_code`, `real_touch_count`) pass `tsc` + `next build` because both sides are hand-written and independently wrong-able.
- **Envelope (unchanged, do NOT touch):** every covered route replies `reply.send({ request_id, data: <Result> })` (e.g. `bff.routes.ts:1193-1198`). Web already models this as `BffEnvelope<T>` and unwraps `.data` at each call site (`client.ts:944,956,…`). **We validate the inner `data`, not the envelope.**

**The fix (mechanism):** Zod schema in `@brain/contracts` is the SOLE truth. Core asserts its route payload `satisfies z.infer<Schema>` at compile time (+ dev/test `schema.parse`). Web `import { z.infer types }` for the covered DTOs AND `schema.parse(data)` the unwrapped envelope body at the client method boundary → drift throws a CLEAR field-named ZodError at the seam, never a deep `BigInt(undefined)`.

---

## 2. Covered READ endpoints THIS slice + the core source-of-truth type to mirror EXACTLY

> RULE: the schema MUST mirror core's CURRENT real output — fields verified by reading the actual use-case return types below. DO NOT invent or add fields. Preserve discriminated unions and `null`-ables exactly.

| # | Endpoint (core route) | Core source-of-truth type (`file`) | Money / discriminant shape (verified) |
|---|---|---|---|
| 1 | `GET /v1/dashboard/realized-revenue` | `RevenueSnapshot` — `apps/core/src/modules/analytics/internal/domain/metrics/revenue-snapshot.ts:35-47` | `{state:'no_data', as_of, realized:null, provisional:null}` \| `{state:'has_data', as_of, realized:MoneyRecord, provisional:MoneyRecord}`. `MoneyRecord = Record<string, string>` (per-currency bigint-minor strings). |
| 2 | `GET /v1/analytics/kpi-summary` | `KpiSummaryResult` — `get-kpi-summary.ts:11-22` | `KpiSummaryDto = {currency_code:string, realized_minor, provisional_minor, order_count, aov_minor, rto_rate_pct}` (all bigint-string except `rto_rate_pct` numeric-string). Union `{state:'no_data', as_of}` \| `{state:'has_data', as_of, kpis: KpiSummaryDto[]}`. |
| 3 | `GET /v1/analytics/attribution/by-channel` | `AttributionByChannelResult` — `get-attribution-by-channel.ts:25-39` | `{state:'no_data', from, to, model}` \| `{state:'has_data', from, to, model, currency_code: string\|null, attributed_gmv_minor, realized_gmv_minor, unattributed_minor, reconciliation_rate_pct: string\|null, by_channel: ChannelContributionDto[], data_source:'synthetic'\|'live'}`. `ChannelContributionDto = {channel, currency_code, contribution_minor}`. |
| 4 | `GET /v1/analytics/attribution/reconciliation` | `AttributionReconciliationResultDto` — `get-attribution-reconciliation.ts:16-29` | Same has_data money block as #3 (currency_code `string\|null`, three `_minor`, `reconciliation_rate_pct string\|null`); no `by_channel`. Union on `state`. |
| 5 | `GET /v1/analytics/attribution/channel-roas` | `ChannelRoasResult` — `get-channel-roas.ts:24-34` | `ChannelRoasDto = {channel, currency_code, attributed_minor, spend_minor, roas_ratio: string\|null}`. Union `{state:'no_data', from,to,model}` \| `{state:'has_data', from,to,model, rows: ChannelRoasDto[], data_source}`. |
| 6 | `GET /v1/analytics/journey/first-touch-mix` | `JourneyFirstTouchMixResult` — `get-journey-first-touch-mix.ts` | `FirstTouchMixRowDto = {channel: JourneyChannel, count: string, share_pct: string\|null}`. Union `{state:'no_data'}` \| `{state:'has_data', from, to, total: string, by_channel[], data_source}`. NO money column. |
| 7 | `GET /v1/analytics/journey/timeline` | `JourneyTimelineResult` — `get-journey-timeline.ts` | `{state:'no_data'}` \| `{state:'has_data', brain_anon_id: string, stitched: boolean, touches: TimelineTouchDto[], data_source}`. `TimelineTouchDto` = the 17-field touch row (all utm/click ids `string\|null`). **`brain_anon_id` NOT `order_id`** — the historical drift. NO money. |
| 8 | `GET /v1/analytics/journey/stitch-rate` | `JourneyStitchRateResult` — `get-journey-stitch-rate.ts:21-30` | `{state:'no_data'}` \| `{state:'has_data', from, to, total: string, stitched: string, hit_pct: string\|null}`. NO money. |
| 9 | `GET /v1/analytics/order-status-mix` | `OrderStatusMixResult` — `get-order-status-mix.ts:32-49` | `OrderStatusMixRowDto = {lifecycle_state: LifecycleState, count: string, share_pct: string\|null, value_minor: string}`. Union `{state:'no_data'}` \| `{state:'has_data', from, to, currency_code: string, total, terminal_count, by_state[]}`. |
| 10 | `GET /v1/data-quality/summary` | `DataQualitySummaryResult` — `get-data-quality-summary.ts:127-148` | `{state:'no_data'}` \| `{state:'has_data', grades: DqGradeRow[], freshnessSla, coverage:{graded,expected}, costConfidence, attributionConfidence, effectiveConfidence, tier, gate}`. `DqGradeRow = {category, target, grade, passing, observed, threshold, checkedAt}`. **Field is `grades` NOT `cells`. NO `_minor` field — DQ carries grades, not money (see types.ts:519 sentinel).** |
| 11 | `POST /v1/ask` | `AskBrainResult` — `apps/core/src/modules/ai/internal/ask-brain.ts:60-72` | `{kind:'answer', binding:AskBrainBinding, number:ComputedNumber, confidence_grade, trust_tier, provenance_id}` \| `{kind:'refusal', reason: string}`. `ComputedNumber = {figure_kind:'money'\|'none', money: MoneyRecord\|null, no_data: boolean}`, `MoneyRecord = Record<string, string>`. **Discriminant is `kind`, NOT `state`.** `binding = {metric_id, metric_version, params, snapshot_id}`. |

**Dashboard note:** `dashboard/brand-summary`, `connection-status`, `data-status`, `onboarding-progress` carry NO money (org/brand metadata + connector enums) → NOT in this slice (out of the money/bigint drift class). The money-drift-prone dashboard surface is `dashboard/realized-revenue` = #1 above. The other dashboard summaries stay hand-typed (incremental — Non-goal §32).

**Supporting enums the schemas reference (mirror as `z.enum`/`z.string()` from the real core types, do NOT redeclare loosely):** `AttributionModelId`, `JourneyChannel`, `LifecycleState`, `DqCategory` (`freshness|completeness|schema_validity|reconciliation`), `DqLetterGrade` (`A+|A|B|C|D`), `FreshnessSlaStatus` (`green|at_risk|breached`), `TrustTier`, `ConfidenceGrade`, `GateDecision`, `figure_kind` (`money|none`), `data_source` (`synthetic|live`). Builder reads each from its core definition and mirrors the exact literal set.

---

## 3. The money + honest-empty invariants (NON-NEGOTIABLE, baked into every schema)

- **`Money`** = bigint-as-string: `const MinorUnits = z.string().regex(/^-?\d+$/, 'minor-units must be an integer string')`. Negative allowed (clawbacks are honest negatives — `cod_net_minor` may be negative). NEVER `z.number()`, NEVER float, NEVER `/100`.
- **`MoneyRecord`** = `z.record(z.string(), MinorUnits)` (per-currency map for #1, #11).
- **`currency_code`**: where core sends `string|null` (#3, #4) → `z.string().nullable()`. Where core sends non-null `string` (#2, #5, #9) → `z.string()`. Mirror EXACTLY per the table — do NOT add a phantom `currency_code` (the historical drift), do NOT widen non-null to nullable.
- **Honest-empty discriminated unions** = `z.discriminatedUnion('state', [...])` for #1-#10, `z.discriminatedUnion('kind', [...])` for #11. **Do NOT widen** — `no_data` must NOT carry has_data fields as optional. Preserve exactly.
- **Ratio/pct fields** that core sends nullable (`reconciliation_rate_pct`, `roas_ratio`, `share_pct`, `hit_pct`) → `z.string().nullable()`. They are exact-decimal strings, NOT numbers.
- **Define `MinorUnits` + `MoneyRecord` ONCE** in a shared `packages/contracts/src/api/_money.ts` (or a `money` export in `analytics.api.v1.ts`) and import — Single-Primitive: one money primitive across all schema files.

---

## 4. New `@brain/contracts` files + export shape

Mirror the `pixel.api.v1.ts` style: each file exports `XResponseSchema` (Zod) + `export type XResponse = z.infer<typeof XResponseSchema>`. All re-exported from `src/index.ts`.

| New file | Schemas (export `Schema` + `z.infer` type each) |
|---|---|
| `packages/contracts/src/api/_money.ts` | `MinorUnitsSchema`, `MoneyRecordSchema` (the single money primitive; +shared enum mirrors if cross-file) |
| `packages/contracts/src/api/analytics.api.v1.ts` | `RevenueSnapshotSchema` (#1), `KpiSummarySchema` + `KpiSummaryDtoSchema` (#2), `AttributionByChannelSchema` + `ChannelContributionDtoSchema` (#3), `AttributionReconciliationSchema` (#4), `ChannelRoasSchema` + `ChannelRoasDtoSchema` (#5), `JourneyFirstTouchMixSchema` + `FirstTouchMixRowDtoSchema` (#6), `JourneyTimelineSchema` + `TimelineTouchDtoSchema` (#7), `JourneyStitchRateSchema` (#8), `OrderStatusMixSchema` + `OrderStatusMixRowDtoSchema` (#9) |
| `packages/contracts/src/api/dataquality.api.v1.ts` | `DataQualitySummarySchema` + `DqGradeRowSchema` + `DqCoverageSchema` (#10) |
| `packages/contracts/src/api/ask.api.v1.ts` | `AskBrainResultSchema` + `ComputedNumberSchema` + `AskBrainBindingSchema` (#11) |

`src/index.ts` gets a new `// ── BFF Read DTOs (analytics/dataquality/ask) ──` block exporting every `Schema` const + every `z.infer` type (same dual-export pattern as the existing auth/pixel blocks).

**I-E01 / codegen:** these are NEW schema files, not changes to existing committed contracts → run `pnpm --filter @brain/contracts gen:contracts` (`scripts/codegen.ts`) after authoring; commit any generated artifacts in the same commit. No existing auth/brand/connector contract is touched.

---

## 5. Core becomes the ENFORCED source (no payload change)

For each covered route in `apps/core/src/modules/frontend-api/internal/bff.routes.ts`:

1. **Compile-time `satisfies`:** assert the use-case return type is assignable to the schema's `z.infer`. The cleanest, zero-payload-change binding is a typed identity at the route, e.g.:
   ```ts
   import { RevenueSnapshotSchema } from '@brain/contracts';
   const data = await getRevenueMetrics(...) satisfies z.infer<typeof RevenueSnapshotSchema>;
   reply.send({ request_id: requestId, data });
   ```
   This makes core literally fail `tsc` if its DTO drifts from the contract. (If a direct `satisfies` on the call is awkward, use a typed local: `const data: z.infer<typeof RevenueSnapshotSchema> = await getRevenueMetrics(...)`.)
2. **Dev/test `schema.parse`:** in the alignment guard test (§7) — NOT in the hot route path (avoid runtime cost in prod core). Core's enforcement is compile-time `satisfies` + the round-trip test.
3. **NO payload change:** envelope `{request_id, data}` untouched; field names/values untouched. We only ADD a type assertion + index import.

**Critical builder check:** if `satisfies` FAILS to compile, the schema was authored wrong (invented/missing field) — FIX THE SCHEMA to match core's real output, do NOT change core's payload. Core output is ground truth; the schema mirrors it.

---

## 6. Web derives from the contract + parses at the boundary

**6a. `types.ts` re-exports (replace hand-decls for covered surfaces ONLY):**
Replace the hand-written `interface`/`type` blocks in `apps/web/lib/api/types.ts` for the 11 covered DTOs with re-exports:
```ts
export type {
  RevenueSnapshot as RawRealizedRevenue,         // keep existing web alias names
  KpiSummary as AnalyticsKpiSummaryResponse,
  AttributionByChannel as AnalyticsAttributionByChannelResponse,
  // …reconciliation, channel-roas, journey ×3, order-status-mix, dq, ask
} from '@brain/contracts';
```
Map to the EXISTING web type aliases (`AnalyticsKpiSummaryResponse`, `AnalyticsAttributionByChannelResponse`, `DataQualitySummaryResponse`, etc.) via `export { X as Y }` so consuming components compile UNCHANGED. **Leave every un-migrated type in `types.ts` exactly as-is** (incremental).

**6b. The runtime parse boundary — at the client method, NOT inside `bffFetch`:**
`bffFetch<T>` stays a blind generic (un-migrated endpoints keep working untouched — zero risk). Add a tiny helper in `client.ts`:
```ts
function parseData<S extends z.ZodTypeAny>(schema: S, env: BffEnvelope<unknown>): z.infer<S> {
  const r = schema.safeParse(env.data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new BffApiError(
      `BFF contract drift at ${issue?.path.join('.') || '<root>'}: ${issue?.message}`,
      200, env.request_id, 'CONTRACT_DRIFT',
    );
  }
  return r.data;
}
```
Then each MIGRATED method changes its tail from `return data;` to `return parseData(RevenueSnapshotSchema, env);`. Example (`client.ts:956` getKpiSummary):
```ts
const env = await bffFetch<BffEnvelope<unknown>>(`/v1/analytics/kpi-summary${qs}`);
return parseData(KpiSummarySchema, env);
```
Apply to the 11 methods: `analyticsApi.getKpiSummary`, `.getAttributionByChannel`, `.getAttributionReconciliation`, `.getChannelRoas`, `.getJourneyFirstTouchMix`, `.getJourneyTimeline`, `.getJourneyStitchRate`, `.getOrderStatusMix` · `dashboardApi.getRealizedRevenue` · `dataQualityApi.getSummary` · `askApi` (the ask method). **Un-migrated methods keep `return data;` — untouched.** This throws a CLEAR field-named `BffApiError(code:'CONTRACT_DRIFT')` at the seam instead of `BigInt(undefined)` deep in a component.

**6c. No behavior change:** `parseData` returns the SAME object on success → identical data → identical `formatMoneyDisplay(minorString, currency_code)` rendering. Money formatting path unchanged (never `/100`).

---

## 7. Tests — alignment guard + NEGATIVE drift rejection (CI-enforceable)

Owner: @backend-developer in `packages/contracts` (vitest — `test:contract` script already exists).

1. **Alignment guard (positive):** `packages/contracts/src/api/analytics.api.v1.contract.test.ts` (+ dataquality, ask). For each of the 11 DTOs: build a representative core-shaped payload (both `no_data`/`refusal` AND `has_data`/`answer` arms) and assert `Schema.parse(payload)` succeeds AND round-trips (`parse` output deep-equals input). The `has_data` fixtures use real-shaped money strings (`'12345'`, negative `'-500'`, `MoneyRecord {INR:'12345'}`).
2. **Compile-time core alignment:** the `satisfies` in §5 IS the core↔schema guard (fails `tsc` on drift). Optionally a core-side test that imports a real use-case return-type fixture and `schema.parse`es it.
3. **NEGATIVE drift rejection (≥1 per drift archetype):** assert `Schema.safeParse(driftedPayload).success === false` AND the error path names the offending field, for:
   - renamed money field: `attributed_minor` instead of `attributed_gmv_minor` (#3) → rejected.
   - removed money field: `has_data` missing `realized_minor` (#2) → rejected, path `kpis.0.realized_minor`.
   - wrong type: `realized_minor: 123` (number not string) → rejected by `MinorUnits` regex.
   - phantom field tolerance: strict schemas reject unknown keys OR (decision) use default Zod strip — **decision: do NOT `.strict()`** (core may add fields without breaking web reads); the guard is on MISSING/RENAMED/WRONG-TYPED required fields, which is the actual crash class.
   - discriminant drift: `cells` instead of `grades` (#10) / `order_id` instead of `brain_anon_id` (#7) → rejected.

---

## 8. Track decomposition + exact file ownership

### Track A — @backend-developer (contracts + core enforcement + tests)
**Owns:**
- CREATE `packages/contracts/src/api/_money.ts`
- CREATE `packages/contracts/src/api/analytics.api.v1.ts`
- CREATE `packages/contracts/src/api/dataquality.api.v1.ts`
- CREATE `packages/contracts/src/api/ask.api.v1.ts`
- EDIT `packages/contracts/src/index.ts` (new export block)
- CREATE `packages/contracts/src/api/analytics.api.v1.contract.test.ts` (+ dataquality + ask, or one combined) — positive + negative
- EDIT `apps/core/src/modules/frontend-api/internal/bff.routes.ts` (11 routes: add `satisfies z.infer<Schema>` + import; NO payload change) — lines near `1193`(rev), `1380`(kpi), `1756`(dq), `1944`(order-status), `2012`(first-touch), `2074`(stitch), `2141`(timeline), `2199`(by-channel), `2242`(recon), `2285`(roas), `1267`(ask)
- Run `pnpm --filter @brain/contracts gen:contracts` (I-E01) + commit artifacts.

**Acceptance contract (REQUIRED pass-1 — folds all must-fix):**
- [ ] Each schema mirrors the core type in §2 EXACTLY — verified by reading the cited `file:line`; NO invented field; `currency_code` nullability per-endpoint correct; discriminant key correct (`state` vs `kind`).
- [ ] `MinorUnits` regex `^-?\d+$`; money = string only; `MoneyRecord = z.record(string, MinorUnits)`; NO `z.number()` on money; NO float.
- [ ] `z.discriminatedUnion` preserves honest-empty arms (no widening; `no_data` carries no has_data fields).
- [ ] DQ schema has field `grades` (not `cells`) and NO `_minor` field.
- [ ] Core `satisfies` compiles for all 11 (if not, FIX SCHEMA to match core, never change core payload).
- [ ] Positive round-trip test + ≥5 negative drift tests (rename/remove/wrong-type/discriminant) all green; negative tests assert field-named error path.
- [ ] `gen:contracts` run + artifacts committed (I-E01).
- [ ] `pnpm --filter @brain/contracts typecheck` + `test:contract` green; `apps/core` `tsc` green. Report exact PASS/FAIL counts.

### Track B — @frontend-web-developer (web derive + parse boundary + proof)
**Owns:**
- EDIT `apps/web/lib/api/types.ts` — replace the 11 covered hand-decls with `export { … as <existingAlias> } from '@brain/contracts'`; leave all un-migrated types untouched.
- EDIT `apps/web/lib/api/client.ts` — add `parseData()` helper (§6b); migrate the 11 listed methods to `parseData(Schema, env)`; un-migrated methods untouched; add `'CONTRACT_DRIFT'` handling (reuse existing `BffApiError`).
- PROOF (stakeholder-visible, §5 of req): demonstrate (a) every covered page (revenue/kpi dashboard, attribution, journey, order-status, data-quality, ask) renders IDENTICALLY (same data, same `formatMoneyDisplay`), and (b) a deliberately-drifted BFF response (e.g. mock `attributed_gmv_minor`→`attributed_minor`) now surfaces the contained `BffApiError` "contract drift at attributed_gmv_minor" instead of a white-screen `BigInt(undefined)`. Capture the before/after.

**Acceptance contract (REQUIRED pass-1):**
- [ ] Covered web types are now `z.infer` re-exports — NO hand-redeclaration of any covered DTO remains; existing alias names preserved so components compile unchanged.
- [ ] `parseData` at the method boundary for all 11; `bffFetch<T>` itself UNCHANGED (un-migrated endpoints keep blind cast — incremental).
- [ ] Drift throws a CLEAR field-named `BffApiError(code:'CONTRACT_DRIFT')` at the seam; NEVER reaches a `BigInt()` call.
- [ ] No money-format change: `formatMoneyDisplay(minor, currency)` path identical; never `/100`/`parseFloat`.
- [ ] `apps/web` `tsc` green + `next build` green. Drifted-response containment demonstrated; covered pages render unchanged. Report exact PASS/FAIL.

**Sequencing:** Track A FIRST (publishes schemas + `z.infer` exports), then Track B (depends on `@brain/contracts` exports). Single-builder serial is fine and lower-risk here; A → B.

---

## 9. Alternatives considered + rejection

- **(Rejected) Validate inside `bffFetch<T>` generically (one parse for all):** would force EVERY endpoint (incl. un-migrated, stable auth/brand) through a schema lookup → churns stable surfaces, breaks the "incremental, leave un-migrated untouched" constraint, and `bffFetch` has no schema to pick. Per-method `parseData` is surgical and incremental. **Chosen: per-method.**
- **(Rejected) Codegen TS types from core into web (no Zod runtime):** kills the runtime parse → drift still crashes at runtime, just with a stale type. Fails the core requirement (loud failure at the seam).
- **(Rejected) `.strict()` schemas rejecting unknown keys:** core adding a benign new field would break every web read. We guard MISSING/RENAMED/WRONG-TYPED required fields (the real crash class), not additive fields.

## 10. Reversibility

Fully reversible per-endpoint: revert a method to `return data;` and the type to its hand-decl. No DB migration, no payload change, no new runtime dep (zod already in `@brain/contracts` `^3.25.76` and transitively in web). New schema files are additive. Risk is contained to the 11 migrated method tails.

## 11. Cost

Zero token/model spend (deterministic). Runtime: one `safeParse` per covered BFF response on the web client (negligible, ~µs for these small objects). No new infra, no new dep.

---

## In-lane DoD
- [x] All sections filled; paradigm declared+justified (deterministic); Single-Primitive (one `MinorUnits`/`MoneyRecord` primitive; extend existing `api/*.api.v1.ts` pattern — no new mechanism).
- [x] Tenant-isolation unchanged (brandId still from session in core; no auth/PII/RLS change — req §9); observability = clear field-named seam error; test strategy incl. positive guard + negative drift + real `next build`.
- [x] ≥1 alternative + rejection (§9); reversible (§10); cost (§11).
- [x] Plan calibrated (high-stakes money surface → full binding, no over-engineering: 11 endpoints only, no envelope/behavior change, incremental).
- [x] Every persona/req must-fix folded into acceptance contracts (money-string regex, nullable currency, honest-empty unions, `grades` not `cells`, `brain_anon_id` not `order_id`, no `BigInt(undefined)`, tsc+next build green).
- [x] No pinned version invented (zod `^3.25.76` is the real existing dep).
- [x] No service created → no deploy-pipeline track required (contracts/web/core are existing packages; pure code change).
```
