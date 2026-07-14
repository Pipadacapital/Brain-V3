# 06 — Infrastructure Redesign Proposal (Target Architecture)

**Author:** Chief Platform Architect
**Account:** 380254378136 (PAID PRODUCTION) · **Region:** ap-south-1 (Mumbai) · **Domain:** brain.pipadacapital.com
**Inputs:** `04-architecture-review.md` (Well-Architected review), `inventory/research-infra-cost.md`,
`inventory/research-data-platform.md`, and the six `inventory/*.md` domain inventories.
**Method:** evidence-based, grounded in the live inventory (2026-07-14). Every "delta from current"
is measured against a resource that actually exists in the account, not a strawman.

---

## 0. Executive premise — I challenge "destroy-and-rebuild"

The mandate framed this as a "platform reset." **The evidence does not support a full teardown.**

The Well-Architected review's own verdict is *"a genuinely well-engineered, cost-conscious platform"*
with strong Cost/Performance/Security-fundamentals pillars and material gaps concentrated in **two**
places only: **Reliability** (defensible-but-concentrated SPOFs) and **Operational Excellence**
(alerting pages no one; no account detective baseline). The cost inventories reconcile to
**~$517/mo** with the review concluding *"config-level cost levers are essentially exhausted."*
The data-platform research maps Brain onto 2026 best practice and finds the stack choices
(Strimzi/KRaft, Iceberg-REST, Trino-over-Iceberg, DuckDB-for-medium-data, Valkey, ArgoCD app-of-apps)
are the *recommended* choices, not legacy debt.

**When a design is ~80% right, a full rebuild destroys the 80% to fix the 20% — and re-introduces
every already-solved incident** (the SQLite catalog lock, Trino OOM, Spark OOM, Kafka Spot quorum
loss, LocalStack secret durability). Those fixes are institutional knowledge encoded in the current
IaC. Teardown throws them away and pays to re-learn them.

**Recommendation: SELECTIVE REBUILD, not full teardown.** Concretely:

- **KEEP (do not touch):** VPC/subnet fabric, KMS CMK hierarchy, IRSA model, S3 medallion + lifecycle,
  Aurora Serverless v2, Valkey, ArgoCD GitOps + release→master promotion, Karpenter Spot pools,
  fck-nat, S3-gateway + ECR-interface endpoints, the private-only EKS API, ACM/Route53/external-dns.
  These are already the target-state answer.
- **HARDEN IN PLACE (config/manifest deltas, no rebuild):** wire actionable alerting, add CloudTrail +
  GuardDuty, split Trino serving/batch, complete Spark→DuckDB cutover, migrate Iceberg catalog SQLite→PG,
  spread Kafka across AZs, add KEDA scale-to-zero to batch, add a second Aurora reader at T1.
- **REBUILD ONLY (net-new, additive, reversible):** the two components that are genuinely single-writer
  liabilities on paths that matter — the **Iceberg REST catalog backend** (SQLite → Aurora PG) and the
  **Trino topology** (one cluster → interactive + batch-FTE). Both are additive migrations with the old
  path as rollback, not teardowns.

The rest of this document is the target architecture and the phased path to reach it **without ever
running `terraform destroy` on the account.**

---

## 1. Target architecture overview

### 1.1 ASCII diagram

