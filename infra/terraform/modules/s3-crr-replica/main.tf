################################################################################
# Brain – S3 CRR REPLICA bucket Module (AUD-OPS-014 / AUD-OPS-042)
#
# The REPLICA-REGION half of cross-region replication: a versioned, SSE-KMS,
# locked-down destination bucket + its in-region CMK. The SOURCE-REGION half
# (replication role + the replication configuration on the source bucket) is
# modules/s3-crr; the pair is instantiated together by the env roots.
#
# PROVIDER CONTRACT: this module uses only the DEFAULT aws provider — the root
# passes its replica-region provider as this module's `aws`:
#     providers = { aws = aws.replica }
# (Deliberately NOT configuration_aliases: the CI matrix validates every module
# standalone, and standalone `terraform validate` cannot resolve aliased
# provider configs on resources.)
#
# RESIDENCY (AUD-OPS-042): the roots pin the replica region IN-COUNTRY
# (ap-south-2, Hyderabad) — decision doc docs/adr/0011-s3-crr-residency.md.
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

variable "purpose" {
  type        = string
  description = "Short token naming this replication lane (e.g. warehouse, tfstate) — used in key/alias names and tags."
}

variable "source_bucket_id" {
  type        = string
  description = "Name (id) of the source bucket — the replica is named <source>-crr."
}

variable "replica_noncurrent_days" {
  type        = number
  description = "Days a noncurrent version survives on the replica before expiry. >= 90 mirrors the source warehouse window; >= the GLACIER_IR 90-day minimum storage duration avoids early-delete charges."
  default     = 180
}

data "aws_caller_identity" "current" {}

data "aws_region" "this" {}

locals {
  replica_bucket_name = "${var.source_bucket_id}-crr"
}

###############################################################################
# Replica-region CMK — SSE-KMS objects are re-encrypted in the replica region
###############################################################################
data "aws_iam_policy_document" "replica_kms" {
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

resource "aws_kms_key" "replica" {
  description             = "${var.project} ${var.environment} ${var.purpose} CRR replica bucket key"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.replica_kms.json

  tags = {
    purpose = "dr-replica"
  }
}

resource "aws_kms_alias" "replica" {
  name          = "alias/${var.project}-${var.environment}-${var.purpose}-crr"
  target_key_id = aws_kms_key.replica.key_id
}

###############################################################################
# Replica bucket — versioned (required for replication), SSE-KMS, locked down
###############################################################################
resource "aws_s3_bucket" "replica" {
  # checkov:skip=CKV_AWS_53:DR replica of a non-Object-Lock source — WORM lives on the audit bucket only (same rationale as modules/s3-iceberg)
  bucket = local.replica_bucket_name

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "dr-replica"
    public      = "false"
  }
}

resource "aws_s3_bucket_versioning" "replica" {
  bucket = aws_s3_bucket.replica.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "replica" {
  bucket = aws_s3_bucket.replica.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.replica.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "replica" {
  bucket                  = aws_s3_bucket.replica.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "replica" {
  bucket = aws_s3_bucket.replica.id
  rule {
    id     = "replica-noncurrent-cleanup"
    status = "Enabled"
    filter {
      prefix = ""
    }
    noncurrent_version_expiration {
      noncurrent_days = var.replica_noncurrent_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "replica_bucket_policy" {
  statement {
    sid     = "DenyNonTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.replica.arn,
      "${aws_s3_bucket.replica.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "replica" {
  bucket = aws_s3_bucket.replica.id
  policy = data.aws_iam_policy_document.replica_bucket_policy.json
}

###############################################################################
# Outputs — consumed by the source-side module (modules/s3-crr)
###############################################################################
output "replica_bucket_name" {
  value = aws_s3_bucket.replica.bucket
}

output "replica_bucket_arn" {
  value = aws_s3_bucket.replica.arn
}

output "replica_region" {
  value = data.aws_region.this.region
}

output "replica_kms_key_arn" {
  value = aws_kms_key.replica.arn
}
