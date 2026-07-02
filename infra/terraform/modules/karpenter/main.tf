################################################################################
# Brain – Karpenter Module (AUD-COST-010)
#
# The terraform half of the Karpenter wiring that infra/helm/karpenter/README.md
# ("IAM the operator must add") documented but nothing implemented:
#   1. Controller IRSA role  ${project}-${environment}-karpenter-controller
#      (trusted by the EKS OIDC provider for kube-system/karpenter — the SA the
#      upstream chart creates; annotated via infra/argocd/envs/prod/karpenter.yaml).
#   2. SQS interruption queue named after the cluster (Spot interruption /
#      rebalance / state-change / scheduled-change drain) + EventBridge rules.
#   3. NODE ROLE IS REUSED, not created: EC2NodeClass.role = the eks module's
#      ${project}-${environment}-eks-node (Karpenter v1 manages the instance
#      profile for it — hence the iam:*InstanceProfile grants below).
#
# The karpenter.sh/discovery tags the NodePools match on are set in
# modules/network (private subnets + node SG), value = the cluster name.
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
variable "environment" {
  type = string
}

variable "project" {
  type    = string
  default = "brain"
}

variable "cluster_name" {
  type        = string
  description = "EKS cluster name (module.eks.cluster_name). Also the interruption queue name — must equal settings.interruptionQueue in the karpenter ArgoCD app."
}

variable "oidc_provider_arn" {
  type        = string
  description = "EKS OIDC provider ARN (module.eks.oidc_provider_arn)."
}

variable "oidc_provider_url" {
  type        = string
  description = "EKS OIDC provider URL without https:// (module.eks.oidc_provider_url)."
}

variable "node_role_arn" {
  type        = string
  description = "The eks module node role ARN (module.eks.node_role_arn) that Karpenter-launched nodes assume (EC2NodeClass.role)."
}

data "aws_caller_identity" "current" {}

locals {
  name_prefix = "${var.project}-${var.environment}"

  # AUD-NAME-001: the four mandatory PascalCase keys (Environment/Service/
  # Owner/CostCenter — AWS treats environment/Environment as distinct keys;
  # Environment was the missing 4th). Lowercase project/environment kept for
  # continuity with the applied resources until the doc's §6 duplicate-strip.
  common_tags = {
    project     = var.project
    environment = var.environment
    Environment = var.environment
    Service     = "karpenter"
    Owner       = "data-team"
    CostCenter  = "brain-platform"
  }
}

###############################################################################
# Interruption queue — Spot interruption warning / rebalance recommendation /
# instance state-change / AWS Health scheduled change all drain via this queue.
# Name == cluster name (what karpenter.yaml passes as settings.interruptionQueue).
###############################################################################
resource "aws_sqs_queue" "interruption" {
  name                      = var.cluster_name
  message_retention_seconds = 300
  sqs_managed_sse_enabled   = true

  tags = local.common_tags
}

