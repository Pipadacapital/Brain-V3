# GO-LIVE — zero → serving traffic (prod, ap-south-1)

The complete ordered path from an empty AWS account to Brain serving real
traffic. This is the execution script for the AUD-COST go-live chain
(AUD-COST-001..013 — see `audit/BRAIN-AUDIT-REPORT.md` §4.5); each step names
the finding(s) it closes and its rollback. Companion docs:
`infra/terraform/README.md` ("Prod go-live"), `docs/runbooks/prod-m4-turn-on.md`
(module-level detail), `infra/helm/PLACEHOLDERS.md` (canonical fill list),
`infra/helm/external-secrets-config/README.md` (secret contracts).

**Honesty first — what is NOT automated** (every one of these is a manual step
in this runbook; nothing does them for you):

| # | Manual thing | Step |
| --- | --- | --- |
| 1 | State bootstrap + the FIRST `envs/prod` terraform apply (local operator creds — the CI apply role is created *by* that apply) | 1, 3 |
| 2 | `terraform.tfvars` + `<PROD_ACCOUNT_ID>` in `backend.tf` | 2 |
| 3 | GitHub repo variables/secrets + `production` Environment reviewers | 3 |
| 4 | The placeholder fill pass (ACCOUNT_ID, hostnames, ACM cert, VPC id, Aurora endpoint) — CI *guards* it (AUD-COST-007) but does not *do* it | 4 |
| 5 | ~~Six IRSA roles referenced by manifests but not yet in terraform~~ — CLOSED (AUD-COST-017): all six are `modules/irsa` instances in `envs/prod/bootstrap.tf`, created by the step-3 apply | 4 |
| 6 | Seeding the VALUES of every `brain/prod/k8s/*` Secrets Manager entry (the SHELLS are terraform-created since AUD-COST-017; values never live in TF state) | 8 |
| 7 | `iceberg_catalog` DB bootstrap SQL on Aurora (private-only — run from inside the VPC) | 8 |
| 8 | ACM certificate request + DNS validation; Route53 zone / registrar delegation | 9 |
| 9 | ~~pgbouncer has a chart but no ArgoCD Application~~ — CLOSED (AUD-COST-019): `infra/argocd/envs/prod/pgbouncer.yaml` exists; sync it like every other app | 10 |
| 10 | Trino serving views (`run-trino-views.sh`) — not part of any sync wave | 11 |
| 11 | Every prod ArgoCD sync (all prod apps are manual-gate by design) | 10, 12 |
| 12 | Connector OAuth tokens — minted by reconnecting each connector in the UI post-launch (cannot be seeded) | 13 |

Suggested split: **Day 1 = steps 1–9** (AWS + identity + secrets + DNS),
**Day 2 = steps 10–14** (platform sync, data plane, migrations, smoke).

---

## 0. Preflight

- Tools: `terraform >= 1.9`, `aws` CLI (authed to the prod account with admin),
  `kubectl`, `helm >= 3.14`, `argocd` CLI, `jq`, `yq`, `psql`, `docker`.
- Decisions you must have made: apex domain (e.g. `brain.example.com`),
  hostnames (`px.` collector / `app.` web / `api.` core), whether external-dns
  manages Route53 or you CNAME manually.
- Everything below is **ap-south-1** (AUD-COST-008 fixed Trino's stray
  us-east-1; do not introduce another).

---

## 1. Terraform state bootstrap — LOCAL, one-time (AUD-COST-001)

The `envs/prod` S3 backend cannot create itself:

```bash
cd infra/terraform/bootstrap
terraform init
terraform apply -var environment=prod
# → brain-tfstate-prod-<acct> bucket + brain-tfstate-lock-prod DynamoDB table + state KMS
```

This layer creates the **state backend only** — no OIDC provider, no IAM roles
(those come from `envs/prod` in step 3; the old claim that bootstrap creates the
apply role was false — AUD-COST-002). Its own state stays as a local
`terraform.tfstate` in-dir; keep it.

