TITLE: Repo cleanup + standardization — remove dead feature/dbt/StarRocks legs, fix dormant CD + monitoring, split god-file

## Summary
Comprehensive repo cleanup (audit → verified removal waves → standardization), driven by an evidence-backed audit (52 findings; report in `docs/cleanup/repo-cleanup-report.md`). Every removal was proven unused; high-risk prod/monitoring items went through explicit owner sign-off.

## What changed
- **Removed (proven unused):** analytics-gateway orphan, 3 dead deps, the dead feature-precompute layer (@brain/feature-store + @brain/feature-flags + materialization/freshness crons — contradicted V4 runtime-features), retired dbt/StarRocks gitops (dbt crons, dbtRunnerImage, mysql mv-refresh leg, dbt-runner ECR), Redpanda TF module + drifted avsc, spent PR-body, seed no-op.
- **Fixed dormant pipeline:** CD/infra triggers `[main]→[master]` so CD + Terraform fire on real merges; CI now pins `.sparkV4.image`.
- **Enabled V4 Spark crons** (sparkV4.enabled=true) as sole compute; helm renders clean.
- **Monitoring:** SLO rules + ingest-health dashboard repointed off retired `redpanda_kafka_*` onto Kafka KRaft JMX (+ jmx-exporter scrape).
- **Standardized:** Dockerfile layer-cache reorder (4 services); `registerConnectors` 1118-line god-file split into per-connector helpers (route surface byte-identical); ArgoCD collector path fixed; `.env.production.example` StarRocks→Trino.

## Verify
tsc core/stream-worker/web/isolation-fuzz clean; helm template renders the V4 cron set (zero dbt/mysql/feature refs); yaml/terraform valid; gate-guard 6/6; v4-naming-guard pass; isolation-fuzz + connector tests green. Lone test red is the pre-existing memoized-config one (documented).

## Deploy-time gate
Flipping sparkV4 on requires the spark image to be digest-pinned (now wired in CI) and staging V4 crons confirmed Succeeded before the dbt path is irreversibly gone — that's the live confirmation step.

## Remaining (documented in report §12, non-blocking)
12 unused Trino views, 10 StarRocks live-test repoints, doc sweep, test taxonomy, JMX exporter deploy.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
