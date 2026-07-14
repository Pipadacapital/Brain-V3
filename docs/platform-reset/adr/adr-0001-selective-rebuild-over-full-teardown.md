# ADR-0001 — Selective rebuild over full teardown of the prod platform

**Status:** Proposed
**Date:** 2026-07-14
**Deciders:** Engineering Program Lead (owner sign-off required)
**Account:** 380254378136 (PAID PRODUCTION) · **Region:** ap-south-1 · **Domain:** brain.pipadacapital.com
**Supersedes / relates to:** `02-destruction-plan.md` (teardown mechanics, document-only), `04-architecture-review.md`, `06-redesign-proposal.md`

## Context

The platform-reset program was framed as a possible "destroy-and-rebuild." Two independent
read-only analyses were produced against the live 2026-07-14 inventory:

- The **Well-Architected review** (`04`) concludes the estate is *"a genuinely well-engineered,
  cost-conscious platform"*: Cost, Performance, and Security-fundamentals pillars are strong and
  deliberate, with named ADR graduation triggers. Material gaps are concentrated in exactly two
  pillars — **Reliability** (defensible-but-concentrated SPOFs) and **Operational Excellence**
  (alerting pages no one; no CloudTrail/GuardDuty/Config detective baseline).
- The **cost report** (`07`) finds spend at **~$520–580/mo**, structural levers already applied
  (EKS 1.33/STANDARD, Graviton, Spot, fck-nat, S3-gateway + ECR endpoints, Aurora 0.5-ACU floor,
  Kafka rack-awareness), and concludes *"config-level cost levers are essentially exhausted."*

The current IaC also encodes fixes for a set of already-solved production incidents: the Iceberg
SQLite catalog lock, Trino serving-OOM (bounded heap + autorestart), Spark-OOM (DuckDB port),
Kafka Spot quorum loss (on-demand broker pin), and LocalStack secret durability. These fixes are
institutional knowledge embedded in the manifests and modules.

A full `terraform destroy` would delete the VPC/subnet fabric, the KMS CMK hierarchy, the IRSA
model, the S3 medallion (system of record), Aurora, Valkey, Karpenter, and the ArgoCD GitOps
layer — **all of which already match 2026 target-state** — in order to fix alerting, a catalog
backend, and a Trino topology split. That is a ~5:1 destroy-to-fix ratio, and it re-introduces
every solved incident above in prod.

## Decision

**Adopt SELECTIVE REBUILD. Do not run `terraform destroy` on the prod account.**

Classify every component into one of three lanes:

1. **KEEP (do not touch):** VPC/subnet fabric + endpoints, KMS CMK hierarchy, IRSA model, S3
   medallion + lifecycle, Aurora Serverless v2, ElastiCache Valkey, ArgoCD app-of-apps +
   release→master promotion, Karpenter Spot/Graviton pools, fck-nat, private-only EKS API,
   ACM/Route53/external-dns. These are already the target-state answer.
2. **HARDEN IN PLACE (config/manifest deltas, no rebuild):** actionable SNS alerting, CloudTrail +
   GuardDuty, KEDA scale-to-zero on batch/idle lanes, Karpenter disruption-budget tuning, Kafka
   AZ-spread + 2-replica Kafka-Connect, second Aurora reader at T1, secret rotation, log-retention
   trim, cross-AZ `PreferClose`.
3. **REBUILD ONLY (net-new, additive, reversible, with old path as rollback):** the two genuine
   single-writer liabilities — the **Iceberg REST catalog backend** (SQLite → Aurora PG) and the
   **Trino topology** (one cluster → interactive + batch-FTE). Governed by ADR-0002.

All change flows through the existing pipeline (feature → PR → `release` → owner-gated
`release`→`master` promotion → `deploy.yml` + ArgoCD). Every phase is independently `git revert`-able.

## Alternatives Considered

- **Full teardown + clean rebuild.** Rejected. Destroys the ~80% that is correct to fix the ~20%
  that is operational wiring; re-introduces five solved incident classes in prod; adds migration
  cost and downtime for **no** additional cost benefit (levers are config-exhausted per `07`).
- **Do nothing (accept current state).** Rejected. The two weakest pillars (Reliability SPOFs with
  no paging; missing detective baseline for a PII-holding paid account) are real risks as
  promotional credits deplete and paying brands arrive expecting freshness SLAs.
- **Lift-and-shift to managed equivalents** (MSK, Fargate, S3 Tables, managed Trino). Rejected here
  as a program-level default — evaluated per-component in the redesign; each is more expensive and
  removes control the team already exercises. Individual moves remain open under their own ADRs.

## Consequences

- **Positive:** preserves institutional incident-knowledge; zero-downtime, git-revertible path;
  no data-loss exposure to the medallion/identity/ops stores; cost posture unchanged-to-better.
- **Positive:** focuses effort on the two weakest WAF pillars via *wiring*, not rebuilding — you
  cannot "rebuild" your way to a paging alarm.
- **Negative / accepted:** the concentrated SPOFs (single fck-nat, single Aurora writer, single
  Neo4j, single coordinator) persist at T0/T1; they are made *loud and paged* (ADR-0004) and
  rehearsed rather than eliminated, per their existing graduation triggers.
- **Negative / accepted:** `02-destruction-plan.md` remains a documented, executable teardown
  runbook for the account-closure/exit scenario only — it is explicitly NOT the chosen path.

## Rollback

Selective-rebuild is itself the low-risk path; each hardening/rebuild phase is individually
reversible by `git revert` of its PR (ArgoCD self-heals to the prior manifest state). There is no
destructive action to roll back at the program level. If the program is abandoned entirely, the
account is simply left in its current (already-sound) state — no cleanup required.
