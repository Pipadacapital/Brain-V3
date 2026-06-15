################################################################################
# Brain – IRSA Module (NN-3 enforced)
# Produces an IAM role with an OIDC trust policy that uses StringEquals on
# BOTH oidc:sub (namespace + service-account) AND oidc:aud.
# NEVER uses StringLike or wildcards on the subject — NN-3 non-negotiable.
################################################################################

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

###############################################################################
# Variables
###############################################################################
variable "role_name" {
  description = "IAM role name for this workload"
  type        = string
}

variable "oidc_provider_arn" {
  description = "ARN of the EKS OIDC provider"
  type        = string
}

variable "oidc_provider_url" {
  description = "URL of the EKS OIDC provider (without https://)"
  type        = string
}

variable "namespace" {
  description = "Kubernetes namespace where the service account lives"
  type        = string
}

variable "service_account_name" {
  description = "Kubernetes service account name"
  type        = string
}

variable "policy_arns" {
  description = "List of IAM policy ARNs to attach to the role"
  type        = list(string)
  default     = []
}

variable "inline_policy_json" {
  description = "Optional inline policy document JSON to attach"
  type        = string
  default     = null
}

variable "environment" {
  type = string
}

variable "project" {
  type    = string
  default = "brain"
}

###############################################################################
# OIDC Trust Policy — NN-3: StringEquals on namespace+SA, never StringLike
###############################################################################
data "aws_iam_policy_document" "trust" {
  statement {
    sid     = "EKSOIDCTrust"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    # NN-3 CRITICAL: StringEquals on oidc:sub — NEVER StringLike
    # sub = "system:serviceaccount:<namespace>:<service-account-name>"
    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:sub"
      values   = ["system:serviceaccount:${var.namespace}:${var.service_account_name}"]
    }

    # NN-3: Also constrain aud to prevent token reuse across services
    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

###############################################################################
# IAM Role
###############################################################################
resource "aws_iam_role" "this" {
  name               = "${var.project}-${var.environment}-${var.role_name}"
  assume_role_policy = data.aws_iam_policy_document.trust.json

  tags = {
    project     = var.project
    environment = var.environment
    workload    = var.role_name
    namespace   = var.namespace
    sa          = var.service_account_name
    managed_by  = "terraform"
  }
}

###############################################################################
# Attach managed policies
###############################################################################
resource "aws_iam_role_policy_attachment" "managed" {
  count      = length(var.policy_arns)
  role       = aws_iam_role.this.name
  policy_arn = var.policy_arns[count.index]
}

###############################################################################
# Optional inline policy
###############################################################################
resource "aws_iam_role_policy" "inline" {
  count  = var.inline_policy_json != null ? 1 : 0
  name   = "${var.project}-${var.environment}-${var.role_name}-inline"
  role   = aws_iam_role.this.id
  policy = var.inline_policy_json
}

###############################################################################
# Outputs
###############################################################################
output "role_arn" {
  description = "ARN of the created IRSA role"
  value       = aws_iam_role.this.arn
}

output "role_name" {
  description = "Name of the created IRSA role"
  value       = aws_iam_role.this.name
}
