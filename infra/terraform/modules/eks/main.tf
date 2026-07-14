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

# AUD-OPS-028: 1.32 is in EXTENDED support ($12/day surcharge ≈ $360/mo).
# The default stays 1.32 so the current plan is a NO-OP; the operator flips this
# (with system_ami_type below flipped FIRST) per docs/runbooks/eks-1-33-upgrade.md.
variable "kubernetes_version" {
  type    = string
  default = "1.32"
}

# AUD-INFRA-019: AL2 EKS AMIs END at Kubernetes 1.32 — the system MNG must move
# to AL2023 BEFORE the 1.33 control-plane bump or node creation fails. Default
# keeps the live AL2 group untouched (no-op plan). Flipping to
# AL2023_ARM_64_STANDARD REPLACES the MNG (create-before-destroy via the name
# suffix below) and attaches a launch template with encrypted gp3 roots
# (the AL2 group runs gp2).
variable "system_ami_type" {
  type        = string
  default     = "AL2_ARM_64"
  description = "System MNG AMI type. AL2_ARM_64 (current, k8s <=1.32 only) or AL2023_ARM_64_STANDARD (required for 1.33+)."

  validation {
    condition     = contains(["AL2_ARM_64", "AL2023_ARM_64_STANDARD"], var.system_ami_type)
    error_message = "system_ami_type must be AL2_ARM_64 or AL2023_ARM_64_STANDARD."
  }
}

# AUD-OPS-028: upgradePolicy.supportType. null = leave AWS-managed (current
# EXTENDED — the API rejects STANDARD while the running version is already past
# standard support, so this can only be set AFTER the 1.33 upgrade). Set to
# "STANDARD" post-upgrade to fail-fast on any future extended-support drift.
variable "cluster_support_type" {
  type        = string
  default     = null
  description = "EKS upgradePolicy support type (STANDARD|EXTENDED). null = omit (keep current). Set STANDARD only after upgrading to a standard-support version."
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

  # AUD-COST (2026-07-13): trimmed from all 5 types → audit only. The 5-way set
  # vended ~$78/mo of CloudWatch logs (100% of the CloudWatch bill was
  # VendedLog-Bytes; api+audit log every API call and Karpenter/ArgoCD/KEDA
  # generate a firehose). `audit` is kept as the security-forensics trail
  # ("who did what") — the one you'd want after an incident; api /
  # authenticator / controllerManager / scheduler are control-plane DEBUG logs
  # that nothing monitors today (alerting not yet wired) and can be re-enabled
  # instantly when debugging. In-place cluster update, non-disruptive.
  enabled_cluster_log_types = ["audit"]

  # AUD-OPS-028: omitted while null (no-op on the live cluster); set STANDARD
  # after the 1.33 upgrade so a future lapse into extended support fails the
  # upgrade plan instead of silently billing $12/day.
  dynamic "upgrade_policy" {
    for_each = var.cluster_support_type == null ? [] : [var.cluster_support_type]
    content {
      support_type = upgrade_policy.value
    }
  }

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

# AUD-INFRA-008a: SSM access path to a PRIVATE-ONLY EKS API endpoint. The
# EKS-optimized AL2 AMIs ship the SSM agent; this managed policy lets the
# system nodes register with Systems Manager (agent egress rides the NAT — no
# extra VPC endpoints needed), so an operator can port-forward to the private
# API endpoint through a system node (docs/runbooks/eks-api-access.md). This
# is the PRECONDITION for flipping eks_public_access_cidrs=[] — verify an SSM
# session works BEFORE going private-only, or kubectl access is lost.
resource "aws_iam_role_policy_attachment" "node_AmazonSSMManagedInstanceCore" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

###############################################################################
# System Node Group — small on-demand group for system add-ons
# EC10: staging/prod = 0 nodes (set via variables)
#
# AUD-INFRA-019: ami_type is variable-driven (default AL2_ARM_64 = no-op).
# Flipping to AL2023 changes the node_group_name suffix so create_before_destroy
# stands up the replacement MNG (CoreDNS/Karpenter/ArgoCD keep a home) before
# the AL2 group drains. The AL2023 group also gets a launch template with
# encrypted gp3 roots (AL2 default was gp2).
###############################################################################
locals {
  system_uses_al2023 = var.system_ami_type != "AL2_ARM_64"
}

resource "aws_launch_template" "system_al2023" {
  count       = local.system_uses_al2023 ? 1 : 0
  name_prefix = "${var.project}-${var.environment}-system-al2023-"

  # gp2 → gp3 (AUD-INFRA-019): cheaper per-GB + 3000 baseline IOPS. Size matches
  # the live MNG (20 GiB). Encrypted with the account default aws/ebs key —
  # using the root CMK here would need kms:CreateGrant for the EC2 service.
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 20
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  # IMDSv2-only; hop limit 2 so pods without IRSA can still reach IMDS if needed.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_eks_node_group" "system" {
  cluster_name = aws_eks_cluster.main.name
  # Name changes with the AMI family so the flip is a create-before-destroy
  # replacement, not an in-place destroy of the only system capacity.
  node_group_name = local.system_uses_al2023 ? "${var.project}-${var.environment}-system-al2023" : "${var.project}-${var.environment}-system"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.private_subnet_ids

  # Pin the MNG to the cluster version (was implicit). Setting it to the current
  # live value is a no-op; on the 1.33 bump it drives the in-place rolling
  # AMI upgrade of the (by then AL2023) group.
  version = var.kubernetes_version

  scaling_config {
    desired_size = var.system_node_desired
    min_size     = var.system_node_min
    max_size     = var.system_node_max
  }

  instance_types = ["t4g.medium"]
  ami_type       = var.system_ami_type

  # gp3 roots ride a launch template on the AL2023 group only (AL2 group stays
  # untouched — adding a LT to the live group would force replacement today).
  dynamic "launch_template" {
    for_each = local.system_uses_al2023 ? [1] : []
    content {
      id      = aws_launch_template.system_al2023[0].id
      version = tostring(aws_launch_template.system_al2023[0].latest_version)
    }
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    role = "system"
  }

  # NOTE: replacement only ever happens with a simultaneous name change (the
  # AL2023 flip); same-name forced replacements would conflict under CBD.
  lifecycle {
    create_before_destroy = true
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
  # The 4 app deployables + the `duckdb` data-plane job image (the DuckDB transform tier + Trino
  # maintenance client — the Spark→DuckDB cutover replaced brain-spark-bronze). All get an IMMUTABLE,
  # KMS-encrypted, scan-on-push ECR repo + lifecycle policy. The cronworkflows chart (sparkBronze.image /
  # sparkV4.image) pulls it; CI builds + digest-pins it (see .github/workflows/deploy.yml build-data-images).
  # `spark-bronze` was DROPPED (repo + 11 images deleted 2026-07-14) after the DuckDB cutover — the fast
  # image-repull rollback is gone; a Spark rollback now needs a git-revert of the cutover + an image
  # rebuild. dbt-runner is RETIRED (Brain V4).
  services = ["collector", "stream-worker", "core", "web", "duckdb"]
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
