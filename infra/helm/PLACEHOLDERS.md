# PLACEHOLDERS — the canonical fill-at-apply list (AUD-COST-007)

Prod is a blueprint until `infra/terraform/envs/prod` is applied — these values
genuinely cannot exist before `terraform output` does. This file is the single
list of what must be filled, where each value comes from, and which IAM roles
the helm/argocd manifests reference that terraform does / does not yet create.

Run the fill pass after `terraform apply` (script it with `yq`; a CI guard that
fails prod-promote while `REPLACE_WITH_|ACCOUNT_ID` remains in values-prod
files is the tracked follow-up).

## 1. The single account variable

| Placeholder | Meaning |
| --- | --- |
| `ACCOUNT_ID` | The AWS account id (one per env). Appears in every IRSA `role-arn` annotation and in `infra/argocd/envs/prod/karpenter.yaml`. Deliberately kept as ONE variable — everything else in those ARNs is fixed by convention (below). |

`<PROD_ACCOUNT_ID>` / `<STAGING_ACCOUNT_ID>` / `<DEV_ACCOUNT_ID>` in
`infra/terraform/envs/*/backend.tf` are the same variable (backends cannot
interpolate).

## 2. Derivable from `terraform output` (envs/prod)

| Placeholder | Files | Source |
| --- | --- | --- |
| `REPLACE_WITH_ECR_REGISTRY` | all chart `values*.yaml` image repos | `<ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com` (= prefix of `ecr_repository_urls`) |
| `REPLACE_WITH_DIGEST` | `infra/argocd/rollouts/collector-rollout.yaml` | CI fills app-chart digests (prod-promote); the rollouts files are NOT CD-touched — fill manually |
| `REPLACE_WITH_AURORA_ENDPOINT` | `iceberg-rest/values-prod.yaml` | `aurora_endpoint` |
| warehouse `s3://brain-bronze-prod-ACCOUNT_ID/` | `iceberg-rest/values-prod.yaml` | `warehouse_bucket_name` (AUD-COST-016: ONE warehouse bucket; Bronze/Silver/Gold are Iceberg namespaces inside it — no per-layer buckets) |
| `REPLACE_WITH_PROD_POSTGRES_HOST` | `pgbouncer/values-prod.yaml` | `aurora_endpoint` (pgbouncer fronts Aurora) |
| `REPLACE_WITH_STAGING_POSTGRES_HOST` | `pgbouncer/values-staging.yaml` | staging `aurora_endpoint` |
| `REPLACE_WITH_VPC_ID` | `argocd/envs/prod/aws-load-balancer-controller.yaml` | `vpc_id` |
| metrics bucket `brain-metrics-prod-ACCOUNT_ID` | `kube-prometheus-stack/values-prod.yaml` (Thanos sidecar objstore, AUD-PROD-012) | `metrics_bucket_name` (`modules/s3-metrics`; IRSA-native — no static keys, the `brain-prod-thanos` role carries the objstore policy) |
| `AUDIT_CHECKPOINT_BUCKET` (key in the `core-env` secret, §5) | consumed by `apps/core/src/jobs/audit-checkpoint.ts` (hourly `audit-checkpoint` CronWorkflow — the WORM anchor for the audit hash-chain) | `audit_bucket_name` (`modules/s3-audit`, wired in every env root). NOTE: this is the audit bucket's OWN S3 Object-Lock COMPLIANCE bucket, **not** the medallion warehouse or its `_checkpoints/` prefix; no new terraform needed — the `brain-<env>-jobs` IRSA role already grants Put/Get/List on `checkpoints/*`. Left unset, the job safely no-ops (dev behavior) |

ECR repo names are already aligned with terraform
(`brain-<service>-<env>`, e.g. `brain-core-prod` — `modules/eks` `local.services`).

## 3. Not derivable from terraform (operator decisions)

| Placeholder | Files | Fill with |
| --- | --- | --- |
| `REPLACE_WITH_COLLECTOR_HOSTNAME` | `collector/values-prod.yaml` | e.g. `px.<apex-domain>` — the pixel endpoint (99.95% SLA edge) |
| `REPLACE_WITH_WEB_HOSTNAME` | `web/values-prod.yaml` | e.g. `app.<apex-domain>` |
| `REPLACE_WITH_CORE_HOSTNAME` | `core/values-prod.yaml` | e.g. `api.<apex-domain>` |
| `REPLACE_WITH_ACM_CERT_ARN` | the three values-prod above | ACM cert (ap-south-1) covering those hosts |
| `REPLACE_WITH_APEX_DOMAIN` | `argocd/envs/prod/external-dns.yaml` | the Route53 hosted zone external-dns may manage. Manual-DNS alternative: skip the external-dns app and CNAME each hostname to the shared ALB |

