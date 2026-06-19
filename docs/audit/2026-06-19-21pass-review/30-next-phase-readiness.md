# Next Phase Readiness Assessment (2026-06-19)

**Board:** Principal-level independent audit — final synthesis
**Date:** 2026-06-19
**Scope:** What must be true before the next implementation phase begins. Gaps (missing / over-engineered / under-engineered), each evidence-anchored, plus concrete entry/exit criteria.

---

## Headline Verdict

**NOT READY to start the next build phase. Verdict: CONDITIONAL HOLD.**

The measurement foundation (realized-revenue ledger, deterministic attribution credit + clawback, confidence-gated metric engine, identity-resolution stream path, pixel/collector, NLQ honesty seam) is architecturally sound and survives comparison to docs 01/08/09. But the repo is in a state where **the next phase cannot safely begin until two classes of work close: (a) the deploy/observe spine that lets *anything* reach production, and (b) the Phase-1a control-plane primitives the next phase structurally depends on.**

**Readiness score: 4 of 10 gating criteria met (40%).** Four findings are deploy-blocking P0s (`infra/k8s/` absent → every ArgoCD sync errors; SLO alerts wired to metric names that are never emitted; stream-worker has no health HTTP surface; the flagship Decision Intelligence pillar is `.gitkeep`). The remaining gating items are control-plane stubs (identity merge/unmerge + PII vault, billing/CM2, recommendation detectors) that the next phase builds *on top of* — starting new work before they exist guarantees rework.

---

## A. What Is MISSING (build-blocking absences)

### M-1 — The entire GitOps deploy path is severed (P0)
`infra/argocd/envs/{prod,staging}/collector.yaml:26` point at `path: infra/k8s/collector/overlays/<env>`, but `ls infra/k8s` → **NOT FOUND** (verified). There are **zero Dockerfiles** under `apps/` (`find apps -name Dockerfile` → count 0, verified). `infra/helm/` contains only `README.md` + `authentik/` + an empty `charts/`, while `infra/argocd/envs/prod/core.yaml:13` references `infra/helm/core` (ARC-8). **Nothing in this repo can be built into an image or deployed to any environment today.** Starting a new feature phase while the CD pipeline cannot ship is building inventory that cannot be released.

### M-2 — Observability/alerting is a stub; all SLO pages are dead (P0)
`packages/observability/src/index.ts:162-169` — `defaultCounterSink` emits `console.info("[metric] ...")`; no OTel MeterProvider, no Prometheus counter registration. The doc-04 §I.3 burn-rate alerts reference `collector_acks_total`, `parity_convergence_abs_diff_minor`, `audit_chain_verify_failures_total`, `tenant_context_violation_total` (doc-04:1855-1883) — **none are emitted as real counters.** `infra/observe/prometheus.yml:11-16` scrapes ports `:9091`/`:9092` that no service opens. The cross-tenant-leak and audit-chain-break alarms — the security-critical pages — cannot fire. A new phase that adds tenant-facing write paths must not ship without the isolation/audit alerts live.

### M-3 — Decision Intelligence (the "Decide" pillar) is unimplemented (P0)
`recommendation`, `billing`, `identity`, `job-orchestration` core modules each contain only an empty `internal/` dir + `index.ts` = `export {}; // TODO` (verified for all four). Grep across `db/migrations/` (0001–0036) for `recommendation`, `decision_log`, `signal_snapshot`, `cost_input`, `order_margin_fact`, `true_cm2` returns **0 rows** (VC-1, VC-3). The Home/Command Center (`apps/web/.../dashboard-content.tsx:204-233`) renders KPI tiles only — no Top-3 actions, no Decision Log. Per doc-09:23 "the unit of output is a decision, not a chart"; today the product is a measurement platform, not a decision engine. **This is the headline product gap, not a deploy gap — but it is also a dependency: the next phase's recommendations need CM2 and detectors that do not exist.**

### M-4 — Identity control-plane + PII vault absent (P0 for Phase-1b)
`apps/core/src/modules/identity/internal/` is empty; `index.ts:7` = `export {}`. No `GET /identity/customer/:brain_id` (Customer 360), no `POST /identity/merge|unmerge`, no `contact_pii` KMS vault table (ARC-4; the vault exists only as the unimplemented `MatchPiiPort` interface seam in notification). Async resolution (`stream-worker ResolveIdentityUseCase`) works, but doc-04:171 assigns merge/unmerge/review-queue/PII-vault/Customer-360 to this module. **Outbound email/CAPI passback cannot function without the vault** — any next-phase notification or winback work is blocked here.

