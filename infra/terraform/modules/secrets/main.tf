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
# k8s env-Secret shells (AUD-COST-017) — the seven brain/<env>/k8s/* entries
# the External Secrets Operator chart (infra/helm/external-secrets-config)
# reads and materializes as the envSecretName Secrets every workload chart
# consumes. Creating the SHELLS here makes the go-live fill step a VALUE update
# (aws secretsmanager put-secret-value), not resource creation — and makes
# drift plan-visible. Values are seeded by the operator and NEVER enter TF
# state. Key contracts: infra/helm/external-secrets-config/README.md.
###############################################################################

locals {
  k8s_env_secrets = {
    "core-env"                = "core + BFF + cronworkflows env (DATABASE_URL via pgbouncer, DATABASE_URL_DIRECT, REDIS/KAFKA/TRINO/ICEBERG/NEO4J wiring)"
    "web-env"                 = "web (BFF_BASE_URL / CORE_API_URL)"
    "collector-env"           = "collector (DATABASE_URL, REDIS_URL, KAFKA_BROKERS, HMAC/pixel config)"
    "stream-worker-env"       = "stream-worker (DIRECT Aurora DATABASE_URL — leader lock, KAFKA/TRINO/NEO4J, connector app creds)"
    "pgbouncer-env"           = "pgbouncer upstream admin credentials (DB_USER/DB_PASSWORD)"
    "iceberg-rest-catalog-db" = "iceberg-rest JdbcCatalog credentials (exactly: jdbc-user, jdbc-password)"
    "neo4j-auth"              = "official neo4j chart auth (exactly: NEO4J_AUTH = neo4j/<password>)"
  }
}

resource "aws_secretsmanager_secret" "k8s_env" {
  for_each                = local.k8s_env_secrets
  name                    = "${var.project}/${var.environment}/k8s/${each.key}"
  kms_key_id              = var.kms_key_arn
  description             = "Brain k8s env Secret shell (ESO-synced): ${each.value}"
  recovery_window_in_days = 30

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "k8s-env-secret"
  }
}

###############################################################################
# IAM policies — scoped read access per workload (consumed via IRSA)
###############################################################################

# External Secrets Operator controller (role brain-<env>-external-secrets):
# read ONLY the brain/<env>/k8s/* shells above + KMS decrypt. Attached via the
# irsa_external_secrets module in the env root (AUD-COST-017).
data "aws_iam_policy_document" "eso_k8s_secrets_read" {
  statement {
    sid    = "ReadK8sEnvSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [for s in aws_secretsmanager_secret.k8s_env : s.arn]
  }
  statement {
    sid       = "AllowKMSDecrypt"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_policy" "eso_k8s_secrets_read" {
  name        = "${var.project}-${var.environment}-eso-k8s-secrets"
  description = "External Secrets Operator: read the brain/${var.environment}/k8s/* env-secret shells only"
  policy      = data.aws_iam_policy_document.eso_k8s_secrets_read.json
}

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

output "k8s_env_secret_arns" {
  description = "Map of the brain/<env>/k8s/* env-secret shell ARNs (AUD-COST-017)"
  value       = { for k, s in aws_secretsmanager_secret.k8s_env : k => s.arn }
}

output "eso_k8s_secrets_read_policy_arn" {
  value = aws_iam_policy.eso_k8s_secrets_read.arn
}
