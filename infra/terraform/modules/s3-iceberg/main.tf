################################################################################
# Brain – S3 Iceberg MEDALLION WAREHOUSE Module (AUD-COST-016)
#
# ONE bucket = the single Iceberg REST-catalog warehouse root. This mirrors the
# local lakehouse faithfully: compose runs ONE iceberg-rest server with ONE
# CATALOG_WAREHOUSE (s3://brain-bronze/) and the medallion layers are Iceberg
# NAMESPACES (brain_bronze / brain_silver / brain_gold) inside that one
# warehouse — see docker-compose.yml `iceberg-rest` + db/iceberg/spark/
# iceberg_base.py. The JdbcCatalog places tables at
# <warehouse>/<namespace>/<table>/{data,metadata}, so the per-layer S3 prefixes
# here are the namespace names. The bucket keeps the historical `-bronze-` name
# for parity with the local warehouse root (s3://brain-bronze/).
#
# NO Object Lock (decision AUD-COST-016, was NN-4 COMPLIANCE+7yr): COMPLIANCE
# Object Lock on the DATA bucket is physically incompatible with the platform —
# Iceberg MERGE/compaction rewrite data files, the 7-day raw-PII row-TTL DELETE
# (AUD-PERF-003), snapshot expiry, and DPDP/GDPR right-to-erasure/crypto-shred
# all DELETE objects, which COMPLIANCE mode forbids for 7 years. WORM retention
# lives ONLY on the audit bucket (modules/s3-audit, unchanged). See the
# addendum in docs/adr/0002-iceberg-bronze-spark-streaming.md.
#
# NN-5 note: tenant isolation is NOT an S3 path property under Iceberg —
# brand_id is HIDDEN partitioning (bucket(256, brand_id)), so objects do not
# carry brand prefixes. IAM scopes to the medallion NAMESPACE prefixes (never
# the bucket root); per-brand isolation is enforced at the query seam
# (${BRAND_PREDICATE} on every Trino serving read) and row-level in Spark.
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
  description = "IAM role ARN for stream-worker (kept for caller compatibility; policies are attached by the env roots)"
}

variable "analytics_role_arn" {
  type        = string
  description = "IAM role ARN for the analytics reader (kept for caller compatibility; policies are attached by the env roots)"
}

data "aws_caller_identity" "current" {}

locals {
  # The Iceberg medallion namespaces — each is a top-level prefix under the
  # warehouse root (JdbcCatalog layout: <warehouse>/<namespace>/<table>/...).
  medallion_namespaces = ["brain_bronze", "brain_silver", "brain_gold"]

  # Spark Structured Streaming checkpoint root (CHECKPOINT_LOCATION =
  # s3a://<bucket>/_checkpoints/<job>) — kept inside the warehouse bucket so
  # one IRSA grant covers the whole Spark data plane.
  checkpoint_prefix = "_checkpoints/"

  namespace_object_arns = [
    for ns in local.medallion_namespaces : "${aws_s3_bucket.bronze.arn}/${ns}/*"
  ]
  namespace_list_prefixes = [
    for ns in local.medallion_namespaces : "${ns}/*"
  ]
}

