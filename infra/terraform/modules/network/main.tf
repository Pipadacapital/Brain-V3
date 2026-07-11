################################################################################
# Brain – Network Module
# VPC + public/private subnets across 3 AZs + NAT Gateway (single in dev,
# one-per-AZ in staging/prod) + Security Groups for EKS, RDS, ElastiCache.
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

###############################################################################
# Variables
###############################################################################
variable "environment" {
  type = string
}

variable "project" {
  type    = string
  default = "brain"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "availability_zones" {
  type    = list(string)
  default = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
}

variable "single_nat_gateway" {
  description = "Use a single NAT gateway (cost-optimised for dev). Set false for HA in staging/prod."
  type        = bool
  default     = true
}

variable "enable_nat_gateway" {
  description = <<-EOT
    Create managed NAT Gateway(s) + their default route. Default true (HA managed egress).
    Set FALSE to adopt the cost-optimised fck-nat instance (modules/nat-instance): private route
    tables are still created (and exported via private_route_table_ids) but get NO 0.0.0.0/0 route
    here — the nat-instance module adds it. See ADR-0008. (Conscious HA->cost tradeoff.)
  EOT
  type        = bool
  default     = true
}

###############################################################################
# VPC
###############################################################################
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "${var.project}-${var.environment}"
    environment = var.environment
    project     = var.project
    # Required by EKS for auto-discovery of the VPC
    "kubernetes.io/cluster/${var.project}-${var.environment}" = "shared"
  }
}

###############################################################################
# Internet Gateway
###############################################################################
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags = {
    Name        = "${var.project}-${var.environment}-igw"
    environment = var.environment
  }
}

###############################################################################
# Public Subnets (one per AZ)
###############################################################################
resource "aws_subnet" "public" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone = var.availability_zones[count.index]

  map_public_ip_on_launch = true

  tags = {
    Name        = "${var.project}-${var.environment}-public-${count.index + 1}"
    environment = var.environment
    tier        = "public"
    # Required for EKS external load balancer auto-discovery
    "kubernetes.io/role/elb"                                  = "1"
    "kubernetes.io/cluster/${var.project}-${var.environment}" = "shared"
  }
}

###############################################################################
# Private Subnets (one per AZ)
###############################################################################
resource "aws_subnet" "private" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name        = "${var.project}-${var.environment}-private-${count.index + 1}"
    environment = var.environment
    tier        = "private"
    # Required for EKS internal load balancer auto-discovery
    "kubernetes.io/role/internal-elb"                         = "1"
    "kubernetes.io/cluster/${var.project}-${var.environment}" = "shared"
    # AUD-COST-010: Karpenter EC2NodeClass subnetSelectorTerms match this tag
    # (infra/helm/karpenter values `discoveryTag`, conventionally the cluster name).
    "karpenter.sh/discovery" = "${var.project}-${var.environment}"
  }
}

###############################################################################
# NAT Gateway + EIPs
###############################################################################
locals {
  # Private route tables ALWAYS exist (so subnets route + fck-nat can attach a default route);
  # NAT Gateways (+ their route) are gated by enable_nat_gateway.
  private_rt_count = var.single_nat_gateway ? 1 : length(var.availability_zones)
  nat_count        = var.enable_nat_gateway ? local.private_rt_count : 0
}

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"
  tags = {
    Name        = "${var.project}-${var.environment}-nat-eip-${count.index + 1}"
    environment = var.environment
  }
}

resource "aws_nat_gateway" "main" {
  count         = local.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  depends_on = [aws_internet_gateway.main]

  tags = {
    Name        = "${var.project}-${var.environment}-nat-${count.index + 1}"
    environment = var.environment
  }
}

###############################################################################
# Route Tables
###############################################################################
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = {
    Name        = "${var.project}-${var.environment}-public-rt"
    environment = var.environment
  }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = local.private_rt_count
  vpc_id = aws_vpc.main.id
  # NOTE: the default 0.0.0.0/0 route is a SEPARATE resource (aws_route.private_nat) gated by
  # enable_nat_gateway — so when fck-nat is adopted (enable_nat_gateway=false) these tables exist
  # routeless and modules/nat-instance adds the default route. Do NOT inline the route here.
  tags = {
    Name        = "${var.project}-${var.environment}-private-rt-${count.index + 1}"
    environment = var.environment
  }
}

