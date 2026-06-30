# Runbook — Prod M4 turn-on (terraform apply → cluster → apps)

**Goal:** take prod from **bootstrap-only** (KMS + GitHub-OIDC, ~$0 idle) to a **running cluster** serving a pilot brand, on AWS `ap-south-1`.
**Decisions baked in:** ADR-0009 — Aurora Serverless v2 (not RDS) + fck-nat (not per-AZ managed NAT). Both one-flag reversible.
**Apply model:** **MANUAL** terraform apply (the `infra.yml` CD lane is **plan-only**). ArgoCD prod apps have **no automated sync** — every app is a manual promotion gate.

> Source of truth for the module set: `infra/terraform/envs/prod/bootstrap.tf`. Currently APPLIED: `kms`, `oidc_github`. Everything below is the commented M4 set you uncomment.

---

## 0. Prerequisites

**Tools (local or CI runner):** `terraform >= 1.9`, `aws` CLI, `kubectl`, `helm >= 3.14`, `argocd` CLI, `jq`.
**Access:** an AWS account for prod + a role assumable for `terraform apply` (the bootstrap registered GitHub OIDC; for manual apply use an admin/Terraform role via `aws sso login` or `assume-role`).

**Fill every placeholder first** (CI plan will fail otherwise):
- `infra/terraform/envs/prod/backend.tf` — `brain-tfstate-prod-<PROD_ACCOUNT_ID>`
- `infra/terraform/envs/prod/bootstrap.tf` — `<PROD_ACCOUNT_ID>`
- `infra/argocd/envs/prod/{karpenter,collector}.yaml` — `ACCOUNT_ID` (IRSA role ARNs)
- `infra/helm/trino/values-prod.yaml` — IRSA role ARN + `restUri`

**Prereq gaps — now CLOSED in-repo (this PR):**
1. ✅ **App IRSA roles** — `irsa_collector` / `irsa_core` / `irsa_stream_worker` added to `envs/prod/bootstrap.tf` (commented M4 set, mirrors dev).
2. ✅ **`module "secrets"`** — added to the prod M4 set (Secrets Manager; `kafka/credentials` per ADR-0009 + app secrets).
3. ✅ **`module "elasticache"`** — Redis serving cache added to the prod M4 set.
4. ✅ **Iceberg REST catalog chart** — `infra/helm/iceberg-rest/` authored, **Aurora-Postgres-backed** JdbcCatalog (NOT SQLite — see `iceberg-catalog-sqlite-lock`) + real S3 via IRSA, with `infra/argocd/envs/prod/iceberg-rest.yaml`. Verified: dev-env `terraform validate` (graph incl. the IRSA↔s3_iceberg interdependency) + `helm lint`/`template` green.

So Phase 1 IS now uncomment-and-apply. The **only remaining manual prep** is filling the placeholders below + wiring the values pulled from `terraform output` (Aurora endpoint → `values-prod.yaml` `catalog.jdbcHost`; IRSA ARNs → ArgoCD/Helm).

---

## 1. Phase 0 — Terraform state backend (one-time)

If the state bucket + lock table don't exist yet:
```bash
cd infra/terraform/bootstrap
terraform init && terraform apply    # creates brain-tfstate-prod-<acct> + brain-tfstate-lock-prod (+ KMS, OIDC)
```
This is the only locally-bootstrapped step; it's what makes `envs/prod` usable.

---

## 2. Phase 1 — Provision AWS (uncomment + apply the M4 modules)

