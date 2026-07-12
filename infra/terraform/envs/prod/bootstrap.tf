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

  # AUD-NAME-001: mandatory PascalCase tag set (Environment/Service/Owner/
  # CostCenter + Project/ManagedBy) from modules/_shared. The legacy lowercase
  # duplicates (project/environment/managed_by) are DROPPED here: prod was never
  # applied with them, and IAM treats tag keys as case-insensitive, so
  # project/Project (etc.) collided as duplicate keys on every IAM role
  # (CreateRole InvalidInput: "Duplicate tag keys found"). PascalCase only.
  default_tags {
    tags = module.tags.common_tags
  }
}

# AUD-OPS-014: the DR replica region for S3 CRR (module s3_warehouse_crr below).
# ap-south-2 (Hyderabad) by default — IN-COUNTRY, so the AUD-OPS-042 residency
# posture is unchanged (decision doc docs/adr/0011-s3-crr-residency.md).
provider "aws" {
  alias  = "replica"
  region = var.replica_region
  default_tags {
    tags = module.tags.common_tags
  }
}

locals {
  project     = "brain"
  environment = "prod"
}

# Zero-resource tag standard module (safe in the provider block — it creates
# nothing and depends on no provider).
module "tags" {
  source      = "../../modules/_shared"
  environment = local.environment
  project     = local.project
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
  github_org  = "Pipadacapital"
  github_repo = "Brain-V3"
  # RELEASE-LAYER (2026-07-11): image builds moved to `release` (deploy.yml);
  # master keeps the prod-promote lane (promote-prod.yml) + workflow_dispatch.
  allowed_branches = ["master", "release"]

  # ECR-push + terraform-apply CI roles (deploy.yml / prod-apply.yml). After apply,
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

  # AUD-INFRA-012 / AUD-OPS-031: the full 5-service × 3-AZ endpoint set was
  # ~$110-140/mo (15 ENI-hours) — the second-largest fixed line — for traffic
  # that can ride the fee-free fck-nat (ADR-0009) at ~$0 marginal. Keep ONLY
  # ecr.api/ecr.dkr (registry auth/manifests for image pulls; layer blobs come
  # via the FREE S3 gateway endpoint) in a SINGLE subnet. logs/sts/secretsmanager
  # calls (low-volume JSON) now traverse fck-nat like all other egress.
  # Rollback: delete these two lines to restore the 5×3 legacy set.
  interface_services   = ["ecr.api", "ecr.dkr"]
  interface_subnet_ids = [module.network.private_subnet_ids[0]]
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

  # AUD-OPS-028 / AUD-INFRA-019: EKS 1.33 upgrade gates. Defaults are the LIVE
  # values (1.32 / AL2 / null) so this plan is a no-op; the operator flips them
  # in terraform.tfvars per docs/runbooks/eks-1-33-upgrade.md (AL2023 first,
  # then 1.33, then STANDARD support) to drop the $360/mo extended-support fee.
  kubernetes_version   = var.cluster_version
  system_ami_type      = var.system_ami_type
  cluster_support_type = var.eks_support_type
}

###############################################################################
# Karpenter (AUD-COST-010) — controller IRSA role + SQS interruption queue +
# EventBridge rules. All non-system capacity (Spark batch / Trino / streaming)
# is Karpenter Spot; without this the helm/ArgoCD intent can launch nothing.
# Discovery tags (karpenter.sh/discovery = brain-prod) are set by modules/network.
###############################################################################
module "karpenter" {
  source            = "../../modules/karpenter"
  environment       = local.environment
  project           = local.project
  cluster_name      = module.eks.cluster_name
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url
  node_role_arn     = module.eks.node_role_arn
}

