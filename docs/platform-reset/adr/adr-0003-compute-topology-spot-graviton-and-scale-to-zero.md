# ADR-0003 — Compute topology: Karpenter Spot + Graviton, KEDA scale-to-zero boundaries, and Aurora ACU sizing

**Status:** Proposed
**Date:** 2026-07-14
**Deciders:** Engineering Program Lead, FinOps (owner sign-off required)
**Relates to:** ADR-0001, `06-redesign-proposal.md` §2.2–§2.5/§3, `07-cost-optimization.md` §2/§3, `inventory/research-infra-cost.md` §2–§9

## Context

Compute is ~65–75% of the ~$520–580/mo bill. The estate already runs one EKS 1.33/AL2023 cluster,
a small on-demand system node group, four Karpenter Spot/Graviton pools (app / streaming / trino /
ondemand), KEDA, and Aurora Serverless v2 floored at 0.5 ACU. The banked structural wins (EKS
STANDARD support ~$360/mo, Graviton, fck-nat vs managed NAT, S3-gateway + ECR endpoints) must be
**protected from regression**, not re-recommended.

Research (`research-infra-cost` §2–§9) surfaces the untapped levers as *operational tuning*:
rightsizing requests (industry avg ~69% CPU overprovisioning), extending KEDA scale-to-zero to
idle/batch lanes, raising the Spot ratio with PDBs, and Karpenter consolidation/disruption-budget
tuning — with specific small-cluster edge cases (percentage disruption budgets round to "anytime"
on ≤4-node pools; spot-to-spot consolidation needs ≥15 cheaper options and silently won't fire if
instance families are over-constrained).

The hard question this ADR settles is the **scale-to-zero boundary**: which workloads may go to
zero (bounded cold-start acceptable) vs which must hold a minimum footprint (quorum members,
single-writers, coordinators, the synchronous request/ingest path).

## Decision

**Keep the topology; tune it. Codify an explicit scale-to-zero boundary and an Aurora sizing rule.**

**Topology (unchanged):** one prod EKS cluster, private-only API; a small on-demand system node
group (hosts Karpenter itself — cannot scale to zero); four Karpenter Spot/Graviton pools with
`arch: [arm64]` preferred and amd64 fallback. Consolidate active workloads to **2 AZs** (survive one
AZ loss) while leaving the third-AZ subnets provisioned-empty for a future flip.

**Karpenter tuning (config-only):** `consolidationPolicy: WhenEmptyOrUnderutilized`,
`consolidateAfter: 5m`, **integer** disruption budgets (never `%` on small pools), a business-hours
freeze on the app pool, `Balanced` scoring, and **do not over-constrain instance families** (keep
spot-to-spot consolidation firing). Target ~80% Spot on the Spot-eligible fraction, every critical
Deployment PDB-guarded.

**Scale-to-zero boundary (the load-bearing table):**

| Workload | Posture | Why |
|---|---|---|
| Transform tier (Silver→Gold, maintenance/RTBF) | **Scale to ZERO** | Schedule-driven, replay-safe — biggest win |
| Trino **batch/FTE** cluster | **Scale to ZERO** | FTE retries tasks not queries; only runs during maintenance |
| Non-prod / dev namespaces + non-prod Aurora | **Scale to ZERO** (cron / min-ACU=0 auto-pause) | Idle overnight/weekends |
| stream-worker, Trino **serving** workers | **Warm FLOOR (≥1), never zero** | Latency-sensitive; cold-start breaches serving SLO |
| collector / core / web | **Minimum ≥2 replicas** | Request-path availability + PDB |
| Aurora **prod** (ops + iceberg_catalog) | **Floored min 0.5 ACU, bounded max** | ~15s resume cold-start unacceptable on OLTP/catalog path |
| Kafka brokers (3, quorum) | **Minimum ON-DEMAND** | Stateful quorum; 3× Spot quorum loss documented — never zero, never Spot |
| Trino **coordinator**, Neo4j identity SoR | **Warm ON-DEMAND (1)** | Single gate / single writer; must stay up |
| kafka-connect Bronze sink | **Minimum 2 replicas** | Removes the Bronze-landing freshness SPOF |
| System node pool | **Minimum on-demand (min 2)** | Hosts Karpenter itself |

**Rule of thumb:** scale-to-zero anything **schedule-driven, replay-safe, and off the synchronous
request path**; keep a minimum footprint for **quorum members, single-writers, coordinators, and the
serving/ingest hot path.** Honor Brain's "no event loss" rule — consumer-lag thresholds must never
let a scale-down drop in-flight work.

**Aurora sizing:** prod stays **floored at min 0.5 ACU** (no scale-to-zero in prod) with a bounded
max; a **second `db.serverless` reader** is added at T1 (ADR-0009 trigger) to remove the sole-writer
restart window on the revenue-path DB. Any future **non-prod** Aurora uses **min-ACU=0 + 5-min
auto-pause** (~$44/mo per idle DB banked). The `iceberg_catalog` DB (ADR-0002) co-locates on this
cluster and inherits its 35-day PITR.

## Alternatives Considered

- **Aurora auto-pause (min-ACU=0) in prod.** Rejected: the ~15s resume cold-start is unacceptable
  for the OLTP `ops` schema and Iceberg-catalog reads on the request path. Non-prod only.
- **Always-warm batch pool / HPA-only.** Rejected: pure idle waste; HPA cannot reach zero. KEDA
  scale-to-zero on batch is the biggest untapped compute lever.
- **Cluster Autoscaler + managed node groups for the app tier.** Rejected: worse bin-packing, no
  price-capacity-optimized Spot; Karpenter is the 2026 standard.
- **Re-Spot the Kafka brokers / add managed NAT for HA.** Rejected: 3× documented Spot quorum loss;
  managed NAT re-introduces ~$60–95/mo the fck-nat decision (ADR-0009) already eliminated.
- **3-AZ prod now.** Deferred to T2: 2-AZ survives one AZ loss and halves the cross-AZ probability;
  it is a reversible flag (subnets stay provisioned).

## Consequences

- **Positive:** ~$150–200/mo (≈30–35%) reduction toward a ~$340–400/mo low-traffic steady state,
  entirely on the compute lane, **with single-AZ-failure survivability preserved**.
- **Positive:** batch/idle windows drop to zero compute; the second Aurora reader removes a
  revenue-path restart window at bounded pay-per-use cost.
- **Negative / accepted:** cold-start latency on the first request after a batch idle window
  (acceptable — schedule-driven only); one Aurora writer remains (storage is multi-AZ auto-healing —
  a restart-window, not a data-loss, concern).
- **Guardrail dependency:** the banked wins (STANDARD support, no managed NAT, Aurora min-ACU floor,
  rack-awareness) must be protected by CI/IaC plan-guards (see engineering standards `09`).

## Rollback

Every lever is a config/manifest value under GitOps: revert the PR to restore prior requests/limits,
disruption budgets, ScaledObject floors, or Spot ratio; ArgoCD self-heals. The Aurora reader is a
single TF resource — remove it to revert. The 2-AZ consolidation is reversible by re-scheduling
workloads onto the provisioned-empty third-AZ subnets (`enable`-flag). No destructive step.
