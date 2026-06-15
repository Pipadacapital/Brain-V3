################################################################################
# Brain Platform – Terraform State Bootstrap
# Purpose: Creates the S3 remote state bucket + DynamoDB lock table (or S3-native
#           lock via use_lockfile, TF 1.10+) for a single AWS account/environment.
# Apply once per account before any other Terraform root runs.
# Usage: terraform init && terraform apply -var="environment=dev"
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
  description = "Target environment (dev | staging | prod)"
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "aws_region" {
  description = "AWS region for state bucket (must match data residency requirement)"
  type        = string
  default     = "ap-south-1"
}

variable "project" {
  description = "Project name tag applied to every resource"
  type        = string
  default     = "brain"
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      project     = var.project
      environment = var.environment
      managed_by  = "terraform"
    }
  }
}

###############################################################################
# KMS key for state bucket server-side encryption
###############################################################################
resource "aws_kms_key" "state" {
  description             = "Brain Terraform state bucket encryption key (${var.environment})"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.state_kms.json

  tags = {
    purpose = "terraform-state"
    env     = var.environment
  }
}

resource "aws_kms_alias" "state" {
  name          = "alias/brain-tfstate-${var.environment}"
  target_key_id = aws_kms_key.state.key_id
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "state_kms" {
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
# S3 State bucket
###############################################################################
resource "aws_s3_bucket" "state" {
  bucket        = "brain-tfstate-${var.environment}-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = {
    purpose = "terraform-state"
    env     = var.environment
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

###############################################################################
# DynamoDB lock table (legacy lock; keep for TF < 1.10 compatibility)
###############################################################################
resource "aws_dynamodb_table" "state_lock" {
  name         = "brain-tfstate-lock-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  attribute {
    name = "LockID"
    type = "S"
  }
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.state.arn
  }
  tags = {
    purpose = "terraform-state-lock"
    env     = var.environment
  }
}

###############################################################################
# Outputs consumed by per-env backend.tf stanzas
###############################################################################
output "state_bucket_name" {
  description = "S3 bucket name for Terraform state"
  value       = aws_s3_bucket.state.bucket
}

output "state_lock_table" {
  description = "DynamoDB table name for state locking"
  value       = aws_dynamodb_table.state_lock.name
}

output "state_kms_key_arn" {
  description = "KMS key ARN used for state bucket SSE"
  value       = aws_kms_key.state.arn
}
