# Terraform — AWS (VPC, EKS, Aurora, S3 Iceberg, KMS, self-hosted Kafka (Strimzi), ...). doc 04 §J/§K.

## Prod go-live (AUD-COST-001) — envs/prod is UN-GATED

`envs/prod` is now the full apply-ready ADR-0009 module set (network + fck-nat +
vpc-endpoints, EKS, Aurora Serverless v2, ElastiCache, Secrets Manager, S3
Iceberg Bronze/Silver/Gold, IRSA, Karpenter, CI/CD OIDC roles). Region:
**ap-south-1** everywhere. Everything is `terraform validate`-green with
`-backend=false`; the apply order below is the go-live path.

### Step 0 — remote state bootstrap (one-time, LOCAL credentials)

The `envs/prod` S3 backend needs a state bucket + lock table that must exist
*before* `terraform init` can run there (chicken-and-egg — this root cannot
create its own backend):

```bash
cd infra/terraform/bootstrap
terraform init
terraform apply -var environment=prod        # brain-tfstate-prod-<acct> + brain-tfstate-lock-prod + state KMS
```

This root keeps its own state as a local `terraform.tfstate` file in-dir —
that is expected; keep it (or migrate it into the bucket it created later).

### Step 1 — fill the account id + apply the prod root

1. Fill `<PROD_ACCOUNT_ID>` in `envs/prod/backend.tf` (the state bucket name
   from step 0's output).
2. `cp envs/prod/terraform.tfvars.example envs/prod/terraform.tfvars` and edit
   (EKS API allowlist CIDR, node/ACU sizing).
3. First apply is LOCAL (the CI apply role doesn't exist yet):
   `cd envs/prod && terraform init && terraform plan -out m4.plan && terraform apply m4.plan`.
   Staged alternative: `-target=module.network`, then `-target=module.eks`,
   then a blank-target apply (the graph orders the rest).
4. Set the GitHub repo variables from `terraform output`:
   `AWS_PROD_APPLY_ROLE_ARN` = `github_apply_role_arn`,
   `AWS_ECR_PUSH_ROLE_ARN` = `github_ecr_push_role_arn`. Subsequent applies go
   through `.github/workflows/prod-apply.yml` (OIDC + approval gates).

### Step 2 — Iceberg REST catalog database on Aurora (bootstrap SQL)

The runtime Iceberg catalog is the **REST/JDBC catalog** (iceberg-rest chart →
JdbcCatalog on Aurora) — NOT Glue (see AUD-COST-012; the former
`aws_glue_catalog_database` resources were removed). Nothing creates the
catalog DB automatically (Aurora is private-only, so a terraform `postgresql`
provider can't reach it from CI). One-time bootstrap SQL, run from inside the
VPC (e.g. a `kubectl run psql` pod) against the writer endpoint
(`terraform output aurora_endpoint`) as the master user:

```sql
CREATE ROLE iceberg_catalog LOGIN PASSWORD '<generated>';
CREATE DATABASE iceberg_catalog OWNER iceberg_catalog;
```

Then create the `iceberg-rest-catalog-db` k8s secret (jdbc-user/jdbc-password)
and set `catalog.jdbcHost` in `infra/helm/iceberg-rest/values-prod.yaml` — see
`docs/runbooks/prod-m4-turn-on.md` Phase 4c.

## Brain V4 PHASE 0 — Iceberg Silver + Gold (additive, non-breaking)

`modules/s3-iceberg-medallion` provisions the Iceberg **Silver** and **Gold**
storage layers (S3 bucket + Spark **write** IAM policy + analytics **read**
IAM policy) so Spark can `CREATE` and `MERGE` Iceberg tables in the
`brain_silver` / `brain_gold` namespaces. It is the cloud mirror of the
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
- **No Glue catalog database** (AUD-COST-012): the runtime Iceberg catalog is
  the REST/JDBC catalog on Aurora (see "Prod go-live" step 2 above); the Glue
  IAM grants in the write/read policies are a dormant fallback only.
- `brain-<env>-spark-<layer>-write` IAM policy — Get/Put/Delete on the
  `<layer>/*` prefix only, KMS wrap/unwrap, and (dormant) Glue table writes
  scoped to the layer DB name. Mirrors Bronze NN-5 per-prefix scoping with an
  explicit DENY on bucket root.
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

# prod: UN-GATED (AUD-COST-001) and SINGLE-WAREHOUSE (AUD-COST-016): there are
# NO s3_iceberg_silver/s3_iceberg_gold blocks in envs/prod/bootstrap.tf — the
# one warehouse bucket (module s3_iceberg) holds brain_{bronze,silver,gold} as
# Iceberg namespaces, exactly like local. irsa_spark_jobs carries the single
# medallion RW policy. Plain plan/apply.
```

After apply, point the Spark jobs at the warehouse (per env outputs):

- prod (AUD-COST-016): `warehouse_bucket_name` → ONE warehouse root
  `s3://<warehouse_bucket_name>/`; the layers are Iceberg NAMESPACES inside it.
  dev/staging still output `silver_bucket_name`/`gold_bucket_name` (pre-V4
  per-layer layout, never applied — align with prod before applying them).
- Catalog: point Spark/Trino at the REST catalog (iceberg-rest chart, backed by
  the `iceberg_catalog` DB on Aurora — "Prod go-live" step 2). No Glue DBs.
- `spark_jobs_role_arn` → annotate the `brain-jobs` Kubernetes service account
  (`eks.amazonaws.com/role-arn`) in `infra/helm/cronworkflows/values-*.yaml`.

This is **non-breaking**: it adds new buckets, catalogs, and IAM only. No
existing bucket, read path, dbt model, or app code is changed.
