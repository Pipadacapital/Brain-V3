# Prod go-live inputs — copy to terraform.tfvars and fill before the first apply.
# (terraform.tfvars is gitignored; nothing here is a secret, but keep it out of
# the repo so per-account values don't drift into source.)
#
# REMINDER (not a variable — backends can't interpolate): fill <PROD_ACCOUNT_ID>
# in backend.tf, and apply infra/terraform/bootstrap first (state bucket + lock
# table + state KMS). See infra/terraform/README.md "Prod go-live".

vpc_cidr = "10.0.0.0/16"

# GO-LIVE bootstrap access (AUD-COST-009): your operator IP(s). The EKS API
# endpoint opens publicly ONLY to these CIDRs; [] = private-only. Flip back to
# [] after an SSM bastion / Client VPN exists.
eks_public_access_cidrs = ["94.201.196.57/32"]

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
enable_cross_region_replication = true
replica_region                  = "ap-south-2"

# AUD-INFRA-004: scope external-dns ChangeResourceRecordSets to the Brain zone
# (brain.pipadacapital.com). Unset, the policy fell back to hostedzone/* —
# account-wide DNS mutation from a compromised external-dns pod.
external_dns_zone_ids = ["Z00011362R9ERGL7EC2J9"]
