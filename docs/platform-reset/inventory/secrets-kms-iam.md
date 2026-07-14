# Platform Reset Inventory — Secrets, KMS & IAM

- **Account:** `380254378136` (PAID PRODUCTION)
- **Primary region:** `ap-south-1` (Mumbai)
- **Global-service / straggler sweep:** `us-east-1` — swept and **CLEAN** (no Secrets, no SSM params, no `brain`-named KMS aliases). IAM is global (single view).
- **Inventory method:** read-only AWS CLI (`describe/list/get`) as caller `arn:aws:iam::380254378136:user/Rishabh`.
- **Generated:** 2026-07-14
- **Scope:** AWS Secrets Manager, SSM Parameter Store, KMS keys/aliases, IAM roles / policies / instance profiles / OIDC providers.

> **NOTE:** This is documentation only. Nothing was mutated. All cost figures are ESTIMATES with stated assumptions (AWS ap-south-1 public list prices).

---

## 1. Summary Table

### 1.1 Resource counts by type

| Type | Brain-related | Non-Brain / AWS-owned | Total | Est. monthly USD |
|---|---|---|---|---|
| Secrets Manager secrets | 21 | 1 (`rds!cluster-…`, RDS-managed) | 22 | **$8.80** |
| SSM Parameters | 0 | 0 | 0 | $0.00 |
| KMS customer-managed keys (CMK) | 4 | 0 | 4 | **$4.00** |
| KMS AWS-managed keys (in use) | — | 3 counted (acm, ebs, secretsmanager) + others | ~15 aliases | **$0.00** (AWS-managed CMKs are free) |
| IAM roles (Brain) | 21 | — | 21 | $0.00 |
| IAM roles (AWS service-linked) | — | 12 | 12 | $0.00 |
| IAM roles (other / stray) | — | 1 (`test-role-olkagc08`) | 1 | $0.00 |
| IAM customer-managed policies (Brain) | 16 | 1 (`AWSLambdaBasicExecutionRole-…`) | 17 | $0.00 |
| IAM instance profiles | 2 (both → `brain-prod-eks-node`) | 0 | 2 | $0.00 |
| IAM OIDC providers | 2 (EKS OIDC + GitHub Actions) | 0 | 2 | $0.00 |

**Domain total (est.): ~$12.80 / month** (plus per-API-call charges for KMS/Secrets that are usage-driven — see §4).

### 1.2 Brain KMS customer-managed keys

| Alias | Key ID | Manager | State | Rotation | Region | Est. $/mo |
|---|---|---|---|---|---|---|
| `alias/brain-root-prod` | `2b51c76d…becc068` | CUSTOMER | Enabled | ON (365d, next 2027-07-07) | ap-south-1 | $1.00 |
| `alias/brain-connector-secrets-prod` | `a7f6d44b…f453c` | CUSTOMER | Enabled | ON (365d) | ap-south-1 | $1.00 |
| `alias/brain-audit-prod` | `e45360d5…3dac99` | CUSTOMER | Enabled | ON (365d) | ap-south-1 | $1.00 |
| `alias/brain-tfstate-prod` | `71b76943…21733c` | CUSTOMER | Enabled | ON (365d) | ap-south-1 | $1.00 |

All 4 are single-region symmetric `ENCRYPT_DECRYPT` (`SYMMETRIC_DEFAULT`), origin `AWS_KMS`, **rotation enabled**, no pending deletion.

### 1.3 Secrets Manager (22 secrets, all ap-south-1)

