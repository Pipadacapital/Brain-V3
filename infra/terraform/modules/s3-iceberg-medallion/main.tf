################################################################################
# Brain – S3 Iceberg Medallion (Silver + Gold) Module  [Brain V4 PHASE 0 / W0]
#
# PURPOSE (V4 14-implementation-plan PHASE 0, PR-0.1):
#   Provision the Iceberg SILVER and GOLD storage layers so Spark can CREATE +
#   MERGE Iceberg tables in the brain_silver / brain_gold namespaces. Today only
#   the Bronze bucket/catalog exists (modules/s3-iceberg) — Gold-in-Iceberg is
#   not deployable (08-spark-ownership-report §4 provisioning blocker;
#   09-starrocks-report §6 step 1). This module is the cloud mirror of that.
#
# NON-BREAKING / ADDITIVE: this module creates NEW buckets, NEW Glue databases,
# and a NEW Spark write role/policy. It changes no existing bucket, catalog,
# read path, dbt model, or app code. It is parameterized over a single
# `layer` ("silver" | "gold") and instantiated twice by the env roots.
#
# MIRRORS modules/s3-iceberg (Bronze) conventions:
#   - SSE-KMS (aws:kms) with the root CMK, bucket_key_enabled.
#   - Versioning enabled; full public-access block.
#   - DenyUnencryptedPuts + DenyNonTLS bucket policy.
#   - Glue Data Catalog database per layer for Iceberg metadata.
#   - Tenant key brand_id is the Iceberg partition (bucket(256, brand_id)) on
#     every table — enforced by the Spark DDL, mirrored by per-prefix IAM here.
#
# DIFFERS from Bronze by design:
#   - NO Object Lock COMPLIANCE/7yr. Silver/Gold are DERIVED, rebuildable layers
#     (Bronze is the immutable source-of-truth that carries the WORM retention).
#     Putting COMPLIANCE Object Lock on Silver/Gold would make Spark MERGE /
#     compaction / snapshot-expiry / crypto-shred impossible. Lifecycle expiry
#     of noncurrent versions only.
#   - The Spark WRITE role needs Get/Put/Delete (Iceberg MERGE rewrites data
#     files; compaction + snapshot-expiry + crypto-shred DELETE old files —
#     14-plan PHASE 0 PR-0.2). Bronze's stream-worker role is Put-only.
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
variable "layer" {
  type        = string
  description = "Medallion layer this module instance provisions: silver or gold."
  validation {
    condition     = contains(["silver", "gold"], var.layer)
    error_message = "layer must be one of: silver, gold."
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
  description = "Root CMK ARN for SSE-KMS (same root CMK as Bronze)."
}

variable "analytics_role_arn" {
  type        = string
  description = "IAM role ARN for the StarRocks/analytics reader (read-only this layer)."
}

data "aws_caller_identity" "current" {}

locals {
  # brain-silver-<env>-<acct> / brain-gold-<env>-<acct> — mirrors Bronze naming.
  bucket_name = "${var.project}-${var.layer}-${var.environment}-${data.aws_caller_identity.current.account_id}"

  # Glue database mirrors Bronze: brain_silver_<env> / brain_gold_<env>.
  # The Iceberg namespace seen by Spark/StarRocks is brain_<layer> (the env
  # suffix scopes the physical Glue DB per account-per-environment isolation).
  glue_db_name = "${var.project}_${var.layer}_${var.environment}"

  # Iceberg writes table data + metadata under the warehouse root. Hidden
  # partitioning (bucket(256, brand_id)) lands files under <layer>/<table>/data/*
  # and <layer>/<table>/metadata/* — so the workload prefix is the layer root.
  data_prefix = "${var.layer}/"
}

###############################################################################
# Bucket — DERIVED layer: NO Object Lock (rebuildable; MERGE/compaction need it)
###############################################################################
resource "aws_s3_bucket" "this" {
  # CKV_AWS_53 (S3 Object Lock) is intentionally NOT set here. Silver/Gold are
  # DERIVED, rebuildable medallion layers — Iceberg MERGE rewrites data files and
  # compaction/snapshot-expiry/crypto-shred (14-plan PR-0.2) DELETE old files, all
  # impossible under COMPLIANCE Object Lock. The immutable WORM source of truth is
  # Bronze (modules/s3-iceberg keeps COMPLIANCE+7yr). Versioning + 30d noncurrent
  # cleanup + full public-access-block + TLS/SSE-KMS bucket policy still apply.
  # checkov:skip=CKV_AWS_53:derived/rebuildable Iceberg layer — Object Lock would block MERGE/compaction/crypto-shred; WORM lives on Bronze
  bucket = local.bucket_name

  tags = {
    project     = var.project
    environment = var.environment
    # Distinct from purpose=bronze: the Checkov/OPA COMPLIANCE+7yr rule keys on
    # purpose=bronze and must NOT fire on these derived layers.
    purpose = var.layer
    public  = "false"
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Lifecycle: derived layers keep only recent noncurrent versions. Snapshot
# expiry + compaction (PR-0.2 maintenance) reclaim live data; S3 here only
# trims orphaned noncurrent object versions + aborts stale multipart uploads.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    id     = "${var.layer}-noncurrent-cleanup"
    status = "Enabled"
    filter {
      prefix = local.data_prefix
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
# Glue Data Catalog database for Iceberg metadata (brain_silver / brain_gold)
###############################################################################
resource "aws_glue_catalog_database" "this" {
  name        = local.glue_db_name
  description = "Brain ${title(var.layer)} layer Iceberg catalog (${var.environment})"
}

###############################################################################
# Spark WRITE IAM policy — Get/Put/Delete on this layer prefix ONLY.
# Iceberg MERGE rewrites data files; compaction + snapshot-expiry + crypto-shred
# DELETE old files (PR-0.2). Mirrors Bronze NN-5 per-prefix scoping + explicit
# DENY on bucket root.
###############################################################################
data "aws_iam_policy_document" "spark_write" {
  statement {
    sid    = "AllowLayerPrefixReadWrite"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = [
      "${aws_s3_bucket.this.arn}/${local.data_prefix}*",
    ]
  }

  statement {
    sid       = "AllowBucketList"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.this.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.data_prefix}*"]
    }
  }

  # Belt-and-suspenders: explicit DENY of object ops on the bucket-root ARN.
  statement {
    sid    = "DenyBucketRootObjectAccess"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [aws_s3_bucket.this.arn]
  }

  # Iceberg SSE-KMS: Spark must wrap/unwrap data keys to write + compact.
  statement {
    sid    = "AllowKMSForS3"
    effect = "Allow"
    actions = [
      "kms:GenerateDataKey",
      "kms:Decrypt",
    ]
    resources = [var.kms_key_arn]
  }

  # Glue catalog write: Spark CREATE TABLE / commit Iceberg snapshots updates
  # Glue table metadata for this layer's database only.
  statement {
    sid    = "AllowGlueCatalogWrite"
    effect = "Allow"
    actions = [
      "glue:GetDatabase",
      "glue:GetDatabases",
      "glue:CreateTable",
      "glue:UpdateTable",
      "glue:DeleteTable",
      "glue:GetTable",
      "glue:GetTables",
      "glue:GetPartition",
      "glue:GetPartitions",
      "glue:BatchCreatePartition",
      "glue:BatchUpdatePartition",
      "glue:CreatePartition",
      "glue:UpdatePartition",
      "glue:DeletePartition",
    ]
    resources = [
      "arn:aws:glue:*:${data.aws_caller_identity.current.account_id}:catalog",
      "arn:aws:glue:*:${data.aws_caller_identity.current.account_id}:database/${local.glue_db_name}",
      "arn:aws:glue:*:${data.aws_caller_identity.current.account_id}:table/${local.glue_db_name}/*",
    ]
  }
}

resource "aws_iam_policy" "spark_write" {
  name        = "${var.project}-${var.environment}-spark-${var.layer}-write"
  description = "Spark write to Iceberg ${var.layer}: layer prefix only (NN-5 mirror)"
  policy      = data.aws_iam_policy_document.spark_write.json
}

###############################################################################
# Analytics/StarRocks reader — GetObject ONLY on this layer prefix.
# StarRocks mv_* (PHASE 3) reads Iceberg Silver/Gold via the external catalog.
###############################################################################
data "aws_iam_policy_document" "analytics_read" {
  statement {
    sid    = "AllowLayerPrefixRead"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      "${aws_s3_bucket.this.arn}/${local.data_prefix}*",
    ]
  }

  statement {
    sid       = "AllowBucketList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.this.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.data_prefix}*"]
    }
  }

  statement {
    sid    = "DenyLayerWrite"
    effect = "Deny"
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
    ]
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

  statement {
    sid    = "AllowGlueCatalogRead"
    effect = "Allow"
    actions = [
      "glue:GetDatabase",
      "glue:GetDatabases",
      "glue:GetTable",
      "glue:GetTables",
      "glue:GetPartition",
      "glue:GetPartitions",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "analytics_read" {
  name        = "${var.project}-${var.environment}-analytics-${var.layer}-read"
  description = "Analytics/StarRocks read Iceberg ${var.layer}: layer prefix only (NN-5 mirror)"
  policy      = data.aws_iam_policy_document.analytics_read.json
}

###############################################################################
# Bucket policy — enforce TLS + deny unencrypted puts (mirrors Bronze)
###############################################################################
data "aws_iam_policy_document" "bucket_policy" {
  statement {
    sid       = "DenyUnencryptedPuts"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.this.arn}/*"]
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
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
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

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.bucket_policy.json
}

###############################################################################
# Outputs
###############################################################################
output "bucket_name" {
  value = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.this.arn
}

output "glue_database_name" {
  value = aws_glue_catalog_database.this.name
}

output "spark_write_policy_arn" {
  value = aws_iam_policy.spark_write.arn
}

output "analytics_read_policy_arn" {
  value = aws_iam_policy.analytics_read.arn
}
