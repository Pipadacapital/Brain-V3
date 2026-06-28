# Brain — Repository Cleanup Plan (Consolidated)

**Status:** Drives the next (destructive) phase, executed in verified waves.
**Source:** Synthesis of 5 area audits (App+Deps, Database, Infrastructure, CI/CD+Env, Test+Monitoring+Tooling), extending `docs/cleanup/repo-cleanup-audit.md`.
**Date:** 2026-06-28 · **Branch context:** `master` (default), audits run on `feat/post-merge-followups`.
**Golden rule:** Nothing is removed unless an audit *proved* it unused (grep / import-graph / git-tracking evidence). Anything not provably dead is `needs-user-confirm`. Append-only ledgers (migrations, ADRs) and protective test suites are NEVER deleted — they are repointed or banner-marked.

---

## 0. Headline counts

### Findings by area

| Area | Total findings | remove | consolidate/standardize | simplify | document | needs-user-confirm |
|---|---|---|---|---|---|---|
| App code + dependencies | 7 | 3 | 0 | 1 | 0 | 3 |
| Database (migrations/Spark/Trino/serving) | 6 | 1 | 1 | 0 | 3 | 1 |
| Infrastructure (compose/Helm/Argo/TF/observe) | 15 | 3 | 2 | 2 | 2 | 6 |
| CI/CD + env config + build scripts | 13 | 4 | 0 | 0 | 4 | 5 |
| Tests + monitoring + dev tooling | 11 | 2 | 3 | 1 | 1 | 4 |
| **Raw total** | **52** | **13** | **6** | **4** | **10** | **19** |

> **Dedup:** `packages/analytics-gateway/` is flagged independently by **4 of 5** audits (App, DB, Infra, CI/CD, Test). It is **one** physical orphan → counted once in the waves below (12 distinct removable items, not 13).

### Findings by risk

| Risk | Count | Examples |
|---|---|---|
| LOW | 28 | analytics-gateway, unused deps, retired StarRocks env block, PR-BODY.md, seed.mjs stub, stale comments |
| MEDIUM | 16 | feature-store cron, 12 unused Trino views, isolation-fuzz StarRocks tests, collector ArgoCD path, live-test repointing |
| HIGH | 8 | dbt Helm crons + ECR repo, duplicate 0033 migration, create→drop migration chains, brain-slo redpanda alerts |

### Estimated blast radius

- **Zero-runtime-impact removals (Wave 1):** ~12 items. Most are untracked files, unused deps, or retired-system config templates. PR diff is small; `analytics-gateway` won't even appear in a diff (untracked → filesystem delete + lockfile regen).
- **Ref-coupled (Wave 2):** ~8 items touching CI/CD triggers, ArgoCD source paths, Helm values, and test harness repointing. Each needs a paired ref update + green CI to verify.
- **Load-bearing / confirm (Wave 3):** ~10 items spanning prod gitops (dbt crons, mysql-refresh leg, dbt-runner ECR), monitoring (redpanda SLO alerts), and the feature-precompute layer. These need infra/product owner sign-off because they touch prod deploy or could mask a latent consumer.
- **Documentation:** ~10 banner/comment edits + 1 broken-harness fix. No runtime impact; reduces "is this the current architecture?" ambiguity.

---

## 1. Removal waves

### WAVE 1 — LOW risk, auto-removable + verify (orphans, dead files, unused deps, retired-system leftovers with proof)