###############################################################################
# Operational DB — ADR-0009: Aurora Serverless v2 (0.5–2 ACU, burst-elastic,
# managed HA), NOT plain RDS. PG is operational-only; the workload is spiky.
###############################################################################
module "aurora" {
  source      = "../../modules/aurora"
  environment = local.environment
  project     = local.project
  vpc_id      = module.network.vpc_id
  subnet_ids  = module.network.private_subnet_ids
  # The EKS-managed cluster SG is what node/pod traffic actually egresses from —
  # nodes are NOT in the network module's eks_nodes_sg, so rds_sg alone left every
  # workload→Aurora connection timing out. Allow the real node SG too.
  ingress_security_group_ids = [module.network.rds_sg_id, module.eks.cluster_primary_security_group_id]
  kms_key_arn                = module.kms.root_kms_key_arn
  min_capacity               = var.aurora_min_capacity
  max_capacity               = var.aurora_max_capacity
}

# ElastiCache Redis: same fix — allow 6379 from the EKS-managed cluster SG. The
# network elasticache_sg only admitted the (unused) eks_nodes_sg.
resource "aws_security_group_rule" "redis_from_eks_cluster_sg" {
  type                     = "ingress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  security_group_id        = module.network.elasticache_sg_id
  source_security_group_id = module.eks.cluster_primary_security_group_id
  description              = "Redis from EKS-managed cluster SG (real node traffic)"
}

# Karpenter selects node SGs by the karpenter.sh/discovery tag, which lives on the
# network module's eks_nodes SG — but that SG is NOT the one the EKS control plane
# trusts for the private API endpoint (nor the one our Aurora/Redis ingress rules
# allow). Result: Karpenter nodes booted but never registered (NodeNotFound). Tag
# the EKS-managed cluster SG (what system MNG nodes use + our DB rules trust) so
# Karpenter nodes attach it and can reach the API + the databases.
resource "aws_ec2_tag" "cluster_sg_karpenter_discovery" {
  resource_id = module.eks.cluster_primary_security_group_id
  key         = "karpenter.sh/discovery"
  value       = "brain-prod"
}

# EC2 Spot service-linked role — Karpenter's controller role cannot create it, so
# the FIRST Spot launch on a fresh account fails with
# AuthFailure.ServiceLinkedRoleCreationNotPermitted. Create it once here.
resource "aws_iam_service_linked_role" "spot" {
  aws_service_name = "spot.amazonaws.com"
}

# iceberg-rest catalog image (apache/iceberg-rest-fixture + the PG JDBC driver the
# fixture omits — see db/iceberg/rest/Dockerfile). Not a pnpm app, so it's outside
# the eks module's brain-<svc>-prod ECR set; same IMMUTABLE, KMS-encrypted posture.
resource "aws_ecr_repository" "iceberg_rest" {
  name                 = "brain-iceberg-rest-prod"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = module.kms.root_kms_key_arn
  }
}

# AUD-INFRA-018: the standalone repo lacked the lifecycle policy the eks-module
# app repos get — IMMUTABLE tags + no lifecycle = every rebuild accumulates
# forever. Mirrors the eks module's untagged-expiry and adds keep-last-N for
# tagged images (immutable tagging means every build is a new tag). N=10 keeps
# any digest a running pod could still pull after a node reschedule.
resource "aws_ecr_lifecycle_policy" "iceberg_rest" {
  repository = aws_ecr_repository.iceberg_rest.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only the last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      },
    ]
  })
}

###############################################################################
# Secrets Manager + S3 Iceberg medallion WAREHOUSE + S3 Audit (WORM).
# AUD-COST-016: ONE warehouse bucket, NO Object Lock. The local lakehouse runs
# ONE iceberg-rest server with ONE warehouse root and the medallion layers as
# Iceberg NAMESPACES (brain_bronze/brain_silver/brain_gold) — prod mirrors that
# exactly (modules/s3-iceberg header has the full rationale). WORM retention
# lives on the audit bucket only (modules/s3-audit).
###############################################################################
module "secrets" {
  source      = "../../modules/secrets"
  environment = local.environment
  project     = local.project
  kms_key_arn = module.kms.root_kms_key_arn
  # AUD-PROD-004: enables the brain/connector/* runtime-secret IAM policies
  # (attached to irsa_core / irsa_stream_worker below).
  connector_kms_key_arn = module.kms.connector_kms_key_arn
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
# Thanos long-term metrics (AUD-PROD-012) — objstore bucket + IRSA role for
# the Thanos sidecar inside the kube-prometheus-stack Prometheus pods
# (observability stack: ArgoCD app in ns `monitoring`). NN-3 trust is pinned
# to the SA kube-prometheus-stack creates for Prometheus (shared by the
# sidecar container): monitoring/kube-prometheus-stack-prometheus — a rename
# on the chart side is a deterministic STS AccessDenied, keep them in lockstep.
###############################################################################
module "s3_metrics" {
  source      = "../../modules/s3-metrics"
  environment = local.environment
  project     = local.project
  kms_key_arn = module.kms.root_kms_key_arn
}

module "irsa_thanos" {
  source               = "../../modules/irsa"
  role_name            = "thanos"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "monitoring"
  service_account_name = "kube-prometheus-stack-prometheus"
  environment          = local.environment
  project              = local.project
  policy_arns          = [module.s3_metrics.thanos_objstore_policy_arn]
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
    # AUD-PROD-004: read brain/connector/* tokens (backfill/repull) + CMK decrypt.
    module.secrets.stream_worker_connector_secrets_read_policy_arn,
  ]
}

