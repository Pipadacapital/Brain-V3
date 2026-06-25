################################################################################
# Brain – Prod Environment Root (Bootstrap Only)
# EC10 PROD: workspace/account bootstrapped (state bucket created by bootstrap/,
# GitHub OIDC provider registered, root IAM bootstrapped). All resource
# declarations exist; terraform plan passes. NO apply of compute until M4.
# Zero running AWS resources; zero idle spend.
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
  # assume_role { role_arn = "arn:aws:iam::<PROD_ACCOUNT_ID>:role/TerraformApply" }

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
  environment = "prod"
}

###############################################################################
# KMS — APPLIED in bootstrap (needed for state bucket + OIDC)
###############################################################################
module "kms" {
  source      = "../../modules/kms"
  environment = local.environment
  project     = local.project
}

###############################################################################
# GitHub OIDC — APPLIED in bootstrap (needed for CI gate to plan prod)
###############################################################################
module "oidc_github" {
  source           = "../../modules/oidc-github"
  environment      = local.environment
  project          = local.project
  github_org       = "brain-platform"
  github_repo      = "brain"
  allowed_branches = ["main"]
}

###############################################################################
# Network — DECLARED only; plan passes; apply deferred to M4
# Uncomment module call to apply at M4.
###############################################################################
# module "network" {
#   source             = "../../modules/network"
#   environment        = local.environment
#   project            = local.project
#   single_nat_gateway = false  # HA for prod: one NAT per AZ
# }

###############################################################################
# EKS — DECLARED only; plan target exists; apply deferred to M4
###############################################################################
# module "eks" {
#   source             = "../../modules/eks"
#   environment        = local.environment
#   project            = local.project
#   vpc_id             = module.network.vpc_id
#   private_subnet_ids = module.network.private_subnet_ids
#   cluster_sg_id      = module.network.eks_cluster_sg_id
#   node_sg_id         = module.network.eks_nodes_sg_id
#   kms_key_arn        = module.kms.root_kms_key_arn
#   system_node_desired = 3
#   system_node_min     = 2
#   system_node_max     = 6
# }

###############################################################################
# RDS — DECLARED; apply deferred to M4
###############################################################################
# module "rds" {
#   source      = "../../modules/rds"
#   environment = local.environment
#   ...
# }

###############################################################################
# S3 Iceberg + Audit — DECLARED; NN-4 COMPLIANCE+7yr at creation
# Apply S3 buckets before any data pipeline (before M1 for staging-prod parity)
###############################################################################
# module "s3_iceberg" { ... }
# module "s3_audit"   { ... }

###############################################################################
# Brain V4 PHASE 0 — Iceberg MEDALLION (Silver + Gold) + Spark jobs IRSA.
# DECLARED only (mirrors the deferred-apply discipline above); apply alongside
# s3_iceberg at M1/M4 for staging-prod parity. Uncomment when the prod S3 layer
# is applied. ADDITIVE: no read path / dbt / app code change.
###############################################################################
# module "s3_iceberg_silver" {
#   source             = "../../modules/s3-iceberg-medallion"
#   layer              = "silver"
#   environment        = local.environment
#   project            = local.project
#   kms_key_arn        = module.kms.root_kms_key_arn
#   analytics_role_arn = module.irsa_core.role_arn
# }
#
# module "s3_iceberg_gold" {
#   source             = "../../modules/s3-iceberg-medallion"
#   layer              = "gold"
#   environment        = local.environment
#   project            = local.project
#   kms_key_arn        = module.kms.root_kms_key_arn
#   analytics_role_arn = module.irsa_core.role_arn
# }
#
# module "irsa_spark_jobs" {
#   source               = "../../modules/irsa"
#   role_name            = "jobs"
#   oidc_provider_arn    = module.eks.oidc_provider_arn
#   oidc_provider_url    = module.eks.oidc_provider_url
#   namespace            = "argo"
#   service_account_name = "brain-jobs"
#   environment          = local.environment
#   project              = local.project
#   policy_arns = [
#     module.s3_iceberg.stream_worker_s3_policy_arn,
#     module.s3_iceberg_silver.spark_write_policy_arn,
#     module.s3_iceberg_gold.spark_write_policy_arn,
#   ]
# }

###############################################################################
# Outputs — bootstrap phase (oidc + kms only)
###############################################################################
output "github_plan_role_arn" { value = module.oidc_github.github_plan_role_arn }
output "root_kms_key_arn" { value = module.kms.root_kms_key_arn }
output "audit_kms_key_arn" { value = module.kms.audit_kms_key_arn }
