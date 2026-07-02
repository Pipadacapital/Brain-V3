################################################################################
# Brain – Staging Environment Root
# EC10 STAGING: structural scaffold applied (network/IAM/S3/state/KMS);
# compute NOT created — EKS node groups desired/min/max=0; RDS count=0.
# terraform plan passes with zero errors; terraform apply creates only infra
# (no running compute = zero idle AWS spend).
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
  # assume_role { role_arn = "arn:aws:iam::<STAGING_ACCOUNT_ID>:role/TerraformApply" }

  default_tags {
    tags = {
      project     = local.project
      environment = local.environment
      managed_by  = "terraform"
    }
  }
}

locals {
  project     = "brain"
  environment = "staging"
}

###############################################################################
# KMS — structural scaffold: created
###############################################################################
module "kms" {
  source      = "../../modules/kms"
  environment = local.environment
  project     = local.project
}

###############################################################################
# Network — structural scaffold: created
###############################################################################
module "network" {
  source             = "../../modules/network"
  environment        = local.environment
  project            = local.project
  single_nat_gateway = true # Single NAT for staging cost control
}

###############################################################################
# GitHub OIDC
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
# EKS — EC10 STAGING: node groups at ZERO (infrastructure declared, no compute)
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

  # EC10 STAGING: zero node count — no idle compute spend
  system_node_desired = 0
  system_node_min     = 0
  system_node_max     = 0

  # M-03 FIX: staging must use private-only endpoint (DPDP multi-tenant baseline).
  # public_endpoint defaults to false in the module; set explicitly for clarity.
  public_endpoint = false
}

###############################################################################
# Secrets Manager — structural scaffold: created
###############################################################################
module "secrets" {
  source      = "../../modules/secrets"
  environment = local.environment
  project     = local.project
  kms_key_arn = module.kms.root_kms_key_arn
}

###############################################################################
# S3 Iceberg (Bronze) + Glue — NN-4/NN-5: created (non-compute)
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
# ADDITIVE / non-compute: buckets + Glue DBs + Spark-write policy created in
# staging (staging-prod parity). No read path / dbt / app code change.
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
# S3 Audit (WORM) — NN-4: created
###############################################################################
module "s3_audit" {
  source      = "../../modules/s3-audit"
  environment = local.environment
  project     = local.project
  kms_key_arn = module.kms.audit_kms_key_arn
}

###############################################################################
# IRSA roles — NN-3: created (needed even with zero nodes for when M1 enables compute)
###############################################################################
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

# Spark jobs IRSA (Brain V4 PHASE 0) — Argo CronWorkflow SA (brain-jobs) that
# runs the Spark Bronze sink + Phase 1+ Spark Silver/Gold MERGE jobs.
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
    module.s3_iceberg.stream_worker_s3_policy_arn,
    module.s3_iceberg_silver.spark_write_policy_arn,
    module.s3_iceberg_gold.spark_write_policy_arn,
  ]
}

###############################################################################
# RDS — EC10 STAGING: module present, count=0 (no RDS instance created)
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
  # EC10 STAGING: false = no RDS instance (uncomment for M1)
  create   = false
  multi_az = true
}

###############################################################################
# ElastiCache — EC10 STAGING: module present, count=0
###############################################################################
module "elasticache" {
  source      = "../../modules/elasticache"
  environment = local.environment
  project     = local.project
  subnet_ids  = module.network.private_subnet_ids
  redis_sg_id = module.network.elasticache_sg_id
  kms_key_arn = module.kms.root_kms_key_arn
  # EC10 STAGING: false = no Redis instance (uncomment for M1)
  create = false
}

###############################################################################
# Observability — log groups + alarm declared
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
# Outputs
###############################################################################
output "bronze_bucket_name" { value = module.s3_iceberg.bronze_bucket_name }
output "audit_bucket_name" { value = module.s3_audit.audit_bucket_name }

# Brain V4 PHASE 0 — Iceberg Silver/Gold. Glue DB outputs removed with the
# Glue catalog databases (AUD-COST-012 — runtime catalog is REST/JDBC).
output "silver_bucket_name" { value = module.s3_iceberg_silver.bucket_name }
output "gold_bucket_name" { value = module.s3_iceberg_gold.bucket_name }
output "spark_jobs_role_arn" { value = module.irsa_spark_jobs.role_arn }
output "eks_cluster_name" { value = module.eks.cluster_name }
output "root_kms_key_arn" { value = module.kms.root_kms_key_arn }
output "github_plan_role_arn" { value = module.oidc_github.github_plan_role_arn }
