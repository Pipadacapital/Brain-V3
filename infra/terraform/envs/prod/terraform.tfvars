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

# GO-LIVE bootstrap access (AUD-COST-009 / AUD-INFRA-008a): operator IP(s).
# The EKS API endpoint opens publicly ONLY to these CIDRs; [] = private-only.
# If your ISP rotates the IP, kubectl access dies until this list is
# re-applied — the refresh procedure AND the SSM port-forward fallback (which
# works with [] private-only) are in docs/runbooks/eks-api-access.md.
# Flip to [] once the SSM path is verified end-to-end.
eks_public_access_cidrs = ["94.201.196.57/32"]

# EKS system node group (platform add-ons only; workloads run on Karpenter Spot).
system_node_desired = 3
system_node_min     = 2
system_node_max     = 6

# ADR-0009 Aurora Serverless v2 starter sizing (raise max_capacity under load).
aurora_min_capacity = 0.5
aurora_max_capacity = 2

# AUD-INFRA-004: scope external-dns ChangeResourceRecordSets to the Brain zone
# (brain.pipadacapital.com). Unset, the policy fell back to hostedzone/* —
# account-wide DNS mutation from a compromised external-dns pod.
external_dns_zone_ids = ["Z00011362R9ERGL7EC2J9"]

# ── EKS 1.33 upgrade (AUD-OPS-028, −$360/mo extended-support fee) ────────────
# GATED: commented = live state (1.32 / AL2 / AWS-default support) = no-op plan.
# Uncomment ONE STEP AT A TIME, apply, verify, then the next — full runbook in
# docs/runbooks/eks-1-33-upgrade.md. Step 1 REPLACES the system MNG
# (create-before-destroy) onto AL2023 + gp3 roots (AUD-INFRA-019).
# system_ami_type  = "AL2023_ARM_64_STANDARD"   # step 1 — prereq (AL2 AMIs end at 1.32)
# cluster_version  = "1.33"                     # step 2 — control plane + MNG roll
# eks_support_type = "STANDARD"                 # step 3 — fail-fast on future extended-support drift
