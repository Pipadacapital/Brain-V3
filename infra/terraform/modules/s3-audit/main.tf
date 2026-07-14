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

# ADR-0004 (SEC-1): when true, append the CloudTrail service-principal grants
# (GetBucketAcl + PutObject under the trail prefix) to the bucket policy so an
# account CloudTrail can deliver its log files into this WORM bucket. Default
# false keeps the policy unchanged (fully additive). The prod root flips this on
# and passes the same prefix it gives modules/security-baseline.
variable "enable_cloudtrail_delivery" {
  type        = bool
  description = "Append CloudTrail delivery grants to the audit bucket policy (ADR-0004 SEC-1)."
  default     = false
}

variable "cloudtrail_s3_key_prefix" {
  type        = string
  description = "CloudTrail s3_key_prefix — must match modules/security-baseline var of the same name."
  default     = "cloudtrail"
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

  # ADR-0004 (SEC-1): CloudTrail delivery grants (var-gated, default off). The
  # trail service principal must read the bucket ACL and Put log objects under
  # its prefix with the bucket-owner-full-control ACL. Scoped to this account's
  # trails via aws:SourceArn.
  dynamic "statement" {
    for_each = var.enable_cloudtrail_delivery ? [1] : []
    content {
      sid       = "AWSCloudTrailAclCheck"
      effect    = "Allow"
      actions   = ["s3:GetBucketAcl"]
      resources = [aws_s3_bucket.audit.arn]
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
  }

  dynamic "statement" {
    for_each = var.enable_cloudtrail_delivery ? [1] : []
    content {
      sid       = "AWSCloudTrailWrite"
      effect    = "Allow"
      actions   = ["s3:PutObject"]
      resources = ["${aws_s3_bucket.audit.arn}/${var.cloudtrail_s3_key_prefix}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]
      principals {
        type        = "Service"
        identifiers = ["cloudtrail.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "s3:x-amz-acl"
        values   = ["bucket-owner-full-control"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [data.aws_caller_identity.current.account_id]
      }
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

  # Read the prior checkpoint to chain the new one (least-privilege: checkpoints/ prefix only).
  # GetObject reads the newest record's hash; ListBucket (prefix-scoped) finds it.
  statement {
    sid       = "AllowAuditCheckpointRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.audit.arn}/checkpoints/*"]
  }

  statement {
    sid       = "AllowAuditCheckpointList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.audit.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["checkpoints/*"]
    }
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
  description = "Audit checkpoint writer: Put/Get/List on the checkpoints prefix (for hash-chaining)"
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