data "aws_iam_policy_document" "interruption_queue" {
  statement {
    sid     = "AllowEventBridgeAndSqsSend"
    effect  = "Allow"
    actions = ["sqs:SendMessage"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com", "sqs.amazonaws.com"]
    }
    resources = [aws_sqs_queue.interruption.arn]
  }

  statement {
    sid     = "DenyNonTLS"
    effect  = "Deny"
    actions = ["sqs:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_sqs_queue.interruption.arn]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "interruption" {
  queue_url = aws_sqs_queue.interruption.id
  policy    = data.aws_iam_policy_document.interruption_queue.json
}

# EventBridge rules — the four event classes the Karpenter interruption
# controller consumes (mirrors the upstream karpenter CloudFormation).
locals {
  interruption_rules = {
    spot-interruption = {
      source      = "aws.ec2"
      detail_type = "EC2 Spot Instance Interruption Warning"
    }
    rebalance = {
      source      = "aws.ec2"
      detail_type = "EC2 Instance Rebalance Recommendation"
    }
    instance-state-change = {
      source      = "aws.ec2"
      detail_type = "EC2 Instance State-change Notification"
    }
    scheduled-change = {
      source      = "aws.health"
      detail_type = "AWS Health Event"
    }
  }
}

resource "aws_cloudwatch_event_rule" "interruption" {
  for_each = local.interruption_rules

  name = "${local.name_prefix}-karpenter-${each.key}"
  event_pattern = jsonencode({
    source        = [each.value.source]
    "detail-type" = [each.value.detail_type]
  })

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "interruption" {
  for_each = aws_cloudwatch_event_rule.interruption

  rule      = each.value.name
  target_id = "KarpenterInterruptionQueue"
  arn       = aws_sqs_queue.interruption.arn
}

###############################################################################
# Controller IRSA role — NN-3: StringEquals on kube-system/karpenter (the SA
# the upstream chart creates; ArgoCD annotates it with this role's ARN).
###############################################################################
data "aws_iam_policy_document" "controller_trust" {
  statement {
    sid     = "KarpenterControllerTrust"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:sub"
      values   = ["system:serviceaccount:kube-system:karpenter"]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "controller" {
  name               = "${local.name_prefix}-karpenter-controller"
  assume_role_policy = data.aws_iam_policy_document.controller_trust.json

  tags = local.common_tags
}

# Karpenter v1 controller permissions (mirrors the upstream controller policy,
# account-scoped where the API allows it).
data "aws_iam_policy_document" "controller" {
  statement {
    sid    = "AllowEC2Provisioning"
    effect = "Allow"
    actions = [
      "ec2:CreateFleet",
      "ec2:CreateLaunchTemplate",
      "ec2:CreateTags",
      "ec2:DeleteLaunchTemplate",
      "ec2:RunInstances",
      "ec2:TerminateInstances",
      "ec2:Describe*",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "AllowPricing"
    effect    = "Allow"
    actions   = ["pricing:GetProducts"]
    resources = ["*"]
  }

  # EKS-optimized AMI alias lookup (public SSM parameters, no account in ARN).
  statement {
    sid       = "AllowSsmAmiLookup"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:*::parameter/aws/service/*"]
  }

  statement {
    sid       = "AllowEksDescribe"
    effect    = "Allow"
    actions   = ["eks:DescribeCluster"]
    resources = ["arn:aws:eks:*:${data.aws_caller_identity.current.account_id}:cluster/${var.cluster_name}"]
  }

  # Launched nodes assume the EXISTING eks-module node role.
  statement {
    sid       = "AllowPassNodeRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [var.node_role_arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }

  # Karpenter v1 manages the instance profile for the node role itself.
  statement {
    sid    = "AllowInstanceProfileManagement"
    effect = "Allow"
    actions = [
      "iam:AddRoleToInstanceProfile",
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:GetInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
      "iam:TagInstanceProfile",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:instance-profile/*"]
  }

  statement {
    sid    = "AllowInterruptionQueue"
    effect = "Allow"
    actions = [
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ReceiveMessage",
    ]
    resources = [aws_sqs_queue.interruption.arn]
  }
}

resource "aws_iam_role_policy" "controller" {
  name   = "${local.name_prefix}-karpenter-controller"
  role   = aws_iam_role.controller.id
  policy = data.aws_iam_policy_document.controller.json
}

###############################################################################
# Outputs
###############################################################################
output "controller_role_arn" {
  description = "Karpenter controller IRSA role ARN — fill into the serviceAccount annotation in infra/argocd/envs/prod/karpenter.yaml (replaces ACCOUNT_ID placeholder)."
  value       = aws_iam_role.controller.arn
}

output "interruption_queue_name" {
  description = "Interruption queue name (== settings.interruptionQueue in karpenter.yaml)."
  value       = aws_sqs_queue.interruption.name
}

output "interruption_queue_arn" {
  value = aws_sqs_queue.interruption.arn
}
