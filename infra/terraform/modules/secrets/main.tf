################################################################################
# Brain – Secrets Manager Module
# Creates secret SHELLS (no values in TF state). IRSA-scoped read per workload.
# External-Secrets Operator pattern for injection into pods.
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
  description = "Root CMK ARN for secrets encryption"
}

###############################################################################
# Secret shells — values populated at runtime (never in TF state)
###############################################################################

resource "aws_secretsmanager_secret" "db_app" {
  name                    = "${var.project}/${var.environment}/db/app-credentials"
  kms_key_id              = var.kms_key_arn
  description             = "Brain application DB credentials (non-superuser, app role)"
  recovery_window_in_days = 30

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "db-credentials"
  }
}

resource "aws_secretsmanager_secret" "kafka" {
  name                    = "${var.project}/${var.environment}/kafka/credentials"
  kms_key_id              = var.kms_key_arn
  description             = "Kafka bootstrap servers + SASL credentials (self-hosted Strimzi)"
  recovery_window_in_days = 30

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "event-bus-credentials"
  }
}

resource "aws_secretsmanager_secret" "grafana" {
  name                    = "${var.project}/${var.environment}/grafana/credentials"
  kms_key_id              = var.kms_key_arn
  description             = "Grafana Cloud API key + OTLP endpoints"
  recovery_window_in_days = 30

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "observability-credentials"
  }
}

resource "aws_secretsmanager_secret" "apicurio" {
  name                    = "${var.project}/${var.environment}/apicurio/credentials"
  kms_key_id              = var.kms_key_arn
  description             = "Apicurio schema registry endpoint + auth"
  recovery_window_in_days = 30

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "schema-registry-credentials"
  }
}

###############################################################################
# IAM policies — scoped read access per workload (consumed via IRSA)
###############################################################################

data "aws_iam_policy_document" "collector_secrets_read" {
  statement {
    sid    = "ReadCollectorSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      aws_secretsmanager_secret.kafka.arn,
      aws_secretsmanager_secret.apicurio.arn,
    ]
  }
  statement {
    sid       = "AllowKMSDecrypt"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_policy" "collector_secrets_read" {
  name        = "${var.project}-${var.environment}-collector-secrets"
  description = "collector: read Kafka + Apicurio secrets only"
  policy      = data.aws_iam_policy_document.collector_secrets_read.json
}

data "aws_iam_policy_document" "stream_worker_secrets_read" {
  statement {
    sid    = "ReadStreamWorkerSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      aws_secretsmanager_secret.kafka.arn,
      aws_secretsmanager_secret.apicurio.arn,
    ]
  }
  statement {
    sid       = "AllowKMSDecrypt"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_policy" "stream_worker_secrets_read" {
  name        = "${var.project}-${var.environment}-stream-worker-secrets"
  description = "stream-worker: read Kafka + Apicurio secrets only"
  policy      = data.aws_iam_policy_document.stream_worker_secrets_read.json
}

data "aws_iam_policy_document" "core_secrets_read" {
  statement {
    sid    = "ReadCoreSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      aws_secretsmanager_secret.db_app.arn,
      aws_secretsmanager_secret.kafka.arn,
    ]
  }
  statement {
    sid       = "AllowKMSDecrypt"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_policy" "core_secrets_read" {
  name        = "${var.project}-${var.environment}-core-secrets"
  description = "core: read db + kafka secrets only"
  policy      = data.aws_iam_policy_document.core_secrets_read.json
}

data "aws_iam_policy_document" "otel_collector_secrets_read" {
  statement {
    sid    = "ReadOtelSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      aws_secretsmanager_secret.grafana.arn,
    ]
  }
  statement {
    sid       = "AllowKMSDecrypt"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_policy" "otel_collector_secrets_read" {
  name        = "${var.project}-${var.environment}-otel-collector-secrets"
  description = "otel-collector: read Grafana credentials only"
  policy      = data.aws_iam_policy_document.otel_collector_secrets_read.json
}

###############################################################################
# Outputs
###############################################################################
output "db_app_secret_arn" {
  value = aws_secretsmanager_secret.db_app.arn
}

output "kafka_secret_arn" {
  value = aws_secretsmanager_secret.kafka.arn
}

output "grafana_secret_arn" {
  value = aws_secretsmanager_secret.grafana.arn
}

output "apicurio_secret_arn" {
  value = aws_secretsmanager_secret.apicurio.arn
}

output "collector_secrets_policy_arn" {
  value = aws_iam_policy.collector_secrets_read.arn
}

output "stream_worker_secrets_policy_arn" {
  value = aws_iam_policy.stream_worker_secrets_read.arn
}

output "core_secrets_policy_arn" {
  value = aws_iam_policy.core_secrets_read.arn
}

output "otel_collector_secrets_policy_arn" {
  value = aws_iam_policy.otel_collector_secrets_read.arn
}