# core sends transactional email (account verification, invites) via SES.
# SES itself enforces the verified sending identity (brain.pipadacapital.com
# DKIM), so scoping the action to * is safe; SendRawEmail covers MIME bodies.
resource "aws_iam_policy" "core_ses_send" {
  name = "${local.project}-${local.environment}-core-ses-send"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ses:SendEmail", "ses:SendRawEmail"]
      Resource = "*"
    }]
  })
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
    # AUD-PROD-004: create/put/read/delete brain/connector/* runtime secrets +
    # connector CMK encrypt/decrypt (OAuth tokens, PII-vault DEK wrapping).
    module.secrets.core_connector_secrets_rw_policy_arn,
    # transactional email (account verification) via SES
    aws_iam_policy.core_ses_send.arn,
  ]
}

###############################################################################
# Platform-controller + serving IRSA roles (AUD-COST-017) — the six roles the
# helm/ArgoCD manifests reference (infra/helm/PLACEHOLDERS.md §4) that nothing
# created. Namespaces + ServiceAccount names MUST match the charts exactly
# (NN-3 StringEquals trust): a mismatch is a deterministic STS AccessDenied at
# pod start.
###############################################################################

# web — chart SA `web` (brain.fullname = chart name). No AWS access needed
# today; the role exists so the values-prod IRSA annotation resolves.
module "irsa_web" {
  source               = "../../modules/irsa"
  role_name            = "web"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "web"
  service_account_name = "web"
  environment          = local.environment
  project              = local.project
  policy_arns          = []
}

# trino — serving engine, read-only over the medallion warehouse namespaces
# (AUD-COST-016 layout). SA name = trino.fullname = brain-prod-trino.
module "irsa_trino" {
  source               = "../../modules/irsa"
  role_name            = "trino"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "trino"
  service_account_name = "brain-${local.environment}-trino"
  environment          = local.environment
  project              = local.project
  policy_arns          = [module.s3_iceberg.analytics_s3_policy_arn]
}

# iceberg-rest — the JdbcCatalog server writes table METADATA files itself
# (create/commit land server-side), so it needs the same medallion RW grant as
# the Spark data plane. SA name = `iceberg-rest` (chart serviceAccount.name).
module "irsa_iceberg_rest" {
  source               = "../../modules/irsa"
  role_name            = "iceberg-rest"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "iceberg-rest"
  service_account_name = "iceberg-rest"
  environment          = local.environment
  project              = local.project
  policy_arns          = [module.s3_iceberg.spark_medallion_rw_policy_arn]
}

# external-secrets — ESO controller; reads ONLY brain/prod/k8s/* (shells now
# created by modules/secrets). SA name pinned to `external-secrets` in
# infra/argocd/envs/prod/external-secrets.yaml (upstream fullname would drift).
module "irsa_external_secrets" {
  source               = "../../modules/irsa"
  role_name            = "external-secrets"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "external-secrets"
  service_account_name = "external-secrets"
  environment          = local.environment
  project              = local.project
  policy_arns          = [module.secrets.eso_k8s_secrets_read_policy_arn]
}

