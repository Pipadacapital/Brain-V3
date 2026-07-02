################################################################################
# Brain – Prod Environment Root (M4 UN-GATED — AUD-COST-001)
# Formerly bootstrap-only (kms + oidc_github, every runtime module commented per
# EC10 deferred-apply). The go-live decision un-gates the full ADR-0009 module
# set: network (fck-nat egress), EKS, Aurora Serverless v2, ElastiCache,
# S3 Iceberg medallion (Bronze/Silver/Gold), secrets, IRSA.
#
# STEP ZERO (remote state, one-time, local creds): apply infra/terraform/bootstrap
# with -var environment=prod (S3 state bucket + DynamoDB lock + state KMS), then
# fill <PROD_ACCOUNT_ID> in backend.tf. See infra/terraform/README.md
# "Prod go-live" and docs/runbooks/prod-m4-turn-on.md.
#
# Apply path: .github/workflows/prod-apply.yml (OIDC, confirm-phrase +
# `production` environment approval gates), staged via the -target input:
#   module.network → module.nat_instance + module.vpc_endpoints → module.eks
#   → blank target (everything else; the graph orders Aurora/S3/IRSA correctly).
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
  source      = "../../modules/oidc-github"
  environment = local.environment
  project     = local.project
  # AUD-COST-002: MUST match the real remote (git remote -v) or every OIDC
  # role assumption is rejected — was brain-platform/brain (repo doesn't exist).
  github_org       = "Rishabhporwal"
  github_repo      = "Brain-V4"
  allowed_branches = ["master"] # repo default branch (workflow_dispatch runs here) — was "main" (mismatch)

  # ECR-push + terraform-apply CI roles (main.yml / prod-apply.yml). After apply,
  # set repo variables AWS_ECR_PUSH_ROLE_ARN / AWS_PROD_APPLY_ROLE_ARN from the
  # outputs below.
  create_cicd_roles = true
  apply_environment = "production"
}

###############################################################################
# Network + egress — ADR-0009: prod egress = fck-nat (cost-optimised starter),
# NOT per-AZ managed NAT Gateway. enable_nat_gateway=false → modules/network
# creates routeless private RTs; nat-instance adds the default route. Switch
# back to HA managed NAT = enable_nat_gateway=true + drop nat_instance/vpc_endpoints.
###############################################################################
module "network" {
  source             = "../../modules/network"
  environment        = local.environment
  project            = local.project
  vpc_cidr           = var.vpc_cidr
  single_nat_gateway = true  # moot when enable_nat_gateway=false (fck-nat is single-instance anyway)
  enable_nat_gateway = false # ADR-0009: fck-nat owns egress
}

module "nat_instance" {
  source                  = "../../modules/nat-instance"
  environment             = local.environment
  project                 = local.project
  vpc_id                  = module.network.vpc_id
  public_subnet_id        = module.network.public_subnet_ids[0]
  vpc_cidr                = var.vpc_cidr
  private_route_table_ids = module.network.private_route_table_ids
}

module "vpc_endpoints" {
  source                  = "../../modules/vpc-endpoints"
  environment             = local.environment
  project                 = local.project
  vpc_id                  = module.network.vpc_id
  vpc_cidr                = var.vpc_cidr
  region                  = "ap-south-1"
  private_subnet_ids      = module.network.private_subnet_ids
  private_route_table_ids = module.network.private_route_table_ids
}

###############################################################################
# EKS — system node group only; all workload capacity is Karpenter-managed
###############################################################################
module "eks" {
  source              = "../../modules/eks"
  environment         = local.environment
  project             = local.project
  vpc_id              = module.network.vpc_id
  private_subnet_ids  = module.network.private_subnet_ids
  cluster_sg_id       = module.network.eks_cluster_sg_id
  node_sg_id          = module.network.eks_nodes_sg_id
  kms_key_arn         = module.kms.root_kms_key_arn
  system_node_desired = var.system_node_desired
  system_node_min     = var.system_node_min
  system_node_max     = var.system_node_max

