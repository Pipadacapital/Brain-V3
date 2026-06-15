################################################################################
# Brain – GitHub Actions OIDC Module
# Creates the GitHub OIDC provider + CI plan/apply role for the Terraform IaC gate.
# NN-3: StringEquals on oidc:sub — repo + branch scoped, never wildcard.
# Provides short-lived credentials; NO static AWS keys in GitHub secrets.
################################################################################

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

variable "environment" {
  type = string
}

variable "project" {
  type    = string
  default = "brain"
}

variable "github_org" {
  type        = string
  description = "GitHub organisation name"
}

variable "github_repo" {
  type        = string
  description = "GitHub repository name (without org)"
}

variable "allowed_branches" {
  type        = list(string)
  description = "Branches allowed to assume the plan role"
  default     = ["main"]
}

data "aws_caller_identity" "current" {}

###############################################################################
# GitHub OIDC provider (one per account)
###############################################################################
data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github.certificates[0].sha1_fingerprint]

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "github-actions-oidc"
  }
}

###############################################################################
# Terraform PLAN role
# NN-3: StringEquals on oidc:sub — repo-scoped, never StringLike with wildcard
###############################################################################
data "aws_iam_policy_document" "github_plan_trust" {
  statement {
    sid     = "GitHubActionsPlanTrust"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    # NN-3: StringEquals on sub — repo + branch scoped
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        for branch in var.allowed_branches :
        "repo:${var.github_org}/${var.github_repo}:ref:refs/heads/${branch}"
      ]
    }

    # NN-3: Constrain aud
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "github_plan" {
  name               = "${var.project}-${var.environment}-github-plan"
  assume_role_policy = data.aws_iam_policy_document.github_plan_trust.json

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "github-actions-terraform-plan"
  }
}

data "aws_iam_policy_document" "github_plan_permissions" {
  statement {
    sid    = "AllowTerraformPlan"
    effect = "Allow"
    actions = [
      "ec2:Describe*",
      "eks:Describe*",
      "eks:List*",
      "iam:Get*",
      "iam:List*",
      "kms:Describe*",
      "kms:List*",
      "rds:Describe*",
      "elasticache:Describe*",
      "s3:GetBucket*",
      "s3:ListBucket*",
      "s3:GetEncryptionConfiguration",
      "s3:GetBucketVersioning",
      "s3:GetBucketObjectLockConfiguration",
      "secretsmanager:Describe*",
      "secretsmanager:List*",
      "glue:Get*",
      "cloudwatch:Describe*",
      "cloudwatch:List*",
      "logs:Describe*",
      "dynamodb:Describe*",
      "dynamodb:List*",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "AllowStateRead"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [
      "arn:aws:s3:::${var.project}-tfstate-${var.environment}-*",
      "arn:aws:s3:::${var.project}-tfstate-${var.environment}-*/*",
    ]
  }

  statement {
    sid    = "AllowStateLock"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    ]
    resources = [
      "arn:aws:dynamodb:*:${data.aws_caller_identity.current.account_id}:table/${var.project}-tfstate-lock-${var.environment}",
    ]
  }
}

resource "aws_iam_role_policy" "github_plan" {
  name   = "${var.project}-${var.environment}-github-plan-permissions"
  role   = aws_iam_role.github_plan.id
  policy = data.aws_iam_policy_document.github_plan_permissions.json
}

###############################################################################
# Outputs
###############################################################################
output "oidc_provider_arn" {
  description = "ARN of the GitHub Actions OIDC provider"
  value       = aws_iam_openid_connect_provider.github.arn
}

output "oidc_provider_url" {
  description = "URL of the GitHub Actions OIDC provider"
  value       = aws_iam_openid_connect_provider.github.url
}

output "github_plan_role_arn" {
  description = "ARN of the Terraform plan role for CI (consumed by Track B)"
  value       = aws_iam_role.github_plan.arn
}
