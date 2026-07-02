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

# AUD-COST-002: the CI/CD identity roles the GitHub workflows assume.
# deploy.yml (push to master) → vars.AWS_ECR_PUSH_ROLE_ARN (image build/push/sign);
# prod-apply.yml (workflow_dispatch + `production` Environment) → vars.AWS_PROD_APPLY_ROLE_ARN.
# Off by default so dev/staging keep the plan-only posture; enable in envs/prod.
variable "create_cicd_roles" {
  type        = bool
  description = "Create the GitHub Actions ECR-push and terraform-apply roles (prod CI/CD identity)."
  default     = false
}

variable "apply_environment" {
  type        = string
  description = "GitHub Environment gating the apply workflow. Environment-bound jobs present sub = repo:<org>/<repo>:environment:<name> (NOT a branch ref)."
  default     = "production"
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
# ECR PUSH role (AUD-COST-002) — assumed by .github/workflows/deploy.yml on push
# to the default branch to build/push/cosign-sign the service images. Scoped to
# the ${project}-*-${environment} repositories created in modules/eks.
###############################################################################
data "aws_iam_policy_document" "github_ecr_push_trust" {
  count = var.create_cicd_roles ? 1 : 0

  statement {
    sid     = "GitHubActionsEcrPushTrust"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    # NN-3: StringEquals on sub — repo + branch scoped (push events on master)
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        for branch in var.allowed_branches :
        "repo:${var.github_org}/${var.github_repo}:ref:refs/heads/${branch}"
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "github_ecr_push_permissions" {
  count = var.create_cicd_roles ? 1 : 0

  # GetAuthorizationToken is account-level — cannot be resource-scoped.
  statement {
    sid       = "AllowEcrLogin"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Push + pull (buildx cache reads) on the per-service repos only. Cosign
  # signatures are OCI artifacts pushed to the same repos — covered here.
  statement {
    sid    = "AllowServiceRepoPushPull"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
    ]
    resources = [
      "arn:aws:ecr:*:${data.aws_caller_identity.current.account_id}:repository/${var.project}-*-${var.environment}",
    ]
  }
}

resource "aws_iam_role" "github_ecr_push" {
  count              = var.create_cicd_roles ? 1 : 0
  name               = "${var.project}-${var.environment}-github-ecr-push"
  assume_role_policy = data.aws_iam_policy_document.github_ecr_push_trust[0].json

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "github-actions-ecr-push"
  }
}

resource "aws_iam_role_policy" "github_ecr_push" {
  count  = var.create_cicd_roles ? 1 : 0
  name   = "${var.project}-${var.environment}-github-ecr-push-permissions"
  role   = aws_iam_role.github_ecr_push[0].id
  policy = data.aws_iam_policy_document.github_ecr_push_permissions[0].json
}

###############################################################################
# Terraform APPLY role (AUD-COST-002) — assumed by .github/workflows/prod-apply.yml.
# That job is bound to the `production` GitHub Environment, so the OIDC sub is
# repo:<org>/<repo>:environment:<name> (never a branch ref) — trust exactly that.
# Human gates live in the workflow (confirm phrase + Environment reviewers).
###############################################################################
data "aws_iam_policy_document" "github_apply_trust" {
  count = var.create_cicd_roles ? 1 : 0

  statement {
    sid     = "GitHubActionsApplyTrust"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_org}/${var.github_repo}:environment:${var.apply_environment}"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "github_apply" {
  count              = var.create_cicd_roles ? 1 : 0
  name               = "${var.project}-${var.environment}-github-apply"
  assume_role_policy = data.aws_iam_policy_document.github_apply_trust[0].json

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "github-actions-terraform-apply"
  }
}

# Admin-scoped by design: the env root manages IAM/EKS/RDS/S3/KMS/VPC — a
# hand-rolled allowlist WILL drift and brick prod applies. Access is bounded by
# the environment-scoped OIDC trust above + the workflow's human approval gate.
# Scope down post-launch if desired (PowerUserAccess + a tight IAM statement).
resource "aws_iam_role_policy_attachment" "github_apply_admin" {
  count      = var.create_cicd_roles ? 1 : 0
  role       = aws_iam_role.github_apply[0].name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
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

output "github_ecr_push_role_arn" {
  description = "ARN of the ECR push role (repo variable AWS_ECR_PUSH_ROLE_ARN); null unless create_cicd_roles"
  value       = var.create_cicd_roles ? aws_iam_role.github_ecr_push[0].arn : null
}

output "github_apply_role_arn" {
  description = "ARN of the terraform apply role (repo variable AWS_PROD_APPLY_ROLE_ARN); null unless create_cicd_roles"
  value       = var.create_cicd_roles ? aws_iam_role.github_apply[0].arn : null
}
