# Go / No-Go Recommendation (2026-06-19)

**Verdict: NO-GO for production deployment.**

**Headline number: 0 of the 4 core revenue/identity bounded contexts are implemented, and 0 deployable services can be shipped through the GitOps pipeline (0 Dockerfiles, 0 Helm charts for app services, 0 CronWorkflow specs).** This is not a "harden-then-ship" posture; it is a "the product surface and the delivery pipeline do not yet exist" posture. The codebase is a well-structured Phase-1a skeleton with several real correctness/enforcement defects layered on top — but the gating issue is absence of function, not quality of function.

This is a **No-Go**, not a Conditional-Go, because two independent hard blockers each individually prevent deployment: (1) there is no container/Helm artifact to deploy (DevOps gap), and (2) the identity control-plane + PII vault + billing loop that define the product's "Enable Decisions / Capture Truth" promise are `.gitkeep` stubs. A Conditional-Go is only appropriate when the conditions are hardening tasks on a working system; here the conditions are net-new feature builds.

---

## Scorecard against the eight production criteria

| Criterion | Verdict | Anchor |
|---|---|---|
| Production-grade? | **No** | No deployable artifact exists: `find apps -iname Dockerfile` → 0 results; `infra/helm/charts/` is empty; `infra/argocd/envs/prod/core.yaml:17` points `path: infra/helm/core` at a directory that does not exist (ARC-8). |
| Architecturally correct? | **Partial** | DDD bounded-context layout and the medallion/metric-engine seams are sound *by design*, but the CI fences meant to enforce them are structurally inert (RS-1, ARC-1, ARC-2). The intended architecture is not the enforced architecture. |
| Scalable to 10k brands? | **Unproven / at risk** | Collector durability anchor is a Postgres-table spool, not the disk WAL ADR-003 specifies (ARC-3): a single Postgres failover stalls event acceptance for *all* brands simultaneously during peak windows. No revenue-finalization/parity scheduler exists to keep derived state converged at fleet scale (ARC-6). |
| Secure for enterprise data? | **Unproven** | PII vault (`contact_pii`) exists only as an unimplemented `MatchPiiPort` interface seam — there is no KMS-encrypted plaintext store (ARC-4). The metric-engine brand-predicate fence (the CI backstop against cross-tenant leakage) never fires (RS-1, ARC-2). |
| Resilient under failure? | **No** | Collector accept path returns HTTP 500 if the Postgres spool INSERT throws (`apps/collector/src/application/accept-event.usecase.ts:27-31`); the documented disk-WAL failure model in ADR-003 is wrong (ARC-3). No scheduled jobs means no automated recovery/finalization/DQ-freshness loop (ARC-6). |
| Maintainable by a growing team? | **At risk** | Cursor/sync-state logic copied verbatim across 4 repull jobs (CQ-1); DLQ/retry scaffold duplicated across 5 consumers (CQ-2); authority checks + `generateToken` duplicated (CQ-3, CQ-4). Dead/inconsistent domain code (DP-1). The boundary lint that should catch new coupling is inert (RS-1), so drift will not be caught in review. |
| Cost-efficient at scale? | **N/A yet** | See `docs/audit/19-cost.md`. Phantom prod dependencies (mysql2 in metric-engine RS-2, @brain/config in core RS-3) inflate every install and the Turbo graph but are not a deploy gate. |
| Privacy-compliant? | **No** | The PII vault required for consent-aware outbound and erasure is absent (ARC-4: only `MatchPiiPort` seam, no table/impl). Retention/erasure cannot run on schedule — no Argo CronWorkflow for retention-erasure exists (ARC-6). |

---

## P0 gates — MUST close before any production deploy

These are deployment-blocking. Each maps to a verified finding.

- **P0-A (ARC-8): No deployable artifacts exist.** `find apps -iname Dockerfile` returns 0; `infra/helm/charts/` is empty; `infra/argocd/envs/prod/core.yaml:17` references `infra/helm/core` which does not exist. ArgoCD sync will fail on first activation. Gate: ship Dockerfiles for collector/core/stream-worker/web and Helm charts for each, and confirm an ArgoCD app reaches `Synced/Healthy` in staging.
- **P0-B (ARC-8): Container security scans are silently skipped.** `.github/workflows/pr.yml:134,142,146` gates the build/scan step on an affected-set `jq` that falls back to empty → `skip=true`, bypassing Trivy/OSV on every PR. Gate: replace the fallback with an explicit file-existence check so no PR can merge an unscanned image.
- **P0-C (ARC-4): Identity control-plane + PII vault absent.** `apps/core/src/modules/identity/index.ts` is `export {}; // TODO`; `internal/` holds only `.gitkeep`. No merge/unmerge/review-queue/Customer-360 routes; `contact_pii` exists only as the `MatchPiiPort` interface. Without the vault, outbound email/CAPI passback cannot function and erasure cannot be honored. Gate: implement Customer-360 read, audited merge/unmerge, and a KMS-encrypted `contact_pii` table.
- **P0-D (ARC-3): Collector durability contradicts ADR-003 and has no disk-WAL floor.** `apps/collector/src/infrastructure/pg-spool.repository.ts` INSERTs into `collector_spool`; `accept-event.usecase.ts:27-31` makes that INSERT the durability anchor and 500s on failure — contradicting ADR-003 (`docs/requirements/04_...md:946`, `:187`). Note: staging `main.tf` has `multi_az=true` but `create=false`, so even the documented mitigation is not provisioned. Gate: either add a local disk-WAL accept tier OR formally re-ADR the Postgres-spool decision, provision Multi-AZ, and wire `spool_pending_count` + `pg_pool_errors_total` SLO alerts.

