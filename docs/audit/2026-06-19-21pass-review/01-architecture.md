# Pass 1: Architecture Compliance Audit (architecture)

**Board:** Architecture Compliance  
**Auditor:** Principal-Level Independent Review  
**Date:** 2026-06-19  
**Reference docs:** docs/requirements/03, 04 (ADR-001..013); docs/adr/0001-modular-monolith.md  
**Scope:** ADR-0001 modular-monolith enforcement, bounded-context ownership/coupling, component implementation vs specification  

---

## Board Verdict

The modular-monolith structure is architecturally sound and ADR-001..013 are well-specified. The three-deployable split (Collector, stream-worker, core), boundary tagging, and import-lint intent are all correct. However, the enforcement machinery has two confirmed blind spots that let live violations persist undetected in the main branch: (1) the `no-restricted-imports` ESLint rule cannot match relative-path cross-module imports because the `ignore` library throws on `..`-prefixed strings, letting `frontend-api` reach directly into `workspace-access/internal` in 10 places; (2) the `boundaries/element-types` rule cannot resolve `@brain/*` package aliases without a TypeScript path-resolver plugin, so `data-quality`, `ai`, and `attribution` silently bypass the documented metric-engine fence. Beyond enforcement, four bounded contexts (Identity, Billing, Recommendation, job-orchestration) exist only as `.gitkeep` stubs despite being load-bearing in the Phase 1a delivery plan, and the entire deployment-infrastructure layer (Dockerfiles, Helm charts, Argo Workflow manifests) is missing, making ArgoCD application YAMLs reference directories that do not exist. A collector-spool implementation drift from ADR-003 (Postgres instead of the specified disk WAL) changes the failure-mode model for the 99.95%-SLA path but is partially mitigated by RDS Multi-AZ.

**Severity counts:** Critical 0 | High 4 | Medium 3 | Low 1

---

## Finding ARC-1

**Title:** `frontend-api` module reaches into `workspace-access/internal` in 10 places — boundary enforcement rule cannot catch relative imports  
**Severity:** High  
**Category:** Boundary violation / ADR-001 enforcement gap  
**Priority:** P1  

