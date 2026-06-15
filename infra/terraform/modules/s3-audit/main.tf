################################################################################
# Brain – S3 Audit (WORM) Module
# NN-4: Object Lock COMPLIANCE mode, 7-year retention, set at bucket creation.
# This bucket holds hourly audit-log hash checkpoints (the WORM anchor).
# Tags: purpose=audit — Checkov/OPA rejects GOVERNANCE or <7yr on this tag.
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
  description = "Audit CMK ARN for SSE-KMS"
}

data "aws_caller_identity" "current" {}

###############################################################################
# Audit WORM bucket — NN-4: Object Lock COMPLIANCE + 7yr at creation
###############################################################################
resource "aws_s3_bucket" "audit" {
  bucket = "${var.project}-audit-${var.environment}-${data.aws_caller_identity.current.account_id}"

  # REQUIRED for Object Lock — must be set at bucket creation
  object_lock_enabled = true

  tags = {
    project     = var.project
    environment = var.environment
    # NN-4: Checkov rule validates COMPLIANCE+7yr on purpose=audit buckets
    purpose = "audit"
    public  = "false"
  }
}

# NN-4: Object Lock default retention — COMPLIANCE mode, 7 years
resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    default_retention {
      mode  = "COMPLIANCE"
      years = 7
    }
  }
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

###############################################################################
# Bucket policy — enforce TLS + deny deletes
###############################################################################
data "aws_iam_policy_document" "audit_bucket_policy" {
  statement {
    sid     = "DenyNonTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.audit.arn,
      "${aws_s3_bucket.audit.arn}/*",
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

  statement {
    sid    = "DenyObjectDelete"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = ["${aws_s3_bucket.audit.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "audit" {
  bucket = aws_s3_bucket.audit.id
  policy = data.aws_iam_policy_document.audit_bucket_policy.json
}

###############################################################################
# IAM policy for audit writer (Argo job) — PutObject only
###############################################################################
data "aws_iam_policy_document" "audit_writer" {
  statement {
    sid       = "AllowAuditWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/checkpoints/*"]
  }

  statement {
    sid       = "AllowKMSForAudit"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_policy" "audit_writer" {
  name        = "${var.project}-${var.environment}-audit-writer"
  description = "Audit checkpoint writer: PutObject on checkpoints prefix only"
  policy      = data.aws_iam_policy_document.audit_writer.json
}

###############################################################################
# Outputs
###############################################################################
output "audit_bucket_name" {
  value = aws_s3_bucket.audit.bucket
}

output "audit_bucket_arn" {
  value = aws_s3_bucket.audit.arn
}

output "audit_writer_policy_arn" {
  value = aws_iam_policy.audit_writer.arn
}
