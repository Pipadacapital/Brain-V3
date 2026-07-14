# Prod go-live inputs — the APPLIED values for the live prod account.
#
# AUD-INFRA-008c: this file IS TRACKED in git (deliberately, since PR #5) —
# the header inherited from terraform.tfvars.example used to claim it was
# gitignored, which misled operators about where the applied values live.
# Nothing here is a secret; the values are per-account plan inputs and are
# reviewed in PRs like any other IaC. The operator IP below is knowingly
# visible in source (it only NARROWS the EKS API endpoint exposure).
#
# REMINDER (not a variable — backends can't interpolate): fill <PROD_ACCOUNT_ID>
# in backend.tf, and apply infra/terraform/bootstrap first (state bucket + lock
# table + state KMS). See infra/terraform/README.md "Prod go-live".

vpc_cidr = "10.0.0.0/16"

# EKS API endpoint access (AUD-COST-009 / AUD-INFRA-008a).
# [] = PRIVATE-ONLY — no public endpoint at all. ACTIVE since 2026-07-13: the
# recurring ISP-IP-rotation lockout is eliminated because access no longer
# depends on the operator's public IP. kubectl now goes through the SSM
# port-forward path (IAM-authenticated, IP-independent):
#   tools/ops/eks-ssm-tunnel.sh  →  kubectl --context brain-prod-ssm ...
# The SSM path was verified end-to-end before this flip (see
# docs/runbooks/eks-api-access.md §B). Break-glass if SSM ever breaks: AWS
# console / CLI `aws eks update-cluster-config ... publicAccessCidrs=<ip>/32`
# (then bring this file back in line, or the next apply reverts it).
# To re-open a public pin instead, put an operator "<ip>/32" back in the list.
eks_public_access_cidrs = []

# EKS system node group (platform add-ons only; workloads run on Karpenter Spot).
system_node_desired = 3
system_node_min     = 2
system_node_max     = 6

# ADR-0009 Aurora Serverless v2 starter sizing (raise max_capacity under load).
aurora_min_capacity = 0.5
aurora_max_capacity = 2

# AUD-OPS-014 (DR) — S3 CRR of the medallion warehouse bucket to ap-south-2
# (Hyderabad; IN-COUNTRY per the ADR-0011 residency decision, AUD-OPS-042).
# true stages the replica bucket + CMK + replication role/config for the NEXT
# human-approved prod apply (prod-apply.yml `production` environment gate) —
# est. single-digit $/mo at current warehouse size (transfer ~$0.02/GB once +
# GLACIER_IR ~$0.004/GB-mo). Set false to defer.
# HELD 2026-07-12 (owner cost-lever session): CRR ADDS cost (replica storage in
# ap-south-2) and is a residency decision (ADR-0011) — enable deliberately, not
# as a rider on a cost-reduction apply.
enable_cross_region_replication = false
replica_region                  = "ap-south-2"

# AUD-INFRA-004: scope external-dns ChangeResourceRecordSets to the Brain zone
# (brain.pipadacapital.com). Unset, the policy fell back to hostedzone/* —
# account-wide DNS mutation from a compromised external-dns pod.
external_dns_zone_ids = ["Z00011362R9ERGL7EC2J9"]

# ── EKS 1.33 upgrade (AUD-OPS-028) — COMPLETE, dropped the ~$360/mo extended-support fee ──
# DONE 2026-07-12 (all three steps executed & applied; live cluster verified on
# 1.33 / AL2023 / STANDARD support 2026-07-14). Runbook (kept for the next major
# bump): docs/runbooks/eks-1-33-upgrade.md. NOTE: the modules/eks *defaults* stay
# 1.32 / AL2_ARM_64 as a safe no-op default — these prod overrides are the source
# of truth. FORWARD: schedule the routine 1.33 → 1.34+ roll before 1.33 standard
# support ends (~late-2026); now a single-step node roll (already on AL2023). The
# eks_support_type=STANDARD guard fails the plan if the cluster drifts to extended.
system_ami_type  = "AL2023_ARM_64_STANDARD" # step 1 DONE 2026-07-12 — prereq (AL2 AMIs end at 1.32)
cluster_version  = "1.33"                   # step 2 DONE 2026-07-12 — control plane + MNG roll
eks_support_type = "STANDARD"               # step 3 DONE 2026-07-12 — fail-fast on future extended-support drift
