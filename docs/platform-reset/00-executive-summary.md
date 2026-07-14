# 00 — Platform Reset: Executive Summary

**Author:** Chief Platform Architect
**Date:** 2026-07-14
**Account:** 380254378136 (PAID PRODUCTION) · **Region:** ap-south-1 (Mumbai) · **Domain:** brain.pipadacapital.com
**Status:** COMPLETE ANALYSIS — DESTRUCTION PLAN **AWAITING OWNER APPROVAL. NOTHING HAS BEEN OR WILL BE DELETED.**
**Reading order:** this summary → `04` review → `06` redesign → `07` cost → `08`/`09` repo+standards → `adr/*` → `02` destruction plan (documented, NOT chosen).

---

## 0. Bottom line up front

The engagement was framed as a possible "platform reset / destroy-and-rebuild." **Two independent
read-only analyses of the live 2026-07-14 estate reject a full teardown.** The platform is already
~80% target-state and deliberately cost-optimized. The recommendation is a **SELECTIVE REBUILD**:
keep the correct 80%, harden the operational gaps in place, and additively rebuild only two
components (the Iceberg catalog backend and the Trino topology) — **without ever running
`terraform destroy` on the account.**

- **Current spend: ≈ $520–580/mo** (point-in-time capture peaked ~$620/mo with 3 on-demand Karpenter nodes running).
- **Target spend: ≈ $340–400/mo** — a ~30–35% cut, entirely on the compute lane, with single-AZ-failure survivability preserved.

---

## 1. Current-state snapshot (spend + footprint)

