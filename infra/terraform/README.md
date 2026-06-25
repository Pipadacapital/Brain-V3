# Terraform — AWS (VPC, EKS, RDS, S3/Glue, KMS, Redpanda Cloud, ...). doc 04 §J/§K.

## Brain V4 PHASE 0 — Iceberg Silver + Gold (additive, non-breaking)

`modules/s3-iceberg-medallion` provisions the Iceberg **Silver** and **Gold**
storage layers (S3 bucket + Glue catalog database + Spark **write** IAM policy +
analytics **read** IAM policy) so Spark can `CREATE` and `MERGE` Iceberg tables
in the `brain_silver` / `brain_gold` namespaces. It is the cloud mirror of the
Bronze module (`modules/s3-iceberg`) and is the Terraform half of
`14-implementation-plan.md` PHASE 0 / PR-0.1 (the provisioning blocker called
out in `08-spark-ownership-report.md §4` and `09-starrocks-report.md §6`).

The local-prod equivalent (Iceberg REST namespaces `brain_silver` / `brain_gold`
over MinIO) is wired separately in the docker-compose / `db/iceberg` toolchain —
this directory is cloud IaC only and is **not applied** in local-prod.

### What it creates (per layer, `silver` and `gold`)

- `brain-<layer>-<env>-<acct>` S3 bucket — SSE-KMS (root CMK), versioned,
  public-access-blocked, TLS-only + deny-unencrypted-puts bucket policy.
  **No** Object Lock: Silver/Gold are derived, rebuildable layers; MERGE,
  compaction, snapshot-expiry and crypto-shred must be able to delete files.
  (Bronze keeps the COMPLIANCE+7yr WORM retention as the source of truth.)
- `brain_<layer>_<env>` Glue Data Catalog database for Iceberg metadata.
- `brain-<env>-spark-<layer>-write` IAM policy — Get/Put/Delete on the
  `<layer>/*` prefix only, KMS wrap/unwrap, and Glue table writes scoped to the
  layer DB. Mirrors Bronze NN-5 per-prefix scoping with an explicit DENY on
  bucket root.
- `brain-<env>-analytics-<layer>-read` IAM policy — GetObject on the layer
  prefix only (StarRocks `mv_*` external-catalog reads, Phase 3).

The env roots also add `module.irsa_spark_jobs` — an NN-3 IRSA role for the
Argo CronWorkflow service account `brain-jobs` (namespace `argo`) that runs the
Spark Bronze sink today and the Spark Silver/Gold MERGE jobs from Phase 1+. It
gets Bronze write (existing policy) + the new Silver + Gold write policies.

Money stays `bigint` minor units + `currency_code`, and `brand_id` is the
tenant partition (`bucket(256, brand_id)`) on every Iceberg table — enforced in
the Spark DDL and mirrored by the per-prefix IAM here.

### How to apply (cloud apply is DEFERRED in this repo)

```bash
# dev: full apply (EC10) — creates Silver + Gold buckets/catalogs + spark-jobs role
cd infra/terraform/envs/dev
terraform init
terraform plan      # review: 2x bucket + glue DB + IAM policies + irsa_spark_jobs role
terraform apply

# staging: infra-only (non-compute) — same resources, zero idle compute
cd infra/terraform/envs/staging
terraform init && terraform plan && terraform apply

# prod: DECLARED but commented (bootstrap-only). Uncomment the
# s3_iceberg_silver / s3_iceberg_gold / irsa_spark_jobs blocks in
# envs/prod/bootstrap.tf alongside the s3_iceberg apply at M1/M4, then plan/apply.
```

After apply, point the Spark jobs at the new warehouse roots (per env outputs):

- `silver_bucket_name` / `gold_bucket_name` → Spark `warehouse` =
  `s3://<bucket>/silver/` and `s3://<bucket>/gold/`.
- `silver_glue_database_name` / `gold_glue_database_name` → the
  `brain_silver` / `brain_gold` Glue databases backing the Iceberg catalog.
- `spark_jobs_role_arn` → annotate the `brain-jobs` Kubernetes service account
  (`eks.amazonaws.com/role-arn`) in `infra/helm/cronworkflows/values-*.yaml`.

This is **non-breaking**: it adds new buckets, catalogs, and IAM only. No
existing bucket, read path, dbt model, or app code is changed.