# Managed NAT-Gateway default route — only when enable_nat_gateway = true. With fck-nat it is omitted
# and modules/nat-instance owns the private 0.0.0.0/0 route instead.
resource "aws_route" "private_nat" {
  count                  = local.nat_count
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[count.index].id
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[var.single_nat_gateway ? 0 : count.index].id
}

###############################################################################
# Security Groups
###############################################################################

# EKS cluster (control plane) SG
resource "aws_security_group" "eks_cluster" {
  name        = "${var.project}-${var.environment}-eks-cluster"
  description = "EKS cluster control plane security group"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = {
    Name        = "${var.project}-${var.environment}-eks-cluster-sg"
    environment = var.environment
  }
}

# EKS node group SG
resource "aws_security_group" "eks_nodes" {
  name        = "${var.project}-${var.environment}-eks-nodes"
  description = "EKS worker node security group"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
    description = "Allow node-to-node traffic"
  }

  ingress {
    from_port       = 0
    to_port         = 0
    protocol        = "-1"
    security_groups = [aws_security_group.eks_cluster.id]
    description     = "Allow control plane to nodes"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = {
    Name        = "${var.project}-${var.environment}-eks-nodes-sg"
    environment = var.environment
    # AUD-COST-010: Karpenter EC2NodeClass securityGroupSelectorTerms match this
    # tag — launched nodes join the same SG as the managed node group.
    "karpenter.sh/discovery" = "${var.project}-${var.environment}"
  }
}

# RDS SG – only accepts connections from EKS nodes
resource "aws_security_group" "rds" {
  name        = "${var.project}-${var.environment}-rds"
  description = "RDS PostgreSQL security group - EKS nodes only"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id]
    description     = "Postgres from EKS nodes"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = {
    Name        = "${var.project}-${var.environment}-rds-sg"
    environment = var.environment
  }
}

# ElastiCache SG – only accepts connections from EKS nodes.
# AUD-INFRA-001: rules are STANDALONE resources below, NOT inline blocks.
# envs/prod/bootstrap.tf attaches its own standalone ingress rule
# (redis_from_eks_cluster_sg) to this SG, and Terraform forbids mixing inline
# and standalone rules on one SG — every apply of the inline-owning SG silently
# revoked that rule (prod cache outage). NEVER re-add inline ingress/egress
# blocks here; add new rules as aws_vpc_security_group_*_rule resources.
resource "aws_security_group" "elasticache" {
  name        = "${var.project}-${var.environment}-elasticache"
  description = "ElastiCache Redis security group - EKS nodes only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name        = "${var.project}-${var.environment}-elasticache-sg"
    environment = var.environment
  }
}

# Rule content is IDENTICAL to the former inline blocks — in already-applied
# envs the physical rules exist, so the first plan must IMPORT them (see
# envs/prod/imports-aud-infra-001.tf) instead of creating duplicates.
resource "aws_vpc_security_group_ingress_rule" "elasticache_redis_from_eks_nodes" {
  security_group_id            = aws_security_group.elasticache.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.eks_nodes.id
  description                  = "Redis from EKS nodes"
}

resource "aws_vpc_security_group_egress_rule" "elasticache_all_outbound" {
  security_group_id = aws_security_group.elasticache.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
  description       = "Allow all outbound"
}

###############################################################################
# Outputs
###############################################################################
output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

# Private route-table IDs — consumed by modules/nat-instance (private_route_table_ids) to add the
# default route when enable_nat_gateway = false (fck-nat egress). See ADR-0008.
output "private_route_table_ids" {
  value = aws_route_table.private[*].id
}

output "eks_cluster_sg_id" {
  value = aws_security_group.eks_cluster.id
}

output "eks_nodes_sg_id" {
  value = aws_security_group.eks_nodes.id
}

output "rds_sg_id" {
  value = aws_security_group.rds.id
}

output "elasticache_sg_id" {
  value = aws_security_group.elasticache.id
}
