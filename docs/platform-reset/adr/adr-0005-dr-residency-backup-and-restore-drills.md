# ADR-0005 — DR / residency posture: backup-and-restore tiering, gated CRR, and quarterly restore drills

**Status:** Proposed
**Date:** 2026-07-14
**Deciders:** Engineering Program Lead, Data Platform + Compliance owners (owner sign-off required)
**Relates to:** ADR-0001, ADR-0002, `04-architecture-review.md` (REL-3/REL-7), `06-redesign-proposal.md` §4, ADR-0004 (identity SoR = Neo4j), ADR-0011 (S3 CRR residency)

## Context

Brain's system of record spans **three stores that must be recoverable consistently**:
Iceberg-on-S3 (Bronze = SoR), the Iceberg REST-catalog DB, and the Aurora `ops` schema. The
identity graph (Neo4j Community, ADR-0004 legacy) is the only irreplaceable EKS-PVC dataset.

Current state per the inventory and review:

- **REL-7 — no DR region active.** S3 Cross-Region Replication to ap-south-2 is coded and gated but
  `enable_cross_region_replication = false`. The warehouse SoR has no live off-region copy; only
  in-region S3 durability + versioning. Data **residency** sign-off (ap-south-1 primary) is the
  blocker, not the machinery (ADR-0011).
- **REL-3 — the "rebuild from Silver" recovery path is asserted but unrehearsed.** Aurora has 35-day
  PITR + deletion protection; Neo4j has DLM EBS snapshots (7-day) but its S3 backup bucket is
  **empty** (nightly dumps not being written). Untested backups are not a recovery plan.
- Under ADR-0002 the Iceberg catalog moves to Aurora PG — a data snapshot without a **consistent
  catalog snapshot** is unrecoverable, so catalog DR must be paired with data DR.

The cost posture is starter-scale; active-active DR is premature. The correct 2026 early-stage
posture is **backup-and-restore tiering by RTO/RPO**, with graduation as paying traffic arrives.

## Decision

**Adopt a tiered backup-and-restore DR posture; enable CRR only post-residency-sign-off; and make
recovery *rehearsed*, not asserted, via a quarterly restore drill.**

| Layer | Backup mechanism | Tier | Notes |
|---|---|---|---|
| **Bronze (Iceberg SoR)** | S3 **CRR → ap-south-2** (gated flag; enable post-residency sign-off, ADR-0011) | Standard (24h) → tighten later | Append-only; the true RPO-critical set |
| **Silver/Gold marts** | **Rebuild from Bronze** via refresh loop (do NOT replicate) | Derived | Snapshot-expiry ≥ RPO window for time-travel recovery |
| **Iceberg catalog** | **Aurora PITR** (once on PG, ADR-0002) — 35-day | With ops PG | Data snapshot needs a consistent catalog snapshot |
| **Aurora `ops`** | Automated backups + **35-day PITR**; snapshot copy → ap-south-2 | Important (<1h) | Already 35-day + deletion-protection |
| **Neo4j identity SoR** | DLM EBS snapshots (7-day) **+ nightly S3 dump** (start writing to the empty bucket) | Important | Only irreplaceable PVC dataset; rehearse rebuild-from-Silver |
| **Kafka** | Replayable transport (3-broker replication) + **tiered storage on S3** | Standard | No separate backup by design (defensible) |
| **Prometheus** | Thanos → S3 blocks; local TSDB disposable | Standard | Metrics disposable |
| **Audit** | S3 Object Lock COMPLIANCE, 7yr (immutable) | Compliance | CloudTrail feeds this (ADR-0004) |
| **Terraform state** | S3 versioned + dedicated CMK + DynamoDB lock | Critical | Never delete while IaC is authoritative |

**Operational discipline (the load-bearing decision):**

1. **Residency first.** Keep ap-south-1 as the residency boundary. Enable S3 CRR → ap-south-2 and
   the Aurora cross-region snapshot copy **only after** explicit residency/compliance sign-off
   (ADR-0011). Until then, in-region durability + versioning is the accepted RPO.
2. **Start writing Neo4j nightly S3 dumps** to the existing empty `brain-neo4j-backups` bucket
   (bucket exists; the CronJob must actually run and land objects).
3. **Quarterly restore drill as an Argo Workflow:** rebuild Silver/Gold from a *restored* Bronze +
   catalog snapshot, and restore Neo4j from its S3 dump. A drill that does not produce a byte-checked
   recovered dataset does not count.
4. **Start at standard/backup-and-restore, not active-active.** Graduate DR tiers (tighter RPO,
   warm standby) as paying traffic and freshness SLAs arrive.

## Alternatives Considered

- **Active-active multi-region now.** Rejected: premature cost + operational complexity at
  starter scale; residency sign-off not yet done.
- **Enable CRR immediately without residency sign-off.** Rejected: moves SoR data across a region
  boundary before compliance approves it — a residency violation risk that outweighs the DR gain.
- **Replicate Silver/Gold marts off-region.** Rejected: derived data is cheaper to recompute from
  Bronze than to replicate; only Bronze + catalog + ops + Neo4j are RPO-critical.
- **Trust existing backups without drills.** Rejected: REL-3 — the rebuild path is unrehearsed; an
  untested backup is not a recovery plan.

## Consequences

- **Positive:** a consistent, tiered, cost-matched DR story across all three SoR stores + identity;
  recovery becomes *proven* (quarterly drill) rather than asserted; catalog DR is free once ADR-0002
  moves it to Aurora PITR.
- **Positive:** residency remains an explicit gate, so DR enablement cannot silently violate
  ap-south-1 data residency.
- **Negative / accepted:** until residency sign-off, the warehouse SoR has only in-region durability
  (no off-region copy) — an accepted, time-boxed RPO gap with the CRR machinery ready to flip.
- **Cost:** CRR + cross-region snapshot copy are single-digit-to-low-double-digit $/mo when enabled;
  the quarterly drill consumes transient batch compute (scales back to zero after).

## Rollback

CRR and cross-region snapshot copy are one gated flag each (`enable_cross_region_replication`) —
flip off to revert with no impact to primary-region data. The Neo4j S3-dump CronJob and the drill
Argo Workflow are additive manifests removable by `git revert`. The tiering table is documentation +
existing backup settings; reverting changes nothing destructive in the primary region.
