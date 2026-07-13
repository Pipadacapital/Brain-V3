# Brain — Whole-Repo Cleanup Audit

Date: 2026-06-28
Scope: pnpm + turbo monorepo (apps/, packages/, tools/, db/, infra/, .github/, docker-compose.yml).
Method: synthesis of 10 per-dimension audits (dead TS, deps, scripts/config, docker, IaC, CI/CD, docs, DB/DDL, over-engineering, devex), deduplicated and re-rated conservatively. Findings verified by `git ls-files` / `git grep` where they drive a deletion.

Governing context (CLAUDE.md, Brain V4 OFFICIAL): **dbt REMOVED** (Spark-on-Iceberg sole compute), **StarRocks REMOVED** (serving → Trino-over-Iceberg + Redis; ops → PG `ops` schema), **Redpanda REMOVED** (Apache Kafka KRaft; compose service intentionally still NAMED `redpanda` — NOT dead), **no feature-precompute**. Almost all of the genuine dead weight is residue from these three retirements that the deployment/test/tooling layers have not yet swept.

**Headline:** The application TypeScript and the local docker-compose stack are clean. Dead weight is concentrated in (a) a few orphan stub packages, (b) StarRocks/dbt residue in tools + Helm gitops + Terraform + env templates, and (c) a load-bearing CI bug — `main.yml`/`infra.yml` trigger on `push: [main]` while the default branch is `master`, so the entire build→sign→push→deploy half of the pipeline has never fired.

Safety tiers: **safe** = delete/edit now in one pass, verified unreferenced. **risky** = needs human confirmation (prod gitops, parked seam, or test repoint). **keep** = looks obsolete but is load-bearing (append-only history, tombstone, governance seam).

---

## 1. Dead code

### Safe (verified unreferenced)
- `packages/analytics-gateway/` — orphaned, **git-untracked** build residue (only `dist/` + `node_modules/` + `tsbuildinfo`, no `src/`, no `package.json`) of the deleted StarRocks `GoldRepository`. `git ls-files` = empty; zero importers. Filesystem delete only.
- `packages/metric-engine/src/silver-deps.ts` → `interface SilverConnection` (`@deprecated`, "nothing in the seam uses it anymore") **and** its re-export at `packages/metric-engine/src/index.ts:150`. Verified: only self-reference + the passthrough re-export; zero consumers.
- `packages/ui/` (empty `export {};` stub, superseded by `apps/web/components/ui/`) **+** its dep `@brain/ui` in `apps/web/package.json:18` **+** the `@brain/ui` entry in `apps/web/next.config.js:8` `transpilePackages`. All three must go together (a stale `transpilePackages` entry to a deleted workspace package can break `next build`).
- `@brain/feature-flags` dependency entry in `apps/core/package.json` — verified zero imports under `apps/core/src`. (The *package* itself is risky — see below.)

### Risky (real code / parked seam — confirm intent)
- `packages/feature-flags/` — 95-line "Sprint-0" in-memory `FeatureFlagReader` kill-switch stub (ADR-010). Zero importers repo-wide, so removable code-wise, but it is a deliberately-parked architectural seam. Confirm the team isn't planning to wire it before deleting.
- `apps/stream-worker/src/tests/helpers/iceberg-bronze.ts` — e2e helper still opens a **mysql2 pool to StarRocks :9030** + `REFRESH EXTERNAL TABLE`; StarRocks is gone from compose, so it and its **8 dependent e2e suites** are unrunnable. The tests are valuable (Kafka→Spark→Iceberg Bronze parity) — **repoint to Trino, do not delete.**
- `tools/isolation-fuzz/src/starrocks.test.ts` and `tools/isolation-fuzz/src/silver-touchpoint.test.ts` — connect to StarRocks :9030 and reference deleted DDL (`db/starrocks/bootstrap.sql`, `row_policy_template.sql`). Permanently PEND. Superseded by sibling `trino-brand-predicate.test.ts`. Remove only after confirming the Trino seam test covers the same isolation surface; then drop `mysql2` from `tools/isolation-fuzz/package.json` and the `@see` line in `index.ts:24`.

