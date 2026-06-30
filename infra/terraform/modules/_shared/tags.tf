################################################################################
# Brain – Shared Tags Module (_shared)
#
# Single source of truth for the MANDATORY Brain tag set. Instantiate it once in
# each environment root (infra/terraform/envs/{dev,staging,prod}/*.tf) and feed
# its `common_tags` output into the aws provider `default_tags` block so EVERY
# taggable resource in that root inherits the standard tags automatically — no
# per-resource `tags = {}` boilerplate required.
#
# This module creates NO AWS resources. It is pure locals + outputs, so it is
# free to plan/apply and safe to wire into the EC10 "declared-but-not-applied"
# prod root.
#
# See ./README.md for the adoption recipe and docs/infra/naming-and-tagging.md
# for the full naming + tagging standard.
################################################################################

terraform {
  required_version = ">= 1.9"
}

variable "environment" {
  type        = string
  description = "Deployment environment: dev | staging | prod."
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "project" {
  type        = string
  default     = "brain"
  description = "Project slug. Always 'brain' today."
}

variable "owner" {
  type        = string
  default     = "data-team"
  description = "Owning team. MANDATORY tag value; do not override without a reason."
}

variable "cost_center" {
  type        = string
  default     = "brain-platform"
  description = "Finance cost-allocation bucket. MANDATORY tag value."
}

variable "extra_tags" {
  type        = map(string)
  default     = {}
  description = "Optional caller-supplied tags merged on top of the mandatory set (e.g. { Compliance = \"pii\" })."
}

locals {
  # ── MANDATORY tag set (the four keys every Brain resource must carry) ──
  # Keys are PascalCase per the standard in docs/infra/naming-and-tagging.md.
  mandatory_tags = {
    Environment = var.environment
    Service     = "platform" # override per-resource for service-scoped infra (see README)
    Owner       = var.owner
    CostCenter  = var.cost_center
  }

  # ── Recommended supplementary tags (cheap, high-value for audit/cost) ──
  baseline_tags = {
    Project   = var.project
    ManagedBy = "terraform"
  }

  # common_tags — feed this into the provider `default_tags { tags = ... }`.
  common_tags = merge(local.baseline_tags, local.mandatory_tags, var.extra_tags)
}

output "common_tags" {
  description = "Merged mandatory + baseline tag map for the aws provider default_tags block."
  value       = local.common_tags
}

output "mandatory_tags" {
  description = "Just the four mandatory keys (for assertions / policy checks)."
  value       = local.mandatory_tags
}