| Name | KMS key | Rotation | Purpose |
|---|---|---|---|
| `brain/prod/kafka/credentials` | brain-root-prod | off | Strimzi bootstrap + SASL |
| `brain/prod/grafana/credentials` | brain-root-prod | off | Grafana Cloud API key + OTLP |
| `brain/prod/db/app-credentials` | brain-root-prod | off | App DB role (non-superuser) |
| `brain/prod/app/cookie-secret` | brain-root-prod | off | Core cookie/session boot secret |
| `brain/prod/apicurio/credentials` | brain-root-prod | off | Schema registry endpoint/auth |
| `brain/prod/app/meta-app-secret` | brain-root-prod | off | Meta OAuth app secret |
| `brain/prod/app/google-ads-client-secret` | brain-root-prod | off | Google Ads OAuth client secret |
| `brain/prod/app/jwt-signing-secret` | brain-root-prod | off | JWT signing |
| `brain/prod/k8s/neo4j-auth` | brain-root-prod | off | ESO-synced NEO4J_AUTH |
| `brain/prod/k8s/pgbouncer-env` | brain-root-prod | off | ESO-synced pgbouncer admin |
| `brain/prod/k8s/collector-env` | brain-root-prod | off | ESO-synced collector env |
| `brain/prod/k8s/core-env` | brain-root-prod | off | ESO-synced core env |
| `brain/prod/k8s/iceberg-rest-catalog-db` | brain-root-prod | off | ESO-synced Iceberg REST catalog DB |
| `brain/prod/k8s/stream-worker-env` | brain-root-prod | off | ESO-synced stream-worker env |
| `brain/prod/k8s/web-env` | brain-root-prod | off | ESO-synced web env |
| `rds!cluster-7ea5a1e7-…` | brain-root-prod | **ON** | RDS/Aurora-managed master credential |
| `brain/connector/woocommerce/e43be5e6…/https-ulinen.com` | brain-connector-secrets-prod | off | WooCommerce connector OAuth |
| `brain/connector/gokwik/e43be5e6…/2ed4ab74…` | brain-connector-secrets-prod | off | GoKwik connector |
| `brain/connector/shiprocket/e43be5e6…/accounts-pipadacapital.com` | brain-connector-secrets-prod | off | Shiprocket connector |
| `brain/connector/meta_app/e43be5e6…` | brain-connector-secrets-prod | off | Meta connector app |
| `brain/connector/google_ads_app/e43be5e6…` | brain-connector-secrets-prod | off | Google Ads connector app |

Brand/tenant id embedded in connector secret paths: `e43be5e6-ba4e-480b-a5f2-f62feb252e34`.

### 1.4 IAM roles (21 Brain, all `arn:aws:iam::380254378136:role/…`)

**IRSA (EKS OIDC-federated, workload identity):** `brain-prod-core`, `brain-prod-collector`, `brain-prod-web`, `brain-prod-stream-worker`, `brain-prod-jobs`, `brain-prod-trino`, `brain-prod-iceberg-rest`, `brain-prod-kafka-connect`, `brain-prod-external-secrets`, `brain-prod-external-dns`, `brain-prod-aws-load-balancer-controller`, `brain-prod-ebs-csi-driver`, `brain-prod-karpenter-controller`, `brain-prod-thanos` — trust = `sts:AssumeRoleWithWebIdentity` on `oidc.eks.ap-south-1.amazonaws.com/id/AC7C5C67BE34056B17D7B4E12C8459B8`, scoped to a specific `system:serviceaccount:<ns>:<sa>`.

**GitHub Actions OIDC (CI/CD):** `brain-prod-github-apply`, `brain-prod-github-plan`, `brain-prod-github-ecr-push` — trust = `token.actions.githubusercontent.com`, scoped to `repo:Pipadacapital/Brain-V3` (apply = `environment:production`).

**EKS/EC2 service roles:** `brain-prod-eks-cluster` (eks.amazonaws.com), `brain-prod-eks-node` (ec2.amazonaws.com, backs both instance profiles).

**AWS-service-assumed (backup/DLM):** `brain-prod-neo4j-backup`, `brain-prod-neo4j-dlm`.

---

## 2. Per-Resource Detail

### 2.1 KMS customer-managed keys (CMKs)

All four are Terraform-provisioned (`ManagedBy=terraform`), Brain-tagged, symmetric, single-region, **annual rotation enabled**, no scheduled deletion.

- **`alias/brain-root-prod`** (`2b51c76d-7ab5-4dd1-bb3c-84f31becc068`) — the platform root envelope key. Encrypts **15 of the 15 `brain/prod/*` secrets AND the RDS-managed secret** and (per naming) the app-side KMS PII vault / DEK envelope. This is the single most load-bearing key in the domain — the widest blast radius. Rotation next 2027-07-07.
- **`alias/brain-connector-secrets-prod`** (`a7f6d44b-…`) — encrypts the 5 `brain/connector/*` OAuth/token secrets. Separated from root so connector-secret access can be least-privileged.
- **`alias/brain-audit-prod`** (`e45360d5-…`) — audit-log encryption key (referenced by `brain-prod-audit-writer` policy).
- **`alias/brain-tfstate-prod`** (`71b76943-…`) — encrypts the Terraform remote state (S3 backend). Created earliest (17:42, before the others at 17:46) — bootstrap key.

