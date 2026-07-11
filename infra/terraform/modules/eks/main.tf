################################################################################
# Brain – EKS Module
# EKS cluster + managed node groups + ECR repositories.
# Node group desired/min/max parametrised: dev=real, staging/prod=0.
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

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "cluster_sg_id" {
  type = string
}

variable "node_sg_id" {
  type = string
}

variable "kms_key_arn" {
  type        = string
  description = "Root CMK for secrets/EBS encryption"
}

# EC10: dev=real compute; staging/prod=0 (no idle spend)
variable "system_node_desired" {
  type    = number
  default = 1
}

variable "system_node_min" {
  type    = number
  default = 1
}

variable "system_node_max" {
  type    = number
  default = 3
}

variable "kubernetes_version" {
  type    = string
  default = "1.32"
}

# M-03 FIX: public endpoint is OFF by default (private-only is the secure
# baseline for staging and prod). Set to true ONLY for dev, where bootstrap
# access from a developer workstation is required before a VPN/bastion exists.
# Do NOT set this to true in staging or prod environments.
# The global CKV_AWS_130 skip in .checkov.yaml has been scoped to dev-only
# by removing it from the global skip_check list and instead inline-suppressing
# in the dev env (see infra/terraform/envs/dev/main.tf).
variable "public_endpoint" {
  type        = bool
  default     = false
  description = "Allow public access to the EKS API endpoint. True for dev only; staging and prod must use private-only."
}

# AUD-COST-009: private-only prod/staging had NO access path (no bastion/VPN/SSM;
# GitHub runners are outside the VPC) — the one-time kubectl/helm/argocd bootstrap
# was impossible. Pragmatic 2-day go-live posture: a NON-EMPTY allowlist here
# opens the public endpoint pinned to those CIDRs (operator office/home IP);
# default [] keeps the endpoint private-only. Flip back to [] once an SSM-based
# bastion (t4g.nano + instance profile with AmazonSSMManagedInstanceCore + the
# ssm/ssmmessages/ec2messages interface endpoints) or AWS Client VPN exists.
variable "public_access_cidrs" {
  type        = list(string)
  default     = []
  description = "CIDR allowlist for the public EKS API endpoint. Non-empty enables public access restricted to these CIDRs; empty = private-only (unless public_endpoint=true, dev)."
}

###############################################################################
# EKS Cluster
###############################################################################
resource "aws_eks_cluster" "main" {
  name     = "${var.project}-${var.environment}"
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = var.private_subnet_ids
    security_group_ids      = [var.cluster_sg_id]
    endpoint_private_access = true
    # M-03 FIX: public endpoint is variable-driven, default false.
    # dev may set public_endpoint = true (unrestricted) for bootstrap access.
    # AUD-COST-009: staging/prod may instead set public_access_cidrs — public
    # access pinned to an operator allowlist (default [] = private-only).
    endpoint_public_access = var.public_endpoint || length(var.public_access_cidrs) > 0
    public_access_cidrs    = length(var.public_access_cidrs) > 0 ? var.public_access_cidrs : null
  }

  encryption_config {
    provider {
      key_arn = var.kms_key_arn
    }
    resources = ["secrets"]
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  depends_on = [
    aws_iam_role_policy_attachment.cluster_AmazonEKSClusterPolicy,
  ]

  tags = {
  }
}

###############################################################################
# EKS OIDC Provider for IRSA
###############################################################################
data "tls_certificate" "eks" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
}

###############################################################################
# Cluster IAM Role
###############################################################################
data "aws_iam_policy_document" "cluster_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.project}-${var.environment}-eks-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume_role.json
}

resource "aws_iam_role_policy_attachment" "cluster_AmazonEKSClusterPolicy" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

###############################################################################
# Node IAM Role
###############################################################################
data "aws_iam_policy_document" "node_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.project}-${var.environment}-eks-node"
  assume_role_policy = data.aws_iam_policy_document.node_assume_role.json
}

resource "aws_iam_role_policy_attachment" "node_AmazonEKSWorkerNodePolicy" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_AmazonEKS_CNI_Policy" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_AmazonEC2ContainerRegistryReadOnly" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

###############################################################################
# System Node Group — small on-demand group for system add-ons
# EC10: staging/prod = 0 nodes (set via variables)
###############################################################################
resource "aws_eks_node_group" "system" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.project}-${var.environment}-system"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.private_subnet_ids

  scaling_config {
    desired_size = var.system_node_desired
    min_size     = var.system_node_min
    max_size     = var.system_node_max
  }

  instance_types = ["t4g.medium"]
  ami_type       = "AL2_ARM_64"

  update_config {
    max_unavailable = 1
  }

  labels = {
    role = "system"
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_AmazonEKSWorkerNodePolicy,
    aws_iam_role_policy_attachment.node_AmazonEKS_CNI_Policy,
    aws_iam_role_policy_attachment.node_AmazonEC2ContainerRegistryReadOnly,
  ]

  tags = {
    role = "system"
  }
}