**Rollback:** `terraform destroy` here (only if abandoning entirely — the
bucket/table cost ~nothing).

## 2. Fill the terraform inputs

1. `infra/terraform/envs/prod/backend.tf` — replace `<PROD_ACCOUNT_ID>`
   (backends cannot interpolate variables).
2. `cp infra/terraform/envs/prod/terraform.tfvars.example infra/terraform/envs/prod/terraform.tfvars`
   and edit: `eks_public_access_cidrs = ["<your-ip>/32"]` for the bootstrap
   window (AUD-COST-009 — flip back to `[]` once a bastion/VPN exists), node
   counts, Aurora ACU bounds.

## 3. First `terraform apply` — LOCAL (AUD-COST-001, AUD-COST-002, AUD-COST-010)

The M4 module set is un-gated: network (fck-nat) + vpc-endpoints, EKS (+ the 5
ECR repos), Aurora Serverless v2, ElastiCache, Secrets Manager shells, S3
Bronze/Silver/Gold + audit, all IRSA roles, Karpenter controller/queue, and the
CI OIDC roles. The first apply MUST be local — the CI apply role is one of its
outputs (chicken-and-egg):

```bash
cd infra/terraform/envs/prod
terraform init
terraform plan -out m4.plan     # staged alternative: -target=module.network → module.eks → blank
terraform apply m4.plan
terraform output                # keep this open — steps 4/5/8 consume it
```

Then hand CI its identity — GitHub repo **Settings → Secrets and variables → Actions**:

| Repo variable / secret | Value |
| --- | --- |
| `AWS_PROD_APPLY_ROLE_ARN` | `terraform output github_apply_role_arn` (`brain-prod-github-apply`) |
| `AWS_ECR_PUSH_ROLE_ARN` | `terraform output github_ecr_push_role_arn` (`brain-prod-github-ecr-push`) |
| `ENVIRONMENT` | `prod` — required; the push role is scoped to the `brain-*-prod` ECR repos |
| `AWS_PROD_PLAN_ROLE_ARN` (optional) | `terraform output github_plan_role_arn` |
| secret `GITOPS_TOKEN` | a PAT with `contents:write` (CD gitops commits) |