In `infra/terraform/envs/prod/bootstrap.tf`, **uncomment the M4 module blocks** (they're authored + the inputs verified): `network` (with `enable_nat_gateway = false`), `nat_instance`, `vpc_endpoints`, `eks`, `aurora`, `s3_iceberg`, `s3_audit`, `s3_iceberg_silver`, `s3_iceberg_gold`, `irsa_*` — plus the prereq additions from §0.

```bash
cd infra/terraform/envs/prod
terraform init
terraform plan -out m4.plan          # REVIEW — expect: VPC + fck-nat instance + VPC endpoints,
                                     # EKS + node groups, Aurora cluster, 4 S3 buckets, IRSA roles.
terraform apply m4.plan
```
Terraform's dependency graph orders this correctly (EKS waits on network, Aurora on network, etc.). **If you prefer staged caution**, apply foundational first:
```bash
terraform apply -target=module.network -target=module.nat_instance -target=module.vpc_endpoints
terraform apply -target=module.eks
terraform apply                       # the rest (Aurora, S3, IRSA)
```

**Sanity:** `terraform output` → note `eks` cluster name, `aurora` endpoint, the S3 bucket names, IRSA role ARNs (feed these into the ArgoCD/Helm placeholders if not already).

---

## 3. Phase 2 — Connect to the cluster

```bash
aws eks update-kubeconfig --region ap-south-1 --name brain-prod-eks
kubectl get nodes            # system node group should be Ready
```

---

## 4. Phase 3 — Platform layer (ArgoCD → operators → data plane → apps)

Install ArgoCD, then apply the prod Application manifests **in dependency order** (each is a manual-sync gate — `argocd app sync <name>` after review):

```bash
# 4a. ArgoCD itself
helm repo add argo https://argoproj.github.io/argo-helm && helm repo update
helm install argocd argo/argo-cd -n argocd --create-namespace

# 4b. Operators FIRST (the data plane + autoscalers depend on them)
kubectl apply -f infra/argocd/envs/prod/keda.yaml
kubectl apply -f infra/argocd/envs/prod/karpenter.yaml
kubectl apply -f infra/argocd/envs/prod/strimzi-kafka.yaml      # Strimzi operator + the Kafka CR (3-broker KRaft)
argocd app sync keda karpenter strimzi-kafka
kubectl -n kafka wait --for=condition=Ready kafka/brain-prod-kafka --timeout=600s

# 4c. Iceberg REST catalog (infra/helm/iceberg-rest, Aurora-backed) + Trino.
#     First create the iceberg_catalog DB in Aurora + the iceberg-rest-catalog-db k8s secret
#     (jdbc-user/jdbc-password); set values-prod.yaml catalog.jdbcHost = Aurora endpoint.
kubectl apply -f infra/argocd/envs/prod/iceberg-rest.yaml
argocd app sync iceberg-rest
# Trino's iceberg.properties restUri → http://brain-prod-iceberg-rest.iceberg-rest:8181
argocd app sync trino    # after the catalog is up

# 4d. App tier
kubectl apply -f infra/argocd/envs/prod/{core,web,collector,stream-worker,cronworkflows}.yaml
argocd app sync core web collector stream-worker cronworkflows
```

**Wire the broker:** the app `KAFKA_BROKERS` must be the Strimzi bootstrap Service
(`brain-prod-kafka-kafka-bootstrap.kafka.svc.cluster.local:9092`) — set in the core/collector/stream-worker
chart env (per-env values/secret), not the local `localhost:9092`.

---

## 5. Phase 4 — Secrets (AWS Secrets Manager — the prod analog of LocalStack)

The IRSA roles (Phase 1) grant the apps read access. Seed:
- App secrets: `brain/prod/{jwt-signing-secret,cookie-secret}`, `brain/prod/kafka/credentials` (bootstrap + SASL, from the Strimzi listener), ad-platform app secrets.
- **Connector OAuth tokens are minted by reconnecting in the UI** (they can't be seeded) — onboard the pilot brand and connect Shopify/Meta/etc. once; the tokens land in Secrets Manager. (Same model as local — see `localstack-secrets-durability`, but prod AWS Secrets Manager *does* persist.)

---

## 6. Phase 5 — Medallion bring-up + smoke test

```bash
# Bronze sinks + Silver/Gold run as Argo CronWorkflows (cronworkflows app, already synced).
# Trigger one cycle manually to seed the serving views on a cold catalog:
argo submit -n argo --from cronworkflow/v4-silver ; argo submit -n argo --from cronworkflow/v4-gold
# Apply the Trino serving views:
TRINO_URL=http://<trino-coordinator-svc>:8080 bash db/trino/views/run-trino-views.sh
```

**Smoke (the acceptance gate):**
- Ingest + serving load: `tools/load-test/` k6 harness against the prod BFF + collector (set `BASE_URL`/`COLLECTOR_URL`/`AUTH_COOKIE`). Assert p95 + zero OOM.
- Effectively-once: run `bronze-dedup-effectively-once.live.test.ts` against prod Kafka+Trino.
- Freshness: confirm `brain_data_freshness_seconds` (the exporter) is under SLA in Grafana.
- App health: core/web/collector `/health` 200; a dashboard renders honest-empty (not 500) on the cold brand.

---

## 7. Verification checklist (GA gate — `docs/audit/14-production-readiness.md`)
- [ ] `terraform plan` clean (no drift) post-apply
- [ ] EKS nodes Ready; Karpenter provisioning batch/trino on demand; KEDA scaling workers
- [ ] Strimzi Kafka Ready; topics created; apps connected to the bootstrap Service
- [ ] Aurora reachable (private only); migrations applied (`pnpm migrate` against the prod DB URL)
- [ ] Trino serving views resolve; Redis cache warm
- [ ] SLO rules (`brain-slo.rules.yml` + `freshness.rules.yml`) firing into Alertmanager
- [ ] Isolation: `tools/isolation-fuzz` green at multi-brand scale
- [ ] CTO/E1 sign-off

---

## 8. Rollback / teardown
- **Pause compute, keep data (cheapest safe state):** scale EKS node groups + Aurora min-capacity down; `argocd app set <app> --sync-policy none`.
- **Full teardown:** `terraform destroy` in `envs/prod` (data in S3/Aurora is deleted — Bronze S3 has the WORM/7yr retention, so those objects resist deletion by design; empty/override before destroy if truly tearing down).
- **Decision reversions (one flag each):** managed NAT instead of fck-nat → `network { enable_nat_gateway = true }` + drop `nat_instance`/`vpc_endpoints`; RDS instead of Aurora → swap `module.aurora` → `module.rds`.

---

## 9. Cost (starter, deployed)
≈ **$240–320/mo** running, **~$190/mo** with batch/Trino scaled to zero (per the blueprint estimate): EKS control plane $73 + system node ~$25 + streaming/batch/trino spot $0–130 + Aurora ~$45 + ElastiCache ~$12 + fck-nat ~$4 + S3/endpoints ~$15. **$0 until you run Phase 1.**
