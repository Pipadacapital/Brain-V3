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

# AUD-COST-017: hosted zone id(s) external-dns may manage (e.g. ["Z0123456789ABC"]).
# Empty = the role's ChangeResourceRecordSets falls back to hostedzone/* so the
# first apply works before the zone exists — set the real id(s) once step 9 of
# GO-LIVE creates/identifies the zone, then re-apply.
variable "external_dns_zone_ids" {
  description = "Route53 hosted zone IDs external-dns is allowed to change. Empty = all zones (bootstrap fallback; tighten ASAP)."
  type        = list(string)
  default     = []
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
