################################################################################
# Brain – Dev Environment Root
# EC10: Full apply — all resources running.
# Region: ap-south-1 (COMPLIANCE.md data residency — India).
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

provider "aws" {
  region = "ap-south-1"
  # Assume a dedicated dev account role (account-per-environment isolation)
  # assume_role { role_arn = "arn:aws:iam::<DEV_ACCOUNT_ID>:role/TerraformApply" }

  default_tags {
    tags = {
      project     = local.project
      environment = local.environment
      managed_by  = "terraform"
      region      = "ap-south-1"
    }
  }
}

locals {
  project     = "brain"
  environment = "dev"
}

###############################################################################
# KMS
###############################################################################
module "kms" {
  source      = "../../modules/kms"
  environment = local.environment
  project     = local.project
}

###############################################################################
# Network
###############################################################################
module "network" {
  source             = "../../modules/network"
  environment        = local.environment
  project            = local.project
  single_nat_gateway = true # Cost-optimised for dev
}

###############################################################################
# GitHub OIDC (consumed by Track B CI gate)
###############################################################################
module "oidc_github" {
  source      = "../../modules/oidc-github"
  environment = local.environment
  project     = local.project
  # AUD-COST-002: real remote + real default branch (was brain-platform/brain@main)
  github_org       = "Rishabhporwal"
  github_repo      = "Brain-V4"
  allowed_branches = ["master"]
}

###############################################################################
# EKS — full compute for dev
###############################################################################
module "eks" {
  source             = "../../modules/eks"
  environment        = local.environment
  project            = local.project
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
  cluster_sg_id      = module.network.eks_cluster_sg_id
  node_sg_id         = module.network.eks_nodes_sg_id
  kms_key_arn        = module.kms.root_kms_key_arn

  # Dev: real compute (EC10)
  system_node_desired = 2
  system_node_min     = 1
  system_node_max     = 4

  # M-03 FIX: dev-only public endpoint for bootstrap access before VPN/bastion.
  # CKV_AWS_39 (EKS public endpoint) suppressed inline here only — the global skip has
  # been removed from .checkov.yaml so staging and prod are never silently allowed public.
  # checkov:skip=CKV_AWS_39:dev-only bootstrap access; no VPN/bastion in Sprint-0
  public_endpoint = true
}

###############################################################################
# Secrets Manager
###############################################################################
module "secrets" {
  source      = "../../modules/secrets"
  environment = local.environment
  project     = local.project
  kms_key_arn = module.kms.root_kms_key_arn
}

###############################################################################
# S3 Iceberg (Bronze) + Glue — NN-4/NN-5
###############################################################################
module "s3_iceberg" {
  source                 = "../../modules/s3-iceberg"
  environment            = local.environment
  project                = local.project
  kms_key_arn            = module.kms.root_kms_key_arn
  stream_worker_role_arn = module.irsa_stream_worker.role_arn
  analytics_role_arn     = module.irsa_core.role_arn
}

###############################################################################
# S3 Iceberg MEDALLION (Silver + Gold) + Glue — Brain V4 PHASE 0 / PR-0.1
# ADDITIVE: new buckets/catalogs/Spark-write role beside Bronze. No read path,
# dbt model, or app code changes. Spark CREATE+MERGE into brain_silver/brain_gold.
###############################################################################
module "s3_iceberg_silver" {
  source             = "../../modules/s3-iceberg-medallion"
  layer              = "silver"
  environment        = local.environment
  project            = local.project
  kms_key_arn        = module.kms.root_kms_key_arn
  analytics_role_arn = module.irsa_core.role_arn
}

module "s3_iceberg_gold" {
  source             = "../../modules/s3-iceberg-medallion"
  layer              = "gold"
  environment        = local.environment
  project            = local.project
  kms_key_arn        = module.kms.root_kms_key_arn
  analytics_role_arn = module.irsa_core.role_arn
}

###############################################################################
# S3 Audit (WORM) — NN-4
###############################################################################
module "s3_audit" {
  source      = "../../modules/s3-audit"
  environment = local.environment
  project     = local.project
  kms_key_arn = module.kms.audit_kms_key_arn
}

###############################################################################
# IRSA roles — NN-3 StringEquals, NN-5 prefix-scoped
###############################################################################

# Collector IRSA
module "irsa_collector" {
  source               = "../../modules/irsa"
  role_name            = "collector"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "collector"
  service_account_name = "collector"
  environment          = local.environment
  project              = local.project
  policy_arns          = [module.secrets.collector_secrets_policy_arn]
}