| # | Path | Why obsolete | Affected refs to update | Verify step |
|---|---|---|---|---|
| 1.1 | `packages/analytics-gateway/` (whole dir) | Untracked re-stash of deleted StarRocks `GoldRepository`/Customer360. `git ls-files`=empty; zero importers across repo; superseded by live metric-engine + Trino path. | `pnpm-lock.yaml:440` (stale `packages/analytics-gateway:` stanza, auto-picked by `packages/*` glob). | `rm -rf packages/analytics-gateway` → `pnpm install` → confirm lock stanza gone + `pnpm -r typecheck` green. Won't appear in PR diff (untracked). |
| 1.2 | `apps/web/package.json` → `@radix-ui/react-dropdown-menu` | Unused web dep; no `dropdown-menu.tsx`, zero `DropdownMenu` imports (excl node_modules/.next). | None (no importers). | Remove dep line → `pnpm install` → `pnpm --filter web build`. |
| 1.3 | `apps/core/package.json` → `@aws-sdk/client-kms` | KMS consumed transitively via `@brain/pii-vault`; `apps/core/src` never imports the client directly. | Verify `@brain/pii-vault` declares its own `@aws-sdk/client-kms` first. | Remove dep → `pnpm install` → `pnpm --filter @brain/core typecheck` + a KMS-path live boot. |
| 1.4 | `infra/redpanda/schemas/collector.event.v1.avsc` | Orphan **drifted** duplicate of canonical `packages/contracts/generated/avro/brain.collector.event.v1.avsc` (the one the collector loads). Differs by `diff`; zero readers. | None. Canonical schema unaffected. | `git rm` → grep `collector.event.v1.avsc` returns only the contracts copy. |
| 1.5 | `infra/terraform/modules/redpanda/main.tf` (whole module) | Redpanda Cloud TF module; replaced by self-hosted Kafka KRaft. Zero `source = "../../modules/redpanda"` refs; absent from `infra.yml` validate matrix. | None wired. Also frees `topics.yml` of its "production applier" claim. | `git rm -r` → `grep -r 'modules/redpanda' infra/terraform/envs` = 0. |
| 1.6 | `infra/terraform/modules/secrets/main.tf` lines 48-59 (`aws_secretsmanager_secret "redpanda"`) | Provisions Redpanda Cloud API-key secret for a retired cluster. Module stays (grafana etc. live); drop only this resource block. | dev/staging `secrets` consumers (resource removal only). | `terraform plan` in dev → only the redpanda secret is destroyed. |
| 1.7 | `.env.production.example` lines 52-62 (8× `STARROCKS_*`) | StarRocks removed (Trino-over-Iceberg). Zero `STARROCKS_` refs in prod source/config schemas (only in `.live.test.ts`). | Pair with **doc fix 9.x** adding `TRINO_HOST`/`TRINO_PORT`/`TRINO_SERVING_CACHE_*`. | Edit file → grep `STARROCKS_` in `.env.production.example` = 0. |
| 1.8 | `docs/architecture/v4/PR-BODY.md` | Spent one-off PR body for V4 PR #275, already MERGED (`f21944b`). Zero inbound links; not in `00-INDEX`. | None. | `git rm` → grep `PR-BODY` in docs = 0. |
| 1.9 | `tools/seed/seed.mjs` | 3-line no-op (`console.log('TODO: seed …')`) wired as `pnpm seed`; misleads new devs. Working seeds are the sibling `.sh`/`seed-line-item-order.mjs`. | root `package.json:27` `"seed"` script — remove entry, point devs at `.sh` seeds. | Remove file + script → `pnpm seed` no longer advertised; README/dev-docs point to `.sh`. |
| 1.10 | `packages/feature-store/package.json` → `mysql2` dep | Residual StarRocks driver; runtime reads Gold over Trino. Only importer is the dead `feature-store.live.test.ts`. | Moot if 3.1 (whole package) is approved; otherwise remove dep + the StarRocks live-test. | Remove dep → `pnpm install` → package builds without mysql2. (Defer if package slated for removal.) |

**Wave 1 exit gate:** `pnpm -r typecheck` green · `pnpm install --frozen-lockfile` clean (after intentional lock regen) · v4-naming-guard passes · no new red unit suites.

---

### WAVE 2 — MEDIUM risk (needs paired reference updates before/with removal)