### Keep (looks dead, is load-bearing)
- `packages/tenant-context/` — `brandKey`/`rateLimitKey`/`sessionKey` have no app call sites yet, **but** the active ESLint rule `brain-redis/no-raw-redis-key` (`error`) mandates `brandKey()` as the sole sanctioned Redis-key constructor and the isolation-fuzz tests use it. Governance/isolation seam — keep.

---

## 2. Stale artifacts (scripts, tooling, env, tests)

### Risky — broken-but-valuable, repoint not delete
- `tools/parity-oracle/` (`reference.ts`, `parity.test.ts`) — independent revenue-parity reference still reads gold over the StarRocks MySQL wire; live sections SKIP forever. The only non-tautological parity proof is now a no-op. `integration.yml:120` still runs `test:parity` against it. **Repoint the reference to Trino** or formally retire the gate.
- `tools/seed/insights-demo-seed.sh`, `tools/backfill/backfill-ledger-brain-id.sh`, `tools/backfill/backfill-journey-stitch-map.sh` — all hard-code `docker exec -i brainv3-starrocks-1 mysql -P9030`; that container no longer exists, so all three are **broken** despite being advertised in README + docs/strategy. The PG-side write logic is fine; only the StarRocks reader is dead. (`backfill-journey-stitch-map.sh` is additionally superseded by the TS job `apps/stream-worker/src/jobs/journey-stitch-from-identity.ts`.) Repoint the readers to Trino/Spark.
- `STARROCKS_*` env block in `.env.local-prod` (lines 42-45) and `.env.production.example` (52-62, incl. doubly-dead `STARROCKS_FEATURE_USER`). Read by NO non-test production code. Drop the block; align the `BRONZE_OPERATIONAL_READ_SOURCE` "drives dbt" comment.
- `turbo.json` `globalPassThroughEnv` still lists `STARROCKS_HOST/PORT/ANALYTICS_USER/ANALYTICS_PASSWORD` + `REDPANDA_BROKERS`. Zero `.ts` readers. Trim after confirming no `.env` still sets them.

### Risky — dev-stub no-op
- `tools/seed/seed.mjs` (`pnpm seed`) — body is `console.log('TODO: seed 2 demo brands…')`. Misleading no-op a new dev tries first. Implement, or remove the script + `package.json` entry and point at the working `.sh` seeds.

### Keep
- `.github/workflows/parity-oracle.yml` — intentional retired tombstone (echo + exit 0, manual-dispatch only). Deliberate documented retention; if ever removed, preserve rationale in an ADR.
- `db/migrations/0085_drop_pg_bronze_events.sql` (`SELECT 1;` placeholder) and all 116 migrations — append-only ledger applied in filename order by `scripts/migrate.mjs`; mid-ledger deletion breaks fresh deploys for zero benefit. The 0102 gap is documented; drop migrations (0098/0099/0101/0103/0105) CASCADE their dependent functions/views — hygienic.
- (the retired dbt/StarRocks/feature DBs were dropped via teardown DDL that has since been removed.)

### Safe
- `db/starrocks/.gitkeep` — placeholder for a now-removed subtree; redundant. Verified zero references.

---

## 3. Documentation to remove / update

**No documentation is safe to DELETE.** The ~280 md files under `.engineering-os/runs|memory` + `docs/audit` are intentionally-committed pipeline/audit history (MEMORY.md "Commit EOS run artifacts"); ADRs (0002/0003/0006) carry SUPERSEDED banners and are append-only decision history; `docs/requirements/*`, `docs/architecture/v4/*`, `docs/data-collection-platform/*` are foundational specs / point-in-time audit snapshots. All KEEP.

