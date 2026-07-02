# Brain — Infrastructure Naming & Tagging Standard

Status: **standard** (authoring deliverable G). Scope: all AWS + Kubernetes +
Kafka + Iceberg infrastructure for Brain V4. Region: `ap-south-1`. Account model:
one AWS account per environment (`dev` / `staging` / `prod`).

This document is the canonical reference. It is **grounded in the actual
Terraform/Helm/ArgoCD code** under `infra/`; where the existing code diverges
from the target convention that divergence is called out explicitly in §5–§6 so
it can be reconciled rather than silently ignored.

---

## 1. The convention

```
brain-{env}-{layer}-{resource}
```

| Segment | Allowed values | Notes |
| --- | --- | --- |
| `brain` | constant project slug | `var.project`, default `brain` |
| `{env}` | `dev` \| `staging` \| `prod` | `var.environment` |
| `{layer}` | logical tier — `bronze` \| `silver` \| `gold` (medallion), or a service/zone name (`core`, `system`, `eks`, `rds`, `redis`) | optional; omitted where the resource type already implies the layer |
| `{resource}` | the AWS/k8s resource role (`postgres`, `redis`, `cluster`, `node`, `sg`, `subnet-group`, …) | |

Separator is `-` for AWS resource names and Helm/k8s objects; `_` for Glue/Iceberg
catalog databases (AWS Glue database names disallow `-`). Lowercase only.

Three well-established **ordering exceptions** are baked into the current code
and are kept for backward-compatibility (they are stable identifiers; renaming
forces resource replacement):

- **ECR repositories** put the service before the env: `brain-{service}-{env}`.
- **S3 medallion buckets** put the layer before the env and append the account
  id for global uniqueness: `brain-{layer}-{env}-{account_id}`.
- **KMS aliases** put the resource before the env: `alias/brain-{resource}-{env}`
  (`alias/brain-root-prod`, `alias/brain-audit-prod`, `alias/brain-tfstate-prod`).
  RATIFIED as-is 2026-07-02 (AUD-NAME-007): the prod CMKs are already applied,
  the ordering matches the ECR/S3 exceptions, and an alias rename (while cheap —
  alias-resource-only) buys nothing. No rename.

---

## 2. Mandatory tag set

Every taggable resource MUST carry these four tags:

| Key | Value | Meaning |
| --- | --- | --- |
| `Environment` | `dev` \| `staging` \| `prod` | deployment environment |
| `Service` | `core` \| `web` \| `collector` \| `stream-worker` \| `spark-bronze` \| `trino` \| `platform` | owning deployable; `platform` for shared infra |
| `Owner` | `data-team` | owning team |
| `CostCenter` | `brain-platform` | finance cost-allocation bucket |

Recommended baseline (set once via `default_tags`): `Project=brain`,
`ManagedBy=terraform`.

Apply these via the provider `default_tags` block fed by the shared module
`infra/terraform/modules/_shared` (`module.tags.common_tags`) — see that module's
README. Set a per-resource `Service` (and a `Name` tag where AWS shows one) on
service-scoped resources; everything else inherits from `default_tags`.

---

## 3. Canonical resource-name table

Grounded in the modules under `infra/terraform/modules/` (prod shown; swap `prod`
for `dev`/`staging`).

### Compute / EKS — `modules/eks`, `modules/network`

| Resource type | Name pattern | Example (prod) | Source |
| --- | --- | --- | --- |
| EKS cluster | `brain-{env}` | `brain-prod` | `eks/main.tf` `aws_eks_cluster.main` |
| Cluster IAM role | `brain-{env}-eks-cluster` | `brain-prod-eks-cluster` | `eks/main.tf` |
| Node IAM role | `brain-{env}-eks-node` | `brain-prod-eks-node` | `eks/main.tf` |
| Managed node group (system) | `brain-{env}-system` | `brain-prod-system` | `eks/main.tf` `aws_eks_node_group.system` |
| ECR repo (per service) | `brain-{service}-{env}` | `brain-core-prod`, `brain-spark-bronze-prod` | `eks/main.tf` `aws_ecr_repository.services` |
| VPC | `brain-{env}` (Name tag) | `brain-prod` | `network/main.tf` |
| Public subnet | `brain-{env}-public-{n}` | `brain-prod-public-1` | `network/main.tf` |
| Private subnet | `brain-{env}-private-{n}` | `brain-prod-private-1` | `network/main.tf` |
| NAT gateway | `brain-{env}-nat-{n}` | `brain-prod-nat-1` | `network/main.tf` |
| Security groups | `brain-{env}-{eks-cluster\|eks-nodes\|rds\|elasticache}` | `brain-prod-rds` | `network/main.tf` |

