# Runbook — Production turn-on (ordered)

> **SUPERSEDED (2026-07-06) — use `docs/runbooks/GO-LIVE.md`.** This document describes the
> EC10 "declared-but-not-applied" baseline, which no longer exists: the prod modules were
> UN-GATED (AUD-COST-001, `envs/prod/bootstrap.tf`), RDS was replaced by Aurora Serverless v2
> (ADR-0009), Strimzi/Karpenter/pgbouncer prod apps now exist, and the `bronze-materialize`
> CronWorkflow it references was removed — Bronze landing is the kafka-connect Deployment
> (ADR-0010, `infra/argocd/envs/prod/kafka-connect.yaml`). Kept as historical context only.

Bring the Brain V4 platform up in the **prod** AWS account (`ap-south-1`) from the
EC10 "declared-but-not-applied" baseline to a serving stack. Grounded in
`infra/terraform/envs/prod`, `infra/helm/*`, and `infra/argocd/envs/prod/*`.

> EC10 baseline: only KMS + GitHub OIDC are applied in prod today
> (`envs/prod/bootstrap.tf`). Network / EKS / RDS / ElastiCache / S3 / IRSA modules
> are **declared but commented out** (zero idle spend). Turn-on = uncomment +
> apply in order, then sync ArgoCD.

This runbook complements `docs/runbooks/adr-0006-cutover-and-prod.md` and
`docs/runbooks/RB-5-bronze-iceberg-cutover.md` (the Bronze cut-over phases).

---

## 0. Preconditions

- Prod AWS account bootstrapped: state bucket (via `infra/terraform/bootstrap/`),
  GitHub OIDC provider, root KMS CMK — all already applied (`envs/prod/bootstrap.tf`).
- `terraform` ≥ 1.9, `aws` provider `~> 6.0`, `kubectl`, `helm`, `argocd` CLIs.
- Adopt the tag standard first: wire `module "tags"` +
  `default_tags { tags = module.tags.common_tags }` into the prod provider — see
  `docs/infra/naming-and-tagging.md` and `infra/terraform/modules/_shared`.

---

## 1. Terraform apply sequence (`infra/terraform/envs/prod`)

Uncomment the module blocks in `envs/prod/bootstrap.tf` and apply **in this
dependency order** (each `terraform apply -target` then a final full apply). Module
sources are under `infra/terraform/modules/`.

| Step | Module(s) | Resource (canonical name) | Notes |
| --- | --- | --- | --- |
| 1.1 | `kms`, `oidc_github` | root + audit CMK, GH plan role | already applied (bootstrap) |
| 1.2 | `network` | VPC `brain-prod`, subnets, NAT (one per AZ → `single_nat_gateway = false`), SGs | foundation |
| 1.3 | `s3_iceberg`, `s3_audit` | `brain-bronze-prod-{acct}` = the SINGLE medallion warehouse (NO Object Lock — AUD-COST-016; WORM stays on the audit bucket) | **before any data pipeline** |
| 1.4 | ~~`s3_iceberg_silver`, `s3_iceberg_gold`~~ | REMOVED (AUD-COST-016): Silver/Gold are Iceberg NAMESPACES in the 1.3 warehouse bucket, mirroring local | — |
| 1.5 | `eks` | cluster `brain-prod` (private endpoint), node group `brain-prod-system`, ECR repos `brain-{service}-prod` | `public_endpoint = false` (prod is private-only) |
| 1.6 | `rds` | `brain-prod-postgres` (PG16 Multi-AZ, PITR, deletion protection) | OLTP `ops` schema lives here |
| 1.7 | `elasticache` | `brain-prod-redis` (Multi-AZ, TLS, at-rest KMS) | analytics serving cache |
| 1.8 | `irsa_spark_jobs` + per-service IRSA | role for SA `brain-jobs` in ns `argo` | binds the single medallion RW policy from 1.3 (AUD-COST-016) |

```sh
cd infra/terraform/envs/prod
terraform init
terraform plan -out tfplan         # review: zero destroys expected on first apply
terraform apply tfplan
```

