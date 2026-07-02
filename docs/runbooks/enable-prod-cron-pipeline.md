# Runbook — Enable the production scheduled-job pipeline (insights stay fresh)

This wires the medallion refresh + Bronze sink + catalog registration into CI/CD so the **Insight/
Copilot pipeline runs on fresh real data in production** (not a stale snapshot). The insight detectors
read the gold marts; this keeps those marts rebuilt and provenance-fresh. See
`infra/helm/cronworkflows/` + `.github/workflows/deploy.yml`.

## What this PR automated (no manual step)

1. **Image build + digest-pin.** CI (`build-data-images`) now builds, pushes, cosign-signs, and
   digest-pins the **dbt-runner** (`db/dbt/Dockerfile`) and **spark-bronze** (`db/iceberg/spark/Dockerfile`)
   images — previously not built at all. Path-based change detection (fail-open to building).
2. **Cronworkflows chart digest plumbing.** `gitops-staging` + `prod-promote` now bump the
   cronworkflows chart's four image blocks (`image`, `streamWorkerImage`, `dbtRunnerImage`,
   `sparkBronze.image`) via `yq` (path-precise — a blanket `sed` would hit every `repository:`).
   These were never bumped before, so the chart could not have deployed (fail-closed digest template).
3. **dbt refresh crons ENABLED.** `recognition-refresh` (:05) and `attribution-gold-refresh` (:45)
   are `enabled: true` — they rebuild `gold_revenue_ledger` + `gold_marketing_attribution` from Bronze
   every hour, keeping the insight marts fresh. They need only StarRocks (no Spark cluster).
4. **Catalog self-bootstrap.** `recognition-refresh` sets `DBT_BOOTSTRAP_CATALOG=true`, so the FIRST
   hourly dbt step idempotently (re)registers the `brain_oltp_pg` JDBC catalog + the PG read-shim
   (`db/starrocks/oltp_jdbc_catalog.sql` + `oltp_pg_read_shim.sql`). A fresh cluster — or one whose
   external catalog was dropped on a StarRocks restart — self-heals with no manual step.
5. **ECR repos.** Terraform `local.services` now includes `dbt-runner` + `spark-bronze`, so
   `terraform apply` creates their immutable, KMS-encrypted, scan-on-push repos (the CI push target).

## Prerequisites (one-time human / infra actions)

These cannot live in app code — do them once per environment before/at first deploy:

- **`terraform apply`** (staging then prod) so the two new ECR repos exist. Without them the CI push
  step fails (the image has nowhere to go).
- **`core-env` secret** (External Secrets ← AWS Secrets Manager) must expose, for the dbt-runner pods:
  - `STARROCKS_HOST`, `STARROCKS_PORT`, `STARROCKS_USER`, `STARROCKS_PASSWORD`
  - `BOOTSTRAP_DATABASE_URL` — a **superuser** Postgres DSN (the read-shim DDL needs it). Used only
    by `recognition-refresh` (the catalog-bootstrap step).
  These are the same secret the core/stream-worker deployments already consume; add the two
  StarRocks/bootstrap keys if absent.

## Verify after deploy

```sh
# CronWorkflows scheduled (dbt crons should be present + not suspended)
kubectl get cronworkflows -n <ns> | grep -E 'recognition-refresh|attribution-gold-refresh'

# First recognition-refresh run registered the catalog
mysql -h <starrocks> -P 9030 -e "SHOW CATALOGS;" | grep brain_oltp_pg

# Marts are fresh (build time within the hour) — the insight freshness guard reads this:
mysql -h <starrocks> -P 9030 -e \
  "SELECT max(updated_at) FROM brain_gold.gold_revenue_ledger;"
```

On the dashboard, `/insights` should show **no "Data may be stale" badge** (the freshness guard,
`INSIGHT_FRESHNESS_SLO_HOURS` default 6h). If it appears, a dbt cron is failing — check the Argo
Workflow logs for `recognition-refresh`.

## Enabling the Spark Bronze sink (the one remaining flip)

`sparkBronze.enabled` is intentionally still `false`. The image is now built + digest-pinned, but the
sink needs a **Spark-on-k8s cluster** (Spark Operator or a node pool sized for the driver, ≥4Gi —
the driver heap is pinned to 3g). Enabling it without that would schedule a CronWorkflow that fails at
runtime. Once the cluster is provisioned:

1. Set `sparkBronze.enabled: true` in `infra/helm/cronworkflows/values.yaml` (or the env overlay).
2. Ensure `envSecretName` (`core-env`) carries the sink's config: `KAFKA_BROKERS`, the Iceberg/Glue
   catalog settings, `CHECKPOINT_LOCATION` (durable `s3a://`), `AWS_*`, and **both** lane topics
   (`COLLECTOR_TOPIC` + `BACKFILL_TOPIC`). `STARTING_OFFSETS=latest` in steady state.
3. Argo CD auto-syncs. This lands the live event stream (incl. `gokwik.webhook.v1`) into Iceberg
   Bronze; dbt then builds Silver/Gold from Bronze instead of the PG JDBC shim (the ADR-0002 end state).

Until then, dbt reads PG via the `brain_oltp_pg` JDBC catalog (the M1/transition source) — which the
crons above keep registered and the marts fresh.