### Update (stale-stack, behaviour-misleading)
- `README.md` — front-door cold-start still lists `starrocks (serving MVs)`, brings up "Postgres, Redpanda, StarRocks…", and draws the path "…→ StarRocks serving mv_*". The `mv_*` are now Trino views. Also: `cp .env.example .env.local` (line 24) names two files that don't exist (apps load `.env.local-prod`); step-3 `ALTER ROLE brain_app … LOGIN` is now auto-provisioned by `db/init/00_provision_brain_app_role.sql` (demote to fallback note). **Keep the `redpanda` compose token** — it is the live Kafka service name.
- `docs/runbooks/README.md` — "RB-3 StarRocks rebuild-from-Iceberg" index line (no such recovery path post-Trino).
- `docs/runbooks/RB-4-local-lakehouse.md:147-150` — tells devs to `pip install dbt-starrocks` into `.dbt-venv`; repoint to `pnpm dev:v4-refresh` (Spark).
- `infra/helm/cronworkflows/README.md`, `infra/observe/alerts/brain-slo.rules.yml:218-234` — remediation prose says "rebuild Silver via dbt / check StarRocks"; alert thresholds stay valid, prose is stale.
- `tools/isolation-fuzz/src/index.ts:24` `@see db/starrocks/row_policy_template.sql` — dangling pointer to deleted DDL.
- `.gitignore:25-29` — prune the `db/dbt/target` / `.dbt-venv` stanza (db/dbt absent).
- Stale comments-only: `pr.yml:76-85` (ledger-gate names StarRocks as current truth), `integration.yml:12-15` (header says "NOT on pull_request" but a PR trigger was added), helm values STARROCKS_/REDPANDA comments.

---

## 4. Simplifications (mechanical, behavior-preserving)

- **`apps/web/lib/api/client.ts` (2199 lines)** — single barrel of ~20 API namespaces (`analyticsApi` alone ~555 lines). Split per-domain (`api/analytics.ts`, `api/billing.ts`, …) re-exported from a thin `client.ts`. 42 named-import callers, zero default exports → transparent split. **Safe.**
- **`apps/web/lib/api/types.ts` (1374 lines)** — co-locate request/response types with each domain slice from the split above. Type re-export through a barrel is transparent to importers. **Safe.**
- **`apps/core/src/bootstrap/registerConnectors.ts` (1076 lines, ONE function, 33 inline handlers)** — extract per-connector `registerXConnector(app, deps)` helpers; the pattern already exists (`registerAllWebhookRoutes`, `registerMetaCallbackRoute`). Single caller (`main.ts`). **Safe.**
- **`apps/core/src/main.ts` (868 lines, regrew from a prior 760 split)** — move inline env helpers (`getEnvOrThrow`/`getEnv`) + grouped plugin mounts into `bootstrap/*`. **Safe, low priority.**
- **`apps/core/src/modules/workspace-access/internal/application/invite.service.ts` (824 lines)** — extract one `assertCanManageMembers(actor)` guard (duplicated across 4 methods) and push raw SQL down to the module's repository. **Risky** — must preserve RLS `SET LOCAL` brand context + `ON CONFLICT 23505`; 5 in-module suites guard it.
- **DevEx:** add `pnpm dev:all` (include the `observe` profile) and `--wait` to compose `up` so apps don't race infra healthchecks; fix the inverted compose header comment.

### Keep (looks over-built, isn't)
- `apps/core/src/modules/connector/.../woocommerce/` 11-level hexagonal tree — leaf Command/value-object files carry real logic + co-located tests; collapsing is a risky rewrite.
- `packages/razorpay-mapper/src/index.ts`, `metric-engine/{insights,registry}.ts`, the Spark `*_registry.py` — long-but-flat, cohesive; flagged "deep nesting" was embedded SQL/JSX strings.

---

## 5. Infra (Terraform / IaC)