> Recommended cluster sizing on first apply: `system_node_desired = 3`,
> `system_node_min = 2`, `system_node_max = 6` (see the commented `module "eks"`
> usage block in `bootstrap.tf`).

> **Note:** because the prod root is bootstrap-only today, the module calls for
> network/eks/rds/s3/elasticache/irsa exist as **documented commented usage
> blocks** in `bootstrap.tf`. This runbook is the apply order for uncommenting
> them; do NOT expect them wired live until turn-on.

---

## 2. Cluster add-ons (before app sync)

Install in this order. **Honest status flags** for what exists vs. is to-be-created:

| Add-on | Purpose | Status in repo | Bring-up |
| --- | --- | --- | --- |
| EKS core add-ons | VPC-CNI, CoreDNS, kube-proxy, EBS-CSI | via `eks` module / EKS managed add-ons | enable on cluster |
| **ArgoCD** | GitOps controller | `infra/argocd/app-of-apps.yaml` (root app) | install ArgoCD, then apply app-of-apps |
| **Strimzi** (Kafka operator) | prod Kafka broker (KRaft) | ⚠️ **NOT in repo** — only referenced in comments (`infra/observe/k8s/kafka-observability.yaml`). No Strimzi `Kafka` CR / chart exists yet. **To-be-created.** | install Strimzi operator + author a `Kafka` CR producing the `prod.*` topics (see naming standard §3) |
| **Karpenter** | data-plane autoscaling | ⚠️ **NOT in repo** — no Karpenter manifests/IRSA. **To-be-created.** | install Karpenter + NodePool/EC2NodeClass; until then rely on the `brain-prod-system` managed node group |
| **KEDA** | event-driven worker autoscaling | installed; serving now scales via a plain HPA (`infra/helm/duckdb-serving`) — the old Trino worker ScaledObject is gone with the chart (ADR-0014) | — |
| **duckdb-serving** | serving engine (sole serving compute over Iceberg, ADR-0014 — replaced Trino) | ✅ chart `infra/helm/duckdb-serving` (`values-prod.yaml`: stateless replicas, min 2, HPA) | deployed via ArgoCD app `duckdb-serving-prod` |

> The compose-local broker service is named `redpanda` but runs Apache Kafka
> KRaft; in prod the equivalent is the **Strimzi-managed** Kafka. Topic names are
> identical (`prod.collector.event.v1`, `prod.{lane}.raw.v1`, …).

---

## 3. ArgoCD sync order (`infra/argocd/envs/prod`)

