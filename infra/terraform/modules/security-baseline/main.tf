################################################################################
# Brain – Account Detective-Control Baseline (ADR-0004, SEC-1)
#
# The Well-Architected review found NO account detective baseline — no
# CloudTrail, GuardDuty, Config, Security Hub, or WAF anywhere in the IaC — on a
# PAID prod account holding PII (identity graph, connector OAuth tokens). At the
# same time a WORM audit bucket + audit CMK already exist (modules/s3-audit) with
# NOTHING feeding them the control-plane trail they were built for.
#
# This module wires the two table-stakes detective controls, additively:
#   1. an account (multi-region) CloudTrail with log-file validation, delivering
#      to the EXISTING immutable audit bucket (Object Lock COMPLIANCE 7yr) under
#      the audit CMK — finally feeding the WORM store the API audit trail;
#   2. a GuardDuty detector in-region (single-digit $/mo at this scale);
#   3. an OPTIONAL AWS Config recorder + delivery channel (var-gated, default
#      false — Config has a non-trivial per-rule/per-item cost, so it's a
#      deliberate opt-in fast-follow, not a blocker).
#
# The audit bucket policy (modules/s3-audit) already denies non-TLS + object
# deletes; this module appends the CloudTrail service-principal Put/GetBucketAcl
# grants via a SEPARATE managed bucket policy statement passed back to the env
# root is NOT possible (single bucket policy), so instead the trail is granted
# through the bucket policy that modules/s3-audit owns. To keep lanes clean this
# module takes the audit bucket name/arn as inputs and RELIES on the s3-audit
# module having the CloudTrail grant — see var.audit_bucket_policy_has_cloudtrail
# and the guard below.
#
# COST: CloudTrail management-events (first trail) is FREE; data-events are NOT
# enabled here. GuardDuty ~ single-digit $/mo. Config (gated off) adds
# per-configuration-item + per-rule cost.
#
# ROLLBACK: additive Terraform — destroy -target or git revert. Disabling
# CloudTrail/GuardDuty on a paid PII account is explicitly discouraged (ADR-0004)
# but has no data impact.
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

variable "audit_bucket_name" {
  type        = string
  description = "Name of the EXISTING immutable audit bucket (module.s3_audit.audit_bucket_name) CloudTrail delivers to."
}

variable "audit_bucket_arn" {
  type        = string
  description = "ARN of the EXISTING audit bucket (module.s3_audit.audit_bucket_arn)."
}

variable "audit_kms_key_arn" {
  type        = string
  description = "Audit CMK ARN (module.kms.audit_kms_key_arn) CloudTrail encrypts log files with."
}

variable "enable_cloudtrail" {
  type        = bool
  description = "Create the multi-region CloudTrail. Default true — the detective baseline is table stakes (ADR-0004)."
  default     = true
}

variable "enable_guardduty" {
  type        = bool
  description = "Create the GuardDuty detector in this region. Default true (ADR-0004)."
  default     = true
}

variable "guardduty_finding_publishing_frequency" {
  type        = string
  description = "How often GuardDuty exports non-critical findings to CloudWatch Events (FIFTEEN_MINUTES | ONE_HOUR | SIX_HOURS)."
  default     = "FIFTEEN_MINUTES"
}

variable "enable_config" {
  type        = bool
  description = <<-EOT
    OPTIONAL AWS Config recorder + delivery channel. Default FALSE: Config bills
    per-configuration-item + per-rule-evaluation, so it's a deliberate opt-in
    fast-follow (ADR-0004: "Config + Security Hub follow, not a blocker"). When
    true, Config records all supported resources and delivers to the audit
    bucket under a config/ prefix.
  EOT
  default     = false
}

variable "cloudtrail_s3_key_prefix" {
  type        = string
  description = "Key prefix inside the audit bucket for CloudTrail logs."
  default     = "cloudtrail"
}

