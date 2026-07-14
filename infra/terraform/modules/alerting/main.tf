################################################################################
# Brain – Actionable Alerting Module (ADR-0004, OE-1/OE-2)
#
# The Well-Architected review found the two weakest pillars — Operational
# Excellence + a Security gap — are *wiring* problems: "nothing pages anyone".
# Every existing CloudWatch alarm is either an EC2 built-in auto-action
# (recover/reboot on the fck-nat) or explicitly alarm_actions-less (the Aurora
# ACU, Redis eviction/memory tripwires, and the composite EKS-unhealthy alarm).
# `grep aws_sns_topic infra/terraform` → none, before this module.
#
# This module is the missing paging SINK. It creates:
#   - ONE SNS topic `brain-<env>-alerts` (KMS-encrypted with the shared CMK),
#   - an email subscription (var alert_email),
#   - an OPTIONAL AWS Chatbot / Slack channel configuration (var-gated, default
#     off — Chatbot needs a one-time console workspace authorization),
#   - an EventBridge rule that routes GuardDuty findings at/above a severity
#     floor (var guardduty_finding_severity_floor) to the same topic.
#
# The 5 existing CloudWatch alarms (2 nat-instance EC2-automate, 1 Aurora ACU,
# 2 Redis tripwires, 1 composite EKS-unhealthy) are wired to this topic by
# passing `alarm_sns_topic_arn` (this module's output) into those modules — an
# ADDITIVE change: their alarm_actions default stays [] so an un-wired plan is
# unchanged.
#
# COST: SNS + EventBridge are effectively free at this alarm volume (a few
# notifications/mo); Chatbot is free. Within the FinOps budget guardrails (07).
#
# ROLLBACK: additive Terraform — `terraform destroy -target module.alerting`
# or `git revert` returns the account to its prior (un-paged) state. No
# destructive dependency.
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

variable "environment" {
  type = string
}

variable "project" {
  type    = string
  default = "brain"
}

variable "kms_key_arn" {
  type        = string
  description = "CMK ARN for SNS topic server-side encryption (the shared root CMK)."
}

variable "alert_email" {
  type        = string
  description = <<-EOT
    Email address subscribed to the alerts SNS topic. AWS sends a
    confirmation email that MUST be clicked once before delivery starts
    (Terraform shows the subscription as pending_confirmation until then).
    Empty string = no email subscription (topic still created).
  EOT
  default     = ""
}

variable "enable_slack_chatbot" {
  type        = bool
  description = <<-EOT
    Enable an AWS Chatbot Slack channel configuration on the alerts topic.
    Default false: Chatbot requires a ONE-TIME console step to authorize the
    Slack workspace (aws chatbot -> configure Slack client) before the
    workspace id below is valid. Flip true + set slack_workspace_id /
    slack_channel_id AFTER that authorization.
  EOT
  default     = false
}

variable "slack_workspace_id" {
  type        = string
  description = "Slack workspace id from the AWS Chatbot console authorization (required when enable_slack_chatbot=true)."
  default     = ""
}

variable "slack_channel_id" {
  type        = string
  description = "Slack channel id AWS Chatbot posts alerts to (required when enable_slack_chatbot=true)."
  default     = ""
}

variable "guardduty_finding_severity_floor" {
  type        = number
  description = <<-EOT
    Minimum GuardDuty finding severity (numeric, 1-8.9) routed to SNS via
    EventBridge. GuardDuty severity bands: LOW 1.0-3.9, MEDIUM 4.0-6.9,
    HIGH 7.0-8.9. Default 4 = MEDIUM+ (skip the noisy LOW findings).
  EOT
  default     = 4
}

variable "guardduty_detector_id" {
  type        = string
  description = <<-EOT
    GuardDuty detector id, used ONLY to make the EventBridge rule depend on the
    detector existing (findings are account/region-scoped, not detector-scoped
    in the event pattern). Empty = create the rule anyway (findings still route
    once a detector exists). Pass module.security_baseline.guardduty_detector_id.
  EOT
  default     = ""
}