### M-5 — Two-pass provisional attribution + True CM2 absent (P1, moat)
`attribution_credit_ledger` DDL (`db/migrations/0032...:74-113`) has **no `credit_pass` column**; `credit-writer.ts:117-131` writes finalized-basis credits only — contradicting doc-08:360 (`credit_pass CHECK in('provisional','finalized')`), doc-07:384, BRD:325 (VC-2). No `cost_input` / `order_margin_fact` / CM2 path exists (VC-3); `cost_confidence` therefore computes `'D'` for every brand permanently. The billing cap `fee = max(min(tier%×GMV, cap%×CM2), floor)` is uncomputable. doc-04:77 names these as "the moat — the build must not dilute them under deadline pressure." **Every next-phase recommendation grounded in "expected ΔCM2" has no CM2 to reference.**

### M-6 — Scheduled-job runtime + parity monitor have no manifests (P2)
Revenue-finalization, dbt build, retention/erasure, DQ freshness, and the runtime parity-convergence monitor are implemented as Node scripts (`stream-worker/src/jobs/revenue-finalization.ts:29` says "via Argo CronJob") but **no `CronWorkflow` manifest exists** (`grep -rl CronWorkflow infra` → none, verified) and there is no Argo Workflows Helm chart (ARC-6). Consequence: recognized revenue never moves provisional→finalized in any environment, and parity-oracle layers 2+3 never run. stream-worker also has **no HTTP server at all** (`main.ts:1-417`), so K8s liveness/readiness probes and auto-rollback are impossible (PR-3).

---

## B. What Is OVER-ENGINEERED (complexity carried with no payoff)

### O-1 — Three ESLint boundary fences that are structurally inert
The repo invested in `eslint-plugin-boundaries` + `no-restricted-imports` to enforce ADR-001/002/004, but **all three are dead**:
- The `app` element descriptor (`eslint.config.mjs:56`) precedes `core-module` (:58); `@boundaries/elements` matches first-declared, so *every* `apps/core/**` file classifies as `app` and the metric-engine fence `from:['core-module',...]` is unsatisfiable — `npx eslint .../credit-writer.ts` exits 0 (RS-1, verified).
- The same config has **no `@brain/*` import resolver** (only `eslint-import-resolver-node`), so `@brain/metric-engine` is unresolvable and the fence silently allows it (ARC-2). **9 production files across ai/attribution/data-quality/frontend-api import it undetected.**
- `no-restricted-imports` uses absolute-path globs that never match the `../../` relative specifiers `bff.routes.ts:45-53` actually uses (ARC-1, verified).

This is configuration that *looks like* governance but enforces nothing — worse than no rule, because it gives a false sense of safety on the tenant-isolation seam. **Either make them fire or delete them;** do not carry inert fences into the next phase.

### O-2 — Phantom production dependencies
`packages/metric-engine/package.json:14-16` declares `mysql2` while `silver-deps.ts:37-38` explicitly uses structural typing *instead of* importing it (RS-2) — every consumer compiles a native addon for nothing. `apps/core/package.json:19` declares `@brain/config` which **zero** core source files import (RS-3), creating a false Turbo rebuild edge. These are small but they pollute the dependency graph the next phase reasons about.

---

## C. What Is UNDER-ENGINEERED (built, but below the bar it must meet)

### U-1 — Cursor/sync-state logic copied verbatim across 4 repull jobs
`acquireCursorLock`/`getCursorValue`/`upsertCursorValue`/`setSyncState` are near-verbatim copies in razorpay (`run.ts:360-520`), gokwik (`:296-438`), meta (`:268-365`), shopify (`:440-497`) — the authors' own comments admit the clone (CQ-1). Today the copies are consistent, so the risk is *divergence on the next edit*: a connector fix lands in one copy and silently misses three brands' connectors. Extract `CursorRepository.ts` before adding the next connector.

### U-2 — Collector durability + readiness under-spec'd vs ADR-003
The spool is a Postgres table (`pg-spool.repository.ts`), and `accept-event.usecase.ts:27-31` makes that INSERT "the durability anchor" — contradicting ADR-003's `accept → disk WAL → fsync → ack` (doc-04:946, ARC-3). `/readyz` (`health.route.ts:19-28`) only does `spool.ping()`; if Redpanda is down the drainer stalls, the spool grows unbounded (no DELETE, `0015_collector_spool.sql:12`), and readyz still returns 200 (PR-5). The accept SLA is now coupled to Postgres availability with no backpressure signal — under-engineered for the sale-day peak the spool exists to survive.

### U-3 — OAuth state store is single-replica only
`InProcessOAuthStateStore` (`apps/core/.../InProcessOAuthStateStore.ts:5` self-documents "NOT suitable for multi-instance production") is wired unconditionally at `main.ts:544` for Shopify/Meta/Google with no `isProduction` switch to a Redis-backed store — even though ioredis is already wired at `main.ts:335` (PR-4). Under `minReplicas:3` every connector install fails intermittently with `state_invalid`. Connector onboarding is the next phase's front door.

### U-4 — Ask Brain dispatches 2 of 16 metrics
`ask-brain.ts:184-201` `computeBinding` switches only `realized_revenue`/`provisional_revenue`; the other 14 registered metric IDs fall to `default → figure_kind:'none'` (VC-4). Honesty is preserved (no fabrication) but ROAS/attribution-confidence/RTO/funnel are unanswerable. The connective wiring is missing, not the compute (each `compute*` already exists in metric-engine).

