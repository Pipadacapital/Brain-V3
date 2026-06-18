# 11 — Final Review (Stage 6): feat-silver-tier-order-state

| Field | Value |
|---|---|
| req_id | `feat-silver-tier-order-state` |
| Stage | 6 — Final review (go/no-go) |
| Lane | high_stakes (data plane, multi_tenancy, money-adjacent, NEW read path, NEW external DB catalog) |
| Reviewer | Engineering Advisor (final-reviewer, Opus tier) |
| Diff under review | `git diff master...HEAD` (41 files, +2485/-46) on `feat/silver-tier-order-state` |
| Security verdict (upstream) | **PASS — APPROVE** (CRIT 0 / HIGH 0 / MED 0 / LOW 1) |
| QA verdict (upstream) | **BUILD-OK** (silver-verify exit 0; dbt 9/9; grain 10933=distinct; replay idempotent; isolation 52 incl. non-inert mutation control) |

## Advisor recommendation

**APPROVE → Stakeholder gate (Stage 7).**

The slice does exactly what the requirement and architecture bound — no more. It lands the first Bronze/source→Silver pipeline (StarRocks JDBC external catalog over Postgres → dbt staging→intermediate→mart `silver.order_state`) plus the metric-engine order-status-mix read seam, BFF route, and a stakeholder-visible UI, proving Silver→engine→BFF→UI end-to-end. The HIGH-STAKES invariant (per-brand isolation) is enforced at the correct layer for this paradigm and proven non-inert.

### The paradigm change is sound and correctly placed

The model CHANGED here vs. the OLTP convention, and that change is the central thing this review had to validate:
- StarRocks `CREATE ROW POLICY` is enterprise/managed-only and unavailable on the dev allin1 image. Isolation on the Silver read path is therefore an **app-seam** mechanism: `withSilverBrand(srPool, brandId, fn)` is the single chokepoint that (1) sets `@brain_current_brand_id` and (2) **always** substitutes the `${BRAND_PREDICATE}` sentinel with a parameterized `brand_id = ?`. A caller cannot issue Silver SQL without going through `runScoped`, so the predicate cannot be forgotten (`packages/metric-engine/src/silver-deps.ts:95-136`).
- The JDBC catalog reading Postgres cross-brand as superuser `brain` is **correct by design** — dbt is the ETL writer (like the stream-worker), not a tenant-scoped reader. Isolation is NOT at dbt/staging; it is at the metric-engine read seam (the I-ST01 sole reader). This is documented honestly in-file (`db/starrocks/oltp_jdbc_catalog.sql:17-25`, `db/starrocks/oltp_pg_read_shim.sql:19-22`, `silver_order_state.sql:25-27`).
- Postgres RLS still governs the OLTP side and is unchanged by this slice (no Postgres migration; `0031` reserved-not-used).

## Independent spot-checks (the four highest-risk claims)

1. **App-seam isolation non-inert proof — VERIFIED.** `tools/isolation-fuzz/src/silver-order-state.test.ts:147-166` runs the SAME logical read with `__unsafeDisableBrandPredicate: true` and asserts `expect(leaked.some(r => r.brand_id === BRAND_B)).toBe(true)` — i.e. disabling the seam predicate MUST leak brand-B. The test imports the REAL seam from `@brain/metric-engine` (not a copy), seeds a transient brand-A/brand-B pair, and PENDs visibly (not silently green) if StarRocks/the mart is absent. This is a genuine, falsifiable mutation control — it fails loud if the predicate were inert.
2. **Metric-engine sole read path — VERIFIED.** BFF `GET /api/v1/analytics/order-status-mix` calls `getOrderStatusMix` → `computeOrderStatusMix` → `withSilverBrand`. The route issues NO OLAP SQL itself (`bff.routes.ts` new block; header updated honestly from "ZERO StarRocks calls" to "Silver reads go through the metric-engine seam"). Brand from session (`auth.brandId`, D-1, never body); honest `no_data` when no brand; honest `503` when `srPool` absent. UI never touches StarRocks.
3. **dbt idempotent replay — VERIFIED (by construction + harness).** The mart fold is a pure deterministic ordering (`row_number() over (partition by brand_id, order_id order by is_terminal desc, economic_effective_at desc, state_rank desc, occurred_at desc)`, `silver_order_state.sql:63-70`) over append-only source rows. `make silver-verify` snapshots a content fingerprint (`murmur_hash3_32` over ALL columns EXCEPT the build-time `updated_at`), rebuilds, and diffs — correctly excluding the only non-deterministic column. `assert_order_state_replay.sql` adds fold-consistency invariants (terminal⇔is_terminal, canonical state set). QA reported `silver-verify` exit 0 and replay idempotent; I confirm the mechanism is sound.
4. **No Postgres/StarRocks credential leak — VERIFIED.** `git diff` credential-grep surfaces only: the already-committed dev `brain/brain` Postgres superuser literal in `oltp_jdbc_catalog.sql:49-50` (by design, ETL-writer posture, NOT a new secret) and empty-string `STARROCKS_ANALYTICS_PASSWORD` defaults (`main.ts`, test env fallback). No NEW secret introduced. Matches the Security finding.

### Gates I re-ran (captured)

