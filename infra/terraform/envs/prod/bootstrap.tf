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
# Network + egress — DECLARED only; plan passes; apply deferred to M4.
# ADR-0009: prod egress = fck-nat (cost-optimised starter), NOT per-AZ managed NAT Gateway.
# enable_nat_gateway=false → modules/network creates routeless private RTs; nat-instance adds the
# default route. Switch back to HA managed NAT = set enable_nat_gateway=true + drop the two modules below.
###############################################################################
# module "network" {
#   source             = "../../modules/network"
#   environment        = local.environment
#   project            = local.project
#   single_nat_gateway = true    # moot when enable_nat_gateway=false (fck-nat is single-instance anyway)
#   enable_nat_gateway = false   # ADR-0009: fck-nat owns egress
# }
#
# module "nat_instance" {
#   source                  = "../../modules/nat-instance"
#   environment             = local.environment
#   project                 = local.project
#   vpc_id                  = module.network.vpc_id
#   public_subnet_id        = module.network.public_subnet_ids[0]
#   vpc_cidr                = "10.0.0.0/16"
#   private_route_table_ids = module.network.private_route_table_ids
# }
#
# module "vpc_endpoints" {
#   source                  = "../../modules/vpc-endpoints"
#   environment             = local.environment
#   project                 = local.project
#   vpc_id                  = module.network.vpc_id
#   vpc_cidr                = "10.0.0.0/16"
#   region                  = "ap-south-1"
#   private_subnet_ids      = module.network.private_subnet_ids
#   private_route_table_ids = module.network.private_route_table_ids
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
# Operational DB — DECLARED; apply deferred to M4.
# ADR-0009: prod DB = Aurora Serverless v2 (0.5–2 ACU, burst-elastic, managed HA), NOT plain RDS.
# (PG is operational-only here; the workload is spiky, so serverless auto-scaling fits.)
###############################################################################
# module "aurora" {
#   source                     = "../../modules/aurora"
#   environment                = local.environment
#   project                    = local.project
#   vpc_id                     = module.network.vpc_id
#   subnet_ids                 = module.network.private_subnet_ids
#   ingress_security_group_ids = [module.network.rds_sg_id]
#   kms_key_arn                = module.kms.root_kms_key_arn
#   min_capacity               = 0.5
#   max_capacity               = 2
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
