# ADR-0011: Cross-region S3 replication for DR — in-country (ap-south-2), gated

- **Status:** Proposed (code merged; apply pending owner approval — see "Rollout")
- **Date:** 2026-07-12
- **Audit findings:** AUD-OPS-014 (backup estate single-region/single-account, MEDIUM),
  AUD-OPS-042 (residency verified clean; any cross-region copy must be a documented
  residency decision), AUD-OPS-013 (DR runbook — `docs/runbooks/DR.md`)

## Context

The 2026-07 operational audit measured (AUD-OPS-014) that **every backup of every store
lives in one region (ap-south-1) in one account**: no S3 bucket replication on any of the
4 buckets, no cross-region RDS backup replication, all automated snapshots in-region. Two
failure classes are therefore unrecoverable:

1. **Regional event** — an ap-south-1 S3/KMS/RDS impairment takes the data AND its only
   copies. For Bronze (`brain-bronze-prod-*` — the medallion warehouse and the
   system-of-record: "Bronze is source of truth", "no event loss") this violates a core rule.
2. **Account-level compromise / operator error** — versioning does not survive a principal
   with `s3:DeleteObjectVersion`; a same-bucket purge deletes the versions too.

At the same time, the audit **verified-positive** (AUD-OPS-042) that residency is clean —
all prod stores are ap-south-1 (India) with no cross-region flows — and flagged the
deliberate tension: any future cross-region backup **must be a documented residency
decision**. This ADR is that document.

## Decision

1. **Replica region = ap-south-2 (Hyderabad).** Both AWS Indian regions are used, so the
   replicated data **never leaves India**: the DPDP/data-residency posture verified by
   AUD-OPS-042 is unchanged. We explicitly REJECT out-of-country replicas (ap-southeast-*,
   me-*) — better blast-radius isolation is not worth converting a clean residency story
   into a cross-border transfer requiring DPA/RoPA rework.
2. **Scope: the two keystone buckets only** (cost-first):
   - `brain-bronze-prod-<acct>` — the medallion warehouse (Bronze SoR + derived
     Silver/Gold + serving-view metadata). Replica storage class **GLACIER_IR**
     (instant retrieval, ~$0.004/GB-mo) — a DR copy, not a serving copy.
   - `brain-tfstate-prod-<acct>` — kilobytes, but the recovery keystone: RB-2 (EKS/account
     rebuild) starts from state. Replica storage class STANDARD.
   - NOT replicated (documented non-goals): `brain-metrics-*` (observability, rebuildable),
     `brain-audit-*` (WORM Object-Lock COMPLIANCE already defeats deletion; revisit if a
     regional-loss requirement lands), `brain-neo4j-backups-*` (secondary copy of a store
     that also exports to the — replicated — warehouse via `silver_identity_map`; revisit
     with AUD-OPS-012 hardening).
3. **Delete-marker replication ON**: source deletes arrive on the replica as *reversible
   markers*; replica version history (180d noncurrent retention) is what defeats a
   source-side version purge. The replica keeps its own CMK (SSE-KMS re-encryption) in
   ap-south-2 — a compromised source key cannot decrypt (or schedule deletion of) the
   replica's key material.
4. **Aurora**: stays in-region (35d PITR + daily snapshots). A **monthly manual
   cross-region snapshot copy to ap-south-2** is the documented compensating step
   (procedure in `docs/runbooks/DR.md` §Aurora) — automated cross-region backup
   replication is deferred until revenue justifies the always-on copy cost, per the
   audit's own cost-first rating (MEDIUM, "defer cross-account vaulting").

## Mechanics (implemented, gated)

- `infra/terraform/modules/s3-crr-replica` — replica-region bucket + CMK (versioned,
  SSE-KMS, public-access-blocked, TLS-only, lifecycle: 180d noncurrent expiry). Takes the
  replica-region provider as its default `aws` (CI validates modules standalone —
  no `configuration_aliases`).
- `infra/terraform/modules/s3-crr` — source-side: replication role (least-privilege on
  both buckets + both CMKs) + the replication configuration on the source bucket
  (V2 rule, whole bucket, delete-marker replication, SSE-KMS source-selection).
- Wired in `infra/terraform/envs/prod/bootstrap.tf` (warehouse) and
  `infra/terraform/bootstrap/main.tf` (tfstate), both behind
  **`enable_cross_region_replication`** (+ `replica_region`, default `ap-south-2`).

## Cost (advise-once numbers)

One-time transfer Mumbai→Hyderabad ~$0.02/GB; GLACIER_IR ~$0.004/GB-mo; replication PUT
requests negligible at current volume. At a low-double-digit-GB warehouse this is
**single-digit $/mo**, growing linearly with Bronze. The 180d replica noncurrent window
(vs 90d on source) exceeds the GLACIER_IR 90-day minimum storage duration, avoiding
early-delete charges on churned Iceberg files.

## Rollout / rollback

- **Rollout (apply-decision, owner-gated):** `enable_cross_region_replication = true` is
  staged in `envs/prod/terraform.tfvars`; the change takes effect only via the
  human-approved `prod-apply.yml` lane (`production` environment gate). The tfstate root
  (`infra/terraform/bootstrap`) is applied locally by the owner (`-var enable_cross_region_replication=true`).
  Existing objects are NOT back-replicated by a new rule — after the first apply run a
  one-time S3 Batch Replication job (or `aws s3 sync` to the replica) for the warehouse
  backlog; new/changed objects replicate automatically.
- **Rollback:** set the variable to `false` and re-apply — removes the replication config
  and role; the replica bucket/key stay (data!) until deliberately destroyed.

## Consequences

- Regional/account-compromise RPO for the warehouse drops from "unrecoverable" to
  ~replication lag (typically minutes; 15-min RTC not enabled — cost).
- `docs/runbooks/DR.md` gains a real answer for "ap-south-1 S3 is gone".
- The RoPA/DPA processor inventory should note intra-India multi-region storage
  (no cross-border transfer arises).