- `pnpm vitest run src/order-status-mix.test.ts src/registry.test.ts` (packages/metric-engine) → **24 passed (2 files)**. Spec-derived literals (10/70/20→total 100; 1/3→33.33 basis-point truncation; `value_minor:'100.50'` throws `SyntaxError` — I-S07 runtime boundary). NOT tautological.
- Read the isolation mutation test source and confirmed the negative control is non-inert and falsifiable (claim 1 above).
- Credential grep across full `master...HEAD` diff (claim 4 above).

## Over-engineering audit — CLEAN

One mart, one intermediate view, one staging view, one read seam, one metric (registered in the existing `METRIC_REGISTRY`, in-pattern with `cod_mix`/`checkout_funnel` — NOT a new primitive), one BFF route, one UI page. `registry.ts`/`registry.test.ts` edits are the standard registry extension (Single-Primitive clean), not scope creep. Deps added are minimal and real-pinned: `mysql2 ^3.22.5` (a real published version, not invented) on the two packages that issue StarRocks SQL. No speculative second mart, no abstraction-for-one-use, no drive-by refactor. No WHAT-comments (the in-file blocks are WHY/boundary docs, which this HIGH-STAKES paradigm change warrants).

## Hard-rule deviation check — CLEAN

- No new deployable / topic / envelope (I-E05): the Makefile is a dev/CI invocation; `srPool` is additive to the composition root.
- Additive only: no Postgres migration (`0031` reserved-not-used); the read-shim is `CREATE OR REPLACE VIEW` (reversible); the mart is dbt-owned DDL.
- dbt additive mart; non-additive math (COUNT/share) in metric-engine (ADR-004): respected.
- Money BIGINT minor + currency (I-S07): mart column `bigint` (dbt type-assert `assert_order_state_money_bigint.sql`); engine share math is integer basis-points, throws on fractional.
- I-ST01 sole read path: enforced via the seam; UI never queries StarRocks.
- No Single-Primitive violation; no compliance gap; no un-codified gate-skip; no paradigm escalation beyond the plan (the app-seam isolation model IS the plan, §4). Nothing requires Stakeholder pre-approval beyond the normal gate.

## Reconciled findings table

| ID | Source | Severity | Status | Note |
|---|---|---|---|---|
| SEC-LOW-1 | Security | LOW | Tracked | `SET @brain_current_brand_id` uses sanitized UUID interpolation (`silver-deps.ts:110-111`) — defense-in-depth only; the real filter is the parameterized `brand_id = ?`. Not blocking. |
| DEV-NOTE-1 | QA | dev-boundary | Tracked | Makefile needs an absolute dbt path — handled via the `DBT=` override + `.dbt-venv` auto-resolution (`Makefile:28-29`). Cosmetic. |
| DEV-NOTE-2 | QA | dev-boundary | Tracked | BFF route not end-to-end smoke-tested via a real port this session. The route logic is type-checked + the use-case/engine are unit-tested; the wire test is a follow-up, not a correctness gap. |
| PROD-GAP-1 | Architecture/Security | tracked | Tracked | Engine-level row policy is the prod graduation step (`db/starrocks/row_policy_template.sql` on a managed cluster). M1 enforcement = the app-seam predicate, proven non-inert. Documented in-file + in the always-pass documentation test. |
| OBS-NOTE-1 | Advisor | LOW | Tracked | `db/dbt/profiles/.user.yml` (a dbt anonymous-usage id) is committed; normally gitignored. Harmless. |

## Risks remaining (all tracked, none blocking)

1. **Prod isolation graduation (PROD-GAP-1):** until a managed/enterprise StarRocks applies `CREATE ROW POLICY`, the app-seam predicate is the SOLE enforcement. It is proven non-inert, but it is application-layer, not engine-layer — the seam must remain the only Silver reader. This is the documented, intended M1 posture.
2. **No real-port BFF smoke (DEV-NOTE-2):** the end-to-end Silver→engine→BFF→UI path is proven by unit + isolation tests and type-checking, not by an HTTP wire test this session. Recommend a wire-smoke in the next slice.
3. **Synthetic source labelling:** the dev ledger `cod_*` rows folded into Silver are synthetic; the route honestly passes `data_source: 'synthetic'` and the UI shows the SyntheticBadge. The number shape is real; the data is dev.

## Retro + rule-proposal

Retro written to `14-retro.md`. **No auto-candidate rule:** this is a clean PASS with no recurring root-cause defect to codify. The app-seam isolation model is a novel-but-correct paradigm response to an engine-capability boundary (enterprise-only row policy), not a repeated failure pattern — the ≥3-distinct-prior-run threshold is not met.

## Decision

Residual risk is confined to the two dev-boundary notes (Makefile dbt path; no real-port BFF smoke) and the prod engine-row-policy graduation — all tracked, none blocking. Security PASS reconciles with QA BUILD-OK and with my independent spot-checks of all four highest-risk claims. Per-brand isolation, money (I-S07), sole-read-path (I-ST01), replay-idempotency, no-new-deployable (I-E05), and additive-only are all satisfied with file:line evidence.

VERDICT: PASS

Next action: Stakeholder gate (Stage 7). On commit, stage exactly the product-code + run-artifact paths enumerated in `pending-stakeholder-commit.md` (no `git add -A`).
