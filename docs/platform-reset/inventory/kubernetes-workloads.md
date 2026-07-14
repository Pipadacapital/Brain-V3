# Kubernetes Workloads Inventory — brain-prod (EKS)

- **Cluster:** `arn:aws:eks:ap-south-1:380254378136:cluster/brain-prod`
- **Account / region:** 380254378136 (PAID PRODUCTION) / ap-south-1
- **API access:** PRIVATE-ONLY endpoint. Live `kubectl` was attempted and **FAILED** — the
  configured kube context is the raw EKS ARN and the `brain-prod` context alias does not exist
  locally (`context was not found`); a working session requires the SSM tunnel
  (`tools/ops/eks-ssm-tunnel.sh`, context `brain-prod-ssm`), which was intentionally NOT started
  (read-only, no long-running tunnels). **This inventory is reconstructed from the GitOps manifests**
  — the ArgoCD Application set (`infra/argocd/envs/prod/*.yaml`) + the in-repo Helm charts
  (`infra/helm/*`). ArgoCD is the source of truth; live cluster state should equal this (barring drift).
- **GitOps model:** All apps are ArgoCD `Application` CRs in ns `argocd`, `destination.server:
  https://kubernetes.default.svc` (in-cluster). In-repo charts track `repoURL Brain-V3.git @ master`;
  the rest are upstream Helm charts pinned to a `targetRevision`.

> Read-only documentation only. No mutating action was taken against AWS or Kubernetes.

---

## 1. Namespaces (destination namespaces created/used by the app set)

| Namespace | Purpose / tenants |
|---|---|
| `argocd` | ArgoCD itself + all Application CRs (control plane) |
| `kube-system` | Karpenter, AWS Load Balancer Controller, metrics-server, EBS CSI, CoreDNS (EKS-managed) |
| `cert-manager` | cert-manager |
| `external-dns` | external-dns |
| `external-secrets` | External Secrets Operator + config (ClusterSecretStore/ExternalSecrets) |
| `kafka` | Strimzi operator + Kafka (KRaft) cluster + KafkaTopics + Kafka Connect (Bronze sink) |
| `neo4j` | Neo4j (identity SoR) + neo4j-backup CronJob |
| `trino` | Trino coordinator + workers (sole serving engine) |
| `iceberg-rest` | Iceberg REST catalog (JdbcCatalog over Aurora + S3 data) |
| `collector` | Collector ingest API |
| `core` | Core BFF/API |
| `web` | Next.js web frontend |
| `stream-worker` | Stream/journey-stitch worker |
| `pgbouncer` | PgBouncer connection pooler (fronts Aurora) |
| `argo` | Argo Workflows + CronWorkflows (batch: Silver→Gold refresh, maintenance) |
| `keda` | KEDA operator (event-driven autoscaling: Trino workers, stream-worker) |
| `monitoring` | kube-prometheus-stack (Prometheus/Grafana/Alertmanager) + observability (Thanos, rules) |
| `default` | network-policies chart target (NetworkPolicy CRs; no workloads) |

**~18 namespaces** (excludes always-present EKS system ns beyond kube-system).

---

## 2. ArgoCD Applications (`infra/argocd/envs/prod/*.yaml`)

**24 Application CRs** (a few manifests declare more than one App):

| Application | Source | Chart / path | targetRevision | Dest ns |
|---|---|---|---|---|
| `argo-workflows-prod` | argoproj.github.io/argo-helm | argo-workflows | 0.45.11 | argo |
| `aws-load-balancer-controller-prod` | aws.github.io/eks-charts | aws-load-balancer-controller | 1.10.1 | kube-system |
| `cert-manager-prod` | charts.jetstack.io | cert-manager | v1.16.2 | cert-manager |
| `collector-prod` | Brain-V3.git | infra/helm/collector | master | collector |
| `core-prod` | Brain-V3.git | infra/helm/core | master | core |
| `cronworkflows-prod` | Brain-V3.git | infra/helm/cronworkflows | master | argo |
| `external-dns-prod` | kubernetes-sigs.github.io/external-dns | external-dns | 1.15.0 | external-dns |
| `external-secrets-prod` | charts.external-secrets.io | external-secrets | 0.10.7 | external-secrets |
| `external-secrets-config-prod` | Brain-V3.git | infra/helm/external-secrets-config | master | external-secrets |
| `iceberg-rest-prod` | Brain-V3.git | infra/helm/iceberg-rest | master | iceberg-rest |
| `kafka-connect-prod` | Brain-V3.git | infra/helm/kafka-connect | master | kafka |
| `karpenter-crd-prod` | public.ecr.aws/karpenter | karpenter-crd | 1.0.8 | kube-system |
| `karpenter-prod` | public.ecr.aws/karpenter | karpenter | 1.0.8 | kube-system |
| `karpenter-nodepools-prod` | Brain-V3.git | infra/helm/karpenter | master | kube-system |
| `keda-prod` | (kedacore) keda | keda | 2.15.1 | keda |
| `kube-prometheus-stack-prod` | (prometheus-community) | kube-prometheus-stack | 65.1.1 | monitoring |
| `metrics-server-prod` | kubernetes-sigs.github.io/metrics-server | metrics-server | 3.13.1 | kube-system |
| `neo4j-prod` | (neo4j) neo4j | neo4j | 5.26.0 | neo4j |
| `neo4j-backup-prod` | Brain-V3.git | infra/helm/neo4j-backup | master | neo4j |
| `network-policies-prod` | Brain-V3.git | infra/helm/network-policies | master | default |
| `observability-prod` | Brain-V3.git | infra/helm/observability | master | monitoring |
| `pgbouncer-prod` | Brain-V3.git | infra/helm/pgbouncer | master | pgbouncer |
| `strimzi-operator-prod` | strimzi.io/charts | strimzi-kafka-operator | 0.45.2 | kafka |
| `strimzi-kafka-prod` | Brain-V3.git | infra/helm/strimzi-kafka | master | kafka |
| `stream-worker-prod` | Brain-V3.git | infra/helm/stream-worker | master | stream-worker |
| `trino-prod` | Brain-V3.git | infra/helm/trino | master | trino |
| `web-prod` | Brain-V3.git | infra/helm/web | master | web |