# aws-load-balancer-controller — the UPSTREAM controller IAM policy, vendored
# verbatim from kubernetes-sigs/aws-load-balancer-controller v2.10.1 (matches
# the pinned chart 1.10.1) at policies/aws-load-balancer-controller-iam-policy.json.
# Do not hand-edit the JSON — re-vendor when the chart is bumped.
resource "aws_iam_policy" "alb_controller" {
  name        = "${local.project}-${local.environment}-aws-load-balancer-controller"
  description = "Upstream AWS Load Balancer Controller IAM policy (v2.10.1, vendored)"
  policy      = file("${path.module}/policies/aws-load-balancer-controller-iam-policy.json")
}

module "irsa_alb_controller" {
  source               = "../../modules/irsa"
  role_name            = "aws-load-balancer-controller"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "kube-system"
  service_account_name = "aws-load-balancer-controller"
  environment          = local.environment
  project              = local.project
  policy_arns          = [aws_iam_policy.alb_controller.arn]
}

# external-dns — Route53 record management. Scope ChangeResourceRecordSets to
# the Brain hosted zone(s) via var.external_dns_zone_ids (tfvars, from step 9
# of GO-LIVE); the [] default falls back to hostedzone/* so the FIRST apply
# (before the zone exists) still works — tighten it once the zone id is known.
data "aws_iam_policy_document" "external_dns" {
  statement {
    sid       = "ChangeZoneRecords"
    effect    = "Allow"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = length(var.external_dns_zone_ids) > 0 ? [for z in var.external_dns_zone_ids : "arn:aws:route53:::hostedzone/${z}"] : ["arn:aws:route53:::hostedzone/*"]
  }
  statement {
    sid    = "ListZones"
    effect = "Allow"
    actions = [
      "route53:ListHostedZones",
      "route53:ListResourceRecordSets",
      "route53:ListTagsForResource",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "external_dns" {
  name        = "${local.project}-${local.environment}-external-dns"
  description = "external-dns: Route53 record management on the Brain zone(s)"
  policy      = data.aws_iam_policy_document.external_dns.json
}

module "irsa_external_dns" {
  source               = "../../modules/irsa"
  role_name            = "external-dns"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "external-dns"
  service_account_name = "external-dns"
  environment          = local.environment
  project              = local.project
  policy_arns          = [aws_iam_policy.external_dns.arn]
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
  # AUD-PROD-008: single node per the ADR-0009 starter sizing — the module
  # default (2) silently provisioned a 2-node multi-AZ auto-failover group
  # (double cache spend). The module degrades automatic_failover/multi_az to
  # false when count is 1. Redis here is a rebuildable serving CACHE (Trino
  # is the SoT), so single-AZ is acceptable at this stage.
  num_cache_nodes = 1
  create          = true
}

###############################################################################
# Brain V4 — Spark jobs IRSA. AUD-COST-016: the former per-layer
# s3-iceberg-medallion buckets (brain-{silver,gold}-prod) are GONE — the single
# REST catalog has ONE warehouse root, so Silver/Gold live as namespaces in the
# warehouse bucket above (exactly like local). The Spark data plane (Bronze
# landing + Silver/Gold transforms + maintenance + erasure) gets ONE medallion
# RW policy scoped to the namespace prefixes.
###############################################################################
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
    module.s3_iceberg.spark_medallion_rw_policy_arn,
  ]
}

# Kafka Connect Iceberg sink (ADR-0010 Bronze landing writer). AUD-W1-001:
# the connect SA annotation pointed at a role that was NEVER created
# (brain-prod-spark-jobs) — every sink task died on
# sts:AssumeRoleWithWebIdentity 403 and Bronze landing was down. Same
# medallion RW policy family as the Spark jobs (warehouse prefixes only).
module "irsa_kafka_connect" {
  source               = "../../modules/irsa"
  role_name            = "kafka-connect"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "kafka"
  service_account_name = "kafka-connect-prod-kafka-connect"
  environment          = local.environment
  project              = local.project
  policy_arns = [
    module.s3_iceberg.spark_medallion_rw_policy_arn,
  ]
}

###############################################################################
# Cost guardrails — AUD-OPS-027: the pre-existing brain-prod-monthly-cap budget
# (console-created, IncludeCredit=true) nets promotional credits into "actual"
# spend, so with credits covering the bill it reads $0 and can NEVER fire until
# the credits exhaust. This SECOND budget tracks REAL usage (credits + refunds
# excluded) so the ~2x-target burn rate is visible while credits still mask the
# cash bill. Alerts-only (no budget actions), matching the account guardrail
# posture.
###############################################################################
resource "aws_budgets_budget" "usage_real" {
  name         = "${local.project}-${local.environment}-usage-real"
  budget_type  = "COST"
  limit_amount = "1000"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false
    include_refund = false
  }

  # 50 / 80 / 100% of ACTUAL usage spend → email.
  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      notification_type          = "ACTUAL"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      subscriber_email_addresses = ["rishabhporwal95@gmail.com"]
    }
  }
}

