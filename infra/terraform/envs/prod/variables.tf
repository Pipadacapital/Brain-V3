################################################################################
# Brain – Prod Environment Variables (AUD-COST-001 go-live un-gating)
# Values come from terraform.tfvars (copy terraform.tfvars.example). Defaults
# encode the ADR-0009 starter sizing so a bare `terraform apply` is safe.
################################################################################

variable "vpc_cidr" {
  description = "Prod VPC CIDR (also the NAT-instance / VPC-endpoint ingress range)."
  type        = string
  default     = "10.0.0.0/16"
}

# AUD-COST-009: go-live cluster access. The EKS endpoint is private-only by
# default, but nothing (no bastion/VPN/SSM) can reach it — the one-time
# kubectl/helm/argocd bootstrap needs a path. Set this to your operator IP(s)
# (e.g. ["203.0.113.7/32"]) for the 2-day go-live window, then flip back to []
# once an SSM bastion or Client VPN lands (see modules/eks variable docs).
variable "eks_public_access_cidrs" {
  description = "CIDR allowlist for the public EKS API endpoint. Empty = private-only."
  type        = list(string)
  default     = []
}

# EKS system node group — the fixed ON-DEMAND group that hosts platform add-ons
# (CoreDNS, ArgoCD, KEDA, the Karpenter controller). All other capacity is
# Karpenter-managed (infra/helm/karpenter).
variable "system_node_desired" {
  type    = number
  default = 3
}

variable "system_node_min" {
  type    = number
  default = 2
}

variable "system_node_max" {
  type    = number
  default = 6
}

# ── EKS 1.33 upgrade gates (AUD-OPS-028 + prereq AUD-INFRA-019) ──────────────
# 1.32 bills EXTENDED support ($12/day ≈ $360/mo — 86% of the $500 target).
# ALL THREE defaults equal the live state, so an un-flipped plan is a NO-OP.
# Flip sequence (one apply each, docs/runbooks/eks-1-33-upgrade.md):
#   1. system_ami_type = "AL2023_ARM_64_STANDARD"   (AL2 AMIs end at 1.32)
#   2. cluster_version = "1.33"
#   3. eks_support_type = "STANDARD"                 (fail-fast guard, post-upgrade)
variable "cluster_version" {
  description = "EKS control-plane Kubernetes version. Bump only after the system MNG is on AL2023 (AUD-INFRA-019)."
  type        = string
  default     = "1.32"
}

variable "system_ami_type" {
  description = "System MNG AMI type. Flip to AL2023_ARM_64_STANDARD before cluster_version 1.33 (AL2 AMIs end at 1.32)."
  type        = string
  default     = "AL2_ARM_64"
}

variable "eks_support_type" {
  description = "EKS upgradePolicy supportType. Set to STANDARD only AFTER the 1.33 upgrade (the API rejects it while the running version is extended-support)."
  type        = string
  default     = null
}

# AUD-COST-017: hosted zone id(s) external-dns may manage (e.g. ["Z0123456789ABC"]).
# Empty = the role's ChangeResourceRecordSets falls back to hostedzone/* so the
# first apply works before the zone exists — set the real id(s) once step 9 of
# GO-LIVE creates/identifies the zone, then re-apply.
variable "external_dns_zone_ids" {
  description = "Route53 hosted zone IDs external-dns is allowed to change. Empty = all zones (bootstrap fallback; tighten ASAP)."
  type        = list(string)
  default     = []
}

# AUD-OPS-014 / AUD-OPS-042 (docs/adr/0011-s3-crr-residency.md): cross-region
# replication of the medallion-warehouse bucket to a SECOND IN-COUNTRY region
# (ap-south-2 Hyderabad — data never leaves India, DPDP residency unchanged).
# Gated: false renders zero resources; flipping to true is the ratified DR
# apply-decision (creates the replica bucket + CMK + replication role/config).
variable "enable_cross_region_replication" {
  description = "Enable S3 CRR of the medallion warehouse bucket to replica_region (AUD-OPS-014; residency decision ADR-0011)."
  type        = bool
  default     = false
}

variable "replica_region" {
  description = "In-country DR replica region for S3 CRR (ADR-0011: must remain in India for DPDP residency)."
  type        = string
  default     = "ap-south-2"
}

# ADR-0009: Aurora Serverless v2, 0.5–2 ACU burst-elastic starter sizing.
variable "aurora_min_capacity" {
  description = "Aurora Serverless v2 minimum capacity (ACU)."
  type        = number
  default     = 0.5
}

variable "aurora_max_capacity" {
  description = "Aurora Serverless v2 maximum capacity (ACU)."
  type        = number
  default     = 2
}