And **Settings → Environments → `production`** → add required reviewers (the
human gate for `prod-apply.yml` and `prod-promote`; the apply role's OIDC trust
is bound to this Environment's sub claim). All later applies go through
**Actions → "prod-apply (M4 turn-on)"** with `confirm = apply-prod`.

**Rollback:** `terraform destroy` in `envs/prod` (the AUDIT bucket carries WORM
retention — those objects resist deletion by design; the medallion warehouse
bucket has NO Object Lock since AUD-COST-016 — erasure/compaction need deletes).
Cost while up: ≈$240–320/mo; pause = scale node groups + Aurora min ACU down.

## 4. Placeholder fill pass (AUD-COST-007) + missing IRSA roles

Fill every placeholder from `terraform output` + your step-0 decisions.
Canonical list with sources: `infra/helm/PLACEHOLDERS.md`. Summary:

```bash
ACCT=$(aws sts get-caller-identity --query Account --output text)
# ACCOUNT_ID  → every IRSA annotation in infra/helm/*/values-prod.yaml +
#               infra/argocd/envs/prod/{karpenter,aws-load-balancer-controller,external-dns,external-secrets}.yaml
# REPLACE_WITH_ECR_REGISTRY      → ${ACCT}.dkr.ecr.ap-south-1.amazonaws.com
# REPLACE_WITH_AURORA_ENDPOINT   → terraform output aurora_endpoint   (iceberg-rest/values-prod.yaml)
# REPLACE_WITH_PROD_POSTGRES_HOST→ terraform output aurora_endpoint   (pgbouncer/values-prod.yaml)
# REPLACE_WITH_VPC_ID            → terraform output vpc_id            (aws-load-balancer-controller.yaml)
# REPLACE_WITH_{COLLECTOR,WEB,CORE}_HOSTNAME, REPLACE_WITH_ACM_CERT_ARN,
# REPLACE_WITH_APEX_DOMAIN       → step 0 / step 9 decisions
grep -rEn "REPLACE_WITH_[A-Z0-9_]+|ACCOUNT_ID" infra/helm infra/argocd --include='*.yaml'   # must end EMPTY (rollouts/ excluded — not deployed)
```

Commit the fill to `master`. **CI enforcement:** the PR job
`prod-placeholder-guard` (renders all prod charts; fails on undocumented
tokens) and a `--strict` gate in `deploy.yml prod-promote` that refuses to commit
a prod promotion while ANY placeholder remains (`tools/lint/prod-placeholder-guard.sh`).

**IRSA roles (AUD-COST-017 — nothing to do):** all six roles the manifests
reference — `brain-prod-web`, `brain-prod-trino`, `brain-prod-iceberg-rest`,
`brain-prod-external-secrets`, `brain-prod-aws-load-balancer-controller`,
`brain-prod-external-dns` — are `modules/irsa` instances in
`envs/prod/bootstrap.tf` and were created by the step-3 apply (policies per
PLACEHOLDERS.md §4). Once the Route53 zone exists (step 9), set
`external_dns_zone_ids` in terraform.tfvars and re-apply to scope external-dns
down from the `hostedzone/*` bootstrap fallback.

**Rollback:** git revert of the fill commit.

## 5. ECR image push (AUD-COST-002 CD lane)

Merging to `master` fires `.github/workflows/deploy.yml`: build → push (immutable
digest) → cosign sign for `collector`, `stream-worker`, `core`, `web`
(turbo-affected) and `spark-bronze` (path-based, `db/iceberg/spark/**`) into the
`brain-<name>-prod` repos, then the gitops jobs pin the digests into the chart
values. First run after go-live: dispatch a no-op merge or push a trivial
change so every image builds at least once (the affected-set skips unchanged
apps — an app never built has no digest, and the B3 fail-closed templates will
refuse to render it, which is correct).

Local fallback (no CI): `aws ecr get-login-password | docker login …`, then
`docker build -f apps/<app>/Dockerfile -t <registry>/brain-<app>-prod:<sha> . && docker push …`
and hand-edit the digest into `values-prod.yaml`.

Verify: `aws ecr describe-images --repository-name brain-core-prod --region ap-south-1`.

**Rollback:** images are immutable-tagged; nothing deploys until ArgoCD sync —
no rollback needed at this step.

## 6. Cluster access (AUD-COST-009)

```bash
aws eks update-kubeconfig --region ap-south-1 --name brain-prod-eks
kubectl get nodes    # system node group Ready
```

The API endpoint is public **only** to `eks_public_access_cidrs` from step 2.
After go-live, set it back to `[]` (private-only) via prod-apply.

## 7. ArgoCD bootstrap (AUD-COST-005)

```bash
infra/argocd/bootstrap/install.sh prod
# = pinned argo-cd helm install → AppProjects (brain/brain-prod/brain-staging)
#   → gp3 StorageClass (EBS CSI — AUD-COST-018; the addon itself is terraform)
#   → root app-of-apps (envs/prod). Prints how to read the initial admin password.
argocd login <argocd-server> --username admin   # port-forward svc/argocd-server if no ingress yet
```

Every Application appears **OutOfSync — all prod apps are manual-gate**. Sync
in dependency order (steps 8–12); `argocd app sync <name>` after reviewing each
diff.

**Rollback:** `helm uninstall argocd -n argocd` removes the control plane
without touching workloads.

## 8. Secrets seeding — ESO + Secrets Manager (AUD-COST-004, -006, -012)

Sync the operator + config first: `argocd app sync external-secrets-prod external-secrets-config-prod`
(waves −3/−2; creates the ClusterSecretStore + ExternalSecrets + namespaces).
The ExternalSecrets stay in `SecretSyncedError` until you seed the **exact** SM
entries (flat JSON objects; each key becomes an env var — full key contracts in
`infra/helm/external-secrets-config/README.md`):

```
brain/prod/k8s/core-env                 # DATABASE_URL (pgbouncer.pgbouncer.svc.cluster.local:6432) + DATABASE_URL_DIRECT (Aurora!),
                                        # REDIS_URL, KAFKA_BROKERS, TRINO_HOST, ICEBERG_REST_URI,
                                        # NEO4J_URI/USER/PASSWORD, CHECKPOINT_LOCATION (s3a://), topics, AWS_REGION
brain/prod/k8s/web-env                  # BFF_BASE_URL / CORE_API_URL
brain/prod/k8s/collector-env            # DATABASE_URL, REDIS_URL, KAFKA_BROKERS, HMAC/pixel config
brain/prod/k8s/stream-worker-env        # DATABASE_URL (DIRECT Aurora — leader lock), KAFKA_BROKERS, TRINO_HOST, NEO4J_*, connector creds
brain/prod/k8s/pgbouncer-env            # DB_USER / DB_PASSWORD
brain/prod/k8s/iceberg-rest-catalog-db  # exactly: jdbc-user, jdbc-password
brain/prod/k8s/neo4j-auth               # exactly: NEO4J_AUTH = neo4j/<password>
```

`aws secretsmanager put-secret-value --region ap-south-1 --secret-id brain/prod/k8s/core-env --secret-string file://core-env.json`
(the terraform `secrets` module creates all seven SHELLS + the ESO read policy
since AUD-COST-017 — seeding is a value update, never a resource creation, and
values must never enter TF state).

Wiring facts you need for the JSON values:
`KAFKA_BROKERS=brain-prod-kafka-kafka-bootstrap.kafka.svc.cluster.local:9092`
(after step 10), `NEO4J_URI=bolt://neo4j.neo4j.svc.cluster.local:7687`,
`ICEBERG_REST_URI=http://brain-prod-iceberg-rest.iceberg-rest:8181`,
`ICEBERG_WAREHOUSE=s3://$(terraform output -raw warehouse_bucket_name)/`
(AUD-COST-016: the ONE warehouse root; Bronze/Silver/Gold are namespaces),
`CHECKPOINT_LOCATION=s3a://<warehouse_bucket_name>/_checkpoints` (the Spark
jobs IRSA policy covers the `_checkpoints/` prefix), leave `S3_ENDPOINT` UNSET
(real S3 + IRSA — a set value means MinIO-style static-key addressing). There is
no `BRONZE_SOURCE` env anymore — Bronze landing is connect-only (ADR-0010, see
step 12).

**Iceberg catalog DB (AUD-COST-012 — REST/JDBC on Aurora, NOT Glue):** Aurora is
private-only; run once from inside the VPC (e.g. `kubectl run psql --rm -it --image=postgres:16 -- bash`)
against `terraform output aurora_endpoint` as master:

```sql
CREATE ROLE iceberg_catalog LOGIN PASSWORD '<generated>';
CREATE DATABASE iceberg_catalog OWNER iceberg_catalog;
```

…and put the same credentials into `brain/prod/k8s/iceberg-rest-catalog-db`.

Verify: `kubectl get externalsecrets -A` → all `SecretSynced`.

**Rollback:** rotate/rewrite the SM value; ESO re-syncs within 1h
(`refreshInterval`), then roll the consuming Deployment.

## 9. DNS + TLS (AUD-COST-003)

1. ACM (ap-south-1): request a cert covering the three hostnames → DNS-validate
   → put its ARN in the three `values-prod.yaml` ingress blocks (step 4).
2. Sync the edge lane: `argocd app sync aws-load-balancer-controller-prod cert-manager-prod`
   (+ `external-dns-prod` if Route53-managed; else skip and CNAME each hostname
   to the shared ALB after step 12 creates it — the Ingresses use one
   `group.name: brain-prod` ALB).

**Rollback:** delete the Ingress resources (services stay ClusterIP) — traffic
stops at the edge, nothing internal changes.

## 10. Platform + data-plane sync (AUD-COST-005/-006/-008/-010)

```bash
argocd app sync argo-workflows-prod            # wave -2: CronWorkflow CRDs (Spark crons need this)
argocd app sync karpenter-crd-prod karpenter-prod karpenter-nodepools-prod keda-prod   # autoscalers
argocd app sync kube-prometheus-stack-prod     # monitoring (ns monitoring, AUD-PROD-001/-002): Prometheus +
                                               # Grafana + Alertmanager on the system MNG; loads the brain-slo
                                               # rules; Thanos sidecar → metrics bucket via IRSA (AUD-PROD-012 —
                                               # bucket/role from `terraform output metrics_bucket_name` /
                                               # `thanos_role_arn`, filled in step 4). Sync BEFORE the workload
                                               # apps so the rollout bake analyses have an evaluator.
argocd app sync strimzi-operator-prod strimzi-kafka-prod   # operator, then the 3-broker KRaft Kafka CR
kubectl -n kafka wait --for=condition=Ready kafka/brain-prod-kafka --timeout=600s

argocd app sync pgbouncer-prod                 # AUD-COST-019: GitOps app (wave -1) — core's DATABASE_URL
                                               # targets pgbouncer.pgbouncer.svc.cluster.local:6432;
                                               # needs the pgbouncer-env Secret from step 8
argocd app sync neo4j-prod                     # identity SoR (ADR-0004); auth from neo4j-auth.
                                               # Pinned to the ON-DEMAND Karpenter pool (AUD-COST-018 —
                                               # sync karpenter-nodepools first); PVC binds via gp3/EBS CSI
argocd app sync iceberg-rest-prod              # JdbcCatalog on Aurora (step 8 DB + secret first)
argocd app sync trino-prod                     # serving engine; iceberg.s3.region=ap-south-1 (AUD-COST-008)
```

**Rollback (any app):** `argocd app rollback <app>` to the previous synced
revision — every app is a discrete manual gate, so blast radius is one app.

## 11. Migrations + serving views (AUD-COST-011)

Migrations run automatically as the core chart's **PreSync hook Job**
(`migrations.enabled: true` in values-prod): syncing `core-prod` in step 12
runs `pnpm migrate:up` (all `db/migrations`) against `DATABASE_URL_DIRECT`
(direct Aurora — the advisory lock breaks through pgbouncer) **before** the
Deployment rolls. Nothing to run by hand; on failure inspect the hook Job:
`kubectl -n core logs jobs/<release>-migrate`.

Trino serving views are NOT in any sync wave — apply once after `trino-prod`
is up (idempotent, `CREATE OR REPLACE VIEW`):

```bash
kubectl -n trino port-forward svc/<trino-coordinator> 8090:8080 &
TRINO_URL=http://127.0.0.1:8090 bash db/trino/views/run-trino-views.sh   # 42 mv_* views into iceberg.brain_serving
```

**Rollback:** migrations are forward-only (write a down-migration if needed);
views are replaceable/droppable with no data impact.

## 12. App tier + Bronze cutover + refresh crons (AUD-COST-013)

Bronze landing is connect-only (ADR-0010, cutover executed 2026-07-05): the
`BRONZE_SOURCE`/`BRONZE_LANDING` envs no longer exist — nothing to set on
core/stream-worker or the sparkV4 templates. Enable the `infra/helm/kafka-connect`
chart (the always-on landing writer); `sparkBronze` in `cronworkflows` is
maintenance-only (bronze-maintenance / raw-retention / erasure — there is no
bronze-landing cron).

```bash
argocd app sync core-prod                       # runs the migration PreSync Job first (step 11)
argocd app sync web-prod collector-prod stream-worker-prod
# Bronze landing writer (ADR-0010): deploy the infra/helm/kafka-connect chart
# (fill worker.bootstrapServers etc. per its values.yaml; add an ArgoCD app for it
# alongside the app tier if not already declared).
argocd app sync cronworkflows-prod              # CronWorkflows: bronze-maintenance,
                                                # v4-silver, v4-gold, v4-maintenance (weekly, AUD-COST-013), connector crons
# Seed the medallion once instead of waiting for the schedules:
argo submit -n argo --from cronworkflow/v4-silver --wait
argo submit -n argo --from cronworkflow/v4-gold --wait
```

Note: the app images/digests in values-prod come from CD (step 5 + prod-promote
behind the `production` Environment). The B3 fail-closed templates refuse to
render an unpinned image, and the strict placeholder gate refuses an unfilled
promotion — both failing loud is the designed behavior.

**Rollback:** `argocd app rollback <app>`. Bronze landing rollback is NOT an env
flip anymore (the Spark landing code is deleted): `git revert` the ADR-0010
removal commits + redeploy, then replay the Kafka topics into the restored Spark
sink — loss-free only within the 7-day topic retention window (see
`docs/runbooks/adr-0010-kafka-connect-bronze.md`).

## 13. Smoke checks (the acceptance gate)

In order — each proves the layer below it:

1. **Health:** collector `/healthz` + `/readyz`, core `/health`, web `/` all
   200 via the public hostnames (TLS, redirect from :80).
2. **Collector accepts (2xx):**
   `curl -si https://px.<domain>/v1/events -H 'content-type: application/json' -d '<pixel envelope>'`
   → 2xx (accept-before-validate spool; anything else is an event-loss bug).
3. **Event lands in Bronze:** within ~1 min (the Kafka Connect sink commits every
   30s — ADR-0010):
   `SELECT count(*) FROM iceberg.brain_bronze.collector_events_connect` (Trino) — must include your test event.
4. **mv_* views serve:**
   `SELECT * FROM iceberg.brain_serving.mv_gold_revenue_ledger LIMIT 1` — a
   result set (honest-empty on a cold brand is a PASS; a 5xx/table-not-found is
   a FAIL → re-run step 11 views or check v4-gold logs).
5. **Dashboards 200:** log into web, onboard the pilot brand — every dashboard
   renders 200 with honest-empty states (no empty-chart-as-success, no 500s).
6. **Connectors:** connect Shopify/Meta/etc. in the UI (mints the OAuth tokens
   into Secrets Manager — cannot be pre-seeded).
7. **Load + integrity (recommended before announcing):** `tools/load-test/` k6
   against collector+BFF; `bronze-dedup-effectively-once.live.test.ts` against
   prod Kafka+Trino; `tools/isolation-fuzz` green (tenant isolation);
   `brain_data_freshness_seconds` under SLA.

## 14. Post-launch hardening (same week)

- `eks_public_access_cidrs = []` (AUD-COST-009) once a bastion/VPN exists.
- ~~Add the six PLACEHOLDERS.md §4 IRSA roles + the `brain/prod/k8s/*` SM
  shells to terraform~~ — DONE (AUD-COST-017); scope `external_dns_zone_ids`
  down from the `hostedzone/*` bootstrap fallback if not already done in step 4.
  The pgbouncer ArgoCD Application also exists now (AUD-COST-019) — no
  hand-installed helm release to adopt.
- Scope the `brain-prod-github-apply` role down from AdministratorAccess.
- Verify `v4-maintenance` ran its first weekly cycle (Iceberg compaction +
  snapshot expiry — AUD-COST-013) and `bronze-maintenance` likewise.