## P1 gates — MUST close before GA / multi-tenant load

- **P1-A (RS-1): metric-engine boundary fence is inert.** In `eslint.config.mjs:54-99` the `app` descriptor (`apps/*`, line 56) precedes `core-module` (line 58); `@boundaries/elements` classifies every `apps/core/*` file as `app`, so the `from:['core-module', module !measurement|analytics]` rule is unsatisfiable. `npx eslint apps/core/src/modules/attribution/internal/credit-writer.ts` exits 0. 9 prod files across ai/attribution/data-quality/frontend-api import `@brain/metric-engine` undetected. This is the CI backstop against cross-tenant leakage. Gate: reorder descriptors (core-module before app) and resolve the 9 violations.
- **P1-B (ARC-2): direct StarRocks read outside the Analytics API.** `apps/core/src/modules/attribution/internal/credit-writer.ts:34-35,160-167` runs a `brain_silver.silver_touchpoint` SELECT via `withSilverBrand`, exported live from `attribution/index.ts:46-48`; no `@brain/*` ESLint resolver is wired so `boundaries/element-types` cannot fire. Gate: route the read through the analytics module (ADR-002) and add the import resolver.
- **P1-C (ARC-1): BFF reaches into workspace-access internals 10×.** `bff.routes.ts:45-53,72-73` imports symbols absent from `workspace-access/index.ts`; the `no-restricted-imports` group globs use absolute patterns that never match `../../` specifiers, so the guard is dead. Gate: export the symbols via the barrel and switch the lint rule to a regex matcher.
- **P1-D (ARC-6): no scheduler manifests for any cron job.** `grep -rl CronWorkflow infra/` → none; revenue-finalization, parity-convergence monitor (layers 2+3 of the parity oracle), dbt builds, DQ-freshness, and retention-erasure are Node scripts with no way to self-schedule. Without revenue-finalization, `recognition_label='finalized'` never advances for any brand. Gate: add Argo CronWorkflow specs + the Argo Workflows Helm chart and confirm hourly parity + nightly finalization emit metrics in staging.
- **P1-E (ARC-5): billing + recommendation + job-orchestration are stubs.** Each `index.ts` is `export {}; // TODO` with a `.gitkeep`-only `internal/`. No invoicing/period-seal/GMV-meter, zero recommendation detectors (Command Center delivers no Top-3 actions), no overlap-lock. This blocks platform revenue and the core decision-intelligence value prop. Gate (GA, not first deploy): ship the GMV meter + period seal (migration `0020_provisional_gmv_as_of.sql` exists), ≥1 detector, and the overlap-lock table; add a machine-readable `MODULE_READINESS` / `PHASE_NOT_IMPLEMENTED` 503 marker so unbuilt routes fail loudly.
- **P1-F (CQ-1): cursor/sync-state logic duplicated across 4 repull jobs.** `acquireCursorLock/getCursorValue/upsertCursorValue/setSyncState` near-verbatim in razorpay (360-520), gokwik (296-438), meta (268-365), shopify (440-497). A security/correctness fix to the GUC brand-scoping path must be applied in 4 places — a multi-tenant isolation maintenance hazard. Gate: extract a single `CursorRepository`.

## Pre-GA cleanups (not deploy-gating, tracked)

ARC-7 duplicate `0033_*` migration prefix (add CI uniqueness lint); RS-2/RS-3 phantom prod deps; RS-4 attribution→analytics public-boundary re-export; CQ-2/CQ-3/CQ-4 duplication; DP-1 dead `SharedUtilityPolicy` with divergent threshold semantics; RS-5 Fastify v4/v5 split; CQ-5 unbounded worker pools (missing `idleTimeoutMillis`/`statement_timeout`); CQ-6 non-`void` floating promise.

---

## Path to Go

1. Close **P0-A through P0-D** → enables a *deployable, scannable, durable, identity-capable* staging release (internal/beta, not GA).
2. Close **P1-A through P1-F** → enables enforced isolation, scheduled convergence, and the revenue/decision loops → GA candidate for a controlled brand cohort.
3. The architecture is fundamentally sound; the verdict is No-Go on **completeness and enforcement**, not on **design**. Re-audit after P0+P1 closure; expect Conditional-Go at that point.
