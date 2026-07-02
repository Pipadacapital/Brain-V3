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

# AUD-PROD-004: connector-secrets CMK ARN (modules/kms `connector` key). When
# set, the brain/connector/* runtime-secret IAM policies below are created for
# the core (create/put/read) and stream-worker (read) IRSA roles. Default null
# keeps envs that have not wired the connector platform unchanged.
variable "connector_kms_key_arn" {
  type        = string
  default     = null
  description = "Connector-secrets CMK ARN; enables the brain/connector/* IAM policies (AUD-PROD-004)."
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

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
# App BOOT secret shells (AUD-PROD-003) — the four secrets core FAIL-CLOSES on
# at startup in production. apps/core/src/main.ts treats the env values of
# JWT_SIGNING_SECRET / COOKIE_SECRET / META_APP_SECRET / GOOGLE_ADS_CLIENT_SECRET
# as Secrets Manager names/ARNs and resolves them via AwsSecretsProvider
# (fail-closed: unresolvable secret → startup aborts). Creating the SHELLS here
# makes the go-live fill a VALUE update (aws secretsmanager put-secret-value)
# and the core_secrets_read grant below prevents the deterministic
# AccessDenied → CrashLoop. The brain/<env>/k8s/core-env blob must set those
# four env vars to these secret NAMES (or ARNs) — key contract documented in
# infra/helm/external-secrets-config/README.md.
# Local counterpart: tools/seed/prod-local-aws-bootstrap.sh seeds the same
# four (flat brain/<name> naming, no env segment — see AUD-PROD-014).
###############################################################################

locals {
  app_boot_secrets = {
    "jwt-signing-secret"       = "core JWT signing secret (HIGH-SECRETS-01 fail-closed boot secret)"
    "cookie-secret"            = "core cookie/session secret (HIGH-SECRETS-01 fail-closed boot secret)"
    "meta-app-secret"          = "Meta app secret (OAuth callback + meta-token-refresh; prod boot fail-closed)"
    "google-ads-client-secret" = "Google Ads OAuth client secret (OAuth callback; prod boot fail-closed)"
  }
}

resource "aws_secretsmanager_secret" "app_boot" {
  for_each                = local.app_boot_secrets
  name                    = "${var.project}/${var.environment}/app/${each.key}"
  kms_key_id              = var.kms_key_arn
  description             = "Brain core boot secret shell (value filled at go-live, never in TF state): ${each.value}"
  recovery_window_in_days = 30

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "app-boot-secret"
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
    # AUD-PROD-003: the four brain/<env>/app/* boot shells are read by core at
    # startup (main.ts AwsSecretsProvider, fail-closed) — without this grant a
    # perfect go-live fill pass still ends in AccessDenied → CrashLoop.
    resources = concat(
      [
        aws_secretsmanager_secret.db_app.arn,
        aws_secretsmanager_secret.kafka.arn,
      ],
      [for s in aws_secretsmanager_secret.app_boot : s.arn],
    )
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
  description = "core: read db + kafka + app-boot secrets only"
  policy      = data.aws_iam_policy_document.core_secrets_read.json
}

###############################################################################
# Connector runtime secrets (AUD-PROD-004) — brain/connector/<provider>/<brandId>
# entries are created AT RUNTIME by core (packages/connector-secrets
# AwsSecretsManager: CreateSecret w/ KmsKeyId+Tags, PutSecretValue fallback,
# GetSecretValue, DeleteSecret on disconnect/erasure) and READ by stream-worker
# (backfill/repull token resolution, worker-secrets.ts). No shells exist by
# design — names are per-brand and dynamic — so the grants are ARN-pattern
# scoped. The CMK grants below are also what KmsVaultKeyProvider needs for
# per-brand DEK wrap/unwrap (core) and salt unwrap (both).
###############################################################################

locals {
  # Secrets Manager appends a random 6-char suffix to secret ARNs — the
  # trailing * covers it. Never widen past the brain/connector/ prefix.
  connector_secret_arn_pattern = "arn:aws:secretsmanager:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:secret:${var.project}/connector/*"
}

data "aws_iam_policy_document" "core_connector_secrets_rw" {
  count = var.connector_kms_key_arn != null ? 1 : 0

  statement {
    sid    = "ManageConnectorSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:TagResource", # CreateSecret passes brand_id/connector_type Tags (D-7 audit attribution)
    ]
    resources = [local.connector_secret_arn_pattern]
  }

  statement {
    sid    = "ConnectorCmkUse"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:DescribeKey",
    ]
    resources = [var.connector_kms_key_arn]
  }
}

resource "aws_iam_policy" "core_connector_secrets_rw" {
  count       = var.connector_kms_key_arn != null ? 1 : 0
  name        = "${var.project}-${var.environment}-core-connector-secrets"
  description = "core: create/put/read/delete brain/connector/* runtime secrets + connector CMK encrypt/decrypt (AUD-PROD-004)"
  policy      = data.aws_iam_policy_document.core_connector_secrets_rw[0].json
}

data "aws_iam_policy_document" "stream_worker_connector_secrets_read" {
  count = var.connector_kms_key_arn != null ? 1 : 0

  statement {
    sid    = "ReadConnectorSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [local.connector_secret_arn_pattern]
  }

  statement {
    sid    = "ConnectorCmkDecrypt"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [var.connector_kms_key_arn]
  }
}

resource "aws_iam_policy" "stream_worker_connector_secrets_read" {
  count       = var.connector_kms_key_arn != null ? 1 : 0
  name        = "${var.project}-${var.environment}-stream-worker-connector-secrets"
  description = "stream-worker: read brain/connector/* runtime secrets + connector CMK decrypt (AUD-PROD-004)"
  policy      = data.aws_iam_policy_document.stream_worker_connector_secrets_read[0].json
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

output "app_boot_secret_arns" {
  description = "Map of the brain/<env>/app/* core boot-secret shell ARNs (AUD-PROD-003). Fill JWT_SIGNING_SECRET / COOKIE_SECRET / META_APP_SECRET / GOOGLE_ADS_CLIENT_SECRET in the core-env blob with these."
  value       = { for k, s in aws_secretsmanager_secret.app_boot : k => s.arn }
}

output "k8s_env_secret_arns" {
  description = "Map of the brain/<env>/k8s/* env-secret shell ARNs (AUD-COST-017)"
  value       = { for k, s in aws_secretsmanager_secret.k8s_env : k => s.arn }
}

output "eso_k8s_secrets_read_policy_arn" {
  value = aws_iam_policy.eso_k8s_secrets_read.arn
}

output "core_connector_secrets_rw_policy_arn" {
  description = "core brain/connector/* RW policy ARN (null unless connector_kms_key_arn is set — AUD-PROD-004)"
  value       = var.connector_kms_key_arn != null ? aws_iam_policy.core_connector_secrets_rw[0].arn : null
}

output "stream_worker_connector_secrets_read_policy_arn" {
  description = "stream-worker brain/connector/* read policy ARN (null unless connector_kms_key_arn is set — AUD-PROD-004)"
  value       = var.connector_kms_key_arn != null ? aws_iam_policy.stream_worker_connector_secrets_read[0].arn : null
}