# Stream-worker IRSA (NN-5: write to bronze prefix only)
module "irsa_stream_worker" {
  source               = "../../modules/irsa"
  role_name            = "stream-worker"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "stream-worker"
  service_account_name = "stream-worker"
  environment          = local.environment
  project              = local.project
  policy_arns = [
    module.secrets.stream_worker_secrets_policy_arn,
    module.s3_iceberg.stream_worker_s3_policy_arn,
  ]
}

# Core IRSA
module "irsa_core" {
  source               = "../../modules/irsa"
  role_name            = "core"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "core"
  service_account_name = "core"
  environment          = local.environment
  project              = local.project
  policy_arns = [
    module.secrets.core_secrets_policy_arn,
    module.s3_iceberg.analytics_s3_policy_arn,
  ]
}

# Spark jobs IRSA (Brain V4 PHASE 0) — the Argo CronWorkflow SA (brain-jobs)
# that runs the Spark Bronze sink AND, from Phase 1+, Spark Silver/Gold MERGE
# jobs. NN-3: StringEquals on namespace+SA. Gets Bronze write (existing) +
# Silver/Gold write (new, this phase). Read paths unchanged.
module "irsa_spark_jobs" {
  source               = "../../modules/irsa"
  role_name            = "jobs"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "argo"
  service_account_name = "brain-jobs"
  environment          = local.environment
  project              = local.project
  policy_arns = [
    module.s3_iceberg.stream_worker_s3_policy_arn, # Bronze write (sink)
    module.s3_iceberg_silver.spark_write_policy_arn,
    module.s3_iceberg_gold.spark_write_policy_arn,
  ]
}

###############################################################################
# RDS PostgreSQL — dev: full apply (EC10)
###############################################################################
module "rds" {
  source                 = "../../modules/rds"
  environment            = local.environment
  project                = local.project
  vpc_id                 = module.network.vpc_id
  subnet_ids             = module.network.private_subnet_ids
  rds_sg_id              = module.network.rds_sg_id
  kms_key_arn            = module.kms.root_kms_key_arn
  db_password_secret_arn = module.secrets.db_app_secret_arn
  create                 = true # Full apply in dev
  multi_az               = true
}

###############################################################################
# ElastiCache Redis — dev: full apply (EC10)
###############################################################################
module "elasticache" {
  source      = "../../modules/elasticache"
  environment = local.environment
  project     = local.project
  subnet_ids  = module.network.private_subnet_ids
  redis_sg_id = module.network.elasticache_sg_id
  kms_key_arn = module.kms.root_kms_key_arn
  create      = true # Full apply in dev
}

###############################################################################
# Observability — CloudWatch log groups + composite EKS alarm
###############################################################################
module "observability" {
  source            = "../../modules/observability"
  environment       = local.environment
  project           = local.project
  kms_key_arn       = module.kms.root_kms_key_arn
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url
  cluster_name      = module.eks.cluster_name
}

###############################################################################
# Outputs (consumed by Track D/E via remote state)
###############################################################################
output "bronze_bucket_name" { value = module.s3_iceberg.bronze_bucket_name }
output "audit_bucket_name" { value = module.s3_audit.audit_bucket_name }
output "glue_database_name" { value = module.s3_iceberg.glue_database_name }

# Brain V4 PHASE 0 — Iceberg Silver/Gold (consumed by Spark jobs + StarRocks)
output "silver_bucket_name" { value = module.s3_iceberg_silver.bucket_name }
output "gold_bucket_name" { value = module.s3_iceberg_gold.bucket_name }
output "silver_glue_database_name" { value = module.s3_iceberg_silver.glue_database_name }
output "gold_glue_database_name" { value = module.s3_iceberg_gold.glue_database_name }
output "spark_jobs_role_arn" { value = module.irsa_spark_jobs.role_arn }
output "eks_cluster_name" { value = module.eks.cluster_name }
output "eks_cluster_endpoint" { value = module.eks.cluster_endpoint }
output "oidc_provider_arn" { value = module.eks.oidc_provider_arn }
output "db_endpoint" { value = module.rds.db_endpoint }
output "redis_endpoint" { value = module.elasticache.redis_primary_endpoint }
output "root_kms_key_arn" { value = module.kms.root_kms_key_arn }
output "audit_kms_key_arn" { value = module.kms.audit_kms_key_arn }
output "otel_collector_role_arn" { value = module.observability.otel_collector_role_arn }
output "github_plan_role_arn" { value = module.oidc_github.github_plan_role_arn }

output "ecr_urls" {
  value = module.eks.ecr_repository_urls
}
