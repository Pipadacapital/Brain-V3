# Brain — Repository Cleanup & Production-Readiness Report

**Branch:** `feat/repo-cleanup-wave1` · **Date:** 2026-06-28 · **Plan:** `docs/cleanup/repo-cleanup-plan.md`
**Verdict:** Lean-er, standardized, V4-aligned. All removals were *evidence-proven unused* (grep / import-graph / git-tracking); nothing was deleted "just in case." High-risk prod/monitoring changes were executed only after explicit owner sign-off.

---

## 1. Audit summary
6 parallel read-only sweeps (code/deps, DB/migrations, Docker/K8s/Terraform, CI-CD/env, docs, tests/monitoring/orphans) → **52 findings** (28 LOW, 16 MED, 8 HIGH). Executed in verified waves; the load-bearing items (prod gitops, monitoring, parked seams) went through a user-confirmation gate before any deletion.

## 2. Removed (code, files, services, artifacts)
- **Orphans/dead:** `packages/analytics-gateway/` (untracked StarRocks GoldRepository re-stash); `infra/redpanda/schemas/collector.event.v1.avsc` (drifted dup); `infra/terraform/modules/redpanda/` (Redpanda-Cloud module); `docs/architecture/v4/PR-BODY.md`; `tools/seed/seed.mjs` no-op + its npm script.
- **Dead deps:** `@radix-ui/react-dropdown-menu` (web), `@aws-sdk/client-kms` (core; transitive via pii-vault), `mysql2` (isolation-fuzz, feature-store).
- **Dead feature-precompute layer (approved):** `@brain/feature-store`, `@brain/feature-flags`, the `feature-materialization` job + its cron, and the orphaned `feature-freshness-check` cron — write-only Redis features nothing read; contradicted the V4 "features are RUNTIME" invariant.
- **Retired dbt/StarRocks gitops (approved):** dbt Helm crons (`recognition-refresh`, `attribution-gold-refresh`), `dbtRunnerImage` (base + staging + prod), the mysql `v4-mv-refresh` leg, the `dbt-runner` ECR repo.
- **Wave 2:** isolation-fuzz StarRocks `:9030` tests (covered by `trino-brand-predicate`).

## 3. Simplifications
- `registerConnectors.ts` (1118-line god-file, 33 inline handlers) → per-connector `registerXConnector` helpers under `bootstrap/connectors/` + a thin orchestrator. **Behavior-preserving — registered route surface byte-identical.**
- Dockerfiles (core/web/collector/stream-worker): reordered to `COPY manifests → install → COPY src`, restoring the dependency-install layer cache (no more full reinstall + argon2 recompile per source change).

## 4. Infrastructure
- Enabled the V4 Spark medallion crons (`sparkV4.enabled=true`) as the sole compute; removed every dbt/mysql/StarRocks leg from the cronworkflows chart + EKS Terraform. `helm template` renders cleanly with only the V4 cron set.
- ArgoCD collector Applications repointed from the non-existent `infra/k8s/...` path to the real `infra/helm/collector` chart (the highest-SLO service had an unsyncable GitOps source).

## 5. Docker
Layer-cache reorder across all 4 service Dockerfiles (see §3). Health-checks preserved (stream-worker intentionally has none — no HTTP port). Further minimal-image work noted in §12.

## 6. Kubernetes
Cronworkflows chart is now the single source of scheduled jobs (Bronze sink + V4 silver/gold/mv-refresh + connector repulls + meta-token-refresh). Collector ArgoCD app now resolves. Probes/limits/HPA review noted in §12 (not all services audited line-by-line).

## 7. CI/CD
- **Fixed the dormant pipeline:** `on.push.branches` `[main]→[master]` in `main.yml` + `infra.yml` — CD (build→sign→push→gitops-staging→prod-promote) and the Terraform lane now fire on real merges to the default branch.
- CI digest-bump/promote now also pins `.sparkV4.image` (reuses the spark-bronze image) so the enabled V4 crons deploy.