###############################################################################
# Neo4j backups (AUD-OPS-012) — the identity SoR had ZERO backups. Two layers:
# DLM daily EBS snapshots (7 retained, targeted by the CSI's
# kubernetes.io/created-for/pvc/namespace=neo4j tag) + a backups bucket for the
# nightly neo4j-admin dump CronJob (infra/helm/neo4j-backup, ns neo4j). The
# module header has the full rationale (incl. why the WORM audit bucket is unfit).
###############################################################################
module "neo4j_backup" {
  source      = "../../modules/neo4j-backup"
  environment = local.environment
  project     = local.project
  kms_key_arn = module.kms.root_kms_key_arn
}

# IRSA for the dump CronJob — namespace/SA MUST match the neo4j-backup chart's
# ServiceAccount exactly (NN-3 StringEquals trust): neo4j/neo4j-backup.
module "irsa_neo4j_backup" {
  source               = "../../modules/irsa"
  role_name            = "neo4j-backup"
  oidc_provider_arn    = module.eks.oidc_provider_arn
  oidc_provider_url    = module.eks.oidc_provider_url
  namespace            = "neo4j"
  service_account_name = "neo4j-backup"
  environment          = local.environment
  project              = local.project
  policy_arns = [
    module.neo4j_backup.backup_writer_policy_arn,
  ]
}

###############################################################################
# S3 cross-region replication (AUD-OPS-014) — DR replica of the medallion
# warehouse bucket in ap-south-2 (Hyderabad; in-country, so the AUD-OPS-042
# residency posture is unchanged — decision doc docs/adr/0011-s3-crr-residency.md).
# GATED behind var.enable_cross_region_replication (default false): flipping it
# on in terraform.tfvars is the recorded apply-decision. The tfstate bucket's
# replica is gated the same way in infra/terraform/bootstrap (its own root).
###############################################################################
# Replica-region half (bucket + CMK in ap-south-2) — the module takes the
# replica-region provider as its default `aws` (no configuration_aliases, so
# the CI standalone-module validate matrix works).
module "s3_warehouse_crr_replica" {
  count  = var.enable_cross_region_replication ? 1 : 0
  source = "../../modules/s3-crr-replica"
  providers = {
    aws = aws.replica
  }
  environment      = local.environment
  project          = local.project
  purpose          = "warehouse"
  source_bucket_id = module.s3_iceberg.warehouse_bucket_name
}

# Source-region half: replication role + the replication configuration on the
# warehouse bucket.
module "s3_warehouse_crr" {
  count               = var.enable_cross_region_replication ? 1 : 0
  source              = "../../modules/s3-crr"
  environment         = local.environment
  project             = local.project
  purpose             = "warehouse"
  source_bucket_id    = module.s3_iceberg.warehouse_bucket_name
  source_bucket_arn   = module.s3_iceberg.warehouse_bucket_arn
  source_kms_key_arn  = module.kms.root_kms_key_arn
  replica_bucket_arn  = module.s3_warehouse_crr_replica[0].replica_bucket_arn
  replica_kms_key_arn = module.s3_warehouse_crr_replica[0].replica_kms_key_arn
}

