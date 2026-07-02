################################################################################
# Brain – S3 Iceberg (Bronze) Module
# NN-4: Object Lock COMPLIANCE mode, 7-year retention, set at bucket creation.
# NN-5: Workload IAM policies scoped to per-brand prefix, NEVER bucket root.
# Tags: purpose=bronze — Checkov/OPA rule enforces COMPLIANCE+7yr on this tag.
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

variable "stream_worker_role_arn" {
  type        = string
  description = "IAM role ARN for stream-worker (write only to bronze prefix)"
}

variable "analytics_role_arn" {
  type        = string
  description = "IAM role ARN for analytics/StarRocks reader (read only from bronze prefix)"
}

data "aws_caller_identity" "current" {}

###############################################################################
# Bronze bucket — NN-4: Object Lock COMPLIANCE + 7yr at creation
###############################################################################
resource "aws_s3_bucket" "bronze" {
  bucket = "${var.project}-bronze-${var.environment}-${data.aws_caller_identity.current.account_id}"

  # REQUIRED for Object Lock — must be set at bucket creation, non-retrofittable
  object_lock_enabled = true

  tags = {
    project     = var.project
    environment = var.environment
    # NN-4: Checkov rule checks this tag for COMPLIANCE+7yr enforcement
    purpose = "bronze"
    public  = "false"
  }
}

# NN-4: Object Lock default retention — COMPLIANCE mode, 7 years
resource "aws_s3_bucket_object_lock_configuration" "bronze" {
  bucket = aws_s3_bucket.bronze.id

  rule {
    default_retention {
      mode  = "COMPLIANCE"
      years = 7
    }
  }
}

resource "aws_s3_bucket_versioning" "bronze" {
  bucket = aws_s3_bucket.bronze.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "bronze" {
  bucket = aws_s3_bucket.bronze.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "bronze" {
  bucket                  = aws_s3_bucket.bronze.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "bronze" {
  bucket = aws_s3_bucket.bronze.id
  # 24-month rolling retention per I-E02
  rule {
    id     = "bronze-24mo-ttl"
    status = "Enabled"
    filter {
      prefix = "bronze/"
    }
    expiration {
      days = 730
    }
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

###############################################################################
# Iceberg catalog: NO Glue database here (AUD-COST-012). The runtime catalog is
# the REST/JDBC catalog (infra/helm/iceberg-rest → JdbcCatalog on Aurora, per
# the Brain V4 data platform: rest catalogs brain_{bronze,silver,gold}); the
# former aws_glue_catalog_database was paid-for dead metadata nothing read.
# The catalog DB bootstrap SQL is documented in infra/terraform/README.md
# ("Prod go-live" step 2). Glue IAM grants below are retained as a dormant
# fallback path only.
###############################################################################

###############################################################################
# NN-5: stream-worker IAM policy — PutObject ONLY on bronze/brand_id=*/* prefix
###############################################################################
data "aws_iam_policy_document" "stream_worker_s3" {
  statement {
    sid    = "AllowBronzePrefixWrite"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = [
      "${aws_s3_bucket.bronze.arn}/bronze/brand_id=*/*",
    ]
  }

  statement {
    sid       = "AllowBucketList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.bronze.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["bronze/brand_id=*/*"]
    }
  }

  # NN-5: Explicit DENY on bucket root — belt-and-suspenders
  statement {
    sid    = "DenyBucketRootAccess"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [aws_s3_bucket.bronze.arn]
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

resource "aws_iam_policy" "stream_worker_s3" {
  name        = "${var.project}-${var.environment}-stream-worker-s3"
  description = "stream-worker Bronze write: per-brand prefix only (NN-5)"
  policy      = data.aws_iam_policy_document.stream_worker_s3.json
}

###############################################################################
# NN-5: Analytics/StarRocks reader — GetObject ONLY on bronze prefix
###############################################################################
data "aws_iam_policy_document" "analytics_s3" {
  statement {
    sid    = "AllowBronzePrefixRead"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      "${aws_s3_bucket.bronze.arn}/bronze/brand_id=*/*",
    ]
  }

  statement {
    sid       = "AllowBucketList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.bronze.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["bronze/brand_id=*/*"]
    }
  }

  statement {
    sid    = "DenyBucketRootWrite"
    effect = "Deny"
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [aws_s3_bucket.bronze.arn]
  }

  statement {
    sid    = "AllowKMSDecrypt"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = [var.kms_key_arn]
  }

  # Dormant fallback only (AUD-COST-012): runtime catalog is REST/JDBC, no Glue
  # DB is provisioned. Read-only + harmless; kept so a Glue fallback needs no
  # IAM change.
  statement {
    sid    = "AllowGlueCatalogRead"
    effect = "Allow"
    actions = [
      "glue:GetDatabase",
      "glue:GetTable",
      "glue:GetTables",
      "glue:GetPartition",
      "glue:GetPartitions",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "analytics_s3" {
  name        = "${var.project}-${var.environment}-analytics-s3-read"
  description = "Analytics Bronze read: per-brand prefix only (NN-5)"
  policy      = data.aws_iam_policy_document.analytics_s3.json
}

###############################################################################
# Bucket policy — enforce TLS and deny unencrypted puts
###############################################################################
data "aws_iam_policy_document" "bronze_bucket_policy" {
  statement {
    sid       = "DenyUnencryptedPuts"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.bronze.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid     = "DenyNonTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.bronze.arn,
      "${aws_s3_bucket.bronze.arn}/*",
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

resource "aws_s3_bucket_policy" "bronze" {
  bucket = aws_s3_bucket.bronze.id
  policy = data.aws_iam_policy_document.bronze_bucket_policy.json
}

###############################################################################
# Outputs
###############################################################################
output "bronze_bucket_name" {
  value = aws_s3_bucket.bronze.bucket
}

output "bronze_bucket_arn" {
  value = aws_s3_bucket.bronze.arn
}

output "stream_worker_s3_policy_arn" {
  value = aws_iam_policy.stream_worker_s3.arn
}

output "analytics_s3_policy_arn" {
  value = aws_iam_policy.analytics_s3.arn
}