### Risky
- `infra/terraform/modules/redpanda/main.tf` — entire Redpanda Cloud module (`redpanda_cluster`/`redpanda_topic` via the retired provider). Referenced by **zero envs**, absent from the `infra.yml` validate matrix. Remove with the swap to self-hosted Kafka KRaft.
- `infra/terraform/modules/secrets/main.tf:48-59` — `aws_secretsmanager_secret "redpanda"` (Redpanda Cloud API key). The secrets module IS used by dev/staging, so this orphan secret still gets created. Drop the resource.
- `infra/terraform/modules/eks/main.tf:234-238` — bakes a `dbt-runner` ECR repo for an image that can no longer be built (db/dbt deleted). Dead once the dbt crons go.

### Safe
- `.github/workflows/infra.yml` — add `s3-iceberg-medallion` to the `tf-validate-modules` matrix (load-bearing for dev/staging Silver/Gold yet unvalidated); drop `redpanda` from consideration with the module.

### Keep
- `infra/helm/authentik/values-dev.yaml` — lone override, no Chart/argocd wiring; keep pending IdP-strategy confirmation (no runtime effect).

---

## 6. Docker

The local `docker-compose.yml` (22 services) is clean: every service is profiled or a documented always-on default, both volumes consumed, retired tech gone (only "REPLACES X" comments remain). The `redpanda` service runs `apache/kafka:3.8.1` — **keep the name** (depends_on / network_mode / bootstrap-server / prometheus targets all key off it). All 5 Dockerfiles are CI-built/scanned/signed — keep.

### Risky (prod gitops Helm — retired-tech images)
- `infra/helm/cronworkflows`: `dbtRunnerImage` declaration + the `recognition-refresh` and `attribution-gold-refresh` crons (`enabled:true`, `useDbtRunnerImage:true`, `DBT_SELECT/DBT_VARS/DBT_THREADS`) — built from the **deleted `db/dbt/Dockerfile`**; CI `build-data-images` now builds only `spark-bronze`. They can never get a valid image and duplicate `templates/spark-v4.yaml`. The V4 impact report (`docs/architecture/v4/02-repository-impact-report.md:39`) already marks them REMOVE-after-parity. Confirm the V4 spark crons supersede, then delete.
- `infra/helm/cronworkflows`: `sparkV4.mysqlImage: mysql:8.0` + the `v4-mv-refresh` leg (`templates/spark-v4.yaml:157-211`) issues StarRocks `REFRESH MATERIALIZED VIEW brain_serving.mv_*` / `REFRESH EXTERNAL TABLE` over :9030. StarRocks is gone; refresh is now `tools/dev/v4-refresh-loop.sh` (Spark mv SYNC). Repoint/remove. (`sparkV4.enabled` defaults false → lower blast radius.)

### Safe
- compose header comment / `pnpm dev:all` (see §4 DevEx).

---

## 7. Kubernetes / Helm / ArgoCD

### Risky
- `infra/argocd/envs/{prod,staging}/collector.yaml:26` — both point `path: infra/k8s/collector/overlays/*`, but **`infra/k8s` does not exist** (verified). Every other service Application uses `infra/helm/<svc>`, and a complete unused `infra/helm/collector` chart exists. The highest-SLO service has a broken GitOps source — repoint to `infra/helm/collector`.
- (dbt crons + `v4-mv-refresh` + the cron env still referencing deleted `db/starrocks/oltp_jdbc_catalog.sql`/`oltp_pg_read_shim.sql` — see §6, same artifacts.)

### Keep
- `infra/argocd/rollouts/*` — explicitly labeled "the PATTERN, not yet wired"; intentional design reference.
- App charts (core/web/collector/stream-worker) — production-grade (probes, limits, HPA, non-root/seccomp, digest-pinning). No Ingress/PDB/NetworkPolicy templates exist (services ClusterIP-only) — a readiness gap to track, not dead code.

---

## 8. CI/CD

### Risky — load-bearing branch bug (HEADLINE)
- `.github/workflows/main.yml:3-4` triggers ONLY on `push: branches: [main]`, but the default branch is **`master`** (verified `origin/HEAD → origin/master`; no `main` branch). So **build-and-push (ECR + cosign), build-data-images, gitops-staging, and prod-promote have never run on the real default branch.** `integration.yml` already uses `[master]`. One-word fix (`main`→`master`), but it silently activates the entire CD half — confirm intent and that no out-of-band deploy assumes it stays dormant.
- `.github/workflows/infra.yml:11-13` — same `push: [main]` mismatch; mainline Terraform validate/Checkov/OPA never runs post-merge (PR trigger still gates). Same fix.