###############################################################################
# Outputs — the post-apply fill pass reads these (helm values-prod placeholders,
# ArgoCD IRSA annotations, repo variables). See docs/runbooks/prod-m4-turn-on.md.
###############################################################################
# AUD-OPS-014: null until enable_cross_region_replication = true is applied.
output "warehouse_crr_replica_bucket" { value = one(module.s3_warehouse_crr_replica[*].replica_bucket_name) }
output "github_plan_role_arn" { value = module.oidc_github.github_plan_role_arn }
output "github_ecr_push_role_arn" { value = module.oidc_github.github_ecr_push_role_arn }
output "github_apply_role_arn" { value = module.oidc_github.github_apply_role_arn }
output "root_kms_key_arn" { value = module.kms.root_kms_key_arn }
output "audit_kms_key_arn" { value = module.kms.audit_kms_key_arn }

# AUD-PROD-004: fill CONNECTOR_SECRETS_KMS_KEY_ID (core-env) and KMS_KEY_ID
# (stream-worker-env) in the brain/prod/k8s/* blobs with this key ARN.
output "connector_kms_key_arn" { value = module.kms.connector_kms_key_arn }
output "connector_kms_alias" { value = module.kms.connector_kms_alias }

output "vpc_id" { value = module.network.vpc_id }
output "nat_instance_public_ip" { value = module.nat_instance.public_ip }

output "eks_cluster_name" { value = module.eks.cluster_name }
output "eks_cluster_endpoint" { value = module.eks.cluster_endpoint }
output "ecr_repository_urls" { value = module.eks.ecr_repository_urls }

output "aurora_endpoint" { value = module.aurora.endpoint }
output "aurora_reader_endpoint" { value = module.aurora.reader_endpoint }
output "redis_endpoint" { value = module.elasticache.redis_primary_endpoint }

# AUD-PROD-003: the four core boot-secret shells (brain/prod/app/*). The fill
# pass puts real values here AND sets JWT_SIGNING_SECRET / COOKIE_SECRET /
# META_APP_SECRET / GOOGLE_ADS_CLIENT_SECRET in brain/prod/k8s/core-env to
# these secret NAMES (or ARNs) — core resolves them via AwsSecretsProvider.
output "app_boot_secret_arns" { value = module.secrets.app_boot_secret_arns }

# AUD-COST-016: ONE medallion warehouse bucket (Bronze/Silver/Gold are Iceberg
# NAMESPACES inside it). Fill iceberg-rest/values-prod.yaml catalog.warehouse
# with s3://<warehouse_bucket_name>/.
output "warehouse_bucket_name" { value = module.s3_iceberg.warehouse_bucket_name }
output "audit_bucket_name" { value = module.s3_audit.audit_bucket_name }

# AUD-PROD-012: fill the Thanos objstore.yml bucket + the prometheus
# serviceAccount role-arn annotation in the kube-prometheus-stack values.
output "metrics_bucket_name" { value = module.s3_metrics.metrics_bucket_name }
output "thanos_role_arn" { value = module.irsa_thanos.role_arn }

output "collector_role_arn" { value = module.irsa_collector.role_arn }
output "stream_worker_role_arn" { value = module.irsa_stream_worker.role_arn }
output "core_role_arn" { value = module.irsa_core.role_arn }
output "spark_jobs_role_arn" { value = module.irsa_spark_jobs.role_arn }

# AUD-COST-017: the six platform/serving roles the manifests reference.
output "web_role_arn" { value = module.irsa_web.role_arn }
output "trino_role_arn" { value = module.irsa_trino.role_arn }
output "iceberg_rest_role_arn" { value = module.irsa_iceberg_rest.role_arn }
output "external_secrets_role_arn" { value = module.irsa_external_secrets.role_arn }
output "alb_controller_role_arn" { value = module.irsa_alb_controller.role_arn }
output "external_dns_role_arn" { value = module.irsa_external_dns.role_arn }

# Fill into infra/argocd/envs/prod/karpenter.yaml (ACCOUNT_ID role ARN +
# settings.interruptionQueue — the queue name already matches brain-prod).
output "karpenter_controller_role_arn" { value = module.karpenter.controller_role_arn }
output "karpenter_interruption_queue" { value = module.karpenter.interruption_queue_name }
