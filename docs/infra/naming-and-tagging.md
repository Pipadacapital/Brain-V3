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

Two well-established **ordering exceptions** are baked into the current code and
are kept for backward-compatibility (they are stable identifiers; renaming forces
resource replacement):

- **ECR repositories** put the service before the env: `brain-{service}-{env}`.
- **S3 medallion buckets** put the layer before the env and append the account
  id for global uniqueness: `brain-{layer}-{env}-{account_id}`.

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

### Aurora / RDS Postgres — `modules/rds`

| Resource type | Name pattern | Example (prod) | Source |
| --- | --- | --- | --- |
| RDS instance | `brain-{env}-postgres` | `brain-prod-postgres` | `rds/main.tf` `aws_db_instance.postgres` |
| DB subnet group | `brain-{env}-rds` | `brain-prod-rds` | `rds/main.tf` |
| DB parameter group | `brain-{env}-postgres16` | `brain-prod-postgres16` | `rds/main.tf` |
| Final snapshot | `brain-{env}-final-snapshot` | `brain-prod-final-snapshot` | `rds/main.tf` |

> The module is named `rds`; the engine is PostgreSQL 16 (not Aurora). The
> "Aurora" row in the blueprint maps to this `brain-{env}-postgres` instance.

### ElastiCache (Redis) — `modules/elasticache`

| Resource type | Name pattern | Example (prod) | Source |
| --- | --- | --- | --- |
| Replication group | `brain-{env}-redis` | `brain-prod-redis` | `elasticache/main.tf` |
| Cache subnet group | `brain-{env}-redis` | `brain-prod-redis` | `elasticache/main.tf` |

### S3 buckets + Glue/Iceberg catalogs — `modules/s3-iceberg`, `modules/s3-iceberg-medallion`, `modules/s3-audit`

| Resource type | Name pattern | Example (prod) | Source |
| --- | --- | --- | --- |
| Bronze bucket (WORM) | `brain-bronze-{env}-{account_id}` | `brain-bronze-prod-123456789012` | `s3-iceberg/main.tf` |
| Silver bucket | `brain-silver-{env}-{account_id}` | `brain-silver-prod-…` | `s3-iceberg-medallion/main.tf` |
| Gold bucket | `brain-gold-{env}-{account_id}` | `brain-gold-prod-…` | `s3-iceberg-medallion/main.tf` |
| Audit bucket | (see `modules/s3-audit`) | — | `s3-audit/main.tf` |
| Glue/Iceberg DB (bronze) | `brain_bronze_{env}` | `brain_bronze_prod` | `s3-iceberg/main.tf` |
| Glue/Iceberg DB (silver/gold) | `brain_{layer}_{env}` | `brain_silver_prod`, `brain_gold_prod` | `s3-iceberg-medallion/main.tf` |
| Stream-worker S3 IAM policy | `brain-{env}-stream-worker-s3` | `brain-prod-stream-worker-s3` | `s3-iceberg/main.tf` |
| Analytics read IAM policy | `brain-{env}-analytics-s3-read` | `brain-prod-analytics-s3-read` | `s3-iceberg/main.tf` |

> Bronze carries Object-Lock COMPLIANCE + 7-yr retention (NN-4); Silver/Gold are
> derived/rebuildable so they deliberately have NO Object Lock. Iceberg namespaces
> seen by Spark/Trino are `brain_bronze` / `brain_silver` / `brain_gold` (the
> `_{env}` suffix scopes the physical Glue DB per account).

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

- Rest-Iceberg catalogs: `brain_{bronze,silver,gold}_local` (local) → Glue DBs
  `brain_{layer}_{env}` in cloud.
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