> ECR `{service}` set today: `collector`, `stream-worker`, `core`, `web`,
> `spark-bronze` (the data-plane image carrying the Spark Bronze sink + V4
> Silver/Gold marts). `dbt-runner` is **retired** (Spark is the sole compute).

> **VPC spans 3 AZs** (`ap-south-1a/b/c` — `modules/network` default, not
> overridden by `envs/prod/bootstrap.tf`). RATIFIED 2026-07-02 (AUD-PROD-015,
> was "spec says 2"): the Aurora DB subnet group and the EKS control-plane /
> node placement use the third AZ for subnet-spread headroom and HA — losing
> one AZ still leaves a 2-AZ quorum for Aurora failover and node rescheduling.
> Accepted cost tradeoff: each of the 5 interface endpoints (`sts`,
> `secretsmanager`, `ecr.api`, `ecr.dkr`, `logs` — `modules/vpc-endpoints`)
> places an ENI in all 3 AZs, i.e. one extra ~$7/mo PrivateLink AZ-ENI per
> endpoint (~$35/mo total) versus a 2-AZ layout. Subnet CIDR changes are
> destructive, so this is pinned pre-apply.

### Karpenter node capacity — `infra/helm/karpenter`, `modules/karpenter`

| Object | Name pattern | Example (prod) | Source |
| --- | --- | --- | --- |
| NodePool CR | `{pool}` (no env prefix — CRs are cluster-scoped and the cluster is single-env) | `streaming`, `batch`, `trino`, `ondemand` | `helm/karpenter/values.yaml` `nodePools` |
| EC2NodeClass CR | `brain-default` | `brain-default` | `helm/karpenter/values.yaml` `ec2NodeClass.name` |
| Interruption SQS queue | == cluster name | `brain-prod` | `modules/karpenter/main.tf` |
| Discovery tag | `karpenter.sh/discovery = brain-{env}` | `brain-prod` | `network/main.tf`, `helm/karpenter/values-prod.yaml` |

> Per AUD-COST-010 (ratified 2026-07-02 as AUD-NAME-004): workload capacity is
> Karpenter NodePools (`streaming`/`batch`/`trino` Spot + the tainted
> `ondemand` pool hosting Neo4j, the identity SoR — AUD-COST-018), **not**
> managed node groups. The blueprint's `brain-{env}-{pool}-ng` node-group names
> have no counterpart **by design**; only the system MNG (`brain-{env}-system`)
> is EKS-managed. Karpenter-launched instances/volumes carry the §2 mandatory
> tags via the EC2NodeClass `spec.tags`.

### Aurora PostgreSQL (Serverless v2) — `modules/aurora` (prod)

| Resource type | Name pattern | Example (prod) | Source |
| --- | --- | --- | --- |
| Aurora cluster | `brain-{env}-postgres` | `brain-prod-postgres` | `aurora/main.tf` `aws_rds_cluster.postgres` |
| Cluster instance | `brain-{env}-postgres-{n}` | `brain-prod-postgres-1` | `aurora/main.tf` `aws_rds_cluster_instance` |
| DB subnet group | `brain-{env}-aurora` | `brain-prod-aurora` | `aurora/main.tf` |
| Security group | `brain-{env}-aurora` | `brain-prod-aurora` | `aurora/main.tf` |
| Cluster parameter group | `brain-{env}-aurora-postgres16` | `brain-prod-aurora-postgres16` | `aurora/main.tf` |
| Final snapshot | `brain-{env}-aurora-final-snapshot` | `brain-prod-aurora-final-snapshot` | `aurora/main.tf` |