**Spend: ≈ $520–580/mo steady-state** (cross-checked against Brain's own ~$450–580/mo memory
figure). Compute is 65–75% of the bill. Biggest line items: Karpenter on-demand EC2 (~$180–294),
system node group (~$74), EKS control plane ($73, flat), Karpenter Spot (~$120), Aurora Serverless
v2 ($50–95). A non-line-item — cross-AZ data transfer (~638 GB/day, ~$194/mo at worst) — is already
suppressed by Kafka rack-awareness (PR #165) and must be kept suppressed.

**Footprint (ap-south-1, one account, us-east-1 sweep = clean):**
- **Compute/net:** 1 EKS `brain-prod` (v1.33/AL2023/STANDARD, private-only API via SSM tunnel); 3× t4g.medium on-demand system NG; ~7 Karpenter Spot/Graviton nodes (app/streaming/trino/ondemand pools); single `t4g.nano` fck-nat (no managed NAT); one shared internet-facing ALB (ip-target); S3 gateway + 2 ECR interface endpoints; VPC 10.0.0.0/16.
- **Data/state:** Aurora PostgreSQL Serverless v2 (0.5–2.0 ACU, single writer, 35-day PITR, deletion-protected); ElastiCache Valkey (single-node cache); Neo4j identity SoR (single Community node on EBS PVC); Kafka via Strimzi/KRaft (3 brokers, on-demand-pinned, rack-aware) with a single Kafka-Connect Bronze sink; Trino-over-Iceberg serving; Iceberg medallion on S3 (Bronze = SoR).
- **Storage:** 5 KMS-encrypted, versioned S3 buckets (~13 GB total) — bronze medallion, audit (**Object Lock COMPLIANCE, 7yr, immutable**), metrics, neo4j-backups (empty), tfstate; ~638 GB gp3 EBS.
- **Security/ops:** 4 KMS CMKs (root/connector/audit/tfstate), 22 Secrets Manager secrets (ESO-synced), ~21 IAM roles (14 IRSA + OIDC), ArgoCD app-of-apps GitOps with release→master owner-gated promotion.

---

## 2. Key findings (architecture + monorepo audits)

**Architecture (`04`, AWS Well-Architected) — "a genuinely well-engineered, cost-conscious platform."**
- **Strong pillars:** Cost Optimization (excellent, deliberate — Spot, Graviton, Serverless v2, fck-nat, trimmed endpoints, EKS extended-support fee eliminated), Performance Efficiency, and Security fundamentals (IRSA least-privilege, KMS-everywhere, private EKS API, TLS-only buckets).
- **Weakest pillar — Reliability:** concentrated but defensible SPOFs — single fck-nat egress, single Aurora writer, single Neo4j identity SoR, single Kafka-Connect landing writer, single-node Redis. Each has a written recovery story; the data-loss blast radius is contained by Bronze-is-SoR / at-least-once ingest.
- **Weakest pillar — Operational Excellence + a Security gap:** **nothing pages anyone** (alarms are email-less / EC2-auto-action only; no SNS/chat/PagerDuty sink), `module.observability` isn't even wired into prod, and there is **no account detective baseline** (no CloudTrail/GuardDuty/Config/SecurityHub) on a paid, PII-holding account. App/JWT/connector secrets have no rotation.
- **Single biggest risk:** concentrated single-writer SPOFs on revenue-critical paths **combined with an alerting posture that pages no one** — a *freshness/availability* risk (not data-loss) that becomes an SLA risk as paying brands arrive.

**Monorepo (`08`) — "in good structural health."**
- Code-level naming is internally consistent (Python 100% snake_case, package dirs kebab, all `@brain/*`); commented-out code ≈ zero; knip already configured.
- **The one real debt is doc↔reality drift from the Spark→DuckDB cutover:** `CLAUDE.md`/`claude.md` still assert "Spark is the sole TRANSFORM compute" (code + CI already shipped DuckDB-on-Iceberg + Trino), cite a non-existent `v4-refresh-loop.sh`, and are a case-shadow duplicate on macOS. knip is report-only (not a merge gate).

---

## 3. Redesign recommendation — SELECTIVE REBUILD (explicit position)

**Explicit position: SELECTIVE REBUILD, not full teardown.** When a design is ~80% right, a full
rebuild destroys the 80% to fix the 20% (a ~5:1 destroy-to-fix ratio) and re-introduces every
already-solved incident (SQLite catalog lock, Trino OOM, Spark OOM, Kafka Spot quorum loss,
LocalStack secret durability) — institutional knowledge encoded in the current IaC. There is **no
cost benefit** to teardown (config levers are exhausted), only migration cost and downtime.

Three lanes (ADR-0001):
- **KEEP (do not touch):** VPC/endpoint fabric, KMS CMK hierarchy, IRSA, S3 medallion + lifecycle, Aurora Serverless v2, Valkey, ArgoCD GitOps + release→master promotion, Karpenter Spot/Graviton pools, fck-nat, private EKS API, ACM/Route53/external-dns — already the target-state answer.
- **HARDEN IN PLACE (config/manifest, no rebuild):** actionable SNS alerting, CloudTrail + GuardDuty, KEDA scale-to-zero on batch/idle lanes, Karpenter disruption-budget tuning, Kafka AZ-spread + 2-replica Kafka-Connect, second Aurora reader at T1, secret rotation, log-retention trim, cross-AZ `PreferClose`, rightsizing.
- **REBUILD ONLY (net-new, additive, reversible — old path as rollback):** the Iceberg REST catalog backend (SQLite → Aurora PG) and the Trino topology (one cluster → interactive + batch-FTE). Both governed by ADR-0002; the Spark→DuckDB transform cutover is *finished*, not rebuilt.

Delivered across a 6-phase path (guardrails → cost tuning → catalog → Trino/DuckDB → reliability/DR → observability/commitment), every phase `git revert`-able through the existing feature→PR→release→owner-gated-master pipeline. **No `terraform destroy`.**

---

## 4. Headline cost savings

| | Current | Target (low-traffic steady-state) |
|---|---:|---:|
| **Total** | **≈ $520–580/mo** | **≈ $340–400/mo** (~30–35% cut) |
| EC2 compute (Karpenter + system) | ~370–490 | ~200–250 |
| Aurora Serverless v2 | 50–95 | ~40–55 |
| EBS gp3 | 48–51 | ~35–45 |
| CloudWatch/observability | 8–31 | ~6–12 |
| Cross-AZ transfer | ~0–194 | ~10–30 |

Savings come almost entirely from the **compute lane** — rightsizing requests/limits (highest
untapped lever, ~$60–120/mo), KEDA scale-to-zero on transform/idle lanes (~$40–90/mo), higher Spot
ratio + Karpenter consolidation tuning, and CloudWatch log trim — **with no loss of
single-AZ-failure survivability**. Already-banked wins (EKS STANDARD ~$360/mo, Graviton, fck-nat
vs managed NAT, Aurora 0.5-ACU floor) must be protected from regression, not re-recommended. A
1-yr Compute Savings Plan on the durable on-demand floor is deferred until the post-rightsizing
baseline stabilizes (~1 month). Growth scenario scales cost-linearly to ~$700–1,200/mo.

---

## 5. Destruction plan status — **AWAITING APPROVAL, NOTHING DELETED**

`02-destruction-plan.md` is a **complete, dependency-ordered, documentation-only teardown runbook**
(18 phases, controller-drain-first, with a per-phase reversibility matrix). **No AWS or Kubernetes
resource has been or will be created, modified, or deleted on its basis.** It exists solely as the
account-closure / exit runbook — it is **explicitly NOT the chosen path** (ADR-0001 chose selective
rebuild). Execution of any phase requires explicit, itemized owner GO, and the irreversible
data-loss items (Aurora `ops`, bronze medallion S3, Neo4j identity SoR, the 4 KMS CMKs, Kafka
broker PVCs + secrets) each require **separate individual sign-off**. Note: the `brain-audit-prod`
bucket (Object Lock COMPLIANCE, 7yr) **cannot be deleted by anyone, including account root**, until
retention expires.

---

## 6. What happens next / decisions needed from the owner

1. **Ratify the direction: SELECTIVE REBUILD (approve ADR-0001), not full teardown.** This is the load-bearing decision that unlocks the rest. Approving it confirms `02-destruction-plan.md` stays a shelved exit-only runbook.
2. **Approve Phase 0 guardrails (ADR-0004): CloudTrail → WORM audit bucket + GuardDuty + one SNS→email+chat topic wired to existing alarms.** Highest ROI, lowest cost (single-digit $/mo), fixes the "pages no one / no detective baseline" risk. Recommend: yes, immediately.
3. **Approve the additive catalog + Trino rebuild (ADR-0002): Iceberg catalog SQLite → Aurora PG, and the Trino interactive/batch-FTE split** — both additive with the old path as rollback. Confirm the Data Platform owner co-signs and that the Spark→DuckDB cutover may be finished (Spark tree kept as rollback until e2e green).
4. **Approve the compute/cost topology (ADR-0003): scale-to-zero boundary + rightsizing + 2-AZ consolidation + a second Aurora reader at T1.** Confirm the target of ~$340–400/mo and the intent to add CI/IaC plan-guards protecting the banked wins (no managed NAT, Aurora min-ACU floor, rack-awareness, EKS STANDARD).
5. **DR + residency sign-off (ADR-0005): approve the tiered backup-and-restore posture, and give explicit ap-south-1 residency/compliance sign-off to enable S3 CRR → ap-south-2** (machinery is coded and gated). Also approve starting Neo4j nightly S3 dumps and a quarterly restore drill.
6. **Approve secret rotation (SEC-2) + audit-CMK isolation (SEC-4):** rotation schedules for JWT/cookie/connector app-secrets, and a dedicated non-blanket key policy on the audit CMK.
7. **Approve the monorepo/doc reconciliation (`08`/`09`):** fix `CLAUDE.md`/`claude.md` to describe the shipped DuckDB+Trino architecture, de-duplicate the case-shadow, fix the `v4-naming-guard.sh` header, and promote knip from report-only to a blocking gate.
8. **Approve hygiene deletes** (low-risk, non-teardown): orphaned `px` ACM cert, `brain-prod-otel-collector-secrets` orphan policy, `brain-prod-redis-pre-valkey` manual snapshot, stray `/aws/lambda/test` log group + `test-role-olkagc08`.
9. **Confirm sequencing/ownership:** all work flows through feature → PR → `release` → **owner-gated** `release`→`master` promotion. Confirm you (repo owner) will gate the promotion PRs and the order Phase 0 → 1 → 2 → 3 → 4 → 5.

---

## 7. Deliverable index

| File | One-line description |
|---|---|
| `00-executive-summary.md` | **This document** — engagement summary, recommendation, cost headline, decisions needed. |
| `02-destruction-plan.md` | Documentation-only 18-phase teardown runbook (AWAITING APPROVAL, nothing deleted) — the exit/account-closure path, **not** the chosen one. |
| `04-architecture-review.md` | AWS Well-Architected review of the live estate — pillar scoring, findings (OE/SEC/REL/PE/COST), top-10 improvements, biggest risk. |
| `06-redesign-proposal.md` | Target architecture + explicit "selective rebuild over teardown" case, component-by-component recommendations, 6-phase migration path. |
| `07-cost-optimization.md` | FinOps report — current spend by service, 14 ranked levers, ~$340–400/mo target, growth projection, budget/anomaly/tagging guardrails. |
| `08-monorepo-modernization.md` | Staff-engineer repo audit — naming, stale markers, dead code, deps; headline = Spark→DuckDB doc-drift; prioritized cleanup backlog. |
| `09-engineering-standards.md` | Naming / IaC / review standards to enforce going forward; turns advisory gates into enforcing ones. |
| `adr/adr-0001-selective-rebuild-over-full-teardown.md` | Program decision: selective rebuild, never `terraform destroy`; KEEP / HARDEN / REBUILD lanes. |
| `adr/adr-0002-iceberg-catalog-and-trino-topology-rebuild.md` | Additive rebuild of the Iceberg REST catalog (SQLite → Aurora PG) and Trino interactive/batch-FTE split; finish Spark→DuckDB. |
| `adr/adr-0003-compute-topology-spot-graviton-and-scale-to-zero.md` | Karpenter Spot+Graviton tuning, the scale-to-zero boundary table, and Aurora ACU sizing (+T1 reader). |
| `adr/adr-0004-detective-baseline-and-actionable-alerting.md` | CloudTrail + GuardDuty detective baseline, SNS→email+chat alerting, audit-CMK isolation, secret rotation. |
| `adr/adr-0005-dr-residency-backup-and-restore-drills.md` | Tiered backup-and-restore DR, residency-gated S3 CRR, Neo4j S3 dumps, quarterly restore drill. |
| `inventory/compute-networking.md` | Read-only inventory: EKS, Karpenter nodes, system NG, fck-nat, ALB, VPC/subnets/endpoints, EIPs, SGs. |
| `inventory/databases-backups.md` | Read-only inventory: Aurora, ElastiCache Valkey, DynamoDB lock, AWS Backup, EBS snapshots + DLM (Neo4j). |
| `inventory/kubernetes-workloads.md` | Read-only k8s inventory reconstructed from ArgoCD app-of-apps + Helm charts (private API, SSM-tunnel only). |
| `inventory/observability-dns.md` | Read-only inventory: CloudWatch Logs/Alarms, EventBridge, SNS, Route 53, ACM, CloudFront (none), X-Ray. |
| `inventory/research-data-platform.md` | 2026 best-practice research (Strimzi/KRaft, Iceberg-REST, Trino, DuckDB, Valkey, ArgoCD) mapped to Brain's stack. |
| `inventory/research-infra-cost.md` | 2026 FinOps + Well-Architected cost research for a small prod EKS platform, mapped to Brain with $ impact + when-to-adopt. |
| `inventory/secrets-kms-iam.md` | Read-only inventory: Secrets Manager, SSM params, KMS keys/aliases, IAM roles/policies/instance-profiles/OIDC. |
| `inventory/storage.md` | Read-only inventory: 5 S3 buckets (incl. WORM audit), EBS volumes/snapshots, EFS (none), lifecycle rules. |

---

**No resource has been or will be deleted on the basis of these documents. The destruction plan is
documentation only and awaits explicit, itemized owner approval; selective rebuild (ADR-0001) is
the recommended path.**
