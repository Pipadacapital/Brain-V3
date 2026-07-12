################################################################################
# Brain – S3 Cross-Region Replication (SOURCE side) Module (AUD-OPS-014 / -042)
#
# The entire backup estate was single-region ap-south-1, single-account: a
# regional event (or a principal with s3:DeleteObjectVersion) was unrecoverable
# — against the "no event loss" core rule for Bronze. Paired with
# modules/s3-crr-replica (the replica-region bucket + CMK), this module gives
# ONE versioned source bucket a same-account replica in a SECOND IN-COUNTRY
# region:
#
#   RESIDENCY (AUD-OPS-042): the audit verified residency is clean (all stores
#   ap-south-1) and requires any cross-region copy to be a DOCUMENTED residency
#   decision. That decision is docs/adr/0011-s3-crr-residency.md — the roots
#   pin the replica region to ap-south-2 (Hyderabad), so replicated data NEVER
#   leaves India and the DPDP residency posture is unchanged.
#
# This module creates the SOURCE-REGION half (default aws provider = the
# source region — no configuration_aliases, so the CI standalone-module
# validate matrix works):
#   - the S3 replication role (global IAM), least-privilege on both buckets +
#     both CMKs,
#   - the replication configuration ON THE SOURCE BUCKET (delete markers
#     replicated — the replica mirrors deletes as reversible markers; version
#     history on the replica is what defeats a source-side purge).
#
# COST-FIRST: replication charges inter-region transfer (~$0.02/GB Mumbai→
# Hyderabad) once per object + GLACIER_IR storage (~$0.004/GB-mo) — at the
# current warehouse size this is single-digit $/mo (sizing in ADR-0011).
#
# GATED: instantiated behind `enable_cross_region_replication` in the env root
# (count = 0 when false) — reversible, no-op until the owner-approved apply.
#
# REQUIREMENT: the SOURCE bucket must have versioning Enabled (both call sites —
# the medallion warehouse and the tfstate bucket — already do).
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
  description = "Short token naming this replication lane (e.g. warehouse, tfstate) — used in the role name and rule id."
}

variable "source_bucket_id" {
  type        = string
  description = "Name (id) of the versioned source bucket to replicate."
}

variable "source_bucket_arn" {
  type        = string
  description = "ARN of the source bucket."
}

variable "source_kms_key_arn" {
  type        = string
  description = "CMK the source bucket encrypts with (the replication role needs kms:Decrypt on it)."
}

variable "replica_bucket_arn" {
  type        = string
  description = "ARN of the destination bucket (modules/s3-crr-replica output)."
}

variable "replica_kms_key_arn" {
  type        = string
  description = "Replica-region CMK objects are re-encrypted with (modules/s3-crr-replica output)."
}

variable "replica_storage_class" {
  type        = string
  description = "Storage class objects land in on the replica. GLACIER_IR = instant-retrieval cost floor (AUD-OPS-014 remediation); use STANDARD if the replica must also serve reads."
  default     = "GLACIER_IR"
}

locals {
  role_name = "${var.project}-${var.environment}-${var.purpose}-crr"
}

###############################################################################
# Replication role — assumed by s3.amazonaws.com; least-privilege both sides
###############################################################################
data "aws_iam_policy_document" "replication_trust" {
  statement {
    sid     = "S3Assume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "replication" {
  name               = local.role_name
  assume_role_policy = data.aws_iam_policy_document.replication_trust.json
}

data "aws_iam_policy_document" "replication" {
  statement {
    sid    = "ReadSource"
    effect = "Allow"
    actions = [
      "s3:GetReplicationConfiguration",
      "s3:ListBucket",
    ]
    resources = [var.source_bucket_arn]
  }

  statement {
    sid    = "ReadSourceVersions"
    effect = "Allow"
    actions = [
      "s3:GetObjectVersionForReplication",
      "s3:GetObjectVersionAcl",
      "s3:GetObjectVersionTagging",
    ]
    resources = ["${var.source_bucket_arn}/*"]
  }

  statement {
    sid    = "WriteReplica"
    effect = "Allow"
    actions = [
      "s3:ReplicateObject",
      "s3:ReplicateDelete",
      "s3:ReplicateTags",
    ]
    resources = ["${var.replica_bucket_arn}/*"]
  }

  # SSE-KMS: decrypt source objects…
  statement {
    sid       = "DecryptSource"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.source_kms_key_arn]
  }

  # …and re-encrypt with the replica-region CMK.
  statement {
    sid    = "EncryptReplica"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = [var.replica_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "replication" {
  name   = local.role_name
  role   = aws_iam_role.replication.id
  policy = data.aws_iam_policy_document.replication.json
}

###############################################################################
# Replication configuration ON THE SOURCE bucket
###############################################################################
resource "aws_s3_bucket_replication_configuration" "this" {
  bucket = var.source_bucket_id
  role   = aws_iam_role.replication.arn

  rule {
    id     = "${var.purpose}-crr-all"
    status = "Enabled"

    # V2 rule (empty filter = whole bucket) — required for delete-marker replication.
    filter {}

    delete_marker_replication {
      status = "Enabled"
    }

    # SSE-KMS objects are only replicated when explicitly selected.
    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    destination {
      bucket        = var.replica_bucket_arn
      storage_class = var.replica_storage_class
      encryption_configuration {
        replica_kms_key_id = var.replica_kms_key_arn
      }
    }
  }
}

###############################################################################
# Outputs
###############################################################################
output "replication_role_arn" {
  value = aws_iam_role.replication.arn
}
