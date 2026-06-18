# Technical Debt Register

Debt classified by type, effort, and **interest rate** (how fast the cost compounds if left unpaid). This register covers debt that is *not itself a P0 outage blocker* (those live in the risk register) but will compound into one.

**Effort:** S (≤2 days) · M (≤2 weeks) · L (≤6 weeks) · XL (a phase).
**Interest rate:** how the cost grows — High = compounds with every feature/tenant; Med = compounds with scale milestones; Low = roughly fixed.

---

## Category A — Architectural / boundary debt

| ID | Title | Type | Effort | Interest rate / why it compounds | Evidence |
|---|---|---|---|---|---|
| DEBT-A1 | Inert module-boundary lint (relative-import mismatch) + stale metric-engine fence | Boundary erosion | S | **High** — "extraction = move-a-folder" guarantee silently rots; every new cross-module reach-around is invisible to CI and accreted permanently | `eslint.config.mjs:138-150,91` |
| DEBT-A2 | metric-engine absorbed a DB/RLS seam (`withBrandTxn`), contradicting its pure/no-DB contract | Layering violation | M | **High** — every module needing brand-scoped reads is pulled into the engine import, breaking the fence and the parity-oracle "pure library" premise | `metric-engine/src/deps.ts:18,38-62` |
| DEBT-A3 | bff.routes.ts 2,538-line god-file, 8 positional params, raw OLTP SQL in handlers | Complexity / god-object | L | **High** — every new edge route widens the blast radius; positional wiring is a silent mis-wire class; merge-conflict + review cost grows superlinearly | `bff.routes.ts:77-2538` |
| DEBT-A4 | Empty/stub bounded-context modules (identity/recommendation/billing/job-orchestration) | Misleading structure | S | **Low** — fixed cost; misleads onboarding & capability audits but doesn't worsen with scale | `*/index.ts` = `export {}` |
| DEBT-A5 | `apps/web/lib/api/types.ts` 1,309-line hand-mirror of committed `packages/contracts` | Single-source violation | M | **Med** — every contract change must be made twice; FE typechecks green against stale shape, breaks at runtime | `web/lib/api/types.ts:1-13` |

## Category B — Duplication / Single-Primitive violations

| ID | Title | Type | Effort | Interest rate | Evidence |
|---|---|---|---|---|---|
| DEBT-B1 | 3× webhook HMAC pipeline (~1,256 LOC), already divergent | Security-critical dup | M | **High** — security fixes must land 3× and drift; new connectors copy 400-line files | `shopflo/razorpay/shopify WebhookHandler.ts` |
| DEBT-B2 | 154 hand-rolled `{request_id,error}` envelopes in bff.routes (250+ core-wide); no `sendError` helper | Missing abstraction | S | **High** — trace/correlation correctness enforced only by copy-paste; one forgotten id = un-correlatable error | grep `request_id:` |
| DEBT-B3 | Cursor/sync-state plumbing duplicated across 4+ repull jobs | Missing util | M | **Med** — advisory-lock + state-machine fixes don't propagate; one brand's sync hangs while others fixed | `*-repull/run.ts` |
| DEBT-B4 | Phone-guard threshold implemented twice (resolver inline vs dead `SharedUtilityPolicy`) with off-by-one | Single-Primitive violation | S | **Med** — two impls of one revenue-sensitive rule diverge; live path untested at true boundary | `IdentityResolver.ts:141`, `SharedUtilityPolicy.ts:48` |
| DEBT-B5 | auth.service raw BEGIN/SQL/GUC duplicates `UserSessionRepository` methods | Leaky abstraction | S | **Med** — most security-sensitive flow keeps a 2nd copy of session schema/RLS handling | `auth.service.ts:481-540` |

## Category C — Data-substrate divergence debt (honestly self-documented Phase-1 fallbacks)

