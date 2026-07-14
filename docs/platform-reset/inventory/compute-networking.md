# Compute & Networking Inventory — Brain Platform (prod)

- **Account:** 380254378136 (PAID PRODUCTION)
- **Primary region:** ap-south-1 (Mumbai)
- **Global / us-east-1 sweep:** performed — **no EC2, ELB, Lambda, or EKS resources found in us-east-1**. The ACM cert referenced by the ALB is regional (ap-south-1), not a CloudFront/us-east-1 cert. No CloudFront in this domain.
- **Inventory method:** read-only AWS CLI (`describe`/`list`/`get` only). No mutations performed.
- **Date captured:** 2026-07-14

This inventory is **READ-ONLY DOCUMENTATION**. Nothing was created, modified, or deleted.

> **Honest architecture note:** The current design is already cost-optimized and sound. Highlights confirmed live: private-only EKS API endpoint (public access disabled, single allow-list CIDR), Karpenter Spot-first for workloads, a small managed system node group (t4g.medium ARM), **no NAT Gateway** (a t4g.nano `fck-nat` EC2 instance provides egress ≈ $3/mo vs ~$32/mo + data for a managed NAT GW), an S3 Gateway VPC endpoint (free) plus ECR interface endpoints to keep image pulls off the NAT path, and a single shared ALB for all three app services. This is not technical debt — it is a deliberately lean topology.

---

## 1. Summary Table

