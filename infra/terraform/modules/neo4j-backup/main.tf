################################################################################
# Brain – Neo4j Backup Module (AUD-OPS-012)
#
# Neo4j is the identity SYSTEM OF RECORD (ADR-0004) running as a single-pod
# Community StatefulSet on ONE gp3 EBS volume in ONE AZ — until this module it
# had ZERO backups of any kind (no dumps, no snapshots, no AWS Backup); RPO was
# effectively infinite. Two independent, cheap layers close that:
#
#   1. DLM daily EBS snapshots (7 retained) of the Neo4j data volume —
#      crash-consistent block-level recovery for volume/AZ loss. Targeting is
#      by the EBS CSI driver's DEFAULT provisioning tag
#      kubernetes.io/created-for/pvc/namespace=neo4j (verified live on
#      vol-04dd7c60d1427e51c), so it survives PV recreation with no manual
#      tagging and needs no StorageClass change.
#   2. A dedicated backups bucket for the nightly `neo4j-admin database dump`
#      CronJob (infra/helm/neo4j-backup) — application-consistent logical
#      recovery (restorable into ANY Neo4j, incl. AuraDB). 30d expiry keeps
#      cost at pennies. The audit WORM bucket (modules/s3-audit) is NOT usable
#      here: Object Lock COMPLIANCE + 7-year default retention would make every
#      nightly dump undeletable for 7 years — wrong tool, runaway cost.
#
# Naming follows the documented layer-first exception
# (docs/infra/naming-and-tagging.md §1, same shape as s3-audit/s3-metrics):
# brain-neo4j-backups-<env>-<account_id>.
#
# The matching IRSA role (brain-<env>-neo4j-backup, trusted for
# neo4j/neo4j-backup) is instantiated in the env root with
# backup_writer_policy_arn attached.
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
  description = "Root CMK ARN for SSE-KMS on the backups bucket"
}

variable "snapshot_time_utc" {
  type        = string
  description = "Daily DLM snapshot time (UTC HH:MM). Default 20:30 UTC = 02:00 IST, one hour BEFORE the dump CronJob's maintenance window so the two layers never overlap."
  default     = "20:30"
}

variable "snapshot_retain_count" {
  type        = number
  description = "How many daily EBS snapshots DLM keeps (AUD-OPS-012 remediation: 7)"
  default     = 7
}

data "aws_caller_identity" "current" {}

###############################################################################
# Layer 1 — DLM daily EBS snapshots of the Neo4j data volume.
# gp3 snapshots are incremental; 7 dailies of a 50Gi volume cost pennies/mo
# (cost-first posture). copy_tags carries the CSI provenance tags onto the
# snapshots so restores are traceable back to the PVC.
###############################################################################
data "aws_iam_policy_document" "dlm_trust" {
  statement {
    sid     = "DLMAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${var.project}-${var.environment}-neo4j-dlm"
  assume_role_policy = data.aws_iam_policy_document.dlm_trust.json
}

# AWS-managed service policy: CreateSnapshot/DeleteSnapshot/DescribeVolumes +
# snapshot tagging — exactly the DLM execution surface, nothing more.
resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "neo4j_daily" {
  # DLM descriptions only allow [0-9A-Za-z _-] — no colons/parens.
  description        = "AUD-OPS-012 daily EBS snapshots of the Neo4j identity SoR data volume"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    # EBS CSI default provisioning tag — every PVC-backed volume in the neo4j
    # namespace, present without any StorageClass/driver change and re-applied
    # automatically if the PV is ever recreated. Verified live (2026-07-12):
    # vol-04dd7c60d1427e51c carries kubernetes.io/created-for/pvc/namespace=neo4j.
    target_tags = {
      "kubernetes.io/created-for/pvc/namespace" = "neo4j"
    }

    schedule {
      name      = "neo4j-daily-${var.snapshot_retain_count}d"
      copy_tags = true

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = [var.snapshot_time_utc]
      }

      retain_rule {
        count = var.snapshot_retain_count
      }

      tags_to_add = {
        SnapshotCreator = "dlm-neo4j-daily"
      }
    }
  }
}

###############################################################################
# Layer 2 — backups bucket for the nightly neo4j-admin dump CronJob.
# dumps/ objects expire after 30d (audit-proposed retention); versioning gives
# a bounded 7d undelete window; multipart hygiene mirrors s3-metrics.
###############################################################################
resource "aws_s3_bucket" "neo4j_backups" {
  bucket = "${var.project}-neo4j-backups-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "neo4j-backups"
    public      = "false"
  }
}

resource "aws_s3_bucket_versioning" "neo4j_backups" {
  bucket = aws_s3_bucket.neo4j_backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "neo4j_backups" {
  bucket = aws_s3_bucket.neo4j_backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "neo4j_backups" {
  bucket                  = aws_s3_bucket.neo4j_backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "neo4j_backups" {
  bucket = aws_s3_bucket.neo4j_backups.id
  rule {
    id     = "neo4j-dumps-30d"
    status = "Enabled"
    filter {
      prefix = "dumps/"
    }
    # 30d of nightly dumps (audit-proposed retention), then a 7d
    # noncurrent-version window so an accidental delete is still recoverable
    # without unbounded version growth.
    expiration {
      days = 30
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

###############################################################################
# Bucket policy — TLS only (same posture as s3-metrics)
###############################################################################
data "aws_iam_policy_document" "neo4j_backups_bucket_policy" {
  statement {
    sid     = "DenyNonTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.neo4j_backups.arn,
      "${aws_s3_bucket.neo4j_backups.arn}/*",
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

resource "aws_s3_bucket_policy" "neo4j_backups" {
  bucket = aws_s3_bucket.neo4j_backups.id
  policy = data.aws_iam_policy_document.neo4j_backups_bucket_policy.json
}

###############################################################################
# IAM policy for the backup writer (CronJob SA neo4j/neo4j-backup via IRSA) —
# write-only on the dumps/ prefix. Deliberately NO GetObject/DeleteObject: a
# compromised backup pod cannot read prior dumps (the full identity graph) or
# destroy history; expiry is the lifecycle rule's job.
###############################################################################
data "aws_iam_policy_document" "backup_writer" {
  statement {
    sid    = "AllowDumpWrite"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      # aws-cli uploads >8MB go multipart — Abort/ListParts scoped to the same prefix.
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.neo4j_backups.arn}/dumps/*"]
  }

  statement {
    sid       = "AllowDumpList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.neo4j_backups.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["dumps/*"]
    }
  }

  statement {
    sid       = "AllowKMSForBackups"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_policy" "backup_writer" {
  name        = "${var.project}-${var.environment}-neo4j-backup-writer"
  description = "Neo4j dump CronJob: write-only on the backups dumps/ prefix (AUD-OPS-012)"
  policy      = data.aws_iam_policy_document.backup_writer.json
}

###############################################################################
# Outputs
###############################################################################
output "backup_bucket_name" {
  value = aws_s3_bucket.neo4j_backups.bucket
}

output "backup_bucket_arn" {
  value = aws_s3_bucket.neo4j_backups.arn
}

output "backup_writer_policy_arn" {
  value = aws_iam_policy.backup_writer.arn
}

output "dlm_policy_id" {
  value = aws_dlm_lifecycle_policy.neo4j_daily.id
}
