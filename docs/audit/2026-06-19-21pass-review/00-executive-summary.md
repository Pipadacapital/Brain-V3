# Executive Summary (Brain AI-Native Commerce OS — Principal Audit)

**Audit date:** 2026-06-19 · **Scope:** full monorepo (apps/{collector,core,stream-worker,web}, packages/*, db/, infra/) against reference docs 01–12 + ADRs · **Method:** evidence-anchored, adversarially verified. Every claim below cites a file:line opened during the audit.

---

## Overall Verdict

Brain is a **well-architected, correctly-conceived system that is still mid-build** — not yet production-grade. The *bones* are right: clean DDD bounded-context boundaries, a brand-scoped metric-engine seam, medallion lakehouse, event-driven backbone, and a genuine "capture truth → trust → decisions" model. But three independent classes of problem block a production go:

1. **Core bounded contexts are empty stubs.** Identity control-plane, Billing, Recommendation, and job-orchestration are `.gitkeep` placeholders — the product's *named earliest must-ship outcomes* (billing loop, Top-3 actions, Customer 360) do not exist in code.
2. **The CI guardrails that are supposed to protect the architecture are structurally inert.** The two ESLint boundary rules that enforce ADR-001 (module reach-around) and ADR-002/004 (metric-engine fence) both **silently never fire** — they pass `npx eslint` at exit 0 while real violations accumulate. The safety net is decorative.
3. **The deploy/scheduling path is not wired.** No Dockerfiles, no Helm charts (ArgoCD points at directories that don't exist), and no Argo CronWorkflows — so revenue-finalization, dbt, and the parity-convergence monitor cannot self-schedule, and finalized revenue stays permanently provisional.

These are *build-completeness and enforcement-wiring* gaps, not design defects. The architecture is sound; the implementation has not caught up to it, and the automated checks meant to keep it honest are non-functional.

| Dimension | Verdict |
|---|---|
| Architecturally correct | **Yes** — DDD boundaries, medallion, metric-engine seam, ADRs are coherent |
| Production-grade today | **No** — empty core contexts, no deploy artifacts, inert CI fences |
| Scalable to 10k brands | **Partially** — brand predicates are applied in practice; but Postgres-backed collector spool (not the spec'd disk WAL) makes a single Postgres outage a multi-tenant accept-failure during peak windows |
| Secure for enterprise commerce data | **At risk** — isolation holds *in practice*, but the only CI backstop against a future `withBrandTxn`-skipping query is dead; PII vault unimplemented |
| Resilient | **No** — collector durability anchor is a Postgres table contradicting ADR-003; no scheduled parity/finalization jobs |
| Maintainable | **Degrading** — cursor/DLQ/auth logic copied verbatim 4–5× across files; boundary erosion undetected |
| Cost-efficient | **Acceptable** — phantom deps (mysql2, @brain/config) and version split are minor; no structural cost defect proven |
| Privacy-compliant | **Incomplete** — consent tombstone migration exists, but PII vault and Customer-360 erasure path are not built |

---

## Headline Severity Counts (verified findings)

- **High (verified/upheld):** 8 — ARC-2, ARC-3, ARC-4, ARC-5, RS-1, CQ-1*, plus ARC-1 (downgraded to Medium on verification)
- **Medium:** ~12 — RS-2/3/4, CQ-2/3/4, ARC-6/7, DP-1, and the downgraded ARC-1/CQ-1
- **Low:** ~5 — RS-5, CQ-5/6, ARC-8
- **Cross-cutting theme:** the single most dangerous pattern is **inert enforcement** — two CI boundary rules (RS-1, ARC-1/ARC-2) that look active but cannot fire.

\* CQ-1 corrected to Medium on verification (the cited GUC-drift example was false; copies are currently consistent, so the risk is maintainability drift, not an active bug).

---

## Top 5 Risks

**1. [High] Metric-engine boundary fence is structurally a no-op — 9 files bypass it undetected.**
In `eslint.config.mjs:56`, the `'app'` descriptor (`apps/*`) is declared *before* `'core-module'` (`apps/core/src/modules/*`, `:58`). `@boundaries/elements` matches deepest-first and breaks on the first descriptor in declaration order, so **every** `apps/core/*` file classifies as `app`, never `core-module` — making the `from:['core-module', …]` fence unsatisfiable. `npx eslint apps/core/src/modules/attribution/internal/credit-writer.ts` exits 0 with the rule at level 2. This is the CI backstop against cross-tenant leakage; it is dead. *Fix: reorder `core-module` before `app`.*

**2. [High] Identity bounded context is a `.gitkeep` stub — merge/unmerge, PII vault, Customer 360 absent.**
`apps/core/src/modules/identity/index.ts:7` is literally `export {}; // TODO`; `internal/` holds only `.gitkeep`. Doc-04:171 makes Identity own merge/unmerge, phone guard, review queue, and PII vault. The notification send path has no plaintext source (PII vault is an unimplemented `MatchPiiPort` interface seam only), so outbound email/CAPI passback **cannot function** for any brand. Async stream-worker resolution exists; the admin control-plane does not.

**3. [High] Collector durability anchor is a Postgres table, contradicting ADR-003's disk WAL.**
`apps/collector/src/application/accept-event.usecase.ts:27-30` — *"INSERT INTO collector_spool — this commit IS the durability anchor"* — returns HTTP 500 (no ACK) if it throws. ADR-003 (doc-04:946) specifies *"accept → disk WAL → fsync → ack … needs EBS/NVMe PVC"*. A Postgres outage during a Diwali/BFCM peak therefore drops event acceptance for **all brands simultaneously**, and the documented failure model is wrong. Staging `multi_az=true` but `create=false`, so the Multi-AZ mitigation isn't even provisioned.

**4. [High] Three revenue/decision contexts are empty stubs — Billing, Recommendation, job-orchestration.**
`apps/core/src/modules/{billing,recommendation,job-orchestration}/internal/` each contain only `.gitkeep`; each `index.ts` is `export {} + TODO`. Billing (doc-04:~224) is named the earliest must-ship outcome — Brain cannot invoice, meter GMV, seal periods, or dun. Recommendation delivers **zero** Top-3 actions to Home/Command Center. No overlap-lock for cron jobs. Migration `0020_provisional_gmv_as_of.sql` exists but nothing consumes it.

**5. [High] No deploy/schedule artifacts — ArgoCD points at nonexistent paths; no CronWorkflows.**
`infra/helm/` contains only `README.md`, `authentik/`, and an empty `charts/`; `infra/argocd/envs/prod/core.yaml:13` references `infra/helm/core` which does not exist. `find apps/ -name Dockerfile` returns nothing. No `CronWorkflow` manifest exists anywhere, so `revenue-finalization` never runs and **finalized revenue stays provisional forever** for every brand. CI Trivy/OSV scans are silently skipped via the affected-set fallback (`pr.yml:134-146`).

*Honorable mentions:* duplicate migration `0033` (both `0033_consent_record_tombstone.sql` and `0033_send_log.sql` present, uncaught by CI); cursor-management logic copied verbatim across 4 repull jobs (`razorpay-settlement-repull/run.ts:360-520` et al.); module reach-around into `workspace-access/internal` from `bff.routes.ts:45-53` undetected by a second inert ESLint rule.

---

## Go / No-Go

**NO-GO for production.** The architecture is correct and worth finishing, but core revenue/identity contexts are unbuilt, the deploy and job-scheduling path does not exist, and the two CI fences meant to guarantee tenant isolation and module boundaries are silently inert — fix the enforcement wiring first, then complete Identity + Billing + deploy artifacts, before any production exposure of enterprise commerce data.
