# 07 — Cost Optimization Report (FinOps)

**Author:** FinOps Engineer · **Date:** 2026-07-14
**Account:** 380254378136 (PAID PRODUCTION) · **Region:** ap-south-1 (Mumbai) · **Domain:** brain.pipadacapital.com
**Sources:** `docs/platform-reset/inventory/{compute-networking,databases-backups,storage,observability-dns,secrets-kms-iam}.md`, `docs/platform-reset/inventory/research-infra-cost.md`, `infra/terraform/envs/prod/terraform.tfvars`.

> **Headline:** current prod spend is **≈ $520–580/mo**, cross-checked against Brain's own ~$450–580/mo memory figure. The platform is **already substantially cost-optimized** — the big structural levers (EKS 1.33/STANDARD support, Graviton system + Karpenter nodes, Spot-first workloads, fck-nat instead of managed NAT, S3 gateway + ECR interface endpoints, Aurora Serverless v2 floored at 0.5 ACU, single shared ALB, Kafka rack-awareness) are **applied**. The remaining opportunity is **rightsizing + KEDA scale-to-zero on the transform/idle lanes + finishing cross-AZ hygiene**, which can bring steady-state low-traffic spend to **≈ $340–400/mo** without giving up single-AZ-failure survivability. This is honest tuning, not a rescue of technical debt.

---

## 1. Current Estimated Monthly Spend (by service)

Point-in-time snapshot (2026-07-14). Karpenter node count fluctuates with load; figures use ap-south-1 on-demand list price with Spot ≈ 40% of on-demand.

| Service / line item | Detail | Est. $/mo | Share |
|---|---|---:|---:|
| **EC2 compute — Karpenter on-demand** | 3× t4g.xlarge on-demand (streaming + ondemand pools) | **~180–294** | largest |
| **EC2 compute — system node group** | 3× t4g.medium on-demand (Graviton), min2/des3/max6 | **~74** | large |
| **EKS control plane** | flat $0.10/hr, single cluster | **73** | large |
| **EC2 compute — Karpenter Spot** | 2× t4g.xlarge + 2× t4g.large Spot | **~120** | large |
| **Aurora PostgreSQL Serverless v2** | 0.5–2.0 ACU, single-AZ, 35-day PITR (compute+storage+backup) | **~50–95** | medium |
| **EBS gp3** | 638 GB provisioned (node roots + Kafka/Neo4j/Prometheus/Trino PVCs) | **~48–51** | medium |
| **ALB (shared)** | 1 internet-facing ALB, base + LCU, 3 AZ | **~22** | small |
| **EIPs** | 4 attached (3 ALB, 1 NAT) — no idle charge | **~15** | small |
| **ECR interface VPC endpoints** | 2× (api + dkr) @ ~$7 | **~14** | small |
| **ElastiCache Valkey** | cache.t4g.micro single node | **~12–14** | small |
| **Secrets/KMS** | 4 CMK @ $1 + 22 secrets @ $0.40 + usage | **~13–15** | small |
| **CloudWatch Logs + observability** | EKS control-plane ingest+storage (dominant), 5 alarms, Route 53 | **~8–31** | small |
| **fck-nat instance** | t4g.nano (replaces ~$32/mo managed NAT) | **~3** | tiny |
| **S3 (5 buckets, ~13 GB)** | Bronze/Silver/Gold Iceberg + audit + metrics + tfstate | **~0.50** | tiny |
| **Snapshots (Aurora / Redis / Neo4j-DLM)** | automated + DLM incremental | **~2–8** | tiny |
| **DynamoDB (tfstate lock)** | PAY_PER_REQUEST, ~0 traffic | **~0** | tiny |
| **TOTAL (steady-state midpoint)** | | **≈ $520–580 / mo** | 100% |

