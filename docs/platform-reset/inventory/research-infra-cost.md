# Research: Cost-Optimized, Auto-Scaling Production EKS for Early-Stage SaaS (2026)

> **Scope:** CURRENT (2026) FinOps + AWS Well-Architected best practices for a small production EKS platform, mapped to **Brain's stack** (EKS 1.33 / AL2023, Karpenter, KEDA, Aurora, Kafka/Strimzi, Trino, Spark, Redis, ap-south-1). Each recommendation carries a rough $ impact and a **when-to-adopt** note.
> **Brain context (from prod state):** prod ~$510–580/mo; #1 lever was cross-AZ transfer (~638 GB/day, ~$194/mo) already tackled via Kafka rack-awareness (PR #165); S3 gateway endpoint exists, no NAT gateway; EKS already on 1.33/AL2023/STANDARD (the $360/mo upgrade saving is **already banked**, do NOT re-recommend it). Karpenter IMDS hop-limit fixed (PR #167/#168). Budget alerts-only at $500/mo.

---

## 0. Framework anchor — AWS Well-Architected Cost Optimization + FinOps

The AWS Well-Architected Cost Optimization pillar and the FinOps operating model converge on the same loop for Kubernetes: **measure → rightsize → match commitment to baseline → automate scale-to-demand → attribute cost per tenant/workload.** For containers this happens at the *container spec* level (requests/limits), not just the instance level. Per Cast AI's 2026 report, CPU overprovisioning across clusters averaged ~69% — rightsizing is the single biggest untapped lever for most teams before any commitment/discount play.
Sources: [AWS Prescriptive Guidance — EKS Cost Optimization](https://docs.aws.amazon.com/prescriptive-guidance/latest/scaling-amazon-eks-infrastructure/cost-optimization.html), [FinOps for Kubernetes (Finout)](https://www.finout.io/blog/finops-for-kubernetes-a-practical-cost-optimization-guide), [Kubernetes right-sizing with GitOps automation (AWS)](https://aws.amazon.com/blogs/containers/kubernetes-right-sizing-with-metrics-driven-gitops-automation/)

**FinOps sequence for Brain:** (1) rightsize requests, (2) Graviton + Spot via Karpenter, (3) consolidation + disruption budgets, (4) KEDA scale-to-zero for batch/idle lanes, (5) NAT/VPC-endpoint + cross-AZ hygiene, (6) Aurora min-ACU / scale-to-zero on non-prod, (7) a Compute Savings Plan only once a stable baseline emerges.

---

## 1. Small production EKS topology (early-stage)

- **Control plane:** flat $0.10/hr (~$73/mo) per cluster — unavoidable; run **one** prod cluster, don't split per-service. A minimal but *functional* single-AZ cluster floors around ~$178/mo; that is NOT production-hardened (no HA).
- **Data plane:** Karpenter-managed nodes (no static managed node groups for app tier). Keep a tiny on-demand "system" pool for Karpenter itself + critical singletons; everything else Spot/Graviton via Karpenter.
- **Right the AZ count** (see §8): early-stage prod is well served by **2 AZs**, not 3 — halves the (N-1)/N cross-AZ probability vs 3-AZ and removes one NAT/endpoint set, while still surviving a single-AZ failure.

**$ impact:** topology discipline (1 cluster, Karpenter-only app tier, 2 AZ) typically keeps a small prod cluster in the ~$300–500/mo band vs the ~$438/mo "trap" of default managed node groups + 3× NAT.
**When to adopt:** now — this is Brain's current shape; keep it.
Sources: [Amazon EKS Pricing](https://aws.amazon.com/eks/pricing/), [EKS Pricing 2026: the $438/Month Trap (Cloud Burn)](https://cloudburn.io/blog/amazon-eks-pricing), [EKS Pricing & Cost Optimization (CloudZero)](https://www.cloudzero.com/blog/eks-pricing/)

---

## 2. Karpenter — consolidation, Spot, disruption budgets

- **Policy:** use `consolidationPolicy: WhenEmptyOrUnderutilized` (not `WhenEmpty`). `WhenEmpty` leaves underutilized nodes (10% CPU / 30% mem) running and burns money. Karpenter also offers a **`Balanced`** scoring mode that only acts when savings sufficiently exceed pod-disruption weight — good default for mixed prod.
- **`consolidateAfter`:** ~`5m` is the sweet spot. Below ~2m causes thrashing; above ~15m you stop saving because nodes stay overprovisioned. Timer resets when pods are added/removed, so a node consolidates only after being stable for the full window.
- **Spot:** Karpenter uses the **price-capacity-optimized** allocation strategy (deepest, lowest-interruption pools, not just cheapest). ~80% of nodes on Spot is achievable in production **with PDBs set**.
- **Spot-to-spot consolidation** requires **≥15 cheaper instance-type options** for single-node consolidation (prevents "race to the bottom" churn); multi-node consolidations bypass this. → **Do NOT over-constrain instance families/sizes in the NodePool**, or spot-to-spot consolidation silently won't fire.
- **Disruption budgets:** if undefined, Karpenter defaults to one budget of `nodes: 10%`. **On a small (≤4 node) cluster, 10% rounds to "anytime" — set explicit integer counts, not percentages.** Add a **schedule+duration freeze** (e.g. `nodes: "0"` during business hours, UTC cron) for the app tier, and scope budgets by `reasons` (`Drifted`/`Underutilized`/`Empty`).
- **Safety:** set `PodDisruptionBudget` (`minAvailable`/`maxUnavailable`) on every critical Deployment. The risk with `WhenEmptyOrUnderutilized` is *undeclared* disruption tolerance, not the policy itself.

**$ impact:** Karpenter consolidation typically yields **30–50%** vs static node pools; Spot adds up to ~90% off on-demand for the fault-tolerant fraction (worked example: ~$391/mo saved on 4 of 8 nodes).
**When to adopt:** now — tune the 6 knobs above. For Brain, ensure **Kafka/Strimzi, Trino coordinator, and Spark drivers are PDB-guarded and pinned off aggressive spot** (see §3/§7); stateless BFF/collector/web ride Spot happily.
Sources: [Karpenter Disruption docs](https://karpenter.sh/docs/concepts/disruption/), [Spot-to-Spot Consolidation Best Practices (nOps)](https://www.nops.io/blog/spot-to-spot-consolidation-in-karpenter-how-to-use-best-practices/), [Karpenter consolidation: 6 settings to tune in 2026 (dev.to)](https://dev.to/muskan_8abedcc7e12/karpenter-consolidation-6-settings-worth-tuning-in-2026-4bo6), [Deploy Karpenter on EKS 2026 (Cast AI)](https://cast.ai/blog/deploy-karpenter-eks-node-autoscaling/)

---

## 3. Graviton / ARM

- Graviton (Graviton4 generation) delivers **~15–30% better performance at ~20% lower hourly cost** than equivalent x86. Default all fungible/multi-arch workloads to ARM.
- On EKS you get ARM via **Graviton EC2 node types under Karpenter** (there is **no Fargate Spot for EKS pods** — that's ECS-only, don't plan around it).
- **Requirement:** multi-arch container images. Anything JVM/Node/Python/Go is trivially ARM; verify native deps.

**$ impact:** ~20% off compute on every workload moved to ARM (stacks multiplicatively with Spot: Graviton-Spot vs x86-on-demand can be 60–70%+ off).
**When to adopt:** now for BFF/collector/web/core (Node/TS) and Trino (JVM, ARM-clean). **Verify per-image for Brain:** Spark, Kafka/Strimzi, Trino, Redis all publish arm64 images — add `kubernetes.io/arch: [arm64, amd64]` to NodePools and let Karpenter pick, keeping amd64 as fallback only where a dependency lacks arm64.
Sources: [AWS Graviton](https://aws.amazon.com/ec2/graviton/), [Graviton4 on EKS: Real Cost Savings vs x86 (SquareOps)](https://squareops.com/blog/aws-graviton4-benchmarks-eks-cost-savings/), [AWS Graviton ARM EC2 (techoral)](https://techoral.com/aws/aws-graviton-ec2.html)

---

## 4. Spot vs On-Demand mix

- **Baseline + burst pattern:** on-demand (or a Compute Savings Plan) for the predictable **floor**, Spot for everything **above** the floor and everything stateless/fault-tolerant. This mix typically delivers **50–70% compute savings** vs pure on-demand.
- **Interruption reality:** Spot is spare capacity at up to ~90% off with a 2-minute reclaim warning — fine for stateless, retry-safe, and replayable work.
- **Brain mapping:**
  - **Spot-friendly:** collector, BFF, web, core API replicas (behind PDBs + ≥2 replicas), **Spark executors** (retry/replay-safe by design), Trino workers.
  - **On-demand / no-spot:** Karpenter controller & system pods, **Kafka/Strimzi brokers** (stateful, rack-aware), **Trino coordinator**, **Spark driver**, any singleton. Pin these with a NodePool taint/on-demand requirement.

**$ impact:** 50–70% on the Spot-eligible fraction of compute.
**When to adopt:** now — Brain's transform tier (Spark) and stateless app tier are ideal Spot candidates; guard the stateful set explicitly.
Sources: [EKS Cost Optimization (costimizer.ai)](https://costimizer.ai/blogs/eks-cost-optimization), [Kubernetes Cost Optimization 2026 (sanj.dev)](https://sanj.dev/post/kubernetes-cost-optimization-2026/), [AWS Fargate/Spot note (Cloud Burn)](https://cloudburn.io/blog/amazon-eks-pricing)

---

## 5. KEDA — event-driven autoscaling & scale-to-zero

- KEDA (CNCF **graduated**, production-ready) scales deployments to **zero** when idle and back up the moment work arrives, driven by event sources (Kafka lag, SQS depth, cron, Prometheus metrics). Event-driven autoscaling is cited at **25–40% cloud-cost reduction** for idle-heavy fleets; teams report 20%+ infra savings pairing KEDA with Karpenter.
- **Idle-most-of-the-time workloads = zero compute during idle.** Pair with Karpenter so scaled-to-zero pods let Karpenter deprovision the underlying node.

**Brain mapping (high-value):**
- **Kafka-consumer / stream-worker lanes** → KEDA Kafka-lag scaler; scale replicas with consumer lag, floor at a small non-zero for latency-sensitive lanes.
- **Spark/transform + batch/cron jobs** (Silver→Gold refresh, maintenance/RTBF) → **scale-to-zero between runs**; wake on schedule or queue depth. This is the biggest scale-to-zero win for Brain since transform is bursty, not continuous.
- **Trino workers** → scale on query queue/Prometheus; **keep coordinator warm**, let workers scale toward zero off-hours.
- **Non-prod/dev namespaces** → cron-scale to zero overnight/weekends.

**$ impact:** 25–40% on idle-dominated lanes; near-100% compute elimination on truly idle batch windows.
**When to adopt:** now for batch/transform + dev; **stage carefully for latency-sensitive consumer lanes** (accept cold-start or keep a warm floor of 1). Mind Brain's rule: no event loss — set consumer-lag thresholds so scale-down never drops in-flight work.
Sources: [Event-Driven Autoscaling with KEDA on EKS (AWS)](https://docs.aws.amazon.com/solutions/event-driven-application-autoscaling-with-keda-on-amazon-eks/), [KEDA that actually saves money (Medium)](https://medium.com/@mgaurang123/keda-event-driven-autoscaling-for-kubernetes-that-actually-saves-you-money-42cc40c35415), [Reducing Cloud Costs with KEDA (Hokstad)](https://hokstadconsulting.com/blog/reducing-cloud-costs-keda-autoscaling)

---

## 6. Right-sizing (requests/limits) — the biggest quiet lever

- CPU overprovisioning averaged **~69%** in 2026 — rightsizing requests to actual usage often frees more than any discount.
- **VPA in `Off` (recommendation) mode** as an advisor — do NOT run VPA in auto mode on stateful services (it restarts pods, breaking Kafka/Trino/Spark/Redis). Feed its recommendations into GitOps-managed request values.
- **Compose four tools** for complementary waste: **VPA** (right requests) + **HPA/KEDA** (scale replicas) + **KRR** (metrics-driven recommendations) + **Karpenter** (bin-pack + node choice). No single tool fixes all waste.
- **Set requests ≈ p95 usage; set memory limit = request** (avoid OOM surprises), CPU limit generally unset (let it burst) unless noisy-neighbor.

**$ impact:** commonly **20–50%** cluster compute reduction from requests alone, and it *amplifies* Karpenter bin-packing (fewer/smaller nodes).
**When to adopt:** **first** — before committing to any Savings Plan. For Brain: profile collector/BFF/core/Trino/Spark over 1–2 weeks, then encode requests in Helm values via GitOps (release→master flow).
Sources: [K8s Pod Rightsizing (costimizer.ai)](https://costimizer.ai/blogs/kubernetes-pod-rightsizing), [VPA/HPA/KRR/Karpenter compose (LeanOps)](https://leanopstech.com/blog/kubernetes-rightsizing-vpa-hpa-krr-karpenter-2026/), [Kubernetes right-sizing with GitOps (AWS)](https://aws.amazon.com/blogs/containers/kubernetes-right-sizing-with-metrics-driven-gitops-automation/)

---

## 7. Single-AZ vs Multi-AZ (early-stage trade-off)

- **The cross-AZ tax:** in a 3-AZ cluster with evenly spread pods, any request has **(N-1)/N = ~67%** chance of crossing an AZ; cross-AZ transfer is **~$0.01/GB each direction**. This compounds fast for chatty data platforms (Brain's Kafka↔Spark↔Trino).
- **Multi-AZ networking cost drivers:** one NAT gateway per AZ (~$32/mo each + $0.045/GB) and cross-AZ data transfer — often the dominant line items, not compute.
- **Guidance for early-stage:** run prod across **≥2 AZs** for HA (survive one AZ failure) but **aggressively pin AZ-locality** to suppress the tax. Use **single-AZ only for non-critical / dev** workloads where the risk is acceptable.

**Cross-AZ suppression toolkit (apply in Brain):**
- **Kafka rack-awareness** (already done, PR #165) — keeps producer/consumer/broker traffic in-AZ; the biggest single Brain lever (~638 GB/day → ~$194/mo).
- **`trafficDistribution: PreferClose`** (GA in K8s 1.33 — Brain is on 1.33) on Services → same-zone endpoints first, fall back cross-zone. Simpler/more predictable than Topology Aware Routing.
- **ALB/NLB in `ip` target mode** (via AWS Load Balancer Controller) → LB proxies **directly to the pod, zero data-transfer charge**; `instance` mode adds a cross-AZ kube-proxy hop.
- **`internalTrafficPolicy: Local`** + topology-spread / pod-affinity for tightly-coupled service pairs (co-locate on node/AZ). Cannot combine with Topology Aware Routing.

**$ impact:** cross-AZ hygiene routinely cuts the network bill several-fold; for Brain the rack-awareness + PreferClose + ip-mode combo protects the ~$194/mo lane and prevents regrowth.
**When to adopt:** 2-AZ prod now; layer PreferClose + ip-mode immediately (both are 1.33-ready and low-risk).
Sources: [EKS Cost Optimization — Networking (AWS best practices)](https://docs.aws.amazon.com/eks/latest/best-practices/cost-opt-networking.html), [Single vs Multi-AZ EKS (CloudZero)](https://www.cloudzero.com/blog/eks-pricing/), [Cross-AZ tax YAML tweak (Darryl Ruggles)](https://darryl-ruggles.cloud/eks-and-the-cross-az-tax-how-to-stop-paying-aws-002gb-for-traffic-that-should-never-leave-your-availability-zone/), [Track inter-AZ & NAT traffic (AWS)](https://aws.amazon.com/blogs/containers/track-inter-az-and-nat-gateway-traffic-with-eks-container-network-observability/)

---

## 8. NAT-gateway cost avoidance (VPC endpoints / fck-nat)

- **NAT gateway (2026):** ~$0.045/hr + **$0.045/GB** processed. One-per-AZ for HA → ~$98/mo base for 3 AZs before a byte of data. This is one of the most over-paid AWS line items (audits find bills 3–4× what they should be).
- **Gateway VPC endpoints (S3, DynamoDB): FREE** — no hourly, no per-GB. **Brain already has the S3 gateway endpoint** (keep it; it removes S3/MinIO-tier egress from NAT).
- **Interface VPC endpoints** (ECR api+dkr, STS, Secrets Manager, CloudWatch Logs, Kafka/MSK, etc.): ~$0.01/hr + ~$0.01/GB, and **inter-AZ transfer over PrivateLink is not charged** — far cheaper than routing AWS-service traffic through NAT. Add endpoints for the AWS services Brain calls hot (ECR image pulls especially).
- **fck-nat** (community NAT-instance AMI on `t4g.nano`, ARM): ~**$3.75/mo, no per-GB processing fee**, ~5 Gbps burst — a **90%+ reduction** vs managed NAT for the residual internet egress (webhooks, third-party connector APIs: Shopify/Meta/Google/Shiprocket/GoKwik). Trade-off: it's a single instance (self-managed HA), acceptable early-stage.

**$ impact:** replacing a managed NAT with fck-nat + endpoints commonly cuts the NAT/egress bill **~80–90%** ($98/mo → single-digit $). For Brain (currently *no* NAT gateway per prod state), the play is: **keep S3 gateway endpoint, add interface endpoints for hot AWS services, and if/when outbound internet is needed for connectors, use fck-nat — do NOT introduce a managed NAT gateway.**
**When to adopt:** now — endpoints are pure savings; choose fck-nat over managed NAT the moment private-subnet internet egress is required.
Sources: [EKS Cost Optimization — Networking (AWS)](https://docs.aws.amazon.com/eks/latest/best-practices/cost-opt-networking.html), [NAT Gateway vs VPC Endpoint 80% lower (LeanOps)](https://leanopstech.com/blog/aws-nat-gateway-vs-vpc-endpoint-2026/), [NAT Gateway cost strategies 2026 (CloudAtler)](https://cloudatler.com/blog/aws-nat-gateway-cost-optimization-strategies-in-2026), [Reduce NAT Gateway costs (CloudZero)](https://www.cloudzero.com/blog/reduce-nat-gateway-costs/)

---

## 9. Aurora Serverless v2 — auto-pause / min-ACU

- ASv2 now **scales to 0 ACU and auto-pauses** when there are no connections. Set **min-capacity = 0** at cluster level and an **idle delay 5 min – 24 hr**. Paused = **no compute charge** (storage still billed). Standard ACU = **$0.12/ACU-hr** (~$43.80/mo per 0.5 ACU held continuously); I/O-Optimized = $0.156/ACU-hr.
- **Caveat:** resume adds a **~15-second cold-start** on first connection → great for dev/variable/unpredictable, **not** for prod with strict latency SLOs. For prod keep a **non-zero floor** (e.g. min 0.5–1 ACU) so there's no cold-start, and cap max ACU to bound spend.

**Brain mapping:** Brain's operational state is **PostgreSQL — the `ops` schema** (identity/journey export, ML inference log, stitch shim). It's operational, connection-holding, and on the request path → **prod: min-ACU floor (no scale-to-zero), bounded max-ACU.** **Dev/staging Aurora: min-ACU = 0 + auto-pause (5-min idle)** — this is where the savings land, since non-prod DBs sit idle overnight/weekends.
**$ impact:** dev/staging scale-to-zero saves the full ~$44+/mo per idle instance; prod floor+cap prevents runaway ACU while keeping SLOs.
**When to adopt:** now for non-prod (scale-to-zero); prod uses floored min-ACU only.
Sources: [Scaling to Zero ACUs — auto pause/resume (AWS docs)](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html), [Introducing scale to 0 with ASv2 (AWS blog)](https://aws.amazon.com/blogs/database/introducing-scaling-to-0-capacity-with-amazon-aurora-serverless-v2/), [ASv2 Complete 2026 Guide (Usage.ai)](https://www.usage.ai/blogs/aws/rds/aurora-serverless-v2/), [ACU min/max scaling impact (AWS blog)](https://aws.amazon.com/blogs/database/understanding-how-acu-minimum-and-maximum-range-impacts-scaling-in-amazon-aurora-serverless-v2/)

---

## 10. Commitment layer (last, not first)

Once rightsizing + Spot + Graviton stabilize a predictable **baseline**, cover that floor with a **1-yr Compute Savings Plan** (flexible across instance family/size/region/OS and covers Fargate/Lambda) — layered *under* Spot burst. Commit to only the durable baseline (~the on-demand floor), never to the Spot-eligible fraction. This is the "savings-plan layer most teams leave uncovered."
**$ impact:** ~30% off the committed baseline on top of everything above.
**When to adopt:** after ~1 month of stable post-rightsizing usage — Brain is early-stage, so defer until the baseline stops moving.
Sources: [EKS Cost Optimization — Savings Plan layer (Usage.ai)](https://www.usage.ai/blogs/aws/eks-cost-optimization/), [AWS Prescriptive Guidance — Cost Optimization](https://docs.aws.amazon.com/prescriptive-guidance/latest/scaling-amazon-eks-infrastructure/cost-optimization.html)

---

## Priority-ordered adoption map for Brain

| # | Lever | Rough $ impact | When |
|---|-------|----------------|------|
| 1 | Rightsize requests (VPA-off advisor + KRR, GitOps) | 20–50% compute | Now (first) |
| 2 | Graviton/ARM NodePools (arm64 preferred, amd64 fallback) | ~20% compute | Now |
| 3 | Spot for stateless + Spark/Trino workers; on-demand pin stateful | 50–70% on Spot fraction | Now |
| 4 | Karpenter `WhenEmptyOrUnderutilized` + `consolidateAfter 5m` + integer disruption budgets + business-hours freeze | 30–50% vs static | Now (tune) |
| 5 | KEDA scale-to-zero for batch/transform + dev; Kafka-lag scaler for consumers | 25–40% on idle lanes | Now (batch) / staged (consumers) |
| 6 | Cross-AZ hygiene: keep 2-AZ, Kafka rack-aware (done), `PreferClose`, ALB/NLB ip-mode | protects ~$194/mo lane | Now |
| 7 | VPC interface endpoints (ECR/STS/Secrets/Logs); keep S3 gateway; fck-nat if egress needed — no managed NAT | ~80–90% NAT/egress | Now (endpoints) |
| 8 | Aurora min-ACU floor in prod; scale-to-zero + auto-pause in non-prod | ~$44+/mo per idle non-prod DB | Now (non-prod) |
| 9 | Compute Savings Plan on stabilized baseline | ~30% on committed floor | After ~1 mo stable |

**Do NOT re-recommend for Brain:** EKS 1.33/AL2023 upgrade (already live, saving already banked); a managed NAT gateway (Brain has none — keep it that way).