> **Prod runs Aurora Serverless v2** (`aurora-postgresql`, 0.5–2 ACU
> burst-elastic, managed HA) per **ADR-0009** — `envs/prod/bootstrap.tf`
> `module "aurora"`. The former note here ("the engine is PostgreSQL 16, not
> Aurora") described `modules/rds` and is **superseded** for prod; the cluster
> identifier deliberately keeps the `brain-{env}-postgres` pattern for
> continuity with `modules/rds` (see `aurora/main.tf` header). PG remains
> operational-only (the `ops` schema) — the medallion lives in Iceberg.

### KMS keys — `modules/kms`, `bootstrap`

| Resource type | Name pattern | Example (prod) | Source |
| --- | --- | --- | --- |
| Root CMK alias | `alias/brain-root-{env}` | `alias/brain-root-prod` | `kms/main.tf:46` |
| Audit CMK alias | `alias/brain-audit-{env}` | `alias/brain-audit-prod` | `kms/main.tf:67` |
| TF-state CMK alias | `alias/brain-tfstate-{env}` | `alias/brain-tfstate-prod` | `bootstrap/main.tf:67` |
| TF-state bucket | `brain-tfstate-{env}-{account_id}` | `brain-tfstate-prod-…` | `bootstrap/main.tf:90` |

> KMS aliases use `alias/brain-{resource}-{env}` — a documented §1 ordering
> exception (AUD-NAME-007, RATIFIED 2026-07-02; no rename — the CMKs and
> everything encrypted with them are untouched by keeping the applied names).

### ElastiCache (Redis) — `modules/elasticache`

| Resource type | Name pattern | Example (prod) | Source |
| --- | --- | --- | --- |
| Replication group | `brain-{env}-redis` | `brain-prod-redis` | `elasticache/main.tf` |
| Cache subnet group | `brain-{env}-redis` | `brain-prod-redis` | `elasticache/main.tf` |

### S3 buckets + Iceberg catalog — `modules/s3-iceberg`, `modules/s3-audit`

| Resource type | Name pattern | Example (prod) | Source |
| --- | --- | --- | --- |
| Medallion warehouse bucket (the ONE bucket) | `brain-bronze-{env}-{account_id}` | `brain-bronze-prod-123456789012` | `s3-iceberg/main.tf` `aws_s3_bucket.bronze` |
| Iceberg namespaces (prefixes under the warehouse root) | `brain_bronze` / `brain_silver` / `brain_gold` | `s3://brain-bronze-prod-…/brain_silver/` | `s3-iceberg/main.tf` `medallion_namespaces` |
| Audit bucket (WORM) | `brain-audit-{env}-{account_id}` | `brain-audit-prod-…` | `s3-audit/main.tf` |
| Stream-worker S3 IAM policy | `brain-{env}-stream-worker-s3` | `brain-prod-stream-worker-s3` | `s3-iceberg/main.tf` |
| Spark medallion RW IAM policy | `brain-{env}-spark-medallion-rw` | `brain-prod-spark-medallion-rw` | `s3-iceberg/main.tf` |
| Analytics read IAM policy | `brain-{env}-analytics-s3-read` | `brain-prod-analytics-s3-read` | `s3-iceberg/main.tf` |

> **ONE warehouse bucket (AUD-COST-016, RATIFIED as AUD-PROD-009 2026-07-02):**
> prod does NOT use per-layer Silver/Gold buckets. The single iceberg-rest
> (JdbcCatalog) server has ONE warehouse root, and the medallion layers are
> Iceberg **namespaces** — top-level prefixes under that root — exactly
> mirroring the proven local lakehouse (`CATALOG_WAREHOUSE=s3://brain-bronze/`).
> `modules/s3-iceberg-medallion` is **no longer used by prod** (its header says
> so). The bucket keeps the historical `-bronze-` name for local-parity
> (AUD-NAME-005, ratified §1 ordering exception). IAM still separates layers by
> namespace prefix: stream-worker = `brain_bronze/*` write-only (NN-5), Spark =
> 3-namespace RW, analytics = read-only.
>
> **NO Object Lock on the data bucket** (AUD-COST-016 removed it; the former
> NN-4 "Bronze WORM 7-yr" row is superseded): Iceberg MERGE, compaction,
> `expire_snapshots` and right-to-erasure purges all DELETE objects — WORM
> would break the table format (`s3-iceberg/main.tf` checkov-skip rationale).
> WORM/COMPLIANCE retention lives ONLY on the audit bucket (`modules/s3-audit`).
>
> **No Glue databases** (AUD-COST-012): the runtime catalog is the REST/JDBC
> catalog (`infra/helm/iceberg-rest` → JdbcCatalog on Aurora); the former
> `aws_glue_catalog_database` was dead metadata. Glue IAM grants remain as a
> dormant fallback only.

### Helm releases / ArgoCD Applications — `infra/helm/*`, `infra/argocd/envs/*`

| Object | Name pattern | Example (prod) | Source |
| --- | --- | --- | --- |
| Helm chart | `{service}` | `core`, `web`, `trino`, `collector`, `stream-worker`, `pgbouncer`, `cronworkflows` | `infra/helm/*/Chart.yaml` |
| ArgoCD Application | `{service}-{env}` | `core-prod`, `trino-prod`, `cronworkflows-prod` | `infra/argocd/envs/prod/*.yaml` |
| ArgoCD project | `brain-{env}` | `brain-prod` | `infra/argocd/envs/prod/*.yaml` (`spec.project`) |
| App-of-apps root | `brain-app-of-apps` | — | `infra/argocd/app-of-apps.yaml` |
| K8s namespace (per service) | `{service}` | `core`, `web`, `trino`, `argo` | ArgoCD `destination.namespace` |

> ArgoCD apps flip the order to `{service}-{env}` (service first) — this is the
> Kubernetes/Argo convention and is intentional. Helm **release** names follow
> the ArgoCD Application name.

### CronWorkflows (Argo) — `infra/helm/cronworkflows/templates`

| Workflow | Name | Source |
| --- | --- | --- |
| Bronze materialize | `bronze-materialize` | `spark-bronze.yaml` |
| Bronze maintenance | `bronze-maintenance` | `spark-bronze.yaml` |
| V4 Silver | `v4-silver` | `spark-v4.yaml` |
| V4 Gold | `v4-gold` | `spark-v4.yaml` |

### Kafka topics — `docker-compose.yml` `redpanda-init`, `packages/contracts`

```
{env}.{domain}.{event}.v{n}
```

`{env}` prefix is `prod` / `dev` (derived from `APP_ENV`). Examples (prod):

| Topic | Purpose |
| --- | --- |
| `prod.collector.event.v1` | collector pixel/event ingest lane |
| `prod.collector.order.backfill.v1` | server-trusted backfill lane |
| `prod.{lane}.raw.v1` | the 9 connector raw landing lanes (e.g. `prod.shopify.raw.v1`) |
| `prod.{domain}.{event}.v1` | M1 control/domain events (`order.created.v1`, `pixel.installed.v1`, …) |

> The compose broker service/DNS name is still `redpanda` for backward-compat,
> but it runs `apache/kafka:3.8.1` (KRaft). In prod the broker is Strimzi-managed
> (see prod-deploy runbook) — topic names are unchanged.

---

## 4. Iceberg / Trino serving naming (logical, not infra)

These are logical names enforced in app/SQL code, included here for completeness:

- Rest-Iceberg catalogs: `brain_{bronze,silver,gold}_local` (local) → the same
  `brain_{layer}` namespaces under the single REST/JDBC catalog warehouse in
  cloud (no Glue DBs — AUD-COST-012; see §3 S3/Iceberg notes).
- Trino serving views: `brain_serving.mv_*` → resolve to `iceberg.brain_serving.*`.
- Money is `bigint` minor units + sibling `currency_code`; tenant key is
  `brand_id` on every row/event/key.

---

## 5. Tag-key divergence (current code vs this standard)

The resource modules today emit **lowercase** tag keys via inline `tags = {}`:
`project`, `environment`, `managed_by`, plus per-resource `purpose`, `service`,
`role`, `tier`. The env-root provider `default_tags` (see
`envs/prod/bootstrap.tf`) sets `project` / `environment` / `managed_by`.

This standard mandates the **PascalCase** keys `Environment` / `Service` /
`Owner` / `CostCenter`. AWS treats `environment` and `Environment` as distinct
keys, so a resource will temporarily carry both during migration. That is
acceptable (cost reports can group on either) but should be reconciled.

---

## 6. Follow-up reconciliation checklist (NOT done by this deliverable)

This deliverable only **authors the standard + the shared module**; it does not
edit existing resource modules. To adopt:

- [ ] Add the `module "tags"` + `default_tags { tags = module.tags.common_tags }`
      block to `envs/dev/`, `envs/staging/`, `envs/prod/` providers.
- [ ] Remove the lowercase `default_tags` (`project`/`environment`/`managed_by`)
      from each env provider once `common_tags` carries `Project`/`ManagedBy`.
- [ ] Strip the inline lowercase `tags = { project, environment, … }` blocks from
      `modules/{rds,eks,network,elasticache,s3-iceberg,s3-iceberg-medallion,s3-audit,observability,kms,secrets}`;
      keep only `Name` and per-resource `Service`/`role`/`purpose`/`tier`.
- [ ] Add `Service` to each service-scoped resource (ECR repo `each.key`, IAM
      roles, per-service buckets).
- [ ] Add a CI check (extend `tools/lint/`) asserting the four mandatory tags are
      present on new resources.
- [ ] Decide whether to rename the `redpanda` compose service to `kafka` (cosmetic
      only — many references depend on the DNS name; out of scope here).