**evidenceRef:**  
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts:45-53,72-73` — imports `OnboardingService`, `OnboardingError`, `OnboardingStatus`, `MembershipRepository`, `OrganizationRepository`, `RateLimiter`, `loginFailKeySync`, `loginIpKey`, `registerIpKey` directly from `../../workspace-access/internal/*`  
- `apps/core/src/modules/workspace-access/index.ts:1-21` — none of the above symbols are exported from the module's public interface  
- `eslint.config.mjs:102-114` — the `no-restricted-imports` group pattern `'apps/core/src/modules/*/internal/*'` uses the `ignore` npm library, which throws `RangeError: path should be a path.relative()d string` for any import starting with `../..` — confirmed by inspecting `node_modules/.pnpm/ignore@5.3.2/.../ignore/index.js:397`  

**Impact:**  
- Any refactor of `workspace-access` internals (rate-limiter, repository interfaces, session/token types) silently breaks `bff.routes.ts` because the coupling is invisible to the boundary linter and not surfaced in `workspace-access/index.ts`.  
- The `MembershipRepository` and `OrganizationRepository` are infrastructure concerns that should never cross module lines; the BFF now owns direct Postgres-query knowledge of the workspace-access data model.  
- Extraction of `workspace-access` to its own service (Phase 2 option) requires untangling these direct couplings.  

**rootCause:**  
`bff.routes.ts` predates (or was written concurrently with) the formal `workspace-access` public-API barrel. When needed symbols were absent from `index.ts`, the implementer imported them directly. The ESLint rule was designed to prevent this but uses the `ignore` library for glob matching, which only accepts forward-relative paths — it cannot match `../../module/internal/...` strings.  

**Fix:**  
1. Export the missing symbols from `workspace-access/index.ts`: `OnboardingService`, `OnboardingError`, `OnboardingStatus`, `RateLimiter`, `loginFailKeySync`, `loginIpKey`, `registerIpKey`. Keep `MembershipRepository` and `OrganizationRepository` internal; pass their results (not instances) across the boundary.  
2. Rewrite all 10 imports in `bff.routes.ts` to import from `../../workspace-access/index.js`.  
3. Fix the ESLint rule: replace the `no-restricted-imports` group pattern with a regex matcher using `/modules\/(?!frontend-api)[^/]+\/internal\//` (which the `no-restricted-imports` `regex` option and the `ignore` library *do* support) — OR switch to `eslint-import-resolver-typescript` so that `boundaries/element-types` resolves the module path and catches the violation at the `boundaries` layer instead.  

**tenantImpact:** Single-tenant risk only — the coupling is within a single module; it does not affect cross-tenant isolation. However, if `workspace-access` internals are ever altered (e.g. to add per-brand RLS to the membership query) the BFF will not inherit the guard automatically, creating a potential single-tenant privilege-escalation vector.  

**Detection:** Silent at CI today. Would only surface as a TypeScript compile error if the internal file is deleted/renamed, or in a code-review catch. Add a dedicated integration test that imports `bff.routes.ts` and asserts it resolves all symbols from the module's public barrel — this would catch re-emergence.

---

## Finding ARC-2

**Title:** `metric-engine` package fence (`boundaries/element-types`) is unenforced — 4 modules bypass it without CI detection  
**Severity:** High  
**Category:** Boundary violation / ADR-004 enforcement gap  
**Priority:** P1  

**evidenceRef:**  
- `apps/core/src/modules/data-quality/internal/application/queries/get-metric-trust.ts:15` — `import { evaluateGate } from '@brain/metric-engine'` (runtime import, not type-only)  
- `apps/core/src/modules/ai/provenance/ai-provenance.repository.ts:17` — `import { withBrandTxn } from '@brain/metric-engine'` (runtime)  
- `apps/core/src/modules/attribution/internal/credit-writer.ts:34-35` — `import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine'` (runtime) AND `import { computeAttributionCredit, computeAttributionClawback, ... } from '@brain/metric-engine'` (runtime)  
- `eslint.config.mjs:54-63` — `'boundaries/elements'` maps `'packages/metric-engine'` to element type `metric-engine` and `'apps/core/src/modules/*'` to `core-module`. For the boundary check to fire, the plugin must resolve `@brain/metric-engine` (a pnpm workspace alias) to `packages/metric-engine`. No import resolver is configured (`eslint.config.mjs` contains no `settings['import/resolver']` or equivalent `eslint-import-resolver-typescript` setting), so the plugin cannot match the alias — confirmed by `pnpm exec eslint apps/core/src/modules/data-quality/internal/application/queries/get-metric-trust.ts` returning exit 0 with no errors.  
- `eslint.config.mjs:86-97` — the rule text says "fenced to the measurement and analytics modules only" but `data-quality`, `ai`, and `attribution` are not in the allow-list.  

**Impact:**  
- `withSilverBrand` in `attribution/credit-writer.ts:160-167` issues a direct StarRocks query against `brain_silver.silver_touchpoint` — a plain SQL string outside the Analytics API path. This contradicts ADR-002 ("only the Analytics API reads StarRocks/Iceberg"). The violation is not yet wired in any composition root but the class is exported and ready to be wired.  
- `evaluateGate` in `data-quality` and `withBrandTxn` in `ai-provenance` are lower-risk because they use Postgres utilities from metric-engine (not StarRocks reads), but they represent undocumented consumers of a library explicitly fenced to two modules. Future metric-engine changes will not know to test these callers.  
- The fence's purpose — making metric-engine changes testable against a known set of callers — is defeated.  

**rootCause:**  
The `boundaries/element-types` rule requires a resolver plugin (e.g. `eslint-import-resolver-typescript`) to translate `@brain/*` monorepo aliases to filesystem paths. Without it, the plugin sees `@brain/metric-engine` as an unknown module and defaults to `allow`. Additionally, `withBrandTxn` and `withSilverBrand` are database utilities that logically belong in `@brain/db`, not `@brain/metric-engine`; their placement forces any module doing a brand-scoped Postgres or StarRocks write to import from the metric-engine package.  

**Fix:**  
1. Add `eslint-import-resolver-typescript` to the ESLint config and wire it as the resolver for `eslint-plugin-boundaries`. This makes `@brain/metric-engine` resolve to `packages/metric-engine` so the element-type boundary rule fires.  
2. Move `withBrandTxn` to `@brain/db` (or a new `@brain/pg-utils` package) so modules that need it do not have to import from metric-engine. Move `withSilverBrand`/`BRAND_PREDICATE` to the same package or keep them in metric-engine with explicit per-caller allow-list entries in the ESLint rule.  
3. Add `data-quality` and `ai` to the allow-list in `eslint.config.mjs` if their use is intentional, or refactor them to call metric-engine only via the analytics module.  
4. For attribution: the `credit-writer.ts` StarRocks read must route through the analytics module's query layer to honor ADR-002.  

**tenantImpact:** The StarRocks read in `attribution/credit-writer.ts` sets the `BRAND_PREDICATE` guard, so isolation is maintained in practice. However, bypassing the Analytics API collapses the "single isolation fuzz surface" guarantee — a future change to the brand predicate in credit-writer would need to be found independently, as it is not tested by the Analytics API isolation suite.  

**Detection:** Would appear as a runtime query executing outside the Analytics API observability span. Adding a test that asserts every StarRocks connection is acquired through the analytics module's `getPool()` factory would catch this.

---

## Finding ARC-3

**Title:** Collector spool implemented as Postgres table, not the disk WAL specified in ADR-003  
**Severity:** High  
**Category:** Architecture drift / ADR-003  
**Priority:** P1  

**evidenceRef:**  
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:187` — "Accept event → durable spool (disk WAL/embedded queue) → **ack** → produce to Redpanda"  
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:946 (ADR-003)` — "accept → disk WAL → fsync → ack → async produce. Consequences: (−) local disk is state on a 'stateless' service — needs EBS/NVMe PVC + drain-on-terminate."  
- `apps/collector/src/infrastructure/pg-spool.repository.ts:1-51` — the spool is a `pg.Pool` inserting into the Postgres table `collector_spool`. No disk WAL, SQLite, LevelDB, or embedded queue exists anywhere in the collector source tree (confirmed: `find apps/collector -name '*.ts' | xargs grep -l 'WAL|fsync|LevelDB|SQLite'` returns nothing).  
- `apps/collector/src/application/accept-event.usecase.ts:27-31` — "INSERT INTO collector_spool — this commit IS the durability anchor."  

**Impact:**  
- ADR-003's key benefit is "survives Redpanda outage" — Postgres spool achieves this.  
- ADR-003's key benefit is also "decouples durability from KafkaJS" — Postgres spool achieves this too.  
- But the documented failure model diverges: with a disk WAL, the collector is stateless (EBS/NVMe PVC) and survives Postgres being unreachable (it keeps spooling to disk). With a Postgres spool, Postgres unavailability = spool unavailability = accept-fail = SLA at risk on the 99.95% path.  
- In practice RDS Multi-AZ is configured (confirmed: `infra/terraform/envs/staging/main.tf:182: multi_az = true`), so Postgres is highly available, but the failure surface is different — a Postgres connection pool exhaustion or a transient RDS failover causes collector outage, not a local-disk-full event.  
- The ADR's "drain-on-terminate" note (needed for disk WAL) is irrelevant for Postgres spool, but Postgres connection management must handle scale-out (multiple collector replicas sharing one pool).  

**rootCause:**  
Postgres spool is simpler to implement and operates in the same DB the collector already has a connection to. A disk WAL requires a local stateful PVC, complicates rollout/drain, and adds operational surface. The implementer chose pragmatic simplicity and did not update ADR-003 to reflect the decision.  

**Fix:**  
ADR-003 should be updated to record the actual decision: "Postgres-backed spool (RDS Multi-AZ, 99.99%+ HA) instead of disk WAL; failure mode is Postgres connection exhaustion/failover rather than disk-full; drain-on-terminate is replaced by graceful connection draining on SIGTERM." The code matches a valid alternative approach — the doc just hasn't caught up. If the risk delta (Postgres HA vs disk durability) is accepted, close the drift by updating the ADR; if not, add the disk WAL layer on top of or instead of the Postgres spool.  

**tenantImpact:** SLA impact is uniform across all tenants — the collector is tenant-agnostic at the accept step. A Postgres outage during a peak Diwali/BFCM window drops ALL brand event acceptance simultaneously.  

**Detection:** Alert on `pg_pool_errors_total` on the collector; track `spool_pending_count` vs `spool_drain_lag_ms` as two separate SLIs. If pending count grows without drain, the spool is receiving but not draining — could indicate Redpanda down (good, spool is working) or Postgres slow (bad, spool inserts slowing ACKs).

---

## Finding ARC-4

**Title:** Identity bounded context (core/identity module) is a `.gitkeep` stub — merge/unmerge API, PII vault, and review queue are absent  
**Severity:** High  
**Category:** Missing component / bounded-context gap  
**Priority:** P1  

**evidenceRef:**  
- `apps/core/src/modules/identity/internal/.gitkeep` — the only file in the internal directory (confirmed: `find apps/core/src/modules/identity -type f` returns only `index.ts` and `.gitkeep`)  
- `apps/core/src/modules/identity/index.ts:7` — `export {}; // TODO: expose the public operations of this bounded context.`  
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:171` — the Identity bounded context owns: "Brain ID, `brain_id_alias`, merge/unmerge, phone guard, review queue, profile confidence, PII vault"  
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:377` — merge/unmerge REST endpoints specified: "Phase-1a: no human queue UI — conflicts simply stay apart... the worked queue + SLA + volume alarm arrive in 1b"  
- The async identity resolution exists in `apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts` and `apps/stream-worker/src/application/ResolveIdentityUseCase.ts` — but only handles the mint/link/merge write path off Bronze, not the control-plane merge/unmerge/review API.  

**Impact:**  
- Brands cannot manually trigger merges, unmerges, or review conflict pairs — the control-plane API for the identity graph is entirely missing.  
- The PII vault (plaintext email/phone storage behind per-brand KMS) is unimplemented; the send service (`notification` module) cannot look up plaintext contact info for outbound sends because the vault doesn't exist.  
- `brain_id_alias` table is created by `db/migrations/0017_identity_graph.sql` and written by stream-worker, but no core module reads or exposes it through the Analytics API. Customer 360 (the derived read model) therefore cannot be served.  
- Phase 1b is predicated on having Phase 1a identity in place; this stub makes the 1a→1b transition a larger lift than planned.  

**rootCause:**  
Identity was explicitly flagged as a Phase 1a deliverable with the review-queue UI deferred to 1b (doc-04 §18). The stream-worker async resolution is implemented. The core module control-plane (merge/unmerge REST + the PII vault + Customer 360 read model) was not yet implemented.  

**Fix:**  
Implement the minimum Phase-1a identity control-plane in `apps/core/src/modules/identity/internal/`:  
1. Read API: `GET /identity/customer/:brain_id` → Customer 360 (alias table lookup + aggregated behavior).  
2. Control API: `POST /identity/merge`, `POST /identity/unmerge` (deterministic, admin-only, audited).  
3. PII vault: a KMS-encrypted Postgres table `contact_pii(brand_id, subject_hash, email_enc, phone_enc)` writable by the identity module, readable by the notification module.  
4. Export the public contract from `apps/core/src/modules/identity/index.ts`.  

**tenantImpact:** Multi-tenant: every brand is affected. Without the PII vault, the notification send path (`notification` module) has no plaintext to look up — outbound email/CAPI passback cannot function correctly. Without Customer 360, the analytics read path for customer-level drill-down is broken across all tenants.  

**Detection:** Would surface as a 501 or 404 on identity control-plane routes if they were registered. Currently not routed at all — silent omission.

---

## Finding ARC-5

**Title:** Three bounded contexts (Billing, Recommendation, job-orchestration) are `.gitkeep` stubs with no business logic  
**Severity:** High  
**Category:** Missing components / bounded-context gaps  
**Priority:** P2  

**evidenceRef:**  
- `apps/core/src/modules/billing/internal/.gitkeep` — billing module has no implementation  
- `apps/core/src/modules/recommendation/internal/.gitkeep` — recommendation module has no implementation  
- `apps/core/src/modules/job-orchestration/internal/.gitkeep` — job-orchestration module has no implementation  
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:1000 (M12)` — job-orchestration: "declarative cron catalog + overlap-lock + backfill orchestration consumed by Argo"  
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:226-230` — Billing purpose: "meter realized GMV, apply tier%/cap/min-fee, seal immutable period snapshots, generate inspectable bill, dunning → read-only degradation, true-ups post forward"  
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:471-472` — Recommendation: "Phase-1 recommendations come from deterministic threshold detectors over registry metrics (not ML)"  
- `db/migrations/0020_provisional_gmv_as_of.sql` exists — billing schema is partially present but the module that reads/writes it is not implemented  

**Impact:**  
- **Billing:** Brain cannot generate invoices, compute tier fees, seal periods, or trigger dunning. The "billing loop" that doc-04 names as the earliest must-ship outcome is entirely absent. Realized GMV is computed by the metric engine but never metered, capped, or billed.  
- **Recommendation:** Home/Command Center shows no Top-3 actions; the recommendation contract specified in doc-04 §10.5 (deterministic detectors: CM2 falling, RTO spike, tracking-dark, connector failing) is not implemented. The product value-add for decision intelligence is zero.  
- **job-orchestration:** The declarative cron catalog and overlap-lock (preventing two dbt builds running simultaneously) are unimplemented. Jobs run via ad-hoc Node.js invocations without a scheduler manifest or lock mechanism.  

**rootCause:**  
Phase 1 was explicitly split into 1a/1b/1c to sequence delivery. Billing and Recommendation are 1b deliverables; job-orchestration is scaffolded but not implemented. These stubs are intentional placeholders — the risk is that they exist in the same monorepo without any "readiness gate" distinguishing them from implemented modules, creating the appearance of completeness.  

**Fix:**  
1. Add a `@stub` annotation or a `MODULE_READINESS: 'stub' | 'phase-1b' | 'phase-1c' | 'implemented'` constant to each stub's `index.ts`. This creates a greppable, CI-checkable marker for phase gates.  
2. Track the billing module's Phase-1b scope as issues (GMV meter, period seal, invoice generation). The migration (`0020_provisional_gmv_as_of.sql`) exists — implement the writer.  
3. Implement at least one recommendation detector (CM2 falling threshold) as the minimum to activate the Home/Command Center.  

**tenantImpact:** Multi-tenant: all brands affected. Missing billing means no revenue for the platform; missing recommendations means zero decision-intelligence value delivered.  

**Detection:** Silent — the stub modules export nothing and are never called. A feature-flag-driven "billing_enabled" check at the BFF layer would surface a 503 with a meaningful error rather than a route-not-found.

---

## Finding ARC-6

**Title:** Argo Workflow manifests absent — scheduled jobs have no CronWorkflow specs in infra/  
**Severity:** Medium  
**Category:** Infrastructure gap / deployment architecture  
**Priority:** P2  

**evidenceRef:**  
- `infra/argocd/README.md:1` — "ArgoCD — app-of-apps; per-env overlays (staging/prod); Argo Workflow specs. doc 04 §L."  
- `find infra/ -name '*.yaml' | xargs grep -l 'CronWorkflow\|argoproj.io/v1alpha1.*Workflow'` — returns nothing; no Argo Workflow YAML files exist in the repository  
- `apps/stream-worker/src/jobs/revenue-finalization.ts:29` — "Usage: node dist/jobs/revenue-finalization.js or via Argo CronJob targeting this file"  
- `apps/stream-worker/src/jobs/shopify-backfill/run.ts:9` — "Mirrors the revenue-finalization.ts pattern: standalone Node.js job invoked as `node dist/jobs/shopify-backfill/run.js`"  
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:118` — "scheduled jobs (Argo Workflows) run dbt builds, Bronze→StarRocks loads, the runtime parity-convergence monitor, connector backfill orchestration, and lakehouse maintenance"  
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:347` — "runtime convergence monitor — an Argo job reconciling StarRocks serving vs the Iceberg/Bronze recompute per brand (hourly in Phase 1)"  

**Impact:**  
- The revenue finalization, shopify-backfill, spend-repull, DQ-check, parity-convergence, and other scheduled jobs are implemented as Node.js scripts but have no scheduler manifests. They cannot self-schedule in production.  
- The runtime parity-convergence monitor (the second and third layers of the three-layer parity oracle from doc-04 §7.6) is entirely absent as a scheduled job — only the CI golden-fixture test exists. This collapses the dual-store parity assurance to a single CI-time check.  
- If jobs are triggered manually or via ad-hoc kubectl exec, they bypass the overlap-lock that job-orchestration (ARC-5) is supposed to enforce, risking concurrent dbt builds and duplicate finalization events.  

**rootCause:**  
The job scripts are implemented; the Argo Workflow manifests that schedule them are not. This is a "code exists but is not deployed" state. The Argo Workflow toolchain itself is not installed (no ArgoWorkflows Helm chart in `infra/helm/`).  

**Fix:**  
1. Create `infra/argo-workflows/` with `CronWorkflow` manifests for: `revenue-finalization` (nightly), `dbt-build` (scheduled off-peak), `parity-convergence-monitor` (hourly), `retention-erasure` (daily), `dq-freshness-check` (hourly).  
2. Add the Argo Workflows Helm chart to `infra/helm/`.  
3. Add an ArgoCD `Application` manifest pointing to the Argo Workflows namespace.  

**tenantImpact:** Multi-tenant: without the revenue-finalization job, realized revenue never moves from `provisional` to `finalized` for any tenant. Billing, attribution finalization, and all "finalized-only" analytics are permanently stuck on provisional data.  

**Detection:** The `recognition_label='finalized'` count in the ledger will be 0 or stale. Alert on `SELECT COUNT(*) FROM realized_revenue_ledger WHERE recognition_label='finalized' AND billing_posted_period = current_billing_period()` < threshold per active brand.

---

## Finding ARC-7

**Title:** Duplicate migration sequence `0033` — two files with identical numeric prefix  
**Severity:** Medium  
**Category:** Data architecture / migration integrity  
**Priority:** P2  

**evidenceRef:**  
- `db/migrations/0033_consent_record_tombstone.sql` — the consent SoR + tombstone  
- `db/migrations/0033_send_log.sql` — the operational send/notification log  
- Both confirmed present: `ls -la db/migrations/ | grep 0033` shows both files  
- `node-pg-migrate` uses the full filename (minus extension) as the migration name stored in `pgmigrations.name` (`node_modules/.pnpm/node-pg-migrate@8.0.4.../dist/legacy/runner.js:8: const nameColumn = "name"`) — so both will run and be tracked separately  
- Sort order: `compareFileNamesByTimestamp` uses numeric prefix (both = 33, tie) then `localeCompare` (`consent_record_tombstone` < `send_log` alphabetically) — so consent always runs first  

**Impact:**  
- `0034_capi_passback_log.sql` references `send_log` indirectly through the notification FK structure; as long as both 0033 files run before 0034 (guaranteed by numeric+alpha sort), there is no immediate breakage.  
- A future developer who runs `pnpm migrate:create` will get `0034_xxx` as their new file and may not notice 0033 is doubled; if they later add a migration depending on BOTH 0033 files being present, the ordering ambiguity becomes load-bearing.  
- CI comment (`pr.yml:60`) — "Apply all migrations through 0020" — only runs up to 0020, so this gap is not tested in CI at all.  
- Drift from the convention: all other migrations have unique sequences. The duplicate is a consistency violation that could confuse diff-based tooling or future auditors.  

**rootCause:**  
Two parallel feature branches created migrations simultaneously and both chose 0033 as the next available sequence number. The PR merge did not rename either file.  

**Fix:**  
Rename one file to `0033a_consent_record_tombstone.sql` or renumber it to `0033b_send_log.sql`, OR (preferred) renumber `0033_send_log.sql` to `0037_send_log.sql` (next available) and update `pgmigrations` table in all environments to reflect the rename. Use a migration naming gate in CI (`find db/migrations -name '*.sql' | sed 's/_[^0-9].*//g' | sort | uniq -d | grep .` returns non-empty → fail) to prevent recurrence.  