locals {
  topic_name = "${var.project}-${var.environment}-alerts"
  common_tags = {
    project     = var.project
    environment = var.environment
    purpose     = "alerting"
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

###############################################################################
# SNS topic — the single actionable-alert sink (KMS-encrypted)
###############################################################################
resource "aws_sns_topic" "alerts" {
  name              = local.topic_name
  kms_master_key_id = var.kms_key_arn

  tags = merge(local.common_tags, {
    Name = local.topic_name
  })
}

# Allow CloudWatch alarms + EventBridge to publish to the topic. CloudWatch
# alarm publish is granted via the AWS-managed service principal; EventBridge
# publishes the GuardDuty rule below.
data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid     = "AllowServicesToPublish"
    effect  = "Allow"
    actions = ["SNS:Publish"]
    principals {
      type = "Service"
      identifiers = [
        "cloudwatch.amazonaws.com",
        "events.amazonaws.com",
      ]
    }
    resources = [aws_sns_topic.alerts.arn]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid     = "AllowAccountManage"
    effect  = "Allow"
    actions = ["SNS:Publish", "SNS:Subscribe", "SNS:GetTopicAttributes", "SNS:SetTopicAttributes"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    resources = [aws_sns_topic.alerts.arn]
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

###############################################################################
# Email subscription (pending until the operator clicks the confirmation email)
###############################################################################
resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

###############################################################################
# EventBridge — route GuardDuty findings >= severity floor to SNS
###############################################################################
resource "aws_cloudwatch_event_rule" "guardduty_findings" {
  name        = "${var.project}-${var.environment}-guardduty-findings"
  description = "GuardDuty findings at/above severity ${var.guardduty_finding_severity_floor} -> SNS alerts (ADR-0004)"

  event_pattern = jsonencode({
    source      = ["aws.guardduty"]
    detail-type = ["GuardDuty Finding"]
    detail = {
      severity = [{ numeric = [">=", var.guardduty_finding_severity_floor] }]
    }
  })

  tags = merge(local.common_tags, {
    Name = "${var.project}-${var.environment}-guardduty-findings"
  })
}

resource "aws_cloudwatch_event_target" "guardduty_to_sns" {
  rule      = aws_cloudwatch_event_rule.guardduty_findings.name
  target_id = "guardduty-to-alerts-sns"
  arn       = aws_sns_topic.alerts.arn

  # Compact the finding into a readable notification (title + severity + type).
  input_transformer {
    input_paths = {
      severity    = "$.detail.severity"
      type        = "$.detail.type"
      title       = "$.detail.title"
      region      = "$.region"
      account     = "$.account"
      description = "$.detail.description"
    }
    input_template = <<-EOT
      "GuardDuty finding (severity <severity>) in <account>/<region>: <title> [<type>] — <description>"
    EOT
  }
}

###############################################################################
# AWS Chatbot / Slack (var-gated; requires one-time console workspace auth)
###############################################################################
# IAM role Chatbot assumes to read alarm context (least-privilege: read-only
# CloudWatch + SNS). Chatbot itself only needs to render notifications here.
data "aws_iam_policy_document" "chatbot_assume" {
  count = var.enable_slack_chatbot ? 1 : 0
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["chatbot.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "chatbot" {
  count              = var.enable_slack_chatbot ? 1 : 0
  name               = "${var.project}-${var.environment}-chatbot-alerts"
  assume_role_policy = data.aws_iam_policy_document.chatbot_assume[0].json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "chatbot_readonly" {
  count      = var.enable_slack_chatbot ? 1 : 0
  role       = aws_iam_role.chatbot[0].name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess"
}

resource "aws_chatbot_slack_channel_configuration" "alerts" {
  count              = var.enable_slack_chatbot ? 1 : 0
  configuration_name = "${var.project}-${var.environment}-alerts"
  iam_role_arn       = aws_iam_role.chatbot[0].arn
  slack_channel_id   = var.slack_channel_id
  slack_team_id      = var.slack_workspace_id
  sns_topic_arns     = [aws_sns_topic.alerts.arn]
  logging_level      = "ERROR"

  tags = local.common_tags
}

###############################################################################
# Outputs
###############################################################################
output "sns_topic_arn" {
  description = "The brain-<env>-alerts SNS topic ARN — pass as alarm_sns_topic_arn to the alarm-owning modules."
  value       = aws_sns_topic.alerts.arn
}

output "sns_topic_name" {
  value = aws_sns_topic.alerts.name
}

output "guardduty_event_rule_arn" {
  value = aws_cloudwatch_event_rule.guardduty_findings.arn
}