**AWS-managed keys present (free, auto-created on first service use):** `alias/aws/secretsmanager` (`d296e4d6…`), `alias/aws/ebs` (`08cf5fa1…`), `alias/aws/acm` (`942134bc…`), plus `alias/aws/{dynamodb,lambda,rds,s3,ssm,es,glue,xray,…}`. These are AWS-owned; **not deletable and not billed** ($0). They exist because the corresponding service was touched in-region.

### 2.2 Secrets Manager

- **15 `brain/prod/*` secrets** — all encrypted with `alias/brain-root-prod`, Terraform-managed, no rotation. Split into: app boot secrets (`cookie-secret`, `jwt-signing-secret`, `meta-app-secret`, `google-ads-client-secret` — "fail-closed boot secret shells, value filled at go-live, never in TF state"), infra credentials (`kafka`, `grafana`, `db/app-credentials`, `apicurio`), and 7 `k8s/*-env` secrets that are **ESO-synced** (External Secrets Operator materializes them into k8s Secrets). `LastAccessedDate` on most k8s/app secrets = 2026-07-14 → actively consumed.
- **5 `brain/connector/*` secrets** — connector OAuth/token material, encrypted with `alias/brain-connector-secrets-prod`. Path carries the brand id. Recently accessed (07-12→07-14) → live connectors.
- **1 `rds!cluster-7ea5a1e7-…`** — **RDS/Aurora-managed master secret**, `RotationEnabled=true` (managed by RDS, not Brain). **Do NOT delete directly** — it is owned by the Aurora cluster and will be removed by RDS when the cluster is deleted. Deleting it out-of-band breaks the cluster's managed-master-password feature.

### 2.3 IAM policies (customer-managed, Brain)

16 Brain policies, all attached (`AttachmentCount ≥ 1`) except **`brain-prod-otel-collector-secrets` (Attach=0 — ORPHAN)**. Notable multi-attach: `brain-prod-spark-medallion-rw` (3), `brain-prod-analytics-s3-read` (2), `brain-prod-stream-worker-connector-secrets` (2). These grant scoped access to the S3/Iceberg medallion, connector secrets, SES send, audit writer, ESO k8s-secret read, DNS, LB controller, and Thanos objstore.

### 2.4 IAM instance profiles

- `brain-prod_5525475076559225764` → `brain-prod-eks-node` (Terraform-created).
- `eks-b0cfab4c-4540-66ed-ebf1-f7edbbef5651` → `brain-prod-eks-node` (EKS-managed-nodegroup auto-created). Two profiles, one underlying node role — expected for a managed node group + Karpenter/self-managed mix.

### 2.5 IAM OIDC providers

- `oidc.eks.ap-south-1.amazonaws.com/id/AC7C5C67BE34056B17D7B4E12C8459B8` — the EKS cluster IRSA trust anchor. **All 14 IRSA roles depend on this.** Deleting it breaks every workload role's `AssumeRoleWithWebIdentity`.
- `token.actions.githubusercontent.com` — GitHub Actions OIDC. The 3 `brain-prod-github-*` CI roles depend on it.

### 2.6 Non-Brain / stray resources (NOT part of Brain domain)

- **12 `AWSServiceRoleFor*`** service-linked roles (EKS, EKSNodegroup, AutoScaling, CloudWatchEvents, EC2Spot, ElastiCache, ELB, RDS, ResourceExplorer, ServiceQuotas, Support, TrustedAdvisor) — AWS-owned, deleted automatically when the last consuming resource is gone. Leave alone.
- **`test-role-olkagc08`** (`/service-role/`, trust = `lambda.amazonaws.com`, created 2026-07-14) — a **stray Lambda test role** unrelated to Brain, plus its companion managed policy **`AWSLambdaBasicExecutionRole-b785f082-…`** (Attach=1). Not Brain-tagged. Likely console experimentation; safe to ignore for the Brain reset, but flag for account hygiene.

---

## 3. Destruction Considerations (documentation only — nothing deleted)

**Ordering / dependency caveats specific to this domain:**

