# Karpenter — Brain node autoscaling (Spot)

Karpenter provisions and consolidates EC2 capacity for the `brain-<env>` EKS cluster. This directory
holds the **NodePool + EC2NodeClass intent** (a small local Helm chart). The Karpenter **controller +
CRDs** are installed from the upstream chart via ArgoCD: `infra/argocd/envs/prod/karpenter.yaml`.

## What is (and is NOT) managed here

| Concern | Owner |
|---|---|
| Karpenter controller + CRDs | upstream chart (`public.ecr.aws/karpenter`), pinned `1.0.8`, ArgoCD app |
| NodePools (`streaming`/`ondemand`) + `EC2NodeClass` | this chart (`infra/helm/karpenter`) |
| The EKS `system` node group | **`modules/eks` — UNCHANGED. Do not touch.** |

### The system node group stays ON-DEMAND and fixed
The eks module's managed node group `brain-<env>-system` (`t4g.medium`, AMI `AL2_ARM_64`, on-demand,
`scaling_config` desired/min/max) is **intentionally left as-is**. It is the stable home for the
control plane add-ons: the Karpenter controller itself, CoreDNS, kube-proxy, ArgoCD, and the KEDA
operator. An autoscaler must not run on the Spot capacity it manages, so:
- This change does **not** edit `modules/eks` node groups.
- The Karpenter controller is pinned to it via `nodeSelector: { role: system }` (the label the eks
  module already sets) in `infra/argocd/envs/prod/karpenter.yaml`.
- Everything else (collector, stream-worker, core, web, duckdb-serving, Argo cron jobs) runs on
  Karpenter-managed Spot nodes.

## Node pools (match the blueprint node groups)

| Pool | Instance | Capacity | Scale-to-zero | Bound (`limits`) | Consolidation |
|---|---|---|---|---|---|
| `streaming` | `t4g.large/xlarge` + `m7g.large/xlarge` | spot | **no** (warm) | cpu 20 / 80Gi | `WhenEmptyOrUnderutilized` |
| `ondemand` | `t4g.xlarge` + `m7g.xlarge` | **on-demand** | **yes** (0→2) | cpu 8 / 32Gi | `WhenEmpty` |

(The `batch` pool was removed in the Spark→DuckDB cutover; the `trino` pool in the Trino→
duckdb-serving cutover, ADR-0014 — duckdb-serving replicas + the DuckDB/PyIceberg crons all
ride the `streaming` pool.)

**AUD-OPS-033:** the aggregate ceiling (28 vCPU / 112Gi across the 2 pools) is deliberate and
documented in `values.yaml` — it is intentionally below the sum of all HPA maxima under a
fully-correlated burst; raise pool `limits` and workload maxima together. The `m7g.*` entries
are the t4g spot-drought fallback (same 1:4 vCPU:GiB shape, Graviton3, arm64 — one EC2NodeClass
covers all); Karpenter still provisions the cheaper t4g first.

**`ondemand` (AUD-COST-018)** is the tainted (`brain.platform/pool=ondemand:NoSchedule`)
home for single-instance stateful SoRs — Neo4j (identity SoR, Community = no HA) pins here via
`podSpec.nodeSelector`+toleration in `infra/helm/neo4j/values-prod.yaml`, so a Spot reclaim can
never bounce the only replica. Nothing else lands on paid on-demand capacity unless it explicitly
tolerates the taint; the pool scales to zero when unused.

Karpenter has **no fixed minimum** — a pool scales to zero when no pod requires it, bounded above by
`limits`. The bounds above approximate "0-3" / "0-2" nodes (limit ÷ instance vCPU).

**"streaming = no scale-to-zero"** is enforced two ways: (1) `consolidationPolicy: WhenEmpty` only
reclaims a node once it is *fully* empty (never bin-packs live consumers off it), and (2) the
streaming workloads (collector, live stream-worker) keep a warm baseline of replicas, so the pool
never drains to zero in practice.

### Pinning workloads to a pool
The `streaming` pool is **untainted** so untainted workloads still schedule freely; duckdb-serving
pins itself there via `nodeSelector: { karpenter.sh/nodepool: streaming }` in its own chart
(`infra/helm/duckdb-serving/values-prod.yaml`), as do the cronworkflows job pods. Those edits
belong to the workload charts, not here (no cross-chart edits).

## Wiring the operator must do (NOT done by this chart)

1. **Tag discovery targets.** Add `karpenter.sh/discovery=brain-<env>` to the cluster's **private
   subnets** and the **node security group** so `EC2NodeClass` `subnetSelectorTerms` /
   `securityGroupSelectorTerms` resolve. (The network/eks modules do not set this tag yet.)
2. **Create the IAM below in `modules/eks/irsa`.**

## IAM the operator must add to `modules/eks/irsa`

Karpenter needs **one IRSA role** for the controller, an **SQS interruption queue**, and **reuse** of
the existing node role. Concretely:

1. **Controller IRSA role** `brain-<env>-karpenter-controller`
   - Trust: the eks module OIDC provider (`output.oidc_provider_arn` / `oidc_provider_url`), `sub =
     system:serviceaccount:kube-system:karpenter`, `aud = sts.amazonaws.com`.
   - Policy (Karpenter v1 controller): `ec2:RunInstances`, `ec2:CreateLaunchTemplate`,
     `ec2:CreateFleet`, `ec2:CreateTags`, `ec2:TerminateInstances`, `ec2:DeleteLaunchTemplate`,
     `ec2:Describe*`, `pricing:GetProducts`, `ssm:GetParameter` (EKS-optimized AMI lookup),
     `eks:DescribeCluster`, and SQS `sqs:{GetQueueUrl,GetQueueAttributes,ReceiveMessage,DeleteMessage}`
     on the interruption queue. (Mirror the upstream `karpenter` controller policy / `data.aws_iam_policy_document`.)
   - **`iam:PassRole`** on the node role `brain-<env>-eks-node` (so launched nodes assume it), plus
     `iam:{CreateInstanceProfile,TagInstanceProfile,GetInstanceProfile,AddRoleToInstanceProfile,
     DeleteInstanceProfile,RemoveRoleFromInstanceProfile}` (Karpenter v1 manages the instance profile).
   - Annotate it on the controller SA via `serviceAccount.annotations` in `karpenter.yaml`
     (replace `ACCOUNT_ID`).
2. **SQS interruption queue** `brain-<env>` + EventBridge rules (Spot interruption, rebalance,
   instance state-change, scheduled change) targeting the queue. Name is passed as
   `settings.interruptionQueue` in `karpenter.yaml`.
3. **Node role** — **REUSED**, not created. `EC2NodeClass.role = brain-<env>-eks-node`
   (`aws_iam_role.node`), which already carries `AmazonEKSWorkerNodePolicy`,
   `AmazonEKS_CNI_Policy`, `AmazonEC2ContainerRegistryReadOnly`. No change to that role required.

## Static verification
```
helm lint  infra/helm/karpenter -f infra/helm/karpenter/values-prod.yaml
helm template karpenter-nodepools infra/helm/karpenter -f infra/helm/karpenter/values-prod.yaml
```