  # AUD-COST-009: private-only endpoint has no access path yet; a non-empty
  # operator allowlist (tfvars) opens the public endpoint pinned to those CIDRs
  # for the go-live bootstrap. Empty = private-only.
  public_access_cidrs = var.eks_public_access_cidrs
}

###############################################################################
# Operational DB — ADR-0009: Aurora Serverless v2 (0.5–2 ACU, burst-elastic,
# managed HA), NOT plain RDS. PG is operational-only; the workload is spiky.
###############################################################################
module "aurora" {
  source                     = "../../modules/aurora"
  environment                = local.environment
  project                    = local.project
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  ingress_security_group_ids = [module.network.rds_sg_id]
  kms_key_arn                = module.kms.root_kms_key_arn
  min_capacity               = var.aurora_min_capacity
  max_capacity               = var.aurora_max_capacity
}

###############################################################################
# Secrets Manager + S3 Iceberg (Bronze, NN-4 COMPLIANCE+7yr) + S3 Audit
###############################################################################
module "secrets" {
  source      = "../../modules/secrets"
  environment = local.environment
  project     = local.project
  kms_key_arn = module.kms.root_kms_key_arn
}

module "s3_iceberg" {
  source                 = "../../modules/s3-iceberg"
  environment            = local.environment
  project                = local.project
  kms_key_arn            = module.kms.root_kms_key_arn
  stream_worker_role_arn = module.irsa_stream_worker.role_arn
  analytics_role_arn     = module.irsa_core.role_arn
}

module "s3_audit" {
  source      = "../../modules/s3-audit"
  environment = local.environment
  project     = local.project
  kms_key_arn = module.kms.audit_kms_key_arn
}

###############################################################################
# App IRSA roles (workload identity → Secrets Manager + S3). Mirror of envs/dev.
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

###############################################################################
# Redis serving cache (ADR-0009 sizing: cache.t4g.micro starter)
###############################################################################
module "elasticache" {
  source      = "../../modules/elasticache"
  environment = local.environment
  project     = local.project
  subnet_ids  = module.network.private_subnet_ids
  redis_sg_id = module.network.elasticache_sg_id
  kms_key_arn = module.kms.root_kms_key_arn
  node_type   = "cache.t4g.micro"
  create      = true
}

###############################################################################
# Brain V4 — Iceberg MEDALLION (Silver + Gold) + Spark jobs IRSA
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
# Outputs — the post-apply fill pass reads these (helm values-prod placeholders,
# ArgoCD IRSA annotations, repo variables). See docs/runbooks/prod-m4-turn-on.md.
###############################################################################
output "github_plan_role_arn" { value = module.oidc_github.github_plan_role_arn }
output "github_ecr_push_role_arn" { value = module.oidc_github.github_ecr_push_role_arn }
output "github_apply_role_arn" { value = module.oidc_github.github_apply_role_arn }
output "root_kms_key_arn" { value = module.kms.root_kms_key_arn }
output "audit_kms_key_arn" { value = module.kms.audit_kms_key_arn }

output "vpc_id" { value = module.network.vpc_id }
output "nat_instance_public_ip" { value = module.nat_instance.public_ip }

output "eks_cluster_name" { value = module.eks.cluster_name }
output "eks_cluster_endpoint" { value = module.eks.cluster_endpoint }
output "ecr_repository_urls" { value = module.eks.ecr_repository_urls }

output "aurora_endpoint" { value = module.aurora.endpoint }
output "aurora_reader_endpoint" { value = module.aurora.reader_endpoint }
output "redis_endpoint" { value = module.elasticache.redis_primary_endpoint }

output "bronze_bucket_name" { value = module.s3_iceberg.bronze_bucket_name }
output "silver_bucket_name" { value = module.s3_iceberg_silver.bucket_name }
output "gold_bucket_name" { value = module.s3_iceberg_gold.bucket_name }
output "audit_bucket_name" { value = module.s3_audit.audit_bucket_name }

output "collector_role_arn" { value = module.irsa_collector.role_arn }
output "stream_worker_role_arn" { value = module.irsa_stream_worker.role_arn }
output "core_role_arn" { value = module.irsa_core.role_arn }
output "spark_jobs_role_arn" { value = module.irsa_spark_jobs.role_arn }