###############################################################################
# Warehouse bucket — NO Object Lock (see header). Versioning + SSE-KMS +
# public-access block + TLS-only bucket policy still apply.
###############################################################################
resource "aws_s3_bucket" "bronze" {
  # checkov:skip=CKV_AWS_53:AUD-COST-016 — Object Lock is incompatible with Iceberg MERGE/compaction, the raw-PII row-TTL DELETE and right-to-erasure; WORM lives on the audit bucket only
  bucket = "${var.project}-bronze-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = {
    project     = var.project
    environment = var.environment
    # AUD-COST-016: was purpose=bronze with the NN-4 COMPLIANCE+7yr rule keyed
    # on it. The OPA/Checkov Object-Lock rule now protects purpose=audit only.
    purpose = "medallion-warehouse"
    public  = "false"
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

# Lifecycle: NO object-expiration rule on live data — S3 lifecycle expiry of
# Iceberg data files behind the catalog's back CORRUPTS tables. Data retention
# is enforced as Iceberg row/partition DELETEs by the Spark jobs
# (bronze_raw_retention.py D4 window, the AUD-PERF-003 raw-PII row TTL) and
# file reclamation by expire_snapshots/remove_orphan_files (bronze_maintenance
# + medallion_maintenance). S3 here only trims noncurrent object versions and
# aborts stale multipart uploads.
resource "aws_s3_bucket_lifecycle_configuration" "bronze" {
  bucket = aws_s3_bucket.bronze.id
  rule {
    id     = "warehouse-noncurrent-cleanup"
    status = "Enabled"
    filter {
      prefix = ""
    }
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

###############################################################################
# Iceberg catalog: NO Glue database here (AUD-COST-012). The runtime catalog is
# the REST/JDBC catalog (infra/helm/iceberg-rest → JdbcCatalog on Aurora, per
# the Brain V4 data platform); the former aws_glue_catalog_database was
# paid-for dead metadata nothing read. The catalog DB bootstrap SQL is
# documented in infra/terraform/README.md ("Prod go-live"). Glue IAM grants
# below are retained as a dormant fallback path only.
###############################################################################

###############################################################################
# stream-worker IAM policy — PutObject ONLY on the brain_bronze namespace
# prefix (legacy direct-write seam; the Spark data plane uses the medallion RW
# policy below). Never the bucket root.
###############################################################################
data "aws_iam_policy_document" "stream_worker_s3" {
  statement {
    sid    = "AllowBronzeNamespaceWrite"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = [
      "${aws_s3_bucket.bronze.arn}/brain_bronze/*",
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
      values   = ["brain_bronze/*"]
    }
  }

  # Explicit DENY on bucket root — belt-and-suspenders
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
  description = "stream-worker Bronze write: brain_bronze namespace prefix only (NN-5)"
  policy      = data.aws_iam_policy_document.stream_worker_s3.json
}

###############################################################################
# Spark MEDALLION RW policy — Get/Put/Delete on the three namespace prefixes
# + the streaming checkpoint prefix. Iceberg MERGE rewrites data files;
# compaction + snapshot-expiry + row-TTL + crypto-shred DELETE old files. Used
# by the Spark jobs role (brain-<env>-jobs) and the iceberg-rest catalog server
# (which writes table metadata server-side).
###############################################################################
data "aws_iam_policy_document" "spark_medallion_rw" {
  statement {
    sid    = "AllowMedallionNamespaceRW"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = concat(
      local.namespace_object_arns,
      ["${aws_s3_bucket.bronze.arn}/${local.checkpoint_prefix}*"],
    )
  }

  statement {
    sid       = "AllowBucketList"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.bronze.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = concat(
        local.namespace_list_prefixes,
        ["${local.checkpoint_prefix}*"],
      )
    }
  }

  # Explicit DENY of object ops on the bucket-root ARN — belt-and-suspenders.
  statement {
    sid    = "DenyBucketRootObjectAccess"
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

resource "aws_iam_policy" "spark_medallion_rw" {
  name        = "${var.project}-${var.environment}-spark-medallion-rw"
  description = "Spark data plane + iceberg-rest catalog: RW on the medallion namespace prefixes of the warehouse bucket (AUD-COST-016)"
  policy      = data.aws_iam_policy_document.spark_medallion_rw.json
}

###############################################################################
# Analytics reader — GetObject ONLY on the medallion namespace prefixes.
# Attached to core (direct Iceberg reads) and the Trino serving engine.
###############################################################################
data "aws_iam_policy_document" "analytics_s3" {
  statement {
    sid    = "AllowMedallionNamespaceRead"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = local.namespace_object_arns
  }

  statement {
    sid       = "AllowBucketList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.bronze.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = local.namespace_list_prefixes
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
  description = "Analytics/Trino medallion read: namespace prefixes only (NN-5)"
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

# Alias outputs — the bucket IS the single medallion warehouse root
# (AUD-COST-016). Prefer these names in new wiring.
output "warehouse_bucket_name" {
  value = aws_s3_bucket.bronze.bucket
}

output "warehouse_bucket_arn" {
  value = aws_s3_bucket.bronze.arn
}

output "stream_worker_s3_policy_arn" {
  value = aws_iam_policy.stream_worker_s3.arn
}

output "analytics_s3_policy_arn" {
  value = aws_iam_policy.analytics_s3.arn
}

output "spark_medallion_rw_policy_arn" {
  value = aws_iam_policy.spark_medallion_rw.arn
}