### Keep — present-vs-target pipeline gaps (implement, don't delete)
- No post-deploy **smoke** (both deploy jobs only `echo`; the repo can do it — `integration.yml` uses `wait-on`). 
- No automated **rollback** step (thresholds are echoed, reversion delegated out-of-band).
- No deploy-time **DB migrate** job in `main.yml` (`migrate:up` runs only in test jobs). Confirm migrations run as a K8s init-container/Argo hook so code can't outrun schema.

### Safe — comment/DevEx
- Update stale StarRocks prose in `pr.yml:76-85` and the self-contradicting `integration.yml:12-15` header.
- Extract the duplicated fail-closed affected-set + docker-build snippet (`pr.yml:165-199` ≈ `main.yml:38-81`) to a composite action — drift risk, behaviour-preserving.

### Keep
- `infra.yml:166-205` bootstrap-only OPA/plan branches — in-file-TODO'd tech debt; do NOT strip `continue-on-error` before the dev TF state bucket exists or first run hard-fails.

---

## 9. Local dev experience

- **No single-command bring-up.** `pnpm dev` = `docker compose up -d` + `turbo run dev`; it skips `pnpm migrate`, `pnpm bootstrap` (LocalStack KMS/Secrets/keyring/salts), and `ONESHOT=1 pnpm dev:v4-refresh`. Documented cold start is 7 manual steps. **Fix:** add a `pnpm dev:up` orchestrator (`compose up --wait` → migrate → bootstrap → oneshot v4-refresh → dev). The pieces already exist as scripts.
- **Hard blocker — fresh clone cannot boot.** All 3 Node apps run `tsx watch --env-file=../../.env.${APP_ENV:-local-prod}`; `.env.local-prod` is gitignored with **no committed template** (only `.env.production.example`) and no copy step. tsx hard-errors. **Fix:** commit `.env.local-prod.example` + document the copy.
- Already-fixed, retire from docs: stream-worker is now in `pnpm dev`; `ALTER ROLE brain_app … LOGIN` is auto-provisioned by `db/init/00_provision_brain_app_role.sql`.
- `pnpm seed` is a no-op stub (§2).
- Stale cold-start prose names Redpanda/StarRocks (§3).

---

## 10. Prod deploy

- **The CD pipeline is dormant** due to the `[main]` vs `master` trigger mismatch (§8) — the single most important production finding. Until fixed, no image is built/signed/pushed and no gitops bump happens from a master merge.
- **GitOps source broken for collector** (the 99.95%-SLO service) — ArgoCD points at a nonexistent `infra/k8s/collector/overlays/*` (§7).
- **Retired-tech crons in prod gitops** — dbt crons reference a deleted Dockerfile (fail-closed on missing digest); `v4-mv-refresh` drives removed StarRocks (§6/§7). Reconcile against the Trino/Spark V4 path before they confuse on-call.
- **Pipeline rungs missing:** smoke, rollback, deploy-time migrate are echo-only (§8). A green `main.yml` currently proves only that a manifest was committed, not that the new image is healthy.
- No Ingress/PDB/NetworkPolicy in any chart (§7) — readiness gap.

---

## 11. Remaining tech debt (track, not this pass)

- Repoint the **parity-oracle** reference to Trino or formally retire the gate (currently a silent no-op revenue proof).
- Repoint the 3 StarRocks **backfill/seed scripts** to Trino/Spark.
- Repoint the **8 Bronze-parity e2e suites** (`iceberg-bronze.ts` helper) to Trino; then the `mysql2` deps in `apps/core`, `apps/stream-worker`, `packages/metric-engine`, `packages/feature-store`, `tools/isolation-fuzz` become removable (today they serve only obsolete StarRocks `*.live.test.ts`).
- Decide on `@brain/feature-flags` (wire or delete) and `@brain/ui` removal (done in safe pass).
- Implement smoke/rollback/migrate CD rungs; add Ingress/PDB/NetworkPolicy.
- `@aws-sdk/client-kms` is a redundant direct dep in `apps/core` (resolves transitively via `@brain/pii-vault`) — risky/low value; leave unless trimming deps.

