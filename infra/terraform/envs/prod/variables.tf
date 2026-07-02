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