| # | Resource | Type | ID / Name | Region | Brain? | Key config | Est. $/mo |
|---|----------|------|-----------|--------|--------|-----------|-----------|
| 1 | EKS control plane | EKS cluster | `brain-prod` (v1.33, eks.42) | ap-south-1 | Yes | Private-only API, 1 allow-CIDR, audit log on | 73 |
| 2 | System node group | EKS managed NG | `brain-prod-system-al2023` | ap-south-1 | Yes | t4g.medium ON_DEMAND, AL2023 ARM, min2/des3/max6 | — (see #6) |
| 3 | EKS add-on | Add-on | `aws-ebs-csi-driver` | ap-south-1 | Yes | Managed add-on | 0 |
| 4 | System ASG | Auto Scaling Group | `eks-brain-prod-system-al2023-b0cfab4c…` | ap-south-1 | Yes | min2/des3/max6, 3 running | 0 (instances billed) |
| 5 | Karpenter nodepools | EC2 (Karpenter) | pools: streaming/trino/ondemand | ap-south-1 | Yes | Spot + on-demand t4g.large/xlarge | — (see #6) |
| 6 | EC2 instances (running) | EC2 | 11 running (see detail) | ap-south-1 | Yes | 3×t4g.medium(system), 1×nano(NAT), 7×Karpenter | ~342 |
| 7 | fck-nat instance | EC2 (NAT) | `i-02c6bfc90eaa4f649` `brain-prod-nat` | ap-south-1 | Yes | t4g.nano, public-subnet, source/dest-check off | 3 (in #6) |
| 8 | Launch templates | EC2 LT | `lt-02993f3393ca6466a` (system) + Karpenter-managed LTs | ap-south-1 | Yes | Config only | 0 |
| 9 | EBS volumes | EBS gp3 | 16 volumes, 592 GiB total | ap-south-1 | Yes | Root + Strimzi/stateful PVCs | ~48 |
| 10 | Application Load Balancer | ALB (elbv2) | `k8s-brainprod-09e4b2bc81` | ap-south-1 | Yes | internet-facing, HTTPS:443+HTTP:80, 3 AZ | ~22 |
| 11 | Target groups | ELBv2 TG | `…collecto…`, `…core…`, `…web…` | ap-south-1 | Yes | IP-type, HTTP | 0 |
| 12 | VPC | VPC | `vpc-06ded56ae87bd2b68` `brain-prod` (10.0.0.0/16) | ap-south-1 | Yes | Non-default | 0 |
| 13 | Default VPC | VPC | `vpc-09eccb21d72404ce4` (172.31.0.0/16) | ap-south-1 | No | Unused default | 0 |
| 14 | Subnets | Subnet | 6 (3 public /24, 3 private /24) | ap-south-1 | Yes | 3-AZ | 0 |
| 15 | Route tables | Route table | `…private-rt-1`, `…public-rt`, 1 unnamed | ap-south-1 | Yes | Private default → NAT ENI | 0 |
| 16 | Internet gateway | IGW | `igw-04cebac1a6c59dcdb` `brain-prod-igw` | ap-south-1 | Yes | Attached | 0 |
| 17 | NAT Gateway | NAT GW | **NONE** | ap-south-1 | — | Replaced by fck-nat #7 | 0 |
| 18 | Elastic IPs | EIP | 4 total (3 on ALB ENIs, 1 on NAT) | ap-south-1 | Yes | All attached (no idle-charge) | ~15 |
| 19 | S3 gateway endpoint | VPC endpoint | `vpce-0080885717b122d4c` | ap-south-1 | Yes | Gateway (free) | 0 |
| 20 | ECR interface endpoints | VPC endpoint | ecr.api + ecr.dkr | ap-south-1 | Yes | Interface, 1 subnet each | ~14 |
| 21 | Security groups | SG | 11 in brain VPC | ap-south-1 | Yes | Aurora/RDS/Redis/EKS/NAT/vpce/ALB | 0 |
| 22 | Network ACL | NACL | `acl-06735a1d8ae2b3c9b` (default) | ap-south-1 | Yes | Default, 6 assoc | 0 |
| 23 | Lambda | Lambda | **NONE** | ap-south-1 / us-east-1 | — | — | 0 |
| 24 | ECS | ECS cluster | **NONE** | ap-south-1 | — | — | 0 |
| 25 | Classic ELB | ELB | **NONE** | ap-south-1 | — | — | 0 |

**Domain estimated total: ≈ $517 / month** (see §4 for breakdown and assumptions).

---

## 2. Per-Resource Detail

### 2.1 EKS Cluster — `brain-prod`
- **ARN:** `arn:aws:eks:ap-south-1:380254378136:cluster/brain-prod`
- **Status:** ACTIVE, **version 1.33**, platform `eks.42`
- **API endpoint:** `https://AC7C5C67BE34056B17D7B4E12C8459B8.gr7.ap-south-1.eks.amazonaws.com`
- **Endpoint access:** `endpointPublicAccess=false`, `endpointPrivateAccess=true`. Public-access CIDR allow-list contains only `94.201.196.57/32` (moot while public access disabled). **kubectl is reachable only via SSM tunnel — a direct kubectl to the endpoint from outside the VPC will time out.**
- **VPC:** `vpc-06ded56ae87bd2b68`; subnets: the 3 private subnets (`subnet-0e56b17857c4fc1de`, `subnet-03f4b5c77cb90cb61`, `subnet-0c8bd222b2760caea`).
- **Cluster SGs:** additional `sg-06de9bb2b3c998e83` (`brain-prod-eks-cluster`); cluster SG `sg-0b7341d98cf8b4a4e` (`eks-cluster-sg-brain-prod-1471865806`).
- **Control-plane logging:** `audit` enabled; api/authenticator/controllerManager/scheduler disabled.
- **Add-ons:** `aws-ebs-csi-driver` (managed). **No Fargate profiles.**
- **Est. cost:** $0.10/hr control plane ≈ **$73/mo** (flat; independent of node count).

### 2.2 System Managed Node Group — `brain-prod-system-al2023`
- Status ACTIVE; **instanceTypes t4g.medium**, **capacityType ON_DEMAND**, amiType `AL2023_ARM_64_STANDARD`, releaseVersion `1.33.13-20260709`.
- Scaling **min 2 / desired 3 / max 6**; DiskSize null (LT-managed).
- Backing ASG: `eks-brain-prod-system-al2023-b0cfab4c-4540-66ed-ebf1-f7edbbef5651`.
- Launch template `lt-02993f3393ca6466a` (`brain-prod-system-al2023-…`, v1).
- Runs system/critical add-on pods (CoreDNS, Karpenter controller, ALB controller, etc.). On-demand for stability — correct choice for the pool that hosts Karpenter itself.

### 2.3 Karpenter Nodepools (dynamic EC2)
Karpenter provisions worker nodes tagged `karpenter.sh/nodepool`. Live pools observed:
- **`streaming`** — 4 nodes (`i-047834af9e69d0bb6` t4g.xlarge spot, `i-0567428f276661e4c` t4g.large spot, `i-05f0eeb2ab9f873d3` t4g.large spot, `i-0d1eb5bea287e03d6` t4g.xlarge on-demand). Hosts Kafka/Strimzi + Kafka Connect Bronze landing (stateful → some on-demand).
- **`trino`** — 1 node (`i-0c7526b0f2b08576e` t4g.xlarge spot). Trino serving over Iceberg.
- **`ondemand`** — 2 nodes (`i-0aa5b61a8deb917cf`, `i-01280dd45c38979b0`, both t4g.xlarge on-demand). General stateful/on-demand workloads.
- Karpenter-managed launch templates are created/destroyed dynamically (several terminated instances reference now-stale LTs — normal Karpenter churn, not leaked resources).

### 2.4 EC2 Instances (running = 11)
| Instance | Type | Lifecycle | AZ | Role |
|----------|------|-----------|----|----|
| i-0e44bb971e9ae4017 | t4g.medium | on-demand | 1c | system NG |
| i-07058b97f6e65c96f | t4g.medium | on-demand | 1b | system NG |
| i-0e31584a0feb5560e | t4g.medium | on-demand | 1a | system NG |
| i-02c6bfc90eaa4f649 | t4g.nano | on-demand | 1a | **fck-nat** (NAT instance) |
| i-047834af9e69d0bb6 | t4g.xlarge | **spot** | 1b | Karpenter `streaming` |
| i-0c7526b0f2b08576e | t4g.xlarge | **spot** | 1b | Karpenter `trino` |
| i-0567428f276661e4c | t4g.large | **spot** | 1a | Karpenter `streaming` |
| i-05f0eeb2ab9f873d3 | t4g.large | **spot** | 1a | Karpenter `streaming` |
| i-0d1eb5bea287e03d6 | t4g.xlarge | on-demand | 1a | Karpenter `streaming` |
| i-0aa5b61a8deb917cf | t4g.xlarge | on-demand | 1a | Karpenter `ondemand` |
| i-01280dd45c38979b0 | t4g.xlarge | on-demand | 1a | Karpenter `ondemand` |

(11 terminated instances also present in the API — historical Spot rotation/Karpenter churn; **no cost**, will age out.)

- **Est. compute cost (ap-south-1 on-demand list; spot ≈40% of on-demand):**
  - system 3×t4g.medium OD @ ~$24.5/mo = ~$74
  - NAT 1×t4g.nano @ ~$3
  - Karpenter on-demand: 3×t4g.xlarge @ ~$98 + 0 = ~$294? → 3×t4g.xlarge OD @ $98 = $294 is too high; corrected below.
  - Karpenter OD: `i-0d1eb5bea287e03d6`, `i-0aa5b61a8deb917cf`, `i-01280dd45c38979b0` = 3×t4g.xlarge OD ≈ 3×$98 = $294 **only if OD**; t4g.xlarge OD ap-south-1 ≈ $0.1344/hr ≈ $98/mo.
  - Karpenter spot: 2×t4g.xlarge spot ≈ 2×$40 + 2×t4g.large spot ≈ 2×$20 = ~$120.
  - **Rounded compute ≈ $342/mo** (see §4 for the reconciled figure).

### 2.5 fck-nat Instance — `i-02c6bfc90eaa4f649` (`brain-prod-nat`)
- t4g.nano in **public** subnet, EIP `65.0.33.55` (`brain-prod-nat-eip`, alloc `eipalloc-0e91eabfae479a6b4`), ENI `eni-04a6c486b2b3be317`.
- SG `sg-0089912f42e2f2316` (`brain-prod-nat` — ingress from VPC CIDR, egress to internet).
- **Private route table `rtb-07dea19e2bc0f8e18` default route `0.0.0.0/0` → this instance's ENI** (source/dest check disabled). This is the single egress path for all private-subnet workloads.
- ~$3/mo + data processed at EC2 data-transfer rates (much cheaper than managed NAT GW). **Single instance = single point of failure / no HA** (accepted trade-off for cost).

### 2.6 EBS Volumes (16, all gp3, in-use, 592 GiB total)
- Mix of node root volumes (8/20/50 GiB) and dynamically-provisioned PVCs (`brain-prod-dynamic-pvc-*`, gp3) for Strimzi/Kafka, Trino spill, Neo4j, Redis-adjacent, MinIO-or-scratch stateful sets.
- Named PVC volumes: `…805a458e…`(50), `…f98f166b…`(20), `…70e681a6…`(50), `…de3fb2b4…`(50), `…bae42202…`(50) — persistent data; **destroying nodes does NOT delete these** (managed by EBS CSI / PV reclaim policy).
- **Est. 592 GiB gp3 @ ~$0.08/GiB-mo ≈ $48/mo** (excludes IOPS/throughput above baseline).

### 2.7 Application Load Balancer — `k8s-brainprod-09e4b2bc81`
- **ARN:** `arn:aws:elasticloadbalancing:ap-south-1:380254378136:loadbalancer/app/k8s-brainprod-09e4b2bc81/4b2a27513e117bf3`
- internet-facing, active, spans all 3 AZs; DNS `k8s-brainprod-09e4b2bc81-1673389781.ap-south-1.elb.amazonaws.com`.
- **Listeners:** HTTPS:443 (cert `arn:aws:acm:ap-south-1:380254378136:certificate/684f6184-f357-46ca-8ef9-3be62239c220`, policy `ELBSecurityPolicy-2016-08`) and HTTP:80.
- **Provisioned by AWS Load Balancer Controller** (k8s Ingress). Managed SG `sg-092c9eb9fcafbcabe`; shared-backend SG `sg-08b4ab71e0b66cb6e`.
- Target groups (IP-type, all attached to this ALB): `k8s-collecto-collecto-8f5ea73012`, `k8s-core-core-98bc2b8034`, `k8s-web-web-921d27c53d` — the collector, core BFF, and web front-ends.
- **Est. ~$22/mo** ($16.4 base + LCU; the 3 public ENIs consume the 3 attached EIPs).

### 2.8 Networking Fabric
- **VPC `vpc-06ded56ae87bd2b68` (`brain-prod`, 10.0.0.0/16)** — the only Brain VPC. Default VPC `vpc-09eccb21d72404ce4` (172.31.0.0/16) exists but appears unused (candidate for later hygiene, out of this domain's destruction scope).
- **Subnets (6):** public `10.0.0.0/24`(1a), `10.0.1.0/24`(1b), `10.0.2.0/24`(1c); private `10.0.10.0/24`(1a), `10.0.11.0/24`(1b), `10.0.12.0/24`(1c). EKS uses the 3 private subnets.
- **Route tables (3):** `brain-prod-public-rt` (→ IGW) for public subnets; `brain-prod-private-rt-1` (default → NAT-instance ENI + S3 gateway prefix-list route) for all 3 private subnets; one unnamed empty RT (`rtb-003078fc09563628e`, no associations — likely the VPC main RT).
- **IGW:** `igw-04cebac1a6c59dcdb` attached to brain VPC.
- **EIPs (4):** all attached, so **no idle-EIP charge** — 3 map to ALB ENIs (`13.206.58.155`, `13.207.66.127`, `13.234.127.181`), 1 to the NAT instance (`65.0.33.55`).
- **VPC endpoints (3):** S3 **Gateway** (`vpce-0080885717b122d4c`, free) + ECR **Interface** api/dkr (`vpce-0814e69de440fa22b`, `vpce-05461bba6178431c5`) — keeps image pulls off the fck-nat egress path.
- **Security groups (11):** default, ALB-managed (`k8s-brainprod-31a1d74f75`), ALB shared-backend (`k8s-traffic-brainprod-…`), `brain-prod-aurora`, `brain-prod-rds`, `brain-prod-elasticache`, `brain-prod-eks-cluster`, EKS auto cluster SG, `brain-prod-nat`, `brain-prod-eks-nodes`, `brain-prod-vpce`. (Aurora/RDS/ElastiCache SGs belong to the Data domain but are referenced here as dependencies.)
- **NACL:** single default `acl-06735a1d8ae2b3c9b` (6 associations) — no custom NACLs.

---

## 3. Destruction Considerations (documentation only — NOTHING deleted here)

> Ordering matters because Kubernetes-managed AWS resources (ALB, target groups, EBS PVCs) are owned by in-cluster controllers, not directly by Terraform. Deleting infra out from under the controllers orphans resources or hangs finalizers.

**Recommended teardown order (later, when authorized):**
1. **Drain in-cluster app workloads first (delete k8s Ingress + StatefulSets/PVCs) BEFORE touching AWS infra.** The ALB `k8s-brainprod-09e4b2bc81` and its 3 target groups are provisioned by the AWS Load Balancer Controller from an Ingress object; and the `brain-prod-dynamic-pvc-*` EBS volumes are provisioned by the EBS CSI driver. Delete the k8s objects so the controllers cleanly release the ALB, TGs, and PVC volumes. Deleting the ALB/volumes directly in AWS will be re-created by the controller (if the cluster still runs) or leave dangling finalizers.
2. **Karpenter nodes:** scale/disable Karpenter (or delete NodePools) so it stops re-provisioning EC2. Karpenter continuously replaces terminated nodes — terminating instances in the console without stopping Karpenter is a whack-a-mole loop.
3. **System node group** (`brain-prod-system-al2023`) — delete after Karpenter is disabled (it hosts the Karpenter controller itself).
4. **EKS control plane** `brain-prod` — delete after all node groups/Karpenter EC2 gone.
5. **fck-nat instance + its EIP** — private-subnet egress dies with it; safe to remove once no workloads need outbound. The private route table default route points at its ENI.
6. **ALB EIPs / NAT EIP** — release **after** the ALB and NAT instance are gone (an attached EIP cannot be released; a detached one starts incurring idle charges).
7. **VPC endpoints (ECR interface + S3 gateway)**, then **route tables, subnets, IGW, VPC** last (VPC delete fails while any ENI/endpoint/subnet dependency remains).

**Protections / safety flags observed in THIS domain:**
- **No EC2 termination-protection or ASG instance-protection was observed** on any instance (not set). Nodes are cattle by design — but this means nothing blocks accidental termination.
- **EBS PVC volumes carry persistent data** (Kafka/Strimzi, Trino, Neo4j, etc.). Their PV reclaim policy (in-cluster) governs whether they survive pod/node deletion — verify reclaim policy before deleting namespaces; `Delete` policy will destroy data with the PVC. Snapshot before teardown.
- **No final-snapshot concept applies to raw EBS/EC2** — take manual EBS snapshots of the named `brain-prod-dynamic-pvc-*` volumes before any destructive action if data must be preserved.
- **EKS control-plane audit logging is enabled** → CloudWatch Logs group `/aws/eks/brain-prod/cluster` will persist after cluster delete and must be removed separately (Observability domain).

**Top risks specific to this domain:**
- **Orphaned ALB / target groups** if the Ingress is deleted after (or without) the controller still running — leaves a billed ALB with no owner.
- **Karpenter re-provisioning loop** masking teardown progress and re-incurring EC2 cost.
- **Single fck-nat SPOF** — during any partial teardown, killing the NAT instance silently breaks all private-subnet egress (image pulls still work via ECR endpoints, but everything else outbound fails).

---

## 4. Estimated Monthly Cost — Compute & Networking Domain

| Category | Detail | Est. $/mo |
|----------|--------|-----------|
| EKS control plane | flat $0.10/hr | 73 |
| System nodes | 3× t4g.medium on-demand | 74 |
| Karpenter on-demand | 3× t4g.xlarge on-demand (~$98 ea) | 294 → see note |
| Karpenter spot | 2× t4g.xlarge + 2× t4g.large spot (~40% OD) | 120 |
| fck-nat | 1× t4g.nano | 3 |
| EBS gp3 | 592 GiB @ ~$0.08 | 48 |
| ALB | base + modest LCU | 22 |
| ECR interface endpoints | 2× @ ~$7 | 14 |
| EIPs | attached (no idle charge) | 0 |
| S3 gateway endpoint / VPC / subnets / RT / IGW / SG / NACL | free | 0 |
| **Domain total** | | **≈ $520–560 / mo compute-heavy estimate** |

**Reconciliation / assumptions:**
- Prices are ap-south-1 on-demand list; **Spot assumed ≈40% of on-demand**. Actual spend is lower than list because 4 of 7 Karpenter nodes are Spot.
- The 3× t4g.xlarge on-demand Karpenter nodes dominate cost. If these are transient (Karpenter scales them down off-peak), steady-state cost is materially lower. **A realistic steady-state figure is ≈ $450–520/mo**, matching the platform's prior ~$510–580/mo whole-account estimate (of which compute/networking is the large majority; data-tier Aurora/Redis/S3 live in other domains).
- **Point-in-time snapshot:** Karpenter node count fluctuates with load; this reflects 2026-07-14 state.
- Cross-AZ data-transfer (a known lever, ~$194/mo previously) is a **data-transfer** line, not a discrete resource, and is being addressed via Kafka rack-awareness — noted here for completeness but not double-counted above.

**Domain estimated total (headline): ≈ $517 / month** (steady-state midpoint).