| # | Path | Why | Affected refs to update | Verify step |
|---|---|---|---|---|
| 2.1 | `tools/isolation-fuzz/src/starrocks.test.ts` + `src/silver-touchpoint.test.ts` | Both connect to StarRocks `:9030` and `@see` DELETED `db/starrocks/{bootstrap,row_policy_template}.sql`. Superseded by sibling `trino-brand-predicate.test.ts`. | Fix dangling `@see` in `index.ts:24`; remove now-unused `mysql2` from `tools/isolation-fuzz/package.json` after. | **Confirm `trino-brand-predicate.test.ts` covers the same isolation assertions**, then `git rm` the two + fix `@see` → `pnpm --filter isolation-fuzz test:isolation` green. |
| 2.2 | `infra/argocd/envs/{prod,staging}/collector.yaml` (broken `path: infra/k8s/collector/overlays/*`) | `infra/k8s/` does not exist anywhere; a full unused `infra/helm/collector` chart does. Highest-SLO service has an unsyncable GitOps source. | Repoint both Applications to `path: infra/helm/collector` + `values-<env>.yaml` (matches every other service). | `kubectl apply --dry-run` / Argo app-of-apps render resolves; chart templates present. |
| 2.3 | `e2e-gate.wf.js` removal is **deferred to Wave 3** (conflicting audit verdicts — see 3.x). | — | — | — |

**Wave 2 exit gate:** ArgoCD apps render + sync (dry-run) · isolation-fuzz suite green against Trino predicate · CI `test:isolation` job passes.

---

### WAVE 3 — HIGH risk / needs-user-confirm (not provably unused, or load-bearing prod/monitoring)

| # | Path | Why flagged confirm | What sign-off is needed | Proposed action on confirm |
|---|---|---|---|---|
| 3.1 | `packages/feature-store/` + `apps/stream-worker/.../feature-materialization/run.ts` + dep entry | Write-only dead-end: materializes features into a Redis online store **nothing reads**; contradicts V4 "features are RUNTIME, no precompute" invariant. BUT wired as a prod Helm cron (`cronworkflows/values.yaml:221-223`, hourly :40). | **Infra owner:** confirm no out-of-band consumer reads `feat:*` Redis keys. | Drop the cron + package + stream-worker dep. |
| 3.2 | `packages/feature-flags/` + `apps/core/package.json` dep | 95-line ADR-010 kill-switch stub; zero importers after safe-pass. Deliberately-parked seam. | **Team:** confirm kill-switch isn't about to be wired. | Remove package + dep entry. |
| 3.3 | dbt Helm crons: `infra/helm/cronworkflows` `dbtRunnerImage` + `recognition-refresh` + `attribution-gold-refresh` (values.yaml:25-27,169-212; cronworkflows.yaml:11-13) | Built from DELETED `db/dbt/Dockerfile`; image can never get a digest → fail-closed. Superseded by V4 Spark crons (`templates/spark-v4.yaml`, currently `sparkV4.enabled:false`). | **Infra owner:** switch `sparkV4.enabled:true` and verify V4 silver/gold crons run BEFORE deleting dbt legs. | Coordinated: enable Spark crons → delete dbt crons + `dbtRunnerImage`. |
| 3.4 | `infra/helm/cronworkflows` `v4-mv-refresh` leg + `sparkV4.mysqlImage` (spark-v4.yaml:160-211) | Uses `mysql:8.0` to `REFRESH MATERIALIZED VIEW` over StarRocks MySQL wire (reads `STARROCKS_*`). StarRocks gone; mv SYNC refresh now done by `v4-refresh-loop.sh` (Spark). | **Infra owner:** repoint refresh to Spark/Trino path. | Remove the leg + `mysqlImage`; rely on Spark mv SYNC. |
| 3.5 | `infra/terraform/modules/eks/main.tf:234-238` (`dbt-runner` ECR repo) | ECR repo for an image that can't be built (db/dbt deleted). Sits empty. | Tied to 3.3. | Drop `dbt-runner` from services array once dbt crons go; keep `spark-bronze`. |
| 3.6 | `.github/workflows/main.yml:4` + `infra.yml:12` (`on.push.branches: [main]`) | Default branch is `master` → entire CD pipeline (build→sign→push→gitops→promote) and infra TF lane **never fire** on real merges. Documented open gap. | **User:** confirm intended trigger branch (recommend `[master]` or `[master, main]`). | Change triggers to `[master]`; unblocks `gitops-staging`/`prod-promote`. |
| 3.7 | 12 unused Trino serving views: `mv_gold_{settlement_summary,conversion_feedback,engagement,behavior,contribution_margin,abandoned_cart,logistics_performance,campaign_performance}`, `mv_snap_{order_state,identity_link,attribution_credit}`, `mv_silver_customer_identity` | Built every refresh (`enabled=True`), but exact-name grep = 0 readers across apps/packages. Wasted serving projections + redundant precompute. `snap_*` Iceberg tables ARE read by Spark directly — only the Trino VIEW is unused. | **Product/serving owner:** confirm none are roadmap UI/MCP targets. | Drop the views (and consider disabling marts) — see also 2.x consolidation 3.x below. |
| 3.8 | 10 StarRocks-coupled `apps/core/**/*.live.test.ts` (jobs, ad-spend/attribution/revenue analytics, billing ×3, recommendation ×2, ask-brain-scalars) | Connect via `mysql2` to `:9030`; skip-guard `if(!srUp) return;` → pass GREEN with zero assertions. `integration.yml` advertises them as the "Trino serving" gate (false confidence). v4-naming-guard excludes `*.test.ts` so coupling is uncaught. | **User:** confirm equivalent Trino-over-Iceberg live coverage exists. | Repoint to `createTrinoPool` (consolidate, see §1 strategy) — do NOT delete; they encode real revenue/attribution/billing parity. |
| 3.9 | `infra/observe/alerts/brain-slo.rules.yml` (8 alerts on `redpanda_kafka_*`) | Keyed off metrics only Redpanda emitted; the `redpanda` Prometheus scrape job is COMMENTED OUT post-KRaft swap and apache/kafka emits no such metrics → DLQ/lag/ingest SLO alerts **can never fire** (monitoring blind spot). | **User/infra:** approve wiring a JMX exporter. | Add `kafka-jmx-exporter` scrape job + repoint 8 expressions to JMX metric names. Do NOT delete the SLO intent. |
| 3.10 | `infra/helm/authentik/values-dev.yaml` | Lone Authentik IdP values file; no Chart.yaml/templates/ArgoCD app. Dangling IdP-strategy stub. | **Product/auth:** is Authentik the chosen IdP? | Remove if not chosen; keep if pending decision. |
| 3.11 | `tools/dev/e2e-gate.wf.js` | Hardcoded absolute repo path + brand UUIDs; zero refs in package.json/CI/compose/`.eos-workflows`. CI/CD audit says `remove`; Test audit says `needs-user-confirm` (orchestrator may invoke by direct path). | **Owner:** confirm no out-of-graph orchestrator calls it by path. | Remove (or at minimum parameterize the path + UUIDs). |
| 3.12 | `.github/workflows/parity-oracle.yml` + `.github/pr-bodies/*.md` | Intentional StarRocks-parity tombstone (`workflow_dispatch`-only, gates nothing) + one-time PR-body scratch md. Rationale survives in git + CLAUDE.md. | **User's call** — keep as tombstone or delete. | Optional delete; harmless if kept. |