---

## 3. Workloads (Deployments / StatefulSets / CronJobs)

### Deployments (application tier — Karpenter Spot, HPA/KEDA where noted)
| Workload | ns | replicas (prod) | Notes |
|---|---|---|---|
| collector | collector | 2 | ingest API, behind ALB |
| core | core | 2 | BFF/API, behind ALB |
| web | web | 3 | Next.js frontend, behind ALB |
| stream-worker | stream-worker | 3 (KEDA/HPA-owned) | Kafka-lag scaled; static replicas ignored when autoscaling on |
| pgbouncer | pgbouncer | 2 | PG connection pooler → Aurora |
| iceberg-rest | iceberg-rest | 2 | Iceberg REST catalog (JdbcCatalog/Aurora + S3) |
| kafka-connect | kafka | 1 | Bronze landing sink (Iceberg sink, ADR-0010) |
| trino coordinator | trino | 1 | exactly one; pinned on-demand/stable |
| trino workers | trino | KEDA-scaled | dedicated `trino` Karpenter pool (t4g.xlarge) |

### StatefulSets (operator/upstream-chart-managed — templates NOT in repo charts)
| Workload | ns | replicas | Managed by |
|---|---|---|---|
| Kafka broker (KRaft) | kafka | 3 | Strimzi operator (KafkaNodePool → StatefulSet) |
| Neo4j | neo4j | 1 (single) | neo4j Helm chart |
| Prometheus | monitoring | (kube-prometheus-stack) | Prometheus Operator StatefulSet |
| (Alertmanager, if enabled) | monitoring | — | Prometheus Operator |

### CronJobs / Workflows (batch)
| Workload | ns | Notes |
|---|---|---|
| neo4j-backup | neo4j | CronJob `30 21 * * *` — `neo4j-restore` dump → S3 `brain-neo4j-backups-prod-380254378136` (IRSA write-only) |
| CronWorkflows | argo | Argo CronWorkflows: Silver→Gold refresh + Bronze maintenance/retention/erasure |

### Operators / controllers (no persistent storage of their own)
Karpenter, AWS Load Balancer Controller, cert-manager, external-dns, external-secrets,
metrics-server, Strimzi operator, KEDA, ArgoCD.

---

## 4. Persistent storage (PVC → EBS) footprint

All PVCs use the **`gp3` StorageClass** via the EBS CSI driver (addon = terraform `modules/eks
aws_eks_addon.ebs_csi`; StorageClass applied by `infra/argocd/bootstrap/install.sh`).

| PVC / volume | ns | Size | AccessMode | Retention on delete |
|---|---|---|---|---|
| Kafka broker JBOD (×3 brokers) | kafka | 50Gi each (**~150Gi**) | RWO | `deleteClaim: false` — **data survives CR delete** |
| Neo4j `data` (`data-neo4j-0`) | neo4j | 50Gi | RWO | dynamic; backed up nightly to S3 |
| Prometheus TSDB | monitoring | 20Gi | RWO | local retention 2d / 8GiB; Thanos → S3 for long-term |

**Total EBS-backed PVC footprint ≈ 220Gi** (3×50 Kafka + 50 Neo4j + 20 Prometheus), all gp3.

> Grafana persistence in `kube-prometheus-stack` was not found enabled in prod values (dashboards
> are provisioned from config; treat as ephemeral). Trino, iceberg-rest, collector/core/web,
> stream-worker, pgbouncer, kafka-connect are **stateless** (no PVCs) — Trino/Iceberg state lives in
> **S3 + Aurora**, not EBS.

