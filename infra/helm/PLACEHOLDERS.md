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
| `REPLACE_WITH_PROMETHEUS_ADDRESS` | `argocd/rollouts/*.yaml` | the Prometheus endpoint (observability stack) |

## 4. IRSA role convention + terraform coverage

Convention (modules/irsa): `arn:aws:iam::<ACCOUNT_ID>:role/<project>-<environment>-<name>`
(`brain-prod-core`, `brain-staging-jobs`, ...). The helm values previously said
`brain-core-prod` (name-first) — fixed here; a mismatched role name is a
deterministic STS AccessDenied at pod start.

**Created by terraform today** (`envs/prod/bootstrap.tf`):
`brain-prod-collector`, `brain-prod-stream-worker`, `brain-prod-core`,
`brain-prod-jobs` (SA `brain-jobs` @ ns `argo`),
`brain-prod-karpenter-controller`, plus the CI roles (github-plan /
github-ecr-push / github-apply).

**Referenced by manifests but NOT yet in terraform** (each needs a
`modules/irsa` instance + policy before its app can start):

| Role | Consumer | Policy sketch |
| --- | --- | --- |
| `brain-prod-web` | `web/values-prod.yaml` | none needed today (drop the annotation or create an empty role) |
| `brain-prod-trino` | `trino/values-prod.yaml` (ns `trino`, SA per chart) | read S3 medallion buckets (analytics policy) |
| `brain-prod-iceberg-rest` | `iceberg-rest/values-prod.yaml` (ns `iceberg-rest`) | S3 RW on the medallion buckets |
| `brain-prod-external-secrets` | `argocd/envs/prod/external-secrets.yaml` (ns `external-secrets`) | `secretsmanager:GetSecretValue/DescribeSecret` on `brain/prod/k8s/*` |
| `brain-prod-aws-load-balancer-controller` | `argocd/envs/prod/aws-load-balancer-controller.yaml` (ns `kube-system`) | upstream ALB controller IAM policy |
| `brain-prod-external-dns` | `argocd/envs/prod/external-dns.yaml` (ns `external-dns`) | `route53:ChangeResourceRecordSets` on the zone + `route53:List*` |

## 5. Secrets Manager entries (values, never in TF state)

`brain/prod/k8s/{core-env, web-env, collector-env, stream-worker-env,
pgbouncer-env, iceberg-rest-catalog-db, neo4j-auth}` — contents and key
contracts documented in `infra/helm/external-secrets-config/README.md`.
The terraform `secrets` module must grow these shells + the ESO read policy.
