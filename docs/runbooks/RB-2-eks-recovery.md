# RB-2 — EKS recovery (GitOps re-apply from a dead/lost cluster)

> AUD-OPS-013: previously an out-of-repo pointer (pre-Aurora/ADR-0010 "Brain-docs" §M.3 — stale).
> This is the current procedure. Context/objectives: [DR.md](DR.md). **PENDING EXECUTION** as a drill.

**Premise:** the EKS cluster (or its region's control plane) is unrecoverable, but the DATA
stores survive on their own lifecycles — Aurora, the S3 buckets, Secrets Manager, ECR are all
OUTSIDE the cluster. Everything in-cluster is rebuildable from this repo: terraform (envs/prod) +
ArgoCD (infra/argocd). The two in-cluster STATEFUL exceptions:

- **Neo4j** — data on an EBS PVC. The volume survives cluster deletion (CSI-provisioned volumes
  are `Delete`-reclaim ONLY via the API — if the cluster died rather than was cleanly destroyed,
  the volume is still there; else restore per DR.md §6 from DLM snapshot / dump).
- **Kafka (Strimzi)** — broker PVCs are transport buffers; safe to lose (DR.md §2). Never
  prune-sync them on a LIVE cluster (kafka-operations.md).

## 1. State + terraform

tfstate lives in `brain-tfstate-prod-<acct>` (S3, versioned; replica in ap-south-2 once ADR-0011
is applied) — a cluster loss does NOT touch it.

```bash
cd infra/terraform/envs/prod
terraform init            # backend.tf → the surviving state bucket
terraform plan            # EXPECT: eks/karpenter/irsa resources to create; Aurora/S3/KMS unchanged.
```

If the plan wants to REPLACE Aurora or any S3 bucket — STOP. That is not a cluster rebuild.

Apply in the documented stage order (prod-apply.yml or local per GO-LIVE §3):
`-target=module.network` → `-target=module.nat_instance -target=module.vpc_endpoints` →
`-target=module.eks` → blank target. A rebuild re-creates the OIDC provider → **every IRSA role
trust must be re-pointed**: the irsa modules take the provider ARN from `module.eks`, so the blank
apply fixes them; but the ArgoCD IRSA **annotations** in helm values keep working only if role
ARNs are unchanged (they are — names are deterministic).

## 2. Cluster access + ArgoCD bootstrap (GO-LIVE steps 6–7)

```bash
aws eks update-kubeconfig --region ap-south-1 --name brain-prod-eks
infra/argocd/bootstrap/install.sh prod      # argo-cd + AppProjects + gp3 StorageClass + root app-of-apps
```

All apps appear OutOfSync — **every prod app is a manual gate**; sync in dependency order below.

## 3. Secrets (GO-LIVE step 8 — short form)

Secrets Manager survived; nothing to re-seed. Sync the operator + config and confirm
ExternalSecrets go `SecretSynced`:
`argocd app sync external-secrets-prod external-secrets-config-prod`.
Only if secrets were ALSO lost: full worksheet `prod-secrets-worksheet.md`.

## 4. Platform + data plane (GO-LIVE steps 9–10 order)

```bash
argocd app sync aws-load-balancer-controller-prod cert-manager-prod external-dns-prod   # edge (ACM cert + zone survive)
argocd app sync argo-workflows-prod
argocd app sync karpenter-crd-prod karpenter-prod karpenter-nodepools-prod keda-prod
argocd app sync metrics-server-prod kube-prometheus-stack-prod
argocd app sync strimzi-operator-prod strimzi-kafka-prod
kubectl -n kafka wait --for=condition=Ready kafka/brain-prod-kafka --timeout=600s
argocd app sync pgbouncer-prod
# Neo4j — STATEFUL. BEFORE syncing: if the old data volume survived, pre-bind a PV to it (or
# restore per DR.md §6); syncing first provisions an EMPTY volume.
argocd app sync neo4j-prod neo4j-backup-prod
argocd app sync iceberg-rest-prod duckdb-serving-prod
```

## 5. Migrations + serving views (GO-LIVE step 11)

Aurora survived ⇒ migrations are already applied and the Iceberg catalog is intact — the
`tools/deploy/run-migrations.sh` job will no-op-verify. Serving views re-apply themselves at
duckdb-serving pod startup (local views, not catalog state) — just verify `/readyz` reports
`views_skipped: []` once the pods are up.

## 6. App tier + crons (GO-LIVE step 12)

```bash
argocd app sync core-prod web-prod collector-prod stream-worker-prod
argocd app sync kafka-connect-prod        # Bronze landing resumes from its committed offsets
argocd app sync cronworkflows-prod
argo submit -n argo --from cronworkflow/v4-silver --wait && argo submit -n argo --from cronworkflow/v4-gold --wait
```

## 7. Acceptance (GO-LIVE step 13, abbreviated)

collector 2xx → event in `brain_bronze.collector_events_connect` ≤ 1 min → `mv_*` 200 →
dashboards 200 → identity export + one attribution cycle green. Record timings: this drill's
wall-clock IS the measured RTO (DR.md §2 commits ≤ 1 business day).

## Rollback

Each step is an independent gate: `terraform` stages are `-target`-scoped; every ArgoCD app rolls
back individually (`argocd app rollback <app>`). A half-rebuilt cluster can be abandoned and
re-run from §1 — data stores are never mutated by this runbook.