**tenantImpact:** Risk is schema-level, not per-tenant — all tenants share the schema. A migration failure during deployment would block schema updates for every brand simultaneously.  

**Detection:** Add CI check: `find db/migrations -name '*.sql' | cut -d_ -f1 | sort | uniq -d | xargs -I{} echo "DUPLICATE MIGRATION PREFIX: {}"` — fails if any numeric prefix appears more than once.

---

## Finding ARC-8

**Title:** Helm charts, Dockerfiles, and Argo deployment artifacts absent — CI build-and-scan is silently skipped  
**Severity:** Low  
**Category:** Deployment infrastructure gap  
**Priority:** P3  

**evidenceRef:**  
- `infra/helm/README.md:1` — "Helm — one chart per deployable (collector / stream-worker / core / litellm). doc 04 §K."  
- `ls infra/helm/` — only `README.md`, `authentik/`, and empty `charts/` directory; no chart directories for collector/core/stream-worker/web  
- `infra/argocd/envs/prod/core.yaml:13` — `path: infra/helm/core` — references a directory that does not exist  
- `find apps/ -name 'Dockerfile' 2>/dev/null` — returns nothing; no Dockerfiles exist  
- `.github/workflows/pr.yml:142,146` — "Build Docker image (affected only)" uses `-f apps/${{ matrix.app }}/Dockerfile` — but the affected check script (`jq` on turbo dry-run) falls back to `echo ""` on error (line 134), setting `skip=true` and silently skipping the Docker build and all downstream Trivy/OSV scans for all apps  