### U-5 — Migration-sequence + runbook hygiene
Two migrations share prefix `0033` (`0033_consent_record_tombstone.sql`, `0033_send_log.sql`, verified; ARC-7) — currently ordered deterministically but a collision waiting to bite a future deploy, uncaught by CI (pr.yml runs migrations only through 0020). Runbooks (`docs/runbooks/README.md`, `docs/playbooks/README.md`) are 1–4-line pointer stubs referencing a "core read-only flag" and a `starrocks-rebuild` Argo workflow that do not exist (PR-6).

---

## D. Entry / Exit Criteria for Next-Phase Readiness

### Entry criteria — ALL must hold before the next phase opens (gate, no exceptions)

| # | Criterion | Evidence it is met (verification command/check) | Status |
|---|-----------|--------------------------------------------------|--------|
| E1 | GitOps deploy path resolves end-to-end | `infra/k8s/` exists; ≥1 Dockerfile per deployable; `argocd app diff` for core/collector/stream-worker = no `ComparisonError` | ❌ (M-1, ARC-8) |
| E2 | Real metrics + the 4 security/SLO burn alerts fire | `/metrics` open on each service; Prometheus targets UP; a forced `tenant_context_violation_total` and `audit_chain_verify_failures_total` page in staging | ❌ (M-2) |
| E3 | stream-worker is K8s-probeable | `GET /healthz`+`/readyz` on stream-worker; readyz reflects consumer-group health, not just DB ping | ❌ (M-3 PR-3, U-2 PR-5) |
| E4 | Identity control-plane + PII vault live | `GET /identity/customer/:brain_id` returns for a seeded brand; `POST /merge`+`/unmerge` audited; `contact_pii` KMS table exists | ❌ (M-4) |
| E5 | Boundary fences actually fire OR are removed | reorder `core-module` before `app`; add `eslint-import-resolver-typescript`; `npx eslint .../credit-writer.ts` errors on the metric-engine reach | ❌ (O-1) |
| E6 | Scheduled jobs self-run; finalized revenue advances | `CronWorkflow` manifests for revenue-finalization + parity-monitor exist; `realized_revenue_ledger` shows `recognition_label='finalized'` rows per active brand | ❌ (M-6) |
| E7 | OAuth state is multi-replica safe | `RedisOAuthStateStore` wired under `isProduction`; connector install succeeds under 3 replicas | ❌ (U-3) |
| E8 | Migration + dependency hygiene | no duplicate numeric prefix in `db/migrations/`; `depcheck` clean for metric-engine `mysql2` and core `@brain/config` | ❌ (U-5, O-2) |

**Met today: E-? none of the eight.** (Sound foundation work — ledgers, attribution mechanics, metric engine, identity resolution — sits *below* this gate and is why the verdict is HOLD, not STOP.)

### Exit criteria — the next phase is "done / ready to hand off" when:

1. **Decision pillar emits real output.** ≥1 deterministic detector (e.g., CM2-falling or RTO-spike, doc-09 Part 5) writes a `recommendation` row; Home/Command Center renders Top-3 with Approve/Reject/Edit/Ask-why; every response writes a `decision_log` row (PFS §8.11–8.12). (closes M-3)
2. **CM2 is computed, not 'D'.** `cost_input` + `order_margin_fact` migrations exist; cost-input UI ships; `contribution_margin`/`true_cm2` are registered metric IDs; `cost_confidence` reflects real coverage. (closes M-5/VC-3)
3. **Two-pass attribution restated.** `credit_pass` column added; provisional written at placement, finalized at horizon; billing/recommendation reads filter `credit_pass='finalized'`. (closes M-5/VC-2)
4. **Ask Brain answers all 16 metrics** (or each gap is an explicit, logged `figure_kind='none'` with a roadmap marker — not a silent fallthrough). (closes U-4)
5. **No new connector ships on a copied cursor block** — `CursorRepository.ts` extracted, 4 copies deleted. (closes U-1)
6. **Runbooks are executable** — RB-1/2/3 contain real CLI + the referenced "core read-only flag" exists. (closes U-5/PR-6)

Each exit item must be demonstrated with the same evidence discipline as this audit: a passing test or a real-network check, not a claim.

---

## E. Sequencing Recommendation

Do **not** open the next feature phase on top of the current state. Run a **"phase-zero hardening" track** that closes E1–E8 (deploy spine + observability + identity control-plane + live fences) first — these are dependencies, not parallel work. Then the next phase (Decision Intelligence + CM2 + billing) lands on a substrate that can actually ship, alert, and isolate tenants. Attempting M-3/M-5 product work before E2/E4 means building the moat with no way to deploy it, no alert if it leaks across tenants, and no PII vault for it to act on.