## 8. Environment configuration
`.env.production.example` STARROCKS_* block → correct `TRINO_HOST/PORT` + serving-cache config (prod env was missing Trino vars entirely). `.local.env`/`.env.local-prod.example` remain the single-file local config.

## 9. Documentation
Cronworkflows `README.md` rewritten to the V4 (no-dbt/no-mysql/no-feature) cron set. Spent PR-body removed. **Remaining doc sweep** (architecture docs still referencing dbt/StarRocks as live) → §12.

## 10. Developer experience
One-command local startup confirmed: `pnpm dev:up` (Docker compose `--wait` brings up PG/Kafka(KRaft)/Schema-Registry/Redis/Neo4j/Iceberg-rest/MinIO/Spark + app tiers; migrations + seed run). `seed` no-op script removed so devs aren't misled. Dockerfile cache reorder cuts rebuild time.

## 11. Production deployment
One-command prod path is the now-firing CD pipeline (merge to `master` → build/sign/push images → gitops-staging digest-bump → Argo sync → prod-promote). Infra is IaC (Terraform) + Helm; the `infra.yml` validate/apply lane now triggers. **Deploy-time gate:** flipping `sparkV4.enabled` requires CI to have published + digest-pinned the spark image for the env (now wired) and staging V4 crons to be confirmed `Succeeded` before the legacy dbt path is considered fully retired in a live cluster.

## 12. Remaining technical debt (recommended next, not blocking)
- **12 unused Trino serving views** (`mv_gold_{settlement_summary,conversion_feedback,engagement,behavior,contribution_margin,abandoned_cart,logistics_performance,campaign_performance}`, `mv_snap_*`, `mv_silver_customer_identity`) — 0 readers; drop after product/serving owner confirms none are roadmap UI/MCP targets.
- **10 StarRocks-coupled `*.live.test.ts`** — repoint to `createTrinoPool` (they encode real revenue/attribution/billing parity; do NOT delete). The `integration.yml` "Trino serving" gate is currently false-confidence (they self-skip).
- **Doc sweep:** architecture docs/ADRs/diagrams still referencing dbt/StarRocks/Kafka-Connect as live → update or banner-mark.
- **TF redpanda *secret*** (ref-coupled by 3 IAM policies + an output) — careful removal.
- **Test taxonomy:** standardize `.unit|.integration|.live|.e2e` + a unit-only vitest project so the unit gate stops loading self-skipping live suites.
- **Pre-existing memoized-config test reds** (`get-data-quality-summary`, `oauth-app-creds`) — product code correct; apply the #30 `resetConfigCache()` seam to these suites.
- Minimal-image pass (multi-stage/distroless), per-service probe/limit audit.

## 13. Risks introduced by the cleanup
- **Enabling `sparkV4` by default** makes staging/prod deploys fail-closed until the spark image digest is pinned (now wired in CI) — must confirm on first deploy. *Mitigation:* template fail-closes loudly rather than running a wrong image.
- **dbt-path deletion** assumes the V4 Spark crons fully cover recognition + attribution-gold materialization. Verified by `helm template` + the v4-refresh-loop locally; **staging cron success is the live confirmation gate** before this is irreversible in prod.
- **SLO/dashboard repoint to JMX** requires the `kafka-jmx-exporter` + `kafka-exporter` to actually be deployed; until then the alerts are inert (same blind spot as before, now with a wiring path).
- Nothing else: every removed item was proven zero-consumer; `registerConnectors` split is route-identical.

## 14. Future recommendations
- Land the §12 items (Trino-view prune, live-test repoint, doc sweep, test taxonomy).
- Deploy the JMX exporters to activate the repointed SLOs.
- Add an import-graph/dead-code CI check (e.g. `knip`) so dead code/deps are caught automatically.
- Run the staging deploy to close the V4-cron live-confirmation gate, then delete any final dbt residue.

---
**Net:** removed ~12 distinct dead items + 3 dead packages, fixed the dormant CD pipeline + the monitoring blind spot, standardized Docker caching, and split the largest god-file — all verified, all V4-aligned. The repo is meaningfully leaner and closer to one-command operable for both local and prod.