---

## 5. Workloads that back onto AWS resources (non-EKS)

| K8s object | AWS resource it provisions/uses |
|---|---|
| Ingresses `collector` / `core` / `web` (class `alb`, `group.name`, `scheme: internet-facing`, `target-type: ip`) | **ONE shared internet-facing ALB** (aws-load-balancer-controller) + ACM cert (`certificate-arn`) + Target Groups |
| Kafka PVCs ×3, Neo4j PVC, Prometheus PVC | **EBS gp3 volumes** (~220Gi) via EBS CSI |
| iceberg-rest / Trino / Spark(batch) | **S3 Iceberg warehouse buckets** (single warehouse root, medallion = namespaces) via **pod IRSA** — no MinIO in prod, no static keys |
| iceberg-rest JdbcCatalog + pgbouncer + core/stream-worker | **Aurora Serverless v2** (PostgreSQL: `iceberg_catalog` DB + `ops` schema) |
| neo4j-backup CronJob | **S3** `brain-neo4j-backups-prod-380254378136` (IRSA write-only) |
| Prometheus Thanos sidecar | **S3** metrics bucket (long-term TSDB blocks, IRSA) |
| external-dns | **Route53** records for `brain.pipadacapital.com` |
| external-secrets | **AWS Secrets Manager** (ClusterSecretStore) |
| Redis analytics cache (serving) | **ElastiCache Redis** (managed AWS; not an in-cluster workload) |
| Neo4j `neo4j` Service | **ClusterIP only** (explicitly NOT LoadBalancer — internal identity SoR) |

Neo4j and Trino services are ClusterIP (internal); the **only public ingress is the single ALB**
fronting collector/core/web.

---

## 6. Teardown order

> Cluster teardown is executed by the **compute agent's plan**; this section covers the in-cluster
> objects that must be removed first so nothing dangles / no orphaned AWS resources remain.
> Order matters: kill GitOps reconciliation first (else ArgoCD re-creates deleted objects), then
> workloads, then storage — and delete AWS-attached objects (ALB, PVCs) before the cluster so their
> AWS resources are cleaned up by their controllers.

1. **Stop GitOps reconciliation** — disable ArgoCD auto-sync / delete the Application CRs in
   `argocd` (App-of-Apps first, or set `syncPolicy` to manual). Otherwise ArgoCD re-creates
   anything you delete. Delete order for the Apps mirrors steps 2–5 below.
2. **Delete Ingresses (collector/core/web)** — lets aws-load-balancer-controller **deprovision the
   shared ALB + Target Groups + listeners** while its controller is still running in kube-system.
   (Do NOT remove the ALB controller before its Ingresses, or the ALB leaks.)
3. **external-dns / cert-manager** — remove `external-dns-prod` (releases Route53 records) and
   `cert-manager-prod` after the ALB/DNS is gone.
4. **Application-tier Deployments** — web, core, collector, stream-worker, pgbouncer,
   kafka-connect, Trino (coordinator + workers). Then Argo CronWorkflows / neo4j-backup CronJob
   (ensure no in-flight backup/refresh job is running).
5. **Stateful services** — Neo4j (take a final `neo4j-backup` → S3 first if data is to be
   preserved), Trino, iceberg-rest. Then the **Strimzi Kafka CR** (brokers) — note
   `deleteClaim: false`, so broker PVCs persist and must be deleted explicitly in step 7.
6. **Operators** — Strimzi operator, KEDA, metrics-server, external-secrets(+config), Karpenter
   (deleting Karpenter drains/terminates all Karpenter-provisioned Spot nodes — do this before the
   node groups go away).
7. **PVCs → EBS** — explicitly delete the surviving PVCs so their **EBS volumes are released**:
   Kafka ×3 (50Gi, `deleteClaim:false`), Neo4j (50Gi), Prometheus (20Gi). Verify the underlying
   EBS volumes are deleted (gp3 reclaim), or note them for the compute agent to clean up.
8. **kube-prometheus-stack / observability** (monitoring) and **network-policies** (default).
9. **ArgoCD** itself.
10. **Cluster** — handed to the compute agent (node groups, Karpenter NodePools, EKS control
    plane, then VPC/Aurora/Redis/S3 per the compute/data teardown plans). Confirm the ALB and all
    EBS volumes from steps 2 & 7 are gone before deleting the VPC.

---

## Appendix — SSM tunnel (for a future live re-inventory, not run here)

Private API access is via `tools/ops/eks-ssm-tunnel.sh` → kube context **`brain-prod-ssm`**.
A live re-inventory (once tunneled) would run:
`kubectl --context brain-prod-ssm get ns,pods,pvc,pv,svc,deploy,sts -A` and
`kubectl --context brain-prod-ssm get applications -n argocd`.