Prod has **NO automated sync** — every app has a manual promotion gate
(`syncPolicy` has no `automated` block; `core.yaml` comments "NO automated sync
for prod — manual promotion gate required"). Apps live in project `brain-prod`,
target revision `main`.

Apply the root, then sync children **in dependency order**:

```sh
kubectl apply -f infra/argocd/app-of-apps.yaml      # brain-app-of-apps (project: brain)
```

| Order | ArgoCD Application | Namespace | Chart | Why this order |
| --- | --- | --- | --- | --- |
| 3.1 | `duckdb-serving-prod` | `duckdb-serving` | `infra/helm/duckdb-serving` | serving substrate; app reads depend on it |
| 3.2 | `core-prod` | `core` | `infra/helm/core` | API/BFF (reads duckdb-serving + RDS + Redis) |
| 3.3 | `web-prod` | `web` | `infra/helm/web` | UI (reads core) |
| 3.4 | `collector-prod` | `collector` | `infra/helm/collector` | ingest accept tier |
| 3.5 | `stream-worker-prod` | `stream-worker` | `infra/helm/stream-worker` | drain → Kafka → Bronze |
| 3.6 | `cronworkflows-prod` | `argo` | `infra/helm/cronworkflows` | Spark Bronze + V4 Silver/Gold crons |

```sh
for app in duckdb-serving-prod core-prod web-prod collector-prod stream-worker-prod cronworkflows-prod; do
  argocd app sync "$app"
  argocd app wait "$app" --health --timeout 600
done
```

> `pgbouncer` chart (`infra/helm/pgbouncer`) exists but has **no prod ArgoCD
> Application** in `envs/prod` yet — add `pgbouncer-prod` before/with `core-prod`
> if RDS connection pooling is required. **(to-be-created)**

### CronWorkflows that come online with 3.6

| Workflow | File |
| --- | --- |
| `bronze-materialize`, `bronze-maintenance` | `infra/helm/cronworkflows/templates/spark-bronze.yaml` |
| `v4-silver`, `v4-gold` | `infra/helm/cronworkflows/templates/spark-v4.yaml` |

---

## 4. Smoke tests

### 4.1 Connectivity / health

```sh
kubectl -n duckdb-serving get pods              # ≥2 stateless replicas Ready (/readyz green)
kubectl -n core  get pods                        # core Ready, talks to RDS + Redis + duckdb-serving
kubectl -n argo  get cronworkflows               # bronze-materialize, v4-silver, v4-gold present
argocd app list -p brain-prod                    # all 6 apps Healthy + Synced
```

Trigger one Bronze materialize + one V4 refresh manually and confirm Iceberg
commits land:

```sh
argocd app actions run cronworkflows-prod ...    # or: kubectl create -f from the cron template
```

### 4.2 Load test (k6) — `tools/load-test`

The k6 harness exists: `tools/load-test/ingest.js` (collector accept path,
`:8787`) and `tools/load-test/serving.js` (BFF analytics reads, `:3000`). Point
at the prod ingress (use a dedicated/isolated target, modest VUs):

```sh
brew install k6   # or grafana k6 install docs
k6 run -e COLLECTOR_URL=https://<collector-ingress> \
       -e BRAND_ID=<brand-uuid> -e INSTALL_TOKEN=<pixel-install-token> \
       -e VUS=100 -e DURATION=10m tools/load-test/ingest.js

k6 run -e BASE_URL=https://<web-ingress> tools/load-test/serving.js
```

See `tools/load-test/README.md` for env vars and the **operator post-run
assertions** k6 cannot see directly (Spark event-count == sent, streaming lag,
zero-OOM via Prometheus).

### 4.3 Bronze dedup ("effectively-once") test

The Bronze landing dedups on the Kafka coordinate `(topic, partition, offset)` so
replays never double-write. Verify:

- Live test: `apps/stream-worker/src/tests/bronze-dedup-effectively-once.live.test.ts`
- Guarantee + manual replay procedure: `tools/load-test/DEDUP-GUARANTEE.md`

Run the dedup live test against the deployed pipeline, or follow the manual
replay-and-recount in `DEDUP-GUARANTEE.md`: produce a batch, force a re-delivery
(replay the same offsets), then assert the Bronze row count is unchanged.

---

## 5. Rollback

- ArgoCD: `argocd app rollback <app-prod> <revision>` (10 revisions retained,
  `revisionHistoryLimit: 10`).
- Terraform: `terraform apply` a prior plan; RDS has PITR + 35-day backups +
  deletion protection; Bronze S3 is Object-Lock WORM (immutable, cannot be
  rolled back destructively by design).
- Bronze cut-over rollback phases: `docs/runbooks/RB-5-bronze-iceberg-cutover.md`.

---

## 6. Names referenced that DO NOT yet exist (flag for creation)

| Name | Referenced for | Status |
| --- | --- | --- |
| `tools/dev/dev-bronze-streaming.sh` | host combined-bronze wrapper | not in repo; Bronze landing is the compose `kafka-connect` service / `infra/helm/kafka-connect` chart (ADR-0010, cutover 2026-07-05 — see local-dev runbook) |
| Strimzi `Kafka` CR / operator manifests | prod Kafka broker | not in repo (only doc comments); to-be-created |
| Karpenter NodePool / EC2NodeClass / IRSA | data-plane autoscaling | not in repo; to-be-created |
| `pgbouncer-prod` ArgoCD Application | RDS connection pooling | chart exists, prod Application missing; to-be-created |
| KEDA install | event-driven worker autoscaling | KEDA is installed; serving autoscaling is a plain HPA in `infra/helm/duckdb-serving` (the old Trino ScaledObject stub is gone — ADR-0014) |

Everything else referenced (Terraform modules, Helm charts, ArgoCD apps,
CronWorkflows, k6 scripts, dedup test) was verified to exist in the repo.