`REPLACE_WITH_PROMETHEUS_ADDRESS` is GONE (AUD-PROD-002): the rollouts
manifests now carry the in-cluster kube-prometheus-stack Prometheus address
(`http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090`
— the `kube-prometheus-stack-prod` app, ns `monitoring`) — nothing to fill.

## 4. IRSA role convention + terraform coverage

Convention (modules/irsa): `arn:aws:iam::<ACCOUNT_ID>:role/<project>-<environment>-<name>`
(`brain-prod-core`, `brain-staging-jobs`, ...). The helm values previously said
`brain-core-prod` (name-first) — fixed here; a mismatched role name is a
deterministic STS AccessDenied at pod start.

**Created by terraform today** (`envs/prod/bootstrap.tf`):
`brain-prod-collector`, `brain-prod-stream-worker`, `brain-prod-core`,
`brain-prod-jobs` (SA `brain-jobs` @ ns `argo`),
`brain-prod-karpenter-controller`, plus the CI roles (github-plan /
github-ecr-push / github-apply) — **and, since AUD-COST-017, all six
platform/serving roles** the manifests reference:

| Role | Consumer (SA @ ns) | Policy |
| --- | --- | --- |
| `brain-prod-web` | `web` @ `web` (`web/values-prod.yaml`) | none (empty role so the annotation resolves) |
| `brain-prod-trino` | `brain-prod-trino` @ `trino` | medallion warehouse read-only (`analytics_s3_policy_arn`, AUD-COST-016 layout) |
| `brain-prod-iceberg-rest` | `iceberg-rest` @ `iceberg-rest` | medallion warehouse RW (`spark_medallion_rw_policy_arn` — the catalog server writes table metadata) |
| `brain-prod-external-secrets` | `external-secrets` @ `external-secrets` (name PINNED in the ArgoCD app) | `secretsmanager:GetSecretValue/DescribeSecret` on `brain/prod/k8s/*` (`eso_k8s_secrets_read_policy_arn`) |
| `brain-prod-aws-load-balancer-controller` | `aws-load-balancer-controller` @ `kube-system` | upstream v2.10.1 policy, vendored at `envs/prod/policies/aws-load-balancer-controller-iam-policy.json` |
| `brain-prod-external-dns` | `external-dns` @ `external-dns` | `route53:ChangeResourceRecordSets` on `var.external_dns_zone_ids` (default `hostedzone/*` until the zone id is set) + `route53:List*` |
| `brain-prod-thanos` (AUD-PROD-012) | `kube-prometheus-stack-prometheus` @ `monitoring` (name PINNED — the chart's Prometheus SA, shared by the Thanos sidecar) | `thanos_objstore_policy_arn` (`modules/s3-metrics` — Get/Put/Delete/List on the metrics bucket + KMS GenerateDataKey/Decrypt) |

Nothing referenced by a manifest is missing from terraform anymore; a new role
belongs in `envs/prod/bootstrap.tf` as a `modules/irsa` instance in the same
PR that adds its annotation.

## 5. Secrets Manager entries (values, never in TF state)

`brain/prod/k8s/{core-env, web-env, collector-env, stream-worker-env,
pgbouncer-env, iceberg-rest-catalog-db, neo4j-auth}` — contents and key
contracts documented in `infra/helm/external-secrets-config/README.md`.
The terraform `secrets` module creates these SHELLS + the ESO read policy
(AUD-COST-017), so the go-live fill is a value update:
`aws secretsmanager put-secret-value --secret-id brain/prod/k8s/<name> --secret-string file://<name>.json`
— values are seeded by the operator and never enter TF state.

## kafka-connect (ADR-0010 Bronze landing writer)
- `REPLACE_WITH_WAREHOUSE_BUCKET` (`helm/kafka-connect/values-prod.yaml`): the single
  medallion warehouse bucket — terraform output `warehouse_bucket_name`
  (`modules/s3-iceberg`, `brain-bronze-prod-<acct>`). Same bucket iceberg-rest serves;
  Connect writes through the REST catalog with IRSA S3 credentials (no static keys).
