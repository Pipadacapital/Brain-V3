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
eks_public_access_cidrs = ["94.204.52.169/32"]

# EKS system node group (platform add-ons only; workloads run on Karpenter Spot).
system_node_desired = 3
system_node_min     = 2
system_node_max     = 6

# ADR-0009 Aurora Serverless v2 starter sizing (raise max_capacity under load).
aurora_min_capacity = 0.5
aurora_max_capacity = 2