**Impact:**  
- Container security scans (Trivy CVE, OSV dependency scan) are conditionally skipped in every PR because the affected-set detection returns empty when apps have no `build` task output yet. This means the CI security gates are not exercised.  
- ArgoCD application sync will fail for every prod/staging environment that references `infra/helm/core` etc. — the CD pipeline cannot deploy.  
- The `infra/helm/README.md` claims charts exist, misleading operators who assume the CD pipeline is functional.  

**rootCause:**  
Infrastructure-as-code lagged behind application code. Dockerfiles and Helm charts are typically scaffolded during a hardening/DevOps sprint; that sprint has not yet run. The CI workflow was written to a future state that includes these files.  

**Fix:**  
1. Create minimal single-stage `Dockerfile` for each app (`apps/collector/Dockerfile`, `apps/core/Dockerfile`, `apps/stream-worker/Dockerfile`, `apps/web/Dockerfile`).  
2. Create Helm chart skeletons under `infra/helm/collector/`, `infra/helm/core/`, `infra/helm/stream-worker/` with `Chart.yaml` + `values.yaml` + `values-prod.yaml`.  
3. Until Dockerfiles exist, guard the CI build step with an explicit file-existence check (`test -f apps/${{ matrix.app }}/Dockerfile`) rather than silently skipping via the affected-set fallback.  

**tenantImpact:** No direct per-tenant runtime impact today (no CD pipeline is running). Impact is operational: no way to ship code to production via the GitOps CD pipeline.  

**Detection:** ArgoCD sync status for `core-prod` and `collector-prod` applications will show `OutOfSync` or `Error` because the Helm path does not exist. A health check on the ArgoCD application status surface exposes this immediately once the app-of-apps is activated.