###############################################################################
# EBS CSI driver add-on + IRSA (AUD-COST-018)
# Without it NO PersistentVolumeClaim can bind (EKS >=1.23 has no in-tree EBS
# provisioner) — Neo4j (the identity SoR, ADR-0004) mounts a PVC via the `gp3`
# StorageClass (applied by infra/argocd/bootstrap/install.sh). The controller
# authenticates via IRSA (NN-3 StringEquals on the addon's fixed SA
# ebs-csi-controller-sa @ kube-system) with the AWS-managed driver policy.
# Volumes are encrypted with the default aws/ebs key (the gp3 StorageClass sets
# encrypted:"true" without kmsKeyId); switching to the root CMK would
# additionally need kms:CreateGrant/Decrypt/GenerateDataKey* on that key here.
###############################################################################
data "aws_iam_policy_document" "ebs_csi_trust" {
  statement {
    sid     = "EKSOIDCTrustEbsCsi"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}:sub"
      values   = ["system:serviceaccount:kube-system:ebs-csi-controller-sa"]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ebs_csi" {
  name               = "${var.project}-${var.environment}-ebs-csi-driver"
  assume_role_policy = data.aws_iam_policy_document.ebs_csi_trust.json

  tags = {
    workload = "ebs-csi-driver"
  }
}

resource "aws_iam_role_policy_attachment" "ebs_csi_AmazonEBSCSIDriverPolicy" {
  role       = aws_iam_role.ebs_csi.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

data "aws_eks_addon_version" "ebs_csi" {
  addon_name         = "aws-ebs-csi-driver"
  kubernetes_version = aws_eks_cluster.main.version
  most_recent        = true
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "aws-ebs-csi-driver"
  addon_version               = data.aws_eks_addon_version.ebs_csi.version
  service_account_role_arn    = aws_iam_role.ebs_csi.arn
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  # The controller pods need somewhere to run — create after the system group.
  depends_on = [aws_eks_node_group.system]

  tags = {
  }
}

###############################################################################
# ECR Repositories — per service, immutable tags
###############################################################################
locals {
  # The 4 app deployables + the spark-bronze data-plane job image (the Iceberg Bronze sink; the same
  # image also carries the V4 Silver/Gold marts for the sparkV4 crons). All get an IMMUTABLE,
  # KMS-encrypted, scan-on-push ECR repo + lifecycle policy. The cronworkflows chart (sparkBronze.image /
  # sparkV4.image) pulls it; CI builds + digest-pins it (see .github/workflows/deploy.yml build-data-images).
  # dbt-runner is RETIRED — dbt is removed under Brain V4 (Spark is the sole compute).
  services = ["collector", "stream-worker", "core", "web", "spark-bronze"]
}

resource "aws_ecr_repository" "services" {
  for_each             = toset(local.services)
  name                 = "${var.project}-${each.key}-${var.environment}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }

  tags = {
    service = each.key
  }
}

resource "aws_ecr_lifecycle_policy" "services" {
  for_each   = aws_ecr_repository.services
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images after 7 days"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 7
      }
      action = { type = "expire" }
    }]
  })
}

###############################################################################
# Outputs
###############################################################################
output "cluster_name" {
  value = aws_eks_cluster.main.name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.main.endpoint
}

# The EKS-managed "cluster security group" — auto-created by EKS and attached to
# managed-node-group nodes (and cross-node/pod traffic). Data-plane clients
# (Aurora, ElastiCache) must allow ingress from THIS sg, since the nodes are not
# members of the network module's eks_nodes_sg. (Fixes workload→DB timeouts.)
output "cluster_primary_security_group_id" {
  value = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
}

output "cluster_ca" {
  value = aws_eks_cluster.main.certificate_authority[0].data
}

output "oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.eks.arn
}

output "oidc_provider_url" {
  description = "OIDC provider URL without https:// (for IRSA trust policies)"
  value       = replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")
}

output "node_role_arn" {
  value = aws_iam_role.node.arn
}

output "ecr_repository_urls" {
  value = {
    for k, v in aws_ecr_repository.services : k => v.repository_url
  }
}

output "ebs_csi_role_arn" {
  description = "IRSA role of the aws-ebs-csi-driver addon controller (AUD-COST-018)"
  value       = aws_iam_role.ebs_csi.arn
}