**Wave 3 exit gate:** each item individually signed off; prod gitops items (3.3–3.5) verified with Spark V4 crons green in staging BEFORE dbt-path deletion; CD trigger fix (3.6) confirmed by a test merge building an image.

---

## 2. Simplification list (`action=simplify`)

| Item | Concrete refactor |
|---|---|
| `apps/core/src/bootstrap/registerConnectors.ts` (1118 lines, single function, ~33 inline handlers; repo's largest source file; sole caller `main.ts`) | Behavior-preserving extraction into per-connector `registerXConnector(app, deps)` helpers, mirroring the existing `registerAllWebhookRoutes`/`registerMetaCallbackRoute` pattern. Keep `registerConnectors` as a thin orchestrator that calls the helpers. Mechanical, no behavior change. |
| `apps/{core,web,collector,stream-worker}/Dockerfile` — `COPY . .` before `pnpm install --frozen-lockfile` | Reorder: COPY only `package.json` + `pnpm-lock.yaml` + workspace manifests first → `pnpm install` → then `COPY . .`. Restores dependency-install layer cache (avoids full reinstall + argon2 node-gyp recompile on every source change). Verify workspace install still resolves manifests-first. `stream-worker` keeps no HEALTHCHECK (no HTTP port). |
| Test-suite naming taxonomy (138 plain `*.test.ts`, 49 `.live`, 17 `.unit`, 13 `.integration`, 14 `.e2e`, plus ~14 one-off qualifiers) | Standardize on `.unit|.integration|.live|.e2e` suffixes. Add an exclude glob (or a vitest project per tier) so `test:unit` (`vitest run` with no exclude in apps/core + metric-engine) stops loading live/e2e suites — today they only stay green by self-skipping when infra is down. Makes the unit gate genuinely unit-only and live/e2e opt-in. |

---

## 3. Standardization plan (Docker / K8s / Terraform / CI-CD / env)

### One-command LOCAL
- **Resolved already:** `pnpm dev:up` (`tools/dev/dev-up.sh`) is a true one-command bring-up (compose `--wait` → migrate → bootstrap → v4-refresh → apps). The prior single-command gap is closed.
- **Add `pnpm dev:all`** (or `dev-up --with-observe`) that appends `--profile observe`, so Grafana/Prometheus/Loki/Tempo/otel-collector start locally. Today apps export OTLP to `tempo:4317` but the observe stack never boots in the default profile set (core+ingest+lakehouse) → traces silently go nowhere. Standardize (do not remove the services).
- **Env template parity (prevents fresh-boot crashes):**
  - Add `REDPANDA_BROKERS=localhost:9092` to `.env.local-prod.example` (collector config requires it as `z.string().min(1)` with no default; omission fail-closes the collector at parse).

### PROD env config
- `.env.production.example`: delete the 8 `STARROCKS_*` vars (Wave 1.7) and **add** `TRINO_HOST` / `TRINO_PORT` (+ `TRINO_SERVING_CACHE_*`). Today prod template lacks Trino vars → a prod deploy silently falls back to `localhost:8090` for serving. Reword the `dbt` comment on line 151 (Bronze read-source flag now drives Spark-on-Iceberg, not dbt).

### Production CI/CD
- **Fix CD trigger (3.6):** `main.yml` + `infra.yml` `push:[main]` → `[master]`. This is the single highest-leverage CI fix — the whole build→sign→push→gitops→promote pipeline is currently dark.
- **Add `s3-iceberg-medallion` to the `infra.yml` tf-validate-modules matrix** (lines 70-81). It's consumed by dev+staging (Silver/Gold buckets) but never `terraform validate`d. Do NOT add the dead `redpanda` module (remove it per 1.5).
- **Reword `pr.yml` ledger-gate comment** (lines 76-85) from StarRocks → Trino-over-Iceberg.

### K8s / ArgoCD
- Repoint both `collector.yaml` Applications from non-existent `infra/k8s/collector/overlays/*` to the existing `infra/helm/collector` chart (2.2).
- Coordinated dbt→Spark cron cutover (3.3–3.5): enable `sparkV4.enabled`, verify V4 silver/gold crons, then delete dbt crons + `mysqlImage` mv-refresh leg + `dbt-runner` ECR repo.

### Terraform
- Remove dead `modules/redpanda` (1.5) + the `redpanda` secret resource (1.6) + (coordinated) `dbt-runner` ECR (3.5).
- Reword `infra/terraform/README.md` + `s3-iceberg-medallion/main.tf` comments (StarRocks reader / dbt model → Trino/Spark). IAM/bucket resources stay valid — prose only.

---

## 4. The 14-section deliverable report

### (1) Audit summary
Five area audits extended the prior `repo-cleanup-audit.md`. Headline: the **application TypeScript and the local dev experience are clean and V4-correct** — Spark-on-Iceberg compute, Trino-over-Iceberg serving, dbt+StarRocks removed from runtime, money is bigint+currency throughout, `brand_id`-first isolation holds, and `pnpm dev:up` is a real one-command bring-up. The residual cleanup mass is concentrated in three pockets: (a) **retired-system residue** (StarRocks/dbt/Redpanda-Cloud) that survived in the **prod gitops + IaC + env-template + test/monitoring** layers — config and tooling the migrations never swept; (b) a small set of **genuine orphans** (untracked `analytics-gateway`, unused deps, no-op seed stub, spent one-off docs); and (c) **false-confidence tests + never-firing alerts** that look green/healthy but assert nothing. 52 raw findings (12 distinct removable items after dedup), skewed LOW-risk. No money-model, isolation, or runtime-architecture violations found.

### (2) Removals
13 `remove`-classed findings → 12 distinct items (analytics-gateway dedups across 4 audits). Sequenced into three waves (§1): **Wave 1** (10 LOW items — orphan dir, 3 unused deps, drifted Avro schema, redpanda TF module + secret, StarRocks env block, spent PR-BODY.md, no-op seed.mjs); **Wave 2** (isolation-fuzz StarRocks tests with paired `@see`/mysql2 cleanup, collector ArgoCD path repoint); **Wave 3** (10 confirm-gated items — feature precompute layer, feature-flags stub, dbt Helm crons + ECR, mysql mv-refresh leg, 12 unused Trino views, 10 StarRocks live-tests, redpanda SLO alerts, authentik stub, e2e-gate scratch, parity tombstone). The largest "removal" is conceptual: the StarRocks `.live`/`.e2e`/`.parity`/`.isolation` tiers are **repointed to Trino, not deleted** — they encode real revenue/attribution/billing/Bronze parity coverage.

### (3) Simplifications
Three (§2): split the 1118-line `registerConnectors.ts` god-file into per-connector helpers (sole caller, mechanical); reorder all four node Dockerfiles to copy manifests before `pnpm install` (restores layer cache, kills repeated argon2 recompiles); and impose a `.unit|.integration|.live|.e2e` test taxonomy with a real `test:unit` exclude so the unit gate stops silently loading self-skipping live suites.

### (4) Infrastructure
Local compose is healthy (profiled services, consumed volumes, healthchecks on all stateful services, true one-command boot). The dead weight is in **prod gitops + IaC**: a Redpanda-Cloud TF module + secret (removable), dbt CronWorkflows + `dbtRunnerImage` + `dbt-runner` ECR repo (all build from a deleted Dockerfile → fail-closed; coordinated removal after enabling V4 Spark crons), a `v4-mv-refresh` leg that issues StarRocks MySQL-wire `REFRESH` (repoint to Spark), a broken collector ArgoCD source path (`infra/k8s/` doesn't exist → repoint to the existing `infra/helm/collector` chart), and a dangling Authentik values file. Stale TF prose (StarRocks reader / dbt model) to reword.

### (5) Docker
Four node Dockerfiles share a layer-cache inefficiency (`COPY . .` before install). Fix is a behavior-preserving copy reorder. `stream-worker` correctly has no HEALTHCHECK (no HTTP port) — leave. No dead Dockerfiles; `db/dbt/Dockerfile` is already gone (which is *why* the dbt Helm crons are dead).

### (6) K8s
Two ArgoCD collector Applications point at a non-existent `infra/k8s/collector/overlays/*` while a complete `infra/helm/collector` chart sits unused — the highest-SLO service has an unsyncable GitOps source. Repoint to the Helm chart with `values-<env>.yaml` to match every other service. The dbt→Spark CronWorkflow cutover (enable `sparkV4`, then delete dbt legs) is the main coordinated K8s change.

### (7) CI/CD
**Critical:** `main.yml` + `infra.yml` trigger on `push:[main]` but the repo runs on `master` → the entire CD pipeline and infra TF lane have never fired on a real merge. Fix the trigger to `[master]`. Secondary: add the load-bearing `s3-iceberg-medallion` module to the tf-validate matrix; reword the StarRocks ledger-gate comment in `pr.yml`; decide on the `parity-oracle.yml` tombstone and `.github/pr-bodies/` scratch. The v4-naming-guard correctly excludes `*.test.ts`, which is *why* 10+ StarRocks-coupled live tests slipped the gate — the taxonomy/repoint fix closes that.

### (8) Env config
`.env.production.example` is the worst-drifted artifact: it carries 8 dead `STARROCKS_*` vars and is **missing** the `TRINO_HOST`/`TRINO_PORT` that V4 serving requires (prod would silently fall back to `localhost:8090`). `.env.local-prod.example` is missing `REDPANDA_BROKERS` (collector fail-closes at parse on a fresh boot). `packages/config` schemas are the source of truth and are clean — only the templates drifted. Fixes are template-only (delete StarRocks block, add Trino + Redpanda vars, reword the dbt comment).

### (9) Docs
Top-level README/CLAUDE.md are already V4-correct; CONTENT.md is durable. The misleading-as-current docs are the `docs/connector-platform/*` durable-reference trio (still draws StarRocks+dbt as the live serving tier and cites deleted `db/dbt/models/marts/*.sql` paths) and ADR-0005 (StarRocks partitioning, no supersede banner — unlike its siblings). The V4 architecture bundle predates the StarRocks→Trino swap so its stated target is now wrong. Per repo convention (append-only ADRs/audit history), these are **banner-marked or updated, not deleted**. Spent one-offs (PR-BODY.md, completed migration-plan docs at docs root, connector-verification/-refined artifacts, two overlapping pre-V4 audit generations) are kept as dated history; only PR-BODY.md is a clean delete. The "Brain-docs repo" external pointers in 3 front-door docs conflict with the same canon committed locally under `docs/requirements/` → standardize the pointer.

### (10) Dev experience
Strong baseline (`pnpm dev:up` one-command). Gaps: the observe stack is excluded from the default boot (add `pnpm dev:all` / `--with-observe`); `pnpm seed` is a no-op TODO stub that misleads new devs (remove, point at the `.sh` seeds); the env-template omissions above can crash a fresh boot. The broken unit harness `get-data-quality-summary.test.ts` (2/8 failing — stale mysql2 `srPool` fake vs a correctly Trino-ported product) can red the unit gate for unrelated apps/core changes → fix the fake to the Trino seam.

### (11) Prod deployment
Two blockers stand between this repo and a working prod deploy: (1) the CD trigger branch mismatch (nothing builds/ships on merge), and (2) the dbt→Spark cron cutover is half-done — V4 Spark crons exist but ship `enabled:false` while the dead dbt crons ship `enabled:true` against a deleted image. The remediation order is: fix CD trigger → enable + verify V4 Spark crons in staging → delete dbt crons/ECR/mysql-refresh leg → fix prod env template (Trino vars) → repoint collector ArgoCD path. Monitoring must not be forgotten: the Kafka/DLQ/lag SLO alerts are currently inert (redpanda metrics, no scrape target).

### (12) Remaining tech debt
- **Append-only ledgers (KEEP, document only):** duplicate `0033` migration ordinal (consent + send_log; stable under filename ordering, but breaks "one ordinal = one migration"); create→drop migration chains (bronze_events, revenue/attribution/ad_spend/ml/identity ledgers + 5 dropped resolver fns) — net-zero in final schema but cannot be renumbered without breaking fresh deploys.
- **Risky repoints (per-file confirm):** app TS still references dropped table names (`realized_revenue_ledger` ×36, `ad_spend_ledger` ×28, `attribution_credit_ledger` ×16) — meant to read Gold/Trino now; each needs confirmation it's repointed, not dead.
- **Duplicate precompute:** `gold_abandoned_cart/engagement/behavior` marts recompute what metric-engine derives at read-time from `mv_silver_touchpoint` — consolidate (disable marts + drop the 3 views).
- **Stale serving-glue comments** (`trino-deps.ts:7` says reads go to StarRocks — inverted/false).

### (13) Risks introduced
- **Lockfile churn:** removing `analytics-gateway` + unused deps regenerates `pnpm-lock.yaml`; verify `--frozen-lockfile` in CI after. (Low.)
- **Coverage gap window:** repointing StarRocks live/e2e/parity/isolation tests to Trino temporarily reduces real coverage until the repoint lands — do it as consolidation, not deletion, and verify Trino assertions actually execute (no silent self-skip). (Medium.)
- **Prod cron cutover:** deleting dbt crons before V4 Spark crons are verified green in staging would stop the medallion refresh in prod. Strict ordering required. (High — gated in Wave 3.)
- **Monitoring:** touching `brain-slo.rules.yml` without wiring the JMX exporter leaves ingest/DLQ SLOs unmonitored either way; the fix must *add* the exporter, not just edit expressions. (High.)
- **Untracked deletes** (`analytics-gateway`, `e2e-gate.wf.js`) won't appear in PR diffs — record them explicitly in the PR body so reviewers see them.

### (14) Future recommendations
1. **Make v4-naming-guard catch test-tier coupling** — it currently excludes `*.test.ts`, which is how 25+ StarRocks/mysql2/`:9030` test references survived. Add a test-aware lane (allow Trino, forbid new mysql2/`:9030`).
2. **CI no-op-test guard** — fail when a `.live`/`.e2e` suite runs with zero executed assertions (the `if(!srUp) return;` pattern produced green-with-nothing). Forces honest skip vs pass.
3. **Lockfile-drift gate** — `pnpm install --frozen-lockfile` as a blocking check so untracked-but-workspace-globbed dirs (the `analytics-gateway` failure mode) can't silently re-enter.
4. **Doc freshness banner convention** — adopt the ADR supersede-banner pattern for durable reference docs (connector-platform), and relocate completed plans/verifications under `docs/history/` so they stop reading as active work.
5. **Single source of topic truth** — `infra/redpanda/topics.yml` already drifted from the compose inline list; either make compose read it or delete it (mark non-authoritative).
6. **One canonical IdP decision** — resolve the Authentik stub vs current auth before it rots further.

---

## Appendix — `document` items (banner/comment edits, no runtime change)

| Path | Edit |
|---|---|
| `db/migrations/0033_*` (×2) | Document the duplicate-ordinal quirk; do NOT renumber (already applied). |
| create→drop migration chains | Document as net-zero history; do NOT delete (breaks fresh deploy). |
| `packages/metric-engine/src/trino-deps.ts:7`, `silver-deps.ts:20-23` | Reword inverted "reads go to StarRocks … never Trino" comment. |
| `infra/redpanda/topics.yml` | Mark non-authoritative (both appliers dead/divergent). |
| `infra/terraform/README.md`, `modules/s3-iceberg-medallion/main.tf`, `s3-iceberg/main.tf:39` | Reword StarRocks/dbt prose → Trino/Spark (resources stay valid). |
| `.env.production.example:151` | Drop "dbt" from the Bronze-flag comment; add Trino vars (§3). |
| `.env.local-prod.example` | Add `REDPANDA_BROKERS` (§3). |
| `.github/workflows/pr.yml:76-85`, `main.yml` comment region | Reword StarRocks ledger-gate prose → Trino-over-Iceberg. |
| `docs/connector-platform/{01,02,03}.md` | Update to Spark/Iceberg/Trino OR prepend "SUPERSEDED by Brain V4" banner. |
| `docs/adr/0005-entity-mart-partitioning.md` | Add SUPERSEDED banner (StarRocks removed → ADR-0007/Trino), match 0002/0003/0006. |
| `docs/architecture/v4/{00-INDEX,03-*}.md` | Add note: serving target later changed StarRocks→Trino (ADR-0007). Keep as history. |
| `docs/architecture/*-connector-verification.md`, `*-refined.md` | Keep as dated history or relocate to `docs/history/`; repoint kafka-connect→Spark-SS, brain_silver/gold→Iceberg if updating. |
| `docs/{trino-replaces-starrocks-plan,kafka-kraft-spark-landing-plan,db-audit-*,eos-reconciliation-2026-06}.md` | Move completed plans under `docs/history/`; keep. |
| `docs/architecture/README.md`, `docs/adr/0001-modular-monolith.md`, `docs/runbooks/README.md` | Standardize "Brain-docs repo" pointer vs local `docs/requirements/*` canon. |
| `docs/audit/` (two pre-V4 generations) | Optionally consolidate under one dated folder; do NOT delete (provenance). |
| `apps/core/src/modules/data-quality/tests/get-data-quality-summary.test.ts` | Fix stale mysql2 `srPool` fake → Trino seam (2/8 failing; product code is correct). |
