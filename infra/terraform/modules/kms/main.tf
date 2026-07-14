################################################################################
# Brain – KMS Module
# Creates the root CMK set for Brain. Per-brand DEK creation is a runtime
# operation (brand onboarding) — Sprint-0 IaC only declares the CMK + alias
# path; it does NOT create per-brand DEKs.
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

# ADR-0004 (SEC-4): give the AUDIT CMK its own key policy that does NOT
# blanket-delegate kms:* to account root — so an everyday IAM mistake cannot
# reach the tamper-evidence key — while still granting CloudTrail the
# GenerateDataKey/DescribeKey it needs to encrypt log files. Default false keeps
# the current shared root_kms_policy (no-op), so this is fully additive; the
# prod root flips it on. The root + connector CMKs keep the common
# AllowAccountRoot pattern (ADR-0004 explicitly scopes the tightening to audit).
variable "isolate_audit_cmk_policy" {
  type        = bool
  description = "Apply a dedicated non-blanket key policy to the audit CMK (ADR-0004 SEC-4)."
  default     = false
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

###############################################################################
# Root CMK — general-purpose encryption for S3, Secrets Manager, RDS, etc.
###############################################################################
resource "aws_kms_key" "root" {
  description             = "Brain root CMK (${var.environment}) — S3/SM/RDS encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.root_kms_policy.json

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "root-cmk"
  }
}

resource "aws_kms_alias" "root" {
  name          = "alias/${var.project}-root-${var.environment}"
  target_key_id = aws_kms_key.root.key_id
}

###############################################################################
# Audit CMK — dedicated CMK for audit-log and WORM anchor bucket
###############################################################################
resource "aws_kms_key" "audit" {
  description             = "Brain audit CMK (${var.environment}) — audit-log + WORM bucket"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  # SEC-4: dedicated isolated policy when enabled, else the shared root policy.
  policy = var.isolate_audit_cmk_policy ? data.aws_iam_policy_document.audit_kms_policy.json : data.aws_iam_policy_document.root_kms_policy.json

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "audit-cmk"
  }
}

resource "aws_kms_alias" "audit" {
  name          = "alias/${var.project}-audit-${var.environment}"
  target_key_id = aws_kms_key.audit.key_id
}

###############################################################################
# Connector-secrets CMK (AUD-PROD-004) — encrypts the runtime-created
# brain/connector/<provider>/<brandId> Secrets Manager entries (OAuth tokens,
# packages/connector-secrets AwsSecretsManager passes this key as KmsKeyId) and
# wraps the per-brand PII-vault DEKs/identity salts (KmsVaultKeyProvider).
# Prod equivalent of the LocalStack alias/brain-connector-secrets provisioned
# by tools/seed/prod-local-aws-bootstrap.sh; alias follows the applied
# alias/brain-<resource>-<env> convention. Fill CONNECTOR_SECRETS_KMS_KEY_ID
# (core-env) and KMS_KEY_ID (stream-worker-env) with this key's ARN.
# Access model matches the root/audit CMKs: account-root key policy delegates
# to IAM — the encrypt/decrypt grants live in modules/secrets and attach to
# the core / stream-worker IRSA roles.
###############################################################################
resource "aws_kms_key" "connector" {
  description             = "Brain connector-secrets CMK (${var.environment}) — brain/connector/* SM entries + PII-vault DEK wrapping"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.root_kms_policy.json

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "connector-secrets-cmk"
  }
}

resource "aws_kms_alias" "connector" {
  name          = "alias/${var.project}-connector-secrets-${var.environment}"
  target_key_id = aws_kms_key.connector.key_id
}

###############################################################################
# KMS key policy — allow account root
###############################################################################
data "aws_iam_policy_document" "root_kms_policy" {
  statement {
    sid       = "AllowAccountRoot"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

###############################################################################
# Audit CMK isolated policy (SEC-4) — used only when isolate_audit_cmk_policy.
# Root gets KMS ADMINISTRATION (key lifecycle/policy) but NOT the blanket kms:*
# that includes cryptographic + grant operations; CloudTrail gets exactly the
# encrypt-side operations it needs. This keeps the tamper-evidence key out of
# reach of an everyday IAM data-plane grant while remaining self-administrable.
###############################################################################
data "aws_iam_policy_document" "audit_kms_policy" {
  # Key administration (lifecycle/policy) — NOT Encrypt/Decrypt/GrantCreate.
  statement {
    sid    = "AllowKeyAdministration"
    effect = "Allow"
    actions = [
      "kms:Create*",
      "kms:Describe*",
      "kms:Enable*",
      "kms:List*",
      "kms:Put*",
      "kms:Update*",
      "kms:Revoke*",
      "kms:Disable*",
      "kms:Get*",
      "kms:Delete*",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
    ]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  # CloudTrail: encrypt log files (GenerateDataKey) + describe the key.
  statement {
    sid       = "AllowCloudTrailEncrypt"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  # S3 SSE-KMS: the audit bucket re-encrypts objects (checkpoints + CloudTrail
  # logs) with this CMK on write; readers (audit-writer role) Decrypt.
  statement {
    sid    = "AllowS3AndAuditWriters"
    effect = "Allow"
    actions = [
      "kms:GenerateDataKey*",
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

###############################################################################
# Outputs
###############################################################################
output "root_kms_key_arn" {
  value = aws_kms_key.root.arn
}

output "root_kms_key_id" {
  value = aws_kms_key.root.key_id
}

output "audit_kms_key_arn" {
  value = aws_kms_key.audit.arn
}

output "audit_kms_key_id" {
  value = aws_kms_key.audit.key_id
}

output "root_kms_alias" {
  value = aws_kms_alias.root.name
}

output "connector_kms_key_arn" {
  value = aws_kms_key.connector.arn
}

output "connector_kms_key_id" {
  value = aws_kms_key.connector.key_id
}

output "connector_kms_alias" {
  value = aws_kms_alias.connector.name
}

output "audit_kms_alias" {
  value = aws_kms_alias.audit.name
}