| ID | Title | Type | Effort | Interest rate | Evidence |
|---|---|---|---|---|---|
| DEBT-C1 | Bronze on Postgres instead of Iceberg lakehouse | Substrate divergence | XL | **High** — highest-cardinality data in OLTP grows unbounded; the Phase-3 migration gets harder & riskier with every event ingested | `0016_bronze_events.sql:1-20` |
| DEBT-C2 | Events JSON not Avro; Apicurio registration decorative | Schema governance gap | L | **High** — no wire schema enforcement; every new producer can emit any shape; FULL_TRANSITIVE never checked | `kafka-producer.ts:85`, `ProcessEventUseCase.ts:84-95` |
| DEBT-C3 | Silver order mart from OLTP ledger not Bronze; no replay path | Lineage debt | L | **Med** — ledger loss/corruption has no event-sourced rebuild; compounds as order volume grows | `stg_order_ledger_events.sql:36` |
| DEBT-C4 | Parity oracle + dbt Silver not in CI | Gate debt | M | **High** — every Silver-math/parity regression ships unblocked; "same number" promise un-gated | `.github/workflows`, `Makefile:42-57` |
| DEBT-C5 | bronze_events/ledgers no partitioning/retention | Storage debt | M | **High** — monotonic OLTP storage growth + autovacuum lag; forces costly under-load migration before 1k brands | 37 migrations, no PARTITION BY |

## Category D — Test & verification debt

| ID | Title | Type | Effort | Interest rate | Evidence |
|---|---|---|---|---|---|
| DEBT-D1 | No mutation testing; no coverage thresholds | Effectiveness debt | M | **High** — no proof assertions are meaningful; critical-path floor unverifiable; compounds with every untested merge | grep stryker/coverage=0 |
| DEBT-D2 | Isolation/live tests silently pass green when datastores absent | False-green debt | S | **High** — RLS negative controls report success having run zero assertions; defeats the entire isolation gate | `pg.test.ts:266+`, `*.live.test.ts:148` |
| DEBT-D3 | Auth replay-detection tested only against hand-mocked SQL stub | Over-mocking | S | **Med** — refactor dropping `FOR UPDATE` still passes; mitigated partly by live test | `critical-paths.test.ts:88-118` |
| DEBT-D4 | `rls.test.ts` is a tautological vi.fn simulation | Inert test | S | **Med** — reads as RLS control but proves only mock branching | `rls.test.ts:137-206` |

## Category E — Operational / config debt

| ID | Title | Type | Effort | Interest rate | Evidence |
|---|---|---|---|---|---|
| DEBT-E1 | Runbooks/playbooks are 2-3 line stubs; documented DR re-syncs non-existent manifests | Operational readiness | M | **High** — every incident without a procedure costs RTO; DR path itself broken | `docs/runbooks/README.md`, `docs/playbooks/README.md` |
| DEBT-E2 | Salt resolution: KMS path dead, guard-by-convention across 8+ sites | Defense-in-depth debt | M | **Med** — one forgotten guard hashes all brands with `''` → cross-brand collisions; risk grows with each new call site | `identity-core/src/index.ts:89-99` |
| DEBT-E3 | Money locked to exponent-2 currencies; CAPI `/100` scattered | i18n / money debt | M | **Med** — latent today (all ×100) but Phase-5 GCC onboarding (JPY/KWD) will miss scattered sites → 100× errors | `money/src/index.ts:114-116`, `capi-passback.service.ts:173` |
| DEBT-E4 | Inconsistent deploy tooling (Helm ×3, Kustomize ×1); image-bump sed matches nothing | Pipeline debt | M | **Med** — double maintenance surface; promotion is a silent no-op even once charts exist | `main.yml:125`, `argocd/envs/*` |
| DEBT-E5 | API contract divergence (envelope/idempotency/correlation/rate-limit/status codes) vs frozen doc 06 | Contract drift | L | **High** — code and frozen contract disagree on the wire; every SDK/partner integration built against either is wrong; compounds with each consumer | `03-api-audit.md` H1-H5 |

---

## Debt servicing guidance

**Pay first (highest interest × on the critical path):** DEBT-C1/C2/C4 (data substrate — the longer ingested, the harder), DEBT-B1/B2 (security-critical duplication), DEBT-D1/D2 (the gate that makes everything else trustworthy), DEBT-E5 (contract drift before external consumers exist), DEBT-A1/A2 (boundary enforcement before more reach-arounds accrete).

**Time-box explicitly:** per `engineering-discipline`, refactoring time must be allocated in the next cycle's plan, not left optional. The duplication debt (Category B) and the inert-gate debt (D1/D2) are the cheapest high-interest items and should be the first sprint's debt budget.