1. **KMS keys must be scheduled for deletion LAST, and only after every ciphertext consumer is gone.** `alias/brain-root-prod` encrypts all 15 `brain/prod/*` secrets, the RDS-managed secret, and (per naming) the app PII-vault DEK envelope. Deleting/disabling it while any of those still exist renders them permanently unrecoverable AND breaks ESO sync + app boot (the app is designed to fail-closed on missing boot secrets). Correct order: (a) delete Secrets Manager secrets, (b) delete/allow-RDS-to-delete the RDS secret via cluster teardown, (c) confirm no S3/EBS/tfstate objects still reference the CMKs, then (d) `schedule-key-deletion` on the 4 CMKs. **KMS has a mandatory 7–30 day waiting period** — schedule early in a teardown window but never before consumers are removed. AWS-managed keys need no action (not deletable, not billed).

2. **The RDS-managed secret and IAM instance profiles/OIDC provider are OWNED BY OTHER SERVICES — do not delete out-of-band.** `rds!cluster-7ea5a1e7-…` is removed by Aurora when the cluster is deleted; deleting it manually corrupts the managed-master-password state. The `eks-…` instance profile and the EKS OIDC provider are managed by the EKS control plane — the OIDC provider must outlive every IRSA role (delete IRSA roles first, then detach/delete the provider), and both instance profiles must be disassociated from running nodes before `brain-prod-eks-node` can be deleted. Deleting the OIDC provider first would strand all 14 IRSA roles.

3. **Detach before delete on every IAM role/policy; kill the orphan and stray last.** IAM roles cannot be deleted while policies are attached or (for `brain-prod-eks-node`) while the role sits in an instance profile that a running node uses. Order per role: detach managed/inline policies → remove from instance profiles → delete role; then delete the now-unattached customer-managed policies. **`brain-prod-otel-collector-secrets` (Attach=0)** can be deleted immediately as cleanup. The stray `test-role-olkagc08` + its Lambda-basic-exec policy are non-Brain — either leave (harmless, $0) or remove during account hygiene, but they are outside the Brain reset dependency graph. The 12 `AWSServiceRoleFor*` roles are AWS-managed — never delete manually; they clear when their consuming service is torn down.

**Protections / retention flags in this domain:** Secrets Manager enforces a **default 7–30 day recovery window** on `delete-secret` (force-delete-without-recovery is possible but destroys immediately). KMS enforces a **7–30 day pending-deletion window**. No `DeletionProtection` flag exists on secrets/keys themselves (that lives on the RDS/EKS side). All 4 CMKs have **rotation enabled** — rotation state is irrelevant to deletion but note the last-rotation material is what the pending ciphertext depends on.

**Blast-radius risk:** `alias/brain-root-prod` is the single highest-risk resource in the entire platform reset — it gates decryptability of secrets, PII vault, and (via `brain-tfstate-prod`) potentially Terraform state. Treat its deletion as the terminal, irreversible step.

---

## 4. Domain Cost Summary (ESTIMATES)

| Line item | Qty | Unit assumption (ap-south-1 list) | Est. $/mo |
|---|---|---|---|
| Customer-managed KMS keys | 4 | $1.00 / key / month | $4.00 |
| AWS-managed KMS keys | ~15 | $0 (AWS-owned) | $0.00 |
| Secrets Manager secrets | 22 | $0.40 / secret / month | $8.80 |
| SSM Parameters (Standard) | 0 | $0 | $0.00 |
| IAM (roles, policies, profiles, OIDC) | 40+ | IAM is free | $0.00 |
| **Fixed subtotal** | | | **$12.80** |
| KMS API requests (usage) | — | $0.03 / 10k requests over free tier | usage-driven, typically <$1/mo at this scale |
| Secrets Manager API requests | — | $0.05 / 10k API calls | usage-driven, negligible |

**Estimated fixed monthly cost for the Secrets/KMS/IAM domain: ~$12.80**, plus small usage-driven KMS/Secrets API charges (est. <$2/mo combined given ESO/app access cadence). **Assumptions:** AWS ap-south-1 public list prices; every secret billed the full $0.40 (no proration); AWS-managed CMKs and all IAM objects are free. This domain is a small fraction of the ~$510–580/mo prod bill — it is a security/dependency concern, not a cost lever.