---

## 12. Risks of cleanup

- **Append-only ledgers:** never delete a mid-sequence migration or an ADR — breaks fresh deploys / destroys decision provenance.
- **Prod gitops (Helm/Terraform/ArgoCD):** removing dbt crons, the `v4-mv-refresh` leg, the redpanda TF module, or fixing the collector path changes what a cluster reconciles. Requires an infra owner + confirmation that the V4 spark/Trino path fully supersedes and no live cluster still runs the old cron.
- **The `[main]`→`master` fix is behaviour-activating, not cosmetic:** it turns on a CD pipeline that has been inert. Verify ECR/cosign/gitops creds and that no parallel deploy mechanism assumes dormancy before merging.
- **Test repoints, not deletions:** the StarRocks-coupled e2e/parity/isolation suites encode real coverage (Bronze parity, tenant isolation, revenue parity). Repoint to Trino; deleting them silently drops guarantees.
- **Untracked residue** (`packages/analytics-gateway/`) is a filesystem delete, not a git change — won't show in a PR diff.
- **`@brain/ui` coupling:** the removal touches 3 files (`packages/ui/`, `apps/web/package.json`, `apps/web/next.config.js`); a leftover `transpilePackages` entry can break `next build`.

---

## 13. Validation plan

After the SAFE pass:
1. `pnpm install` — workspace graph resolves after removing `@brain/ui` + `@brain/feature-flags` dep entries and `packages/ui`.
2. `pnpm -w typecheck` (or `turbo run typecheck`) — confirms the `SilverConnection` re-export removal and the dep edits don't break types.
3. `pnpm --filter @brain/web build` (`next build`) — confirms the `next.config.js` `transpilePackages` edit is consistent.
4. `pnpm -w lint` — confirms `no-raw-redis-key` (tenant-context) still passes; nothing referenced the removed stubs.
5. `git status` — confirm `packages/analytics-gateway/` (untracked) is gone and no tracked file referenced it.
6. `bash tools/lint/v4-naming-guard.sh` — confirms no new violations and the cleanup didn't reintroduce retired-DB refs.
7. `docker compose --profile core --profile ingest --profile lakehouse up -d --wait && pnpm migrate && pnpm bootstrap` — smoke the local boot path (validates devex fixes if applied).

For RISKY items: open a tracked issue per cluster (CI branch fix, prod gitops dbt/StarRocks cron reconcile, e2e/parity Trino repoint, feature-flags decision), each with an owner and its own validation (e.g. `helm template infra/helm/cronworkflows`, `terraform validate`, `argocd app diff`).

---

## Appendix — Safe-removal manifest (one-pass, low risk)

| # | Path | Coupled edits | Why safe |
|---|------|---------------|----------|
| 1 | `packages/analytics-gateway/` | none | untracked build residue, zero refs (verified) |
| 2 | `packages/ui/` | remove `@brain/ui` from `apps/web/package.json:18` AND `apps/web/next.config.js:8` transpilePackages | empty `export {};` stub, superseded by `apps/web/components/ui/` |
| 3 | `apps/core/package.json` → `@brain/feature-flags` dep entry | none | zero imports under `apps/core/src` (verified) |
| 4 | `packages/metric-engine/src/silver-deps.ts` → `SilverConnection` interface | remove its re-export at `packages/metric-engine/src/index.ts:150` | `@deprecated`, zero consumers (verified) |
| 5 | `db/starrocks/.gitkeep` | none | placeholder for a now-removed subtree; redundant |

Counts: 5 safe-removal targets, 13 risky items, ~15 keeps, 6 top simplifications.
