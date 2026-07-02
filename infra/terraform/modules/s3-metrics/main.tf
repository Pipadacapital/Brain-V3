################################################################################
# Brain – S3 Metrics (Thanos objstore) Module (AUD-PROD-012)
#
# Long-term metrics bucket for the Thanos sidecar running inside the
# kube-prometheus-stack Prometheus pods (lane P2: ArgoCD app in ns
# `monitoring`). The sidecar ships 2h TSDB blocks here; retention/compaction of
# uploaded blocks is Thanos's job (compactor when enabled), NEVER an S3
# lifecycle expiry — lifecycle deletion of live Thanos blocks corrupts the
# store the same way it would an Iceberg table, so this module only trims
# noncurrent versions and stale multipart uploads.
#
# Naming follows the documented layer-first exception
# (docs/infra/naming-and-tagging.md §1, same shape as s3-audit/s3-iceberg):
# brain-metrics-<env>-<account_id>.
#
# The matching IRSA role (brain-<env>-thanos, trusted for
# monitoring/kube-prometheus-stack-prometheus) is instantiated in the env root
# with thanos_objstore_policy_arn attached.
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
  description = "Root CMK ARN for SSE-KMS"
}

data "aws_caller_identity" "current" {}

###############################################################################
# Metrics bucket
###############################################################################
resource "aws_s3_bucket" "metrics" {
  bucket = "${var.project}-metrics-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "metrics-longterm"
    public      = "false"
  }
}

resource "aws_s3_bucket_versioning" "metrics" {
  bucket = aws_s3_bucket.metrics.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "metrics" {
  bucket = aws_s3_bucket.metrics.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "metrics" {
  bucket                  = aws_s3_bucket.metrics.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# NO expiry of current objects (see header) — noncurrent-version + multipart
# hygiene only. Block retention belongs to Thanos (compactor --retention.*).
resource "aws_s3_bucket_lifecycle_configuration" "metrics" {
  bucket = aws_s3_bucket.metrics.id
  rule {
    id     = "metrics-noncurrent-cleanup"
    status = "Enabled"
    filter {
      prefix = ""
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

###############################################################################
# Bucket policy — TLS only
###############################################################################
data "aws_iam_policy_document" "metrics_bucket_policy" {
  statement {
    sid     = "DenyNonTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.metrics.arn,
      "${aws_s3_bucket.metrics.arn}/*",
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

resource "aws_s3_bucket_policy" "metrics" {
  bucket = aws_s3_bucket.metrics.id
  policy = data.aws_iam_policy_document.metrics_bucket_policy.json
}

###############################################################################
# Thanos objstore IAM policy — the standard Thanos S3 permission set
# (sidecar uploads + store-gateway reads + compactor deletes), bucket-scoped.
###############################################################################
data "aws_iam_policy_document" "thanos_objstore" {
  statement {
    sid    = "ThanosObjstoreObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.metrics.arn}/*"]
  }

  statement {
    sid       = "ThanosObjstoreList"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.metrics.arn]
  }

  statement {
    sid    = "AllowKMSForS3"
    effect = "Allow"
    actions = [
      "kms:GenerateDataKey",
      "kms:Decrypt",
    ]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_policy" "thanos_objstore" {
  name        = "${var.project}-${var.environment}-thanos-objstore"
  description = "Thanos sidecar/store/compactor: RW on the long-term metrics bucket (AUD-PROD-012)"
  policy      = data.aws_iam_policy_document.thanos_objstore.json
}

###############################################################################
# Outputs
###############################################################################
output "metrics_bucket_name" {
  value = aws_s3_bucket.metrics.bucket
}

output "metrics_bucket_arn" {
  value = aws_s3_bucket.metrics.arn
}

output "thanos_objstore_policy_arn" {
  value = aws_iam_policy.thanos_objstore.arn
}