### Biggest line items (the 80/20)
1. **EC2 compute (Karpenter + system nodes) ≈ $370–490/mo (~65–75% of the bill).** This is where every meaningful lever lives. The 3 on-demand t4g.xlarge Karpenter nodes dominate; if some are transient (scaled down off-peak) the real figure sits lower.
2. **EKS control plane $73/mo** — flat and unavoidable for one cluster (correctly running a single cluster, not per-service).
3. **Aurora Serverless v2 $50–95/mo** — already floored at 0.5 ACU; only meaningful if it idles above the floor.
4. **EBS gp3 ~$48–51/mo** — lean (gp3 not io2, baseline IOPS, tight lifecycle); ~$35 of it is node-root/ephemeral that scales with node count.
5. **A non-line-item: cross-AZ data transfer** (~$194/mo at its worst, ~638 GB/day) — a *data-transfer* charge, not a discrete resource, already largely suppressed by **Kafka rack-awareness (PR #165)**. Left unguarded it would be the single biggest line item; keeping it suppressed is a top-5 priority.

---

## 2. Ranked Cost Levers

Ranked by realistic monthly $ saved at current low-traffic scale. "Applied?" reflects the live prod state per the inventories and tfvars.

| # | Lever | Mechanism | Est. $/mo saved | Effort | Risk | Already applied? |
|---|---|---|---:|---|---|---|
| 1 | **Cross-AZ traffic reduction (Kafka rack-awareness)** | Rack-aware Strimzi keeps producer↔broker↔consumer traffic in-AZ; protects the ~$194/mo (~638 GB/day) chatty Kafka↔Spark↔Trino lane | **~150–194 (protected)** | Med | Low | ✅ Yes (PR #165) — **keep**; do not regress |
| 2 | **Rightsize requests/limits (VPA-off advisor + KRR, GitOps)** | Set requests ≈ p95, memory limit = request; amplifies Karpenter bin-packing → fewer/smaller nodes. CPU overprovisioning averages ~69% industry-wide | **~60–120** | Med | Low–Med | ❌ Not yet — **highest untapped lever** |
| 3 | **KEDA scale-to-zero for batch/transform + idle lanes** | Spark Silver→Gold refresh, maintenance/RTBF, dev namespaces scale to 0 between runs; Kafka-lag scaler for consumers (warm floor of 1) | **~40–90** | Med | Med | ⚠️ Partial (KEDA present) — extend to transform/dev scale-to-zero |
| 4 | **Graviton / ARM everywhere** | arm64 NodePools + system group already t4g; ensure all fungible workloads default arm64 (amd64 fallback only) | **~20% of compute (mostly banked)** | Low | Low | ✅ Mostly (all nodes t4g) — verify no x86 stragglers |
| 5 | **Spot via Karpenter for stateless + Spark/Trino workers** | Spot for collector/BFF/web/core replicas + Spark executors + Trino workers; on-demand pin Kafka/Trino-coordinator/Spark-driver/system | **~50–70% of Spot-eligible fraction (partly banked)** | Low | Med | ⚠️ Partial (4/7 Karpenter nodes Spot) — raise Spot ratio, PDB-guard |
| 6 | **Karpenter consolidation tuning** | `WhenEmptyOrUnderutilized` + `consolidateAfter 5m` + **integer** disruption budgets (not %) + business-hours freeze; don't over-constrain instance families (keeps spot-to-spot consolidation firing) | **~30–50% vs static (partly banked)** | Low | Med | ⚠️ Partial — audit the 6 knobs, add PDBs on Kafka/Trino/Spark |
| 7 | **CloudWatch log retention / verbosity trim** | Shorten `/aws/eks/brain-prod/cluster` retention below 30d and/or reduce control-plane audit verbosity; delete stray `/aws/lambda/test` (NEVER_EXPIRE) | **~5–20** | Low | Low | ❌ Not yet — only material observability lever |
| 8 | **Aurora min-ACU floor (prod) + scale-to-zero (non-prod)** | Prod keeps 0.5 ACU floor (no cold-start on SLO path); any dev/staging Aurora → min-ACU=0 + 5-min auto-pause | **~44+/mo per idle non-prod DB** | Low | Low | ✅ Prod floored at 0.5 ACU; ❌ apply scale-to-zero on non-prod |
| 9 | **`trafficDistribution: PreferClose` + ALB/NLB ip-mode** | K8s 1.33 GA — same-zone endpoints first; ip-target mode proxies LB→pod directly (zero cross-AZ kube-proxy hop). Reinforces lever #1 | **~10–30 (reinforces #1)** | Low | Low | ⚠️ ALB is ip-mode ✅; add PreferClose on hot Services |
| 10 | **VPC endpoints / no managed NAT** | S3 gateway endpoint (free) + ECR interface endpoints keep image pulls off egress; fck-nat (t4g.nano) instead of ~$32/mo managed NAT | **~30–90 (banked)** | Low | Low (SPOF) | ✅ Yes — S3 gw + ECR endpoints + fck-nat live. **Keep; add STS/Secrets/Logs endpoints if hot** |
| 11 | **S3 lifecycle / intelligent-tiering** | Bronze bucket already INT-tiering@0d + noncurrent-90d + abort-MPU-7d; metrics/tfstate/neo4j-backups on tight 30/90d rules | **~0 (already minimal, ~$0.50 total)** | Low | Low | ✅ Yes — no action; data volume tiny |
| 12 | **Single-AZ for non-prod** | Run dev/staging single-AZ; cron-scale non-prod namespaces to zero overnight/weekends | **~full non-prod cost when idle** | Low | Low (non-prod) | ❌ N/A yet (no separate non-prod acct observed) — apply when non-prod exists |
| 13 | **EKS 1.33 / AL2023 / STANDARD support** | Avoids ~$360/mo extended-support fee | **~360 (BANKED)** | — | — | ✅ **DONE 2026-07-12** — do NOT re-recommend |
| 14 | **Compute Savings Plan on stable baseline** | 1-yr Compute SP under the Spot burst, committing only the durable on-demand floor | **~30% of committed floor** | Low | Low | ❌ Defer — wait ~1 mo of post-rightsizing stability |

**Guidance:** do levers **2 → 3 → 6/5 → 7 → 9** next (rightsize first, then scale-to-zero, then consolidation/Spot tuning, then log trim, then finish cross-AZ hygiene). Defer the Savings Plan (#14) until the baseline stops moving. Do **not** re-introduce a managed NAT gateway or re-recommend the EKS upgrade — both are already handled.

---

## 3. Target Steady-State Budgets

### 3a. Low-traffic steady-state target (achievable, current scale)

Assumes rightsizing (#2), transform/dev scale-to-zero (#3), higher Spot ratio (#5/#6), and log trim (#7) are applied, while preserving single-AZ-failure survivability (2+ AZ prod, stateful set on-demand-pinned).

| Line item | Current | Target | Lever(s) |
|---|---:|---:|---|
| EC2 compute (Karpenter + system) | ~370–490 | **~200–250** | #2 rightsize, #3 scale-to-zero, #5/#6 Spot+consolidation |
| EKS control plane | 73 | **73** | fixed |
| Aurora Serverless v2 | 50–95 | **~40–55** | #8 floor, bounded max |
| EBS gp3 | 48–51 | **~35–45** | shrinks with node count (#2/#3) |
| ALB + EIPs | ~37 | **~37** | fixed (shared ALB already optimal) |
| ECR endpoints | 14 | **~14** | keep (cheaper than NAT path) |
| ElastiCache Valkey | 12–14 | **~12–14** | already micro single-node |
| Secrets/KMS | 13–15 | **~13–15** | security floor, not a lever |
| CloudWatch/observability | 8–31 | **~6–12** | #7 log trim |
| fck-nat + S3 + snapshots + DynamoDB | ~6 | **~6** | already minimal |
| Cross-AZ transfer | ~0–194 | **~10–30** | #1 rack-aware (kept) + #9 PreferClose |
| **TOTAL** | **~520–580** | **≈ $340–400 / mo** | |

**Low-traffic steady-state target: ≈ $340–400/mo** — a realistic ~$150–200/mo (≈ 30–35%) reduction from today, achieved almost entirely on the EC2/compute lane, with **no loss of single-AZ-failure survivability**. A more aggressive single-AZ-prod posture could floor near ~$300/mo but is **not recommended** for a paid production account.

### 3b. Projected scaled budget (growth scenario)

As traffic grows (more collector/pixel volume, larger medallion, more concurrent Trino queries), the model scales predictably:

| Driver | Scaled behavior | Projected $/mo |
|---|---|---|
| EC2 compute | KEDA/HPA scale replicas up; Karpenter adds Spot nodes; baseline covered by Compute SP (#14) | **~450–700** |
| Aurora | max-ACU raised (e.g. 2→4–8 ACU) under OLTP load | **~90–200** |
| EBS + S3 (medallion growth) | Iceberg warehouse 10 GB → 100s GB; gp3 PVCs grow | **~80–150** |
| Cross-AZ + ALB LCU | more chatty traffic; rack-awareness + PreferClose keep it sub-linear | **~40–100** |
| Observability | more pods → more logs/metrics | **~30–60** |
| **TOTAL (scaled)** | with Savings Plan on baseline | **≈ $700–1,200 / mo** |

Key point: the architecture scales **elastically and cost-linearly** — Karpenter Spot + KEDA mean spend tracks demand, and a Compute Savings Plan on the stabilized floor (#14) shaves ~30% off the committed baseline as growth arrives.

---

## 4. FinOps Guardrails

### Budgets & alerts
- **Current:** AWS Budgets alert-only at **$500/mo** (per Brain memory). **Keep and layer it:**
  - Add **tiered thresholds** at 50% / 80% / 100% / 120% of a **$450/mo** target (below the current $500 to catch the target regression early).
  - Add a **forecasted-spend** budget alert (AWS Budgets forecast) so overruns are flagged mid-month, not after.
  - Route alerts to the existing `brain-ses-notifications` SNS topic (already wired to the account owner) — no new plumbing needed.

### Cost anomaly detection
- Enable **AWS Cost Anomaly Detection** with a monitor on the **EC2 + EKS** service dimension (the 65–75% of spend) and a **cross-AZ / data-transfer** custom monitor — the data-transfer line is the one that silently regrows if rack-awareness/PreferClose drift. Alert threshold ~$20 absolute or 15% relative. Free service; ties into SNS.

### Tagging & cost attribution
- **Enforce a tag taxonomy** and activate them as **cost allocation tags** in Billing: `env=prod`, `app=brain`, `component={eks|aurora|redis|kafka|trino|spark|collector|bff|web}`, and (Brain-critical) `brand_id`/tenant where attributable. The inventories show consistent `brain-prod-*` naming but **cost-allocation-tag activation** must be explicit in the Billing console.
- Add **Karpenter NodePool → component** tagging so per-workload compute cost is attributable (streaming vs trino vs ondemand pools are already distinct — surface them in Cost Explorer).
- Add an **SCP / tag-policy or `tflint`/CI check** to fail any Terraform apply that creates an untagged billable resource (extends the existing v4-naming-guard discipline to cost hygiene).

### Rightsizing & drift loop (the FinOps operating loop)
- Run **VPA in `Off` (recommendation) mode + KRR** as advisors; feed recommendations into Helm values via the release→master GitOps flow (never VPA auto-mode on Kafka/Trino/Spark/Redis — it restarts stateful pods).
- **Monthly FinOps review:** Cost Explorer by component tag → compare to the $340–400 target → action the top regression. Re-baseline before any Savings Plan commitment.
- **Guard the banked wins in CI/IaC:** the `eks_support_type=STANDARD` plan-guard already fails on extended-support drift — add equivalent guards/alerts for (a) accidental managed-NAT-gateway creation, (b) Aurora min-ACU drifting above floor, (c) Kafka rack-awareness config regression.

### Non-prod discipline (when non-prod exists)
- Single-AZ, KEDA/cron scale-to-zero overnight & weekends, Aurora min-ACU=0 + 5-min auto-pause. A non-prod environment left always-on is the most common silent cost leak — pre-empt it with scale-to-zero defaults.

---

## 5. Honest Assessment

The current design is **not carrying cost technical debt** — the structurally expensive mistakes (managed NAT per AZ, x86 nodes, all-on-demand, per-service clusters, EKS extended support, io2 volumes, an unnecessary CDN, over-provisioned Aurora) have all been **avoided or already fixed**. The inventories confirm a deliberately lean topology. The remaining ~$150–200/mo of savings is **operational tuning** (rightsizing + scale-to-zero + Spot ratio + log trim), not remediation. The single most important *defensive* action is to **keep the banked wins from regressing** — cross-AZ rack-awareness, fck-nat (no managed NAT), Graviton, EKS STANDARD support — which the FinOps guardrails above are designed to protect.

---

## Summary (10 lines)

1. **Current prod spend: ≈ $520–580/mo** — cross-checked against Brain's ~$450–580/mo memory figure; EC2 compute is 65–75% of the bill.
2. **Biggest line items:** Karpenter on-demand compute (~$180–294), system nodes (~$74), EKS control plane ($73), Karpenter Spot (~$120), Aurora ($50–95).
3. **Lever 1 — Cross-AZ / Kafka rack-awareness (APPLIED, PR #165):** protects ~$150–194/mo; keep it from regressing.
4. **Lever 2 — Rightsize requests/limits (NOT YET):** ~$60–120/mo, highest untapped lever (industry avg ~69% CPU overprovisioning).
5. **Lever 3 — KEDA scale-to-zero for batch/transform + dev (PARTIAL):** ~$40–90/mo on bursty/idle lanes.
6. **Lever 4 — Spot ratio + Karpenter consolidation tuning (PARTIAL):** 50–70% of the Spot-eligible fraction; raise Spot beyond 4/7 nodes with PDBs.
7. **Lever 5 — CloudWatch log retention/verbosity trim (NOT YET):** ~$5–20/mo, the only material observability lever.
8. **Already banked (do NOT re-recommend):** EKS 1.33/STANDARD (~$360/mo), Graviton, fck-nat vs managed NAT (~$30–90/mo), S3+ECR endpoints, Aurora 0.5-ACU floor.
9. **Achievable low-traffic steady-state: ≈ $340–400/mo** — a ~30–35% cut, entirely on the compute lane, with single-AZ-failure survivability preserved.
10. **Guardrails:** tiered + forecast AWS Budgets at ~$450, Cost Anomaly Detection on EC2/EKS + data-transfer, cost-allocation tags by component/brand, monthly rightsizing review, and CI/IaC guards to protect the banked wins.