```
                                  Internet (users, Shopify/Meta/Google/Shiprocket/GoKwik webhooks)
                                                     │
                              ┌──────────────────────┼───────────────────────┐
                              │ Route53  brain.pipadacapital.com (ext-dns)     │
                              │ ACM (regional, ap-south-1)                     │
                              └──────────────────────┼───────────────────────┘
                                                     ▼
                                     ╔═══════════════════════════════╗
                                     ║  ONE shared ALB (ip-target)   ║  internet-facing, HTTPS:443
                                     ║  AWS Load Balancer Controller ║  → pod IP (zero cross-AZ hop)
                                     ╚═══════════════╤═══════════════╝
   VPC 10.0.0.0/16 (ap-south-1) — KEEP AS-IS        │
 ┌───────────────────────────────────────────────── │ ─────────────────────────────────────────────┐
 │  Public subnets  1a /  1b   (ALB ENIs, fck-nat)   │                                               │
 │  Private subnets 1a / 1b [+1c retire→2-AZ]        ▼                                               │
 │                                                                                                   │
 │   ┌──────────────────────────── EKS brain-prod (v1.33 / AL2023 / private API) ─────────────────┐  │
 │   │                                                                                             │  │
 │   │  SYSTEM POOL (managed NG, on-demand t4g.medium, min2)  — Karpenter/ALB-ctrl/CoreDNS/CSI     │  │
 │   │                                                                                             │  │
 │   │  KARPENTER Spot/Graviton pools (consolidation, price-capacity-optimized, integer budgets)   │  │
 │   │  ┌── app (Spot) ──┐  ┌── streaming (mixed) ──┐  ┌── trino (Spot) ──┐  ┌── ondemand ──┐       │  │
 │   │  │ collector  x2  │  │ Kafka broker  x3 (OD) │  │ trino-svc workers│  │ trino-coord  │       │  │
 │   │  │ core (BFF) x2  │  │  ↳ AZ-spread topology │  │  (KEDA→interactive│  │ (warm, OD)   │       │  │
 │   │  │ web        x3  │  │ kafka-connect x2 (HA) │  │   QUERY retry)    │  │ Neo4j (OD)   │       │  │
 │   │  │ stream-wkr KEDA│  │ (KEDA kafka-lag)      │  │ trino-batch KEDA→0│  │ pgbouncer x2 │       │  │
 │   │  └───────┬────────┘  └──────────┬────────────┘  │  (TASK retry+FTE) │  └──────┬───────┘       │  │
 │   │          │                      │               └─────────┬─────────┘         │               │  │
 │   │  ┌───────┴──── platform services ─────────────────────────┴─────────────────┐ │               │  │
 │   │  │ iceberg-rest x2 │ KEDA │ ArgoCD │ ESO │ cert-mgr │ ext-dns │ Prometheus/Grafana/OTel │      │  │
 │   │  └───────┬─────────┴──────┴────────┴─────┴──────────┴─────────┴──────────────────────────┘   │  │
 │   └──────────┼──────────────────────────────────────────────────────────────────────────────────┘  │
 │              │ IRSA (no static keys)                                                                │
 │   ┌──────────┴─────────────┐   ┌──────────────────────┐   ┌───────────────────────────────────┐    │
 │   │ Aurora Serverless v2   │   │ ElastiCache Valkey    │   │ fck-nat (t4g.nano) → Internet     │    │
 │   │ PostgreSQL 16          │   │ (serving cache,       │   │  egress: connectors/OAuth/LLM     │    │
 │   │  • ops schema (OLTP)   │   │  single node, cache)  │   │ S3 GW endpoint (free) + ECR IF    │    │
 │   │  • iceberg_catalog DB  │   │                       │   │  endpoints keep pulls off NAT     │    │
 │   │  floor 0.5 ACU + reader│   └──────────────────────┘   └───────────────────────────────────┘    │
 │   └────────────────────────┘                                                                        │
 └─────────────────────────────────────────────────────────────────────────────────────────────────┘
                              │ IRSA                          │ IRSA                    │ IRSA
                              ▼                               ▼                         ▼
   ┌──────────────────────────────────┐   ┌────────────────────────────┐   ┌───────────────────────┐
   │ S3 brain-bronze-* (Iceberg SoR)  │   │ S3 brain-audit-* (WORM 7yr)│   │ S3 brain-metrics/tfstate│
   │  brain_{bronze,silver,gold,      │   │  ← CloudTrail feeds here   │   │  Thanos blocks / TF state│
   │  serving}/ · INT-tiering · CRR→  │   └────────────────────────────┘   └───────────────────────┘
   │  ap-south-2 (DR, gated on)       │   Detective baseline: CloudTrail + GuardDuty + Config (NEW)
   └──────────────────────────────────┘
```

### 1.2 One-paragraph description