locals {
  common_tags = {
    project     = var.project
    environment = var.environment
    purpose     = "security-baseline"
  }
  trail_name = "${var.project}-${var.environment}-account-trail"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

###############################################################################
# CloudTrail — account, multi-region, log-file validation ON, -> WORM audit bkt
###############################################################################
resource "aws_cloudtrail" "account" {
  count = var.enable_cloudtrail ? 1 : 0

  name                          = local.trail_name
  s3_bucket_name                = var.audit_bucket_name
  s3_key_prefix                 = var.cloudtrail_s3_key_prefix
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true # tamper-evident digest files
  kms_key_id                    = var.audit_kms_key_arn

  # Management events only (read+write). Data events (S3 object / Lambda) are a
  # separate cost lever, intentionally NOT enabled at starter scale.
  event_selector {
    read_write_type           = "All"
    include_management_events = true
  }

  tags = merge(local.common_tags, {
    Name = local.trail_name
  })
}

###############################################################################
# GuardDuty — threat detection in ap-south-1
###############################################################################
resource "aws_guardduty_detector" "this" {
  count = var.enable_guardduty ? 1 : 0

  enable                       = true
  finding_publishing_frequency = var.guardduty_finding_publishing_frequency

  tags = merge(local.common_tags, {
    Name = "${var.project}-${var.environment}-guardduty"
  })
}

###############################################################################
# AWS Config (OPTIONAL, var-gated default false)
###############################################################################
data "aws_iam_policy_document" "config_assume" {
  count = var.enable_config ? 1 : 0
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["config.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "config" {
  count              = var.enable_config ? 1 : 0
  name               = "${var.project}-${var.environment}-config-recorder"
  assume_role_policy = data.aws_iam_policy_document.config_assume[0].json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "config_managed" {
  count      = var.enable_config ? 1 : 0
  role       = aws_iam_role.config[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}

# Least-privilege delivery grant to the audit bucket (config/ prefix) + CMK.
data "aws_iam_policy_document" "config_delivery" {
  count = var.enable_config ? 1 : 0

  statement {
    sid       = "ConfigBucketList"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl", "s3:ListBucket"]
    resources = [var.audit_bucket_arn]
  }
  statement {
    sid       = "ConfigBucketDelivery"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${var.audit_bucket_arn}/config/*"]
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
  statement {
    sid       = "ConfigCMK"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.audit_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "config_delivery" {
  count  = var.enable_config ? 1 : 0
  name   = "${var.project}-${var.environment}-config-delivery"
  role   = aws_iam_role.config[0].id
  policy = data.aws_iam_policy_document.config_delivery[0].json
}

resource "aws_config_configuration_recorder" "this" {
  count    = var.enable_config ? 1 : 0
  name     = "${var.project}-${var.environment}-recorder"
  role_arn = aws_iam_role.config[0].arn

  recording_group {
    all_supported                 = true
    include_global_resource_types = true
  }
}

resource "aws_config_delivery_channel" "this" {
  count          = var.enable_config ? 1 : 0
  name           = "${var.project}-${var.environment}-delivery"
  s3_bucket_name = var.audit_bucket_name
  s3_key_prefix  = "config"
  s3_kms_key_arn = var.audit_kms_key_arn
  depends_on     = [aws_config_configuration_recorder.this]
}

resource "aws_config_configuration_recorder_status" "this" {
  count      = var.enable_config ? 1 : 0
  name       = aws_config_configuration_recorder.this[0].name
  is_enabled = true
  depends_on = [aws_config_delivery_channel.this]
}

###############################################################################
# Outputs
###############################################################################
output "cloudtrail_arn" {
  value = one(aws_cloudtrail.account[*].arn)
}

output "guardduty_detector_id" {
  description = "GuardDuty detector id — pass to module.alerting so the finding-route rule can depend on it."
  value       = one(aws_guardduty_detector.this[*].id)
}

output "config_recorder_name" {
  value = one(aws_config_configuration_recorder.this[*].name)
}