A single private-API EKS 1.33/AL2023/Graviton cluster in one VPC runs the whole platform. A tiny
on-demand **system pool** hosts cluster-critical controllers; everything else is **Karpenter
Spot/Graviton** across four intent-named pools (app, streaming, trino, ondemand). Stateless app tier
(collector/core/web) and elastic workers (stream-worker, Trino serving workers) autoscale on
HPA/KEDA; **truly-bursty batch (transform + Trino-batch + maintenance) scales to zero via KEDA**
between runs; **stateful singletons and quorum members** (Kafka brokers, Trino coordinator, Neo4j,
kafka-connect) are pinned on-demand and PDB-guarded. Operational state is **Aurora Serverless v2**
(the `ops` OLTP schema **and** the Iceberg REST-catalog DB) with a floored min-ACU and a T1 reader.
The lakehouse is **Iceberg on S3** (append-only Bronze = system of record) served **exclusively by
Trino**, now **split into an always-warm interactive cluster and a scale-to-zero FTE batch cluster**,
fronted by a **Valkey** analytics cache. Kafka/**Strimzi (KRaft)** with rack-awareness lands Bronze
via a **2-replica** Kafka-Connect sink. Egress is one **fck-nat** t4g.nano; AWS-service traffic rides
the free **S3 gateway** + **ECR interface** endpoints. GitOps is **ArgoCD app-of-apps** with
release→master promotion; secrets via **ESO + KMS**; observability via **Prometheus/Grafana/OTel**;
and — the biggest net-new — an **account detective baseline (CloudTrail + GuardDuty)** and **actionable
SNS→email+chat alerting** wired to the alarms that today page no one.

---

## 2. Component-by-component recommendations

For each: **Recommendation · Rationale · Alternatives considered · Trade-offs · Delta from current.**

### 2.1 Network / VPC

- **Recommendation:** Keep the existing `vpc-06ded56ae87bd2b68` (10.0.0.0/16), IGW, S3-gateway + ECR
  interface endpoints, and fck-nat. **Consolidate active workloads to 2 AZs (1a/1b)** while leaving the
  1c subnets provisioned (empty) for a future third-AZ flip. Add **`trafficDistribution: PreferClose`**
  (GA in 1.33) on internal Services and keep the ALB in **`ip` target mode** (already so).
- **Rationale:** The cross-AZ tax is Brain's historically-largest network line (~$194/mo, ~638 GB/day);
  research §7 shows 2-AZ + rack-awareness + PreferClose + ip-mode is the correct early-stage posture.
  The VPC/endpoint layout is already exactly what the cost research prescribes ("keep S3 gateway, add
  interface endpoints for hot AWS services, no managed NAT").
- **Alternatives:** (a) managed NAT gateway HA — rejected, ~$98/mo+data vs $3 for fck-nat, research §8
  says explicitly do NOT introduce one; (b) stay 3-AZ — rejected for cost, kept only as a documented
  T2 upgrade; (c) full second VPC for DR — deferred to CRR (§5 DR), not a hot standby.
- **Trade-offs:** 2-AZ survives one AZ loss but has less spread than 3-AZ; fck-nat remains a single
  egress SPOF (see 2.9). Both are ADR-0009-documented, reversible-by-a-flag decisions.
- **Delta from current:** *Minor.* Retire the 1c workload placement (keep subnets); add `PreferClose`.
  Everything else is **kept as-is** — the network fabric is already target-state.

### 2.2 EKS control plane + system nodes

- **Recommendation:** Keep one `brain-prod` cluster, v1.33/AL2023, **private-only API via SSM tunnel**.
  Keep the small on-demand **system managed node group** (t4g.medium, min2). Enable **`api`+`audit`**
  control-plane log export but trim retention to 14–30d to cap CloudWatch ingest.
- **Rationale:** Review + cost inventory confirm the EKS 1.33/AL2023/STANDARD move already banked the
  ~$360/mo extended-support fee — **do not re-recommend that upgrade.** One cluster is correct (research
  §1: don't split per-service). The system pool must stay on-demand because it hosts Karpenter itself.
- **Alternatives:** (a) Fargate for system pods — rejected, no Fargate-Spot for EKS pods (research §3),
  and Karpenter can't run on Fargate; (b) second cluster for prod/DR — rejected as premature cost.
- **Trade-offs:** private-only API means all ops go through the SSM tunnel (accepted; it eliminates the
  ISP-IP-lockout class). Single cluster = cluster-scoped blast radius, mitigated by namespaces + NetworkPolicies.
- **Delta from current:** *Essentially none* beyond log-retention trim. This is already the target.

### 2.3 Karpenter (Spot + Graviton)

- **Recommendation:** Keep the four Spot/Graviton pools. **Tune the six 2026 knobs** from research §2:
  `consolidationPolicy: WhenEmptyOrUnderutilized`, `consolidateAfter: 5m`, **integer** disruption
  budgets (not `10%` — rounds to "anytime" on a ≤4-node pool), a business-hours freeze on the app pool,
  `Balanced` scoring, and **do not over-constrain instance families** (or spot-to-spot consolidation
  silently won't fire — needs ≥15 cheaper options). Keep `arch: [arm64]` preferred with amd64 fallback.
- **Rationale:** Karpenter consolidation yields 30–50% vs static; Graviton ~20% off; the two stack
  multiplicatively. The pools already exist; the win is in the disruption-budget/consolidation tuning
  that the small-cluster edge cases (research §2) call out.
- **Alternatives:** Cluster Autoscaler + managed node groups — rejected, worse bin-packing and no
  price-capacity-optimized Spot; Karpenter is the 2026 standard.
- **Trade-offs:** Spot interruptions are real; mitigated by the existing 4-rule EventBridge→SQS
  interruption queue + PDBs + on-demand pins on stateful members.
- **Delta from current:** *Config-only.* Verify/tune the six knobs and set **integer disruption budgets**
  — the one concrete gap on a small node count. No rebuild.

### 2.4 Scale-to-zero via KEDA

- **Recommendation:** KEDA stays. **Extend scale-to-zero to the genuinely-idle batch lanes:** the
  transform tier (Silver→Gold refresh, maintenance/RTBF) and the **Trino batch cluster** (2.7) → scale
  to **zero** between runs, waking on Argo cron / queue depth. Keep **Kafka-lag scalers** on stream-worker
  and Trino-serving workers with a **non-zero warm floor** (latency-sensitive). Cron-scale any non-prod
  namespaces to zero overnight.
- **Rationale:** Research §5 — event-driven autoscaling is 25–40% on idle-heavy fleets, near-100% on
  truly-idle batch windows; Brain's transform is bursty, not continuous, so this is its biggest
  scale-to-zero win. Pairs with Karpenter to deprovision the emptied node.
- **Alternatives:** always-warm batch pool — rejected as pure idle waste; HPA-only — can't scale to zero.
- **Trade-offs:** cold-start latency on first request after idle. **Safe for batch** (schedule-driven);
  **NOT for the serving/consumer path** — keep warm floors there. Honor Brain's "no event loss" rule:
  set consumer-lag thresholds so scale-down never drops in-flight work.
- **Delta from current:** *Additive.* KEDA already scales stream-worker + Trino workers; add scale-to-zero
  ScaledObjects/cron for transform + Trino-batch + non-prod. No rebuild.

### 2.5 Aurora Serverless v2 (PostgreSQL)

- **Recommendation:** Keep the single Aurora Serverless v2 cluster carrying **both** the `ops` OLTP
  schema **and** the `iceberg_catalog` DB. Keep **floored min-ACU (0.5)** — no scale-to-zero in prod.
  **Add a second `db.serverless` reader at T1** (ADR-0009 trigger). For any future non-prod cluster, use
  **min-ACU=0 + auto-pause** to bank the ~$44/mo idle savings.
- **Rationale:** Cost research §9 — prod on the request path must keep a floor (the ~15s resume cold-start
  is unacceptable for OLTP SLOs); non-prod is where scale-to-zero pays. The second reader removes the
  sole-writer restart window on a revenue-path DB (review REL-1) at bounded pay-per-use cost. Co-locating
  the Iceberg catalog DB here (see 2.6) gives it Aurora's 35-day PITR for free.
- **Alternatives:** provisioned RDS — rejected, loses ACU auto-scaling for a bursty OLTP profile;
  DynamoDB for ops — rejected, relational `ops` schema + catalog need SQL/transactions.
- **Trade-offs:** the second reader adds idle ACU cost (bounded, pay-per-use); still one writer (Aurora
  storage is multi-AZ auto-healing, so this is a restart-window, not a data-loss, concern).
- **Delta from current:** *Small.* Add reader at T1; **new: point the Iceberg REST catalog at this
  Aurora** (2.6). Keep everything else. **This is not a rebuild.**

### 2.6 Trino / Iceberg / DuckDB / catalog

- **Recommendation (catalog — REBUILD, additive):** Move the **Iceberg REST catalog backend off SQLite
  onto Aurora PostgreSQL** (`iceberg_catalog` DB). This is the single highest-leverage data-platform move
  (research §2 highest-priority) — it kills the SQLite-lock incident class entirely, unblocks concurrency,
  and makes catalog DR trivial (Aurora PITR).
- **Recommendation (Trino — REBUILD topology, additive):** **Split Trino into two clusters** —
  an always-warm **interactive** cluster (`QUERY` retry) behind the Valkey cache for `mv_*` serving reads,
  and a **batch** cluster with **Fault-Tolerant Execution** (`TASK` retry, FTE exchange on S3, multiple
  buckets) for compaction/RTBF/maintenance. Keep bounded JVM heap + restart-on-OOM. KEDA scales the batch
  cluster to zero; the interactive cluster keeps a warm floor. Keep the `${BRAND_PREDICATE}` seam.
- **Recommendation (transform — FINISH cutover):** Complete the **Spark→DuckDB** operational cutover
  (image swap + cronworkflow swap + batch-pool removal + dev:up e2e) with single-writer serialization
  per Iceberg table, 1–4 GB RAM/thread, spill temp-dir on fast disk. **Keep `db/iceberg/spark` as the
  rollback path until e2e green.** Any mart nearing ~1B rows/distributed shuffle stays on Spark (hybrid).
- **Recommendation (Iceberg maintenance):** Wire **health-driven** compaction (`brand_id`-sort + z-order),
  expire-snapshots, remove-orphans as Argo Workflows (not fixed schedules).
- **Rationale:** All four are the exact 2026 best-practice mappings in research §2–§4, and each directly
  retires a documented Brain incident (SQLite lock, Trino serving-OOM, Spark-OOM).
- **Alternatives:** Nessie/Polaris-on-their-own-DB — viable, but Aurora-PG-backed REST catalog reuses
  existing prod PG + PITR (less new surface); S3 Tables (auto-maintenance) — rejected, would move the
  catalog off Brain's self-hosted REST-catalog control and add per-table cost; keeping Spark — rejected,
  it's the OOM root-cause and the DuckDB port is already parity-proven (PR #148).
- **Trade-offs:** two Trino clusters add a small always-warm interactive footprint (bounded); DuckDB's
  single-node ceiling means the hybrid escape hatch must stay.
- **Delta from current:** *This is the core of the "rebuild."* SQLite→PG catalog and Trino topology split
  are net-new but **additive with rollback** — the old single-Trino and SQLite paths remain until cutover
  is green. Not a teardown.

### 2.7 Kafka / Strimzi

- **Recommendation:** Keep Strimzi on EKS (not MSK), **KRaft mode**, rack-awareness. **Spread the 3
  brokers across AZs** via `topology.kubernetes.io/zone` (not just `hostname`) so an AZ loss can't take 2
  of 3 and break quorum. Keep brokers **on-demand pinned** (documented 3× Spot quorum loss — do NOT
  re-Spot). Move to **dedicated controller + broker KafkaNodePools** and adopt **tiered storage** (Kafka
  ≥3.9) to shrink EBS and speed broker recovery. Run **Kafka-Connect at 2 replicas** (remove the
  Bronze-landing SPOF) with a task-death alert.
- **Rationale:** Research §1 — KRaft-only, dedicated node pools, tiered storage are the 2026 standard;
  review REL-4/REL-6 flag the single Connect replica and hostname-only anti-affinity as the two concrete
  Kafka gaps. Rack-awareness is Brain's #1 cost lever and must be preserved.
- **Alternatives:** MSK — rejected, more expensive and less control than Strimzi-on-EKS which Brain
  already operates; re-Spot brokers — rejected, 3× documented quorum loss.
- **Trade-offs:** 2 Connect replicas add a small footprint but remove a freshness SPOF; tiered storage
  adds S3 read latency on cold segments (acceptable — Bronze retention is short by design).
- **Delta from current:** *Config/CR.* Add zone topology, dedicated node pools, tiered storage, and a
  2nd Connect replica. Keep the on-demand pin, rack-awareness, and PVC/ALB drift guards. No rebuild.

### 2.8 Redis / Valkey

- **Recommendation:** Keep **ElastiCache Valkey** (already migrated from Redis 7.1) as the single-node
  serving cache. Keep the SETNX stampede-lock + TTL tiers in the app layer (guards Trino from cold-cache
  cascades). Only add a replica/Multi-AZ if a cold-cache event is shown to OOM the serving Trino.
- **Rationale:** Research §5 — Valkey is the 2026 default (lower memory, permissive license,
  managed-default alignment); it's a *cache*, not a system of record, so single-node is defensible
  (review REL-5). Brain already did the drop-in migration.
- **Alternatives:** self-hosted Redis on EKS — rejected, ElastiCache Valkey is managed and cheap
  (~$12–14/mo); Multi-AZ now — deferred until evidence of cold-cache→Trino-OOM cascade.
- **Trade-offs:** node loss = cold cache + Trino load surge (not data loss); mitigated by the stampede lock.
- **Delta from current:** *None* — already target-state. Delete the lingering `brain-prod-redis-pre-valkey`
  manual snapshot (hygiene, per databases inventory §2.4).

### 2.9 Neo4j (identity SoR) + egress (fck-nat)

- **Recommendation (Neo4j):** Keep single-node Neo4j Community, **on-demand pinned**, ClusterIP-only, with
  the DLM EBS snapshot chain **plus** actually writing nightly dumps to the (currently empty)
  `brain-neo4j-backups` S3 bucket. **Rehearse the "rebuild from Silver + PG audit" recovery** (review
  REL-3 flags it as asserted-but-unrehearsed). Defer Enterprise/Neptune to T2 behind an identity-lag SLO.
- **Recommendation (egress):** Keep the single fck-nat t4g.nano. Keep auto-recover/reboot alarms. Flip to
  per-AZ managed NAT **only** when egress becomes revenue-critical (ADR-0009 trigger, one-flag reversible).
- **Rationale:** Both are cost-justified, ADR-documented SPOFs with written recovery stories; the review
  explicitly says the priority is to make their failure *loud and paged* and *rehearse* recovery — not to
  eliminate them at T0.
- **Alternatives (Neo4j):** Enterprise (clustering) — deferred cost; Neptune — deferred, larger migration.
- **Trade-offs:** Neo4j pod/node loss = identity write-outage window; fck-nat AZ loss = egress stall.
  Accepted at T0/T1, made loud via alerting (2.11).
- **Delta from current:** *Small but important.* Start writing S3 dumps (bucket exists, empty); rehearse
  recovery. Keep the topology.

### 2.10 Ingress / DNS / Secrets

- **Recommendation:** Keep the **single shared ALB** (ip-target), **Route53 + external-dns** (scoped to
  the Brain zone), **ACM** regional cert. Keep **External Secrets Operator + KMS CMK hierarchy** (root /
  connector / audit / tfstate). **Add scheduled rotation** for JWT/cookie/connector app-secrets (Aurora
  master already rotates); give the **audit CMK its own non-blanket key policy** (review SEC-4). Delete the
  orphaned `px` ACM cert and the `brain-prod-otel-collector-secrets` orphan policy (hygiene).
- **Rationale:** Ingress/DNS/secrets fundamentals are already strong (review "already good"); the only
  gaps are secret *rotation* (SEC-2) and audit-key isolation (SEC-4).
- **Alternatives:** per-service ALBs — rejected, the shared ALB is cheaper and sufficient; SOPS/sealed-
  secrets — rejected, ESO+Secrets Manager is already wired and is the research §6 recommendation.
- **Trade-offs:** shared ALB is a single ingress; acceptable, it's managed/HA across AZs.
- **Delta from current:** *Config.* Add rotation schedules + audit-key policy; hygiene deletes. No rebuild.

### 2.11 Observability + GitOps

- **Recommendation (observability):** Keep Prometheus/Grafana + Thanos→S3. Standardize app/BFF on **OTel**
  (metrics collector as single-replica Deployment, logs as DaemonSet, `k8sattributes` processor). **Never
  emit `brain_id` as a raw metric label** (cardinality + tenant-isolation trap, research §7). Surface
  Iceberg-snapshot-age, medallion-refresh-lag, cache-staleness as first-class gauges.
- **Recommendation (alerting — the biggest OE gap):** Wire **one SNS topic → email + chat webhook** into
  the *existing* Aurora-ACU, NAT-status, Redis, and a **composite EKS-unhealthy** alarm. Promote the inline
  "graduation trigger" comments (identity-lag, ACU 80%, Trino OOM) into **paging** Prometheus SLO rules.
- **Recommendation (detective baseline — biggest SEC gap):** Add **CloudTrail** (→ the existing WORM audit
  bucket) + **GuardDuty** (ap-south-1); Config/SecurityHub follow. Single-digit $/mo.
- **Recommendation (GitOps):** Keep **ArgoCD app-of-apps** + release→master owner-gated promotion +
  prune/selfHeal/ServerSideApply. Extend Argo Workflows to host **Iceberg maintenance + DR-backup** jobs,
  env-scoped via overlays so staging exercises them first. Consider **Argo Rollouts** (canary) for
  BFF/web given the serving-fragility history.
- **Rationale:** Review's two weakest pillars are OE (nothing pages) and the missing detective baseline;
  these are the highest-ROI, lowest-cost fixes in the whole program. GitOps is already best-practice.
- **Alternatives:** Grafana-Cloud-managed alerting fully replacing `module.observability` — acceptable if
  ADR-documented and it actually pages; today the intended composite alarm is **dead code in prod** (OE-2).
- **Trade-offs:** more alarms = some noise; tune thresholds from the inline evidence already written.
- **Delta from current:** *Additive, high-value.* Wire SNS + CloudTrail + GuardDuty (net-new); wire or
  ADR-retire `module.observability`; fold in OTel. **These are the changes that most move the needle.**

---

## 3. Scale-to-zero safe vs minimum-footprint required

| Component | Posture | Why |
|---|---|---|
| Transform tier (Silver→Gold, maintenance/RTBF) | **Scale to ZERO** | Schedule-driven, bursty, replay-safe — biggest win (research §5) |
| Trino **batch/FTE** cluster | **Scale to ZERO** | FTE makes worker loss retry tasks, not queries; only runs during maintenance |
| Non-prod / dev namespaces + non-prod Aurora | **Scale to ZERO** (cron / min-ACU=0 auto-pause) | Idle overnight/weekends; ~$44/mo per idle DB |
| stream-worker, Trino **serving** workers | **Warm FLOOR (≥1), never zero** | Latency-sensitive; cold-start would breach serving SLO |
| collector / core / web | **Minimum ≥2 replicas** | Request-path availability + PDB; Spot-friendly above floor |
| Aurora **prod** (ops + catalog) | **Floored min 0.5 ACU** | ~15s resume cold-start unacceptable for OLTP/catalog reads |
| Kafka brokers (3, quorum) | **Minimum ON-DEMAND footprint** | Stateful quorum; 3× Spot quorum loss documented — never zero, never Spot |
| Trino **coordinator** | **Warm ON-DEMAND (1)** | Single coordinator gates all serving; must stay up |
| Neo4j identity SoR | **Minimum ON-DEMAND (1)** | Community can't cluster; single writer, replay-rebuildable but not zero |
| kafka-connect Bronze sink | **Minimum (2 replicas)** | Bronze-landing freshness SPOF removed by 2nd replica |
| ElastiCache Valkey | **Minimum (1 node)** | Managed cache; single node acceptable (not SoR) |
| System node pool | **Minimum on-demand (min 2)** | Hosts Karpenter itself — cannot scale to zero |

**Rule of thumb:** scale-to-zero anything **schedule-driven, replay-safe, and off the synchronous request
path**; keep a **minimum footprint** for **quorum members, single-writers, coordinators, and the
serving/ingest hot path.**

---

## 4. DR / backup strategy

Tier by RTO/RPO (research §8). Brain's system of record spans **three** stores that must be recoverable
**consistently**: Iceberg-on-S3, the REST-catalog DB, and Aurora `ops`.

| Layer | Backup mechanism | RPO / RTO tier | Notes |
|---|---|---|---|
| **Bronze (Iceberg SoR)** | S3 **CRR → ap-south-2** (gated flag, enable post-residency sign-off, ADR-0011) | Standard (24h) → tighten later | Append-only; the true RPO-critical set |
| **Silver/Gold marts** | **Rebuild from Bronze** via refresh loop (do NOT replicate) | Derived — cheaper to recompute | Iceberg snapshot-expiry ≥ RPO window for time-travel recovery |
| **Iceberg catalog** | **Aurora PITR** (once catalog moves to PG, 2.6) — 35-day | With ops PG | A data snapshot without a consistent catalog snapshot is unrecoverable |
| **Aurora `ops`** | Automated backups + **35-day PITR**; snapshot copy to ap-south-2 | Important (<1h) | Already 35-day + deletion-protection |
| **Neo4j identity SoR** | DLM EBS snapshots (7-day) **+ nightly S3 dump** (start writing to the empty bucket) | Important | Only irreplaceable EKS-PVC dataset; rehearse rebuild-from-Silver |
| **Kafka** | Replayable transport (3-broker replication) + **tiered storage on S3** | Standard | No separate backup by design (defensible) |
| **Prometheus** | Thanos → S3 blocks; local TSDB disposable | Standard | Metrics are disposable |
| **Audit** | S3 **Object Lock COMPLIANCE, 7yr** (immutable) | Compliance | CloudTrail feeds this (new) |
| **Terraform state** | S3 versioned + dedicated CMK + DynamoDB lock | Critical | Never delete while IaC is authoritative |

**Operational discipline:** run backups **and a quarterly restore drill** (rebuild Silver/Gold from
restored Bronze+catalog; restore Neo4j from S3 dump) as **Argo Workflows** — *untested backups are not a
recovery plan* (research §8). Start at **standard/backup-and-restore**, not active-active, matching the
cost posture; graduate DR tiers as paying traffic arrives.

---

## 5. Phased migration / build path (Terraform + Helm + ArgoCD + GitHub Actions only)

Every phase is deployable purely through the existing IaC pipeline (feature → PR → `release` → owner-gated
`release`→`master` promotion → `deploy.yml` + ArgoCD). **No `terraform destroy`.** Each phase is
independently revertible by `git revert`.

**Phase 0 — Guardrails first (Terraform + a little Helm) · lowest risk, highest ROI**
- TF: one **SNS topic** (email + chat) wired into existing Aurora-ACU / NAT / Redis alarms + a composite
  EKS-unhealthy alarm (fixes OE-1/OE-2). TF: **CloudTrail → WORM audit bucket** + **GuardDuty** (SEC-1).
- TF: audit-CMK dedicated key policy (SEC-4); JWT/cookie/connector **rotation** schedules (SEC-2).
- Hygiene: delete orphaned `px` ACM cert, `otel-collector-secrets` policy, `brain-prod-redis-pre-valkey`
  snapshot, stray `/aws/lambda/test` log group + `test-role-olkagc08`.
- *Outcome:* the platform now **pages** and is **audited**. Nothing rebuilt.

**Phase 1 — Karpenter / KEDA / cost tuning (Helm/ArgoCD manifests) · config-only**
- Karpenter: integer disruption budgets, `consolidateAfter 5m`, business-hours freeze, un-constrain
  families for spot-to-spot; confirm arm64-preferred.
- KEDA: add scale-to-zero ScaledObjects for transform + non-prod; add `PreferClose` to internal Services.
- Kafka CR: add `topology…/zone` AZ-spread; move to dedicated controller+broker KafkaNodePools.
- *Outcome:* cost/reliability tuning; measurable via Prometheus, all reversible in git.

**Phase 2 — Iceberg catalog SQLite → Aurora PG (additive REBUILD, rollback-safe)**
- TF: create `iceberg_catalog` DB on the existing Aurora. Helm: point `iceberg-rest` JdbcCatalog at PG.
- Cutover behind a flag; **keep SQLite path as rollback** until reads/writes verified. Retires the
  SQLite-lock incident class; gives catalog PITR (DR §4).

**Phase 3 — Trino split + Spark→DuckDB cutover (additive REBUILD, rollback-safe)**
- Helm: stand up **interactive (QUERY)** + **batch (TASK+FTE, KEDA→0)** Trino clusters; FTE exchange on S3.
- Cutover cronworkflows to **DuckDB** transform; remove the Spark batch pool; run `dev:up` e2e.
  **Keep `db/iceberg/spark` until green** (rollback). Wire health-driven Iceberg maintenance as Argo jobs.

**Phase 4 — Reliability + Kafka-Connect HA + DR enablement**
- kafka-connect → **2 replicas** + task-death alert; **tiered storage** (Kafka ≥3.9).
- TF: add **Aurora reader** (T1); enable **S3 CRR → ap-south-2** post-residency sign-off (ADR-0011).
- Start Neo4j **nightly S3 dumps**; add the **quarterly restore-drill** Argo Workflow.

**Phase 5 — Observability depth + progressive delivery**
- OTel standardization + `k8sattributes`; freshness/confidence gauges; drop `brand_id` labels.
- Argo Rollouts (canary) for BFF/web. Promote graduation-trigger comments into **paging** SLO rules.

**Phase 6 — Commitment layer (after ~1 month stable baseline)**
- 1-yr **Compute Savings Plan** on the durable on-demand floor only (never the Spot fraction) — research §10.

---

## 6. Where I challenge "destroy-and-rebuild" (explicit callouts)

1. **The account is ~80% target-state already.** Every "keep" in §2 is a resource that *already exists and
   already matches 2026 best practice.* A teardown would delete the VPC, KMS hierarchy, IRSA, S3 medallion,
   Aurora, Valkey, Karpenter, GitOps — all correct — to fix alerting, a catalog backend, and a Trino split.
   **That is a 5:1 destroy-to-fix ratio.** Selective rebuild fixes the 20% and keeps the 80%.
2. **Teardown re-introduces solved incidents.** The current IaC encodes fixes for the SQLite catalog lock,
   Trino OOM (bounded heap + autorestart), Spark OOM (DuckDB port), Kafka Spot quorum loss (on-demand pin),
   and LocalStack secret durability. A clean rebuild pays to re-discover each of these in prod.
3. **The two genuine liabilities are surgically replaceable, not teardown-worthy.** The SQLite catalog
   backend and the single Trino topology are the only two components that warrant a "rebuild," and both are
   **additive migrations with the old path as rollback** (Phases 2–3) — zero-downtime, git-revertible.
4. **The real gaps are operational, not architectural.** The review's two weakest pillars (Reliability
   SPOFs, Operational-Excellence alerting) are closed by **wiring** (SNS, CloudTrail, GuardDuty, a 2nd
   Connect replica, an Aurora reader, AZ-spread) — Phase-0/4 config, not new architecture. You cannot
   "rebuild" your way to a paging alarm; you just have to wire one.
5. **Cost levers are exhausted at the config layer** (review CO-2). The remaining gains are *structural*
   (DuckDB transform swap — Phase 3), which the selective-rebuild path already captures. A teardown adds
   migration cost and downtime for **no additional cost benefit.**
6. **The DR/rebuild story is asserted-but-unrehearsed** (REL-3). The correct response is a **quarterly
   restore drill** (Phase 4), not a rebuild — a rebuild proves nothing about *recovery* repeatability.

**Bottom line: selective rebuild. Harden in place; rebuild only the catalog backend and Trino topology,
additively and reversibly. Never `terraform destroy` the account.**
