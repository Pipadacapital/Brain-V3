################################################################################
# Brain – VPC Endpoints Module
#
# Cost + egress optimisation companion to modules/nat-instance. Keeps AWS-API
# traffic OFF the NAT path:
#   * S3 Gateway endpoint        — FREE, removes S3 traffic (Iceberg/MinIO->S3,
#                                  ECR layer pulls) from the NAT data charge.
#   * Interface endpoints (PrivateLink, ~$7/mo each + data) for:
#       STS, Secrets Manager, ECR (api + dkr), CloudWatch Logs.
#
# With the S3 Gateway + ECR(api/dkr) + Logs endpoints, the bulk of in-cluster
# AWS-bound bytes (image pulls, log shipping, secret/STS calls) bypass the
# single fck-nat box entirely — both cheaper and more resilient.
#
# Naming: brain-{env}-vpce-{service} ; mandatory tags via local.common_tags.
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
  description = "Deployment environment (dev|staging|prod)."
  type        = string
}

variable "project" {
  description = "Project slug for the brain-{env}-{resource} naming scheme."
  type        = string
  default     = "brain"
}

variable "vpc_id" {
  description = "VPC id (module.network.vpc_id)."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR allowed to reach the interface endpoints on 443."
  type        = string
  default     = "10.0.0.0/16"
}

variable "region" {
  description = "AWS region for the com.amazonaws.{region}.{service} endpoint service names. When null, resolved from the provider."
  type        = string
  default     = null
}

variable "private_subnet_ids" {
  description = "Private subnet ids the interface endpoint ENIs are placed in (module.network.private_subnet_ids)."
  type        = list(string)
}

variable "private_route_table_ids" {
  description = "Private route-table ids that the (free) S3 Gateway endpoint is associated with."
  type        = list(string)
}

variable "interface_services" {
  description = "Interface endpoint short service names to create. Defaults cover the common egress set."
  type        = list(string)
  default = [
    "sts",
    "secretsmanager",
    "ecr.api",
    "ecr.dkr",
    "logs",
  ]
}

variable "tags" {
  description = "Extra tags merged over the mandatory tag set."
  type        = map(string)
  default     = {}
}

###############################################################################
# Locals — naming, region, tags
###############################################################################
data "aws_region" "current" {}

locals {
  name_prefix = "${var.project}-${var.environment}"
  region      = var.region != null ? var.region : data.aws_region.current.region

  common_tags = merge(
    {
      Environment = var.environment
      Service     = "vpc-endpoints"
      Owner       = "data-team"
      CostCenter  = "brain-platform"
      project     = var.project
      environment = var.environment
      managed_by  = "terraform"
    },
    var.tags,
  )

  # Sanitised key for resource Name tags (ecr.api -> ecr-api)
  interface_endpoints = {
    for svc in var.interface_services :
    svc => replace(svc, ".", "-")
  }
}

###############################################################################
# Security Group — interface endpoint ENIs accept HTTPS from the VPC
###############################################################################
resource "aws_security_group" "endpoints" {
  name        = "${local.name_prefix}-vpce"
  description = "VPC interface endpoints SG: HTTPS (443) from VPC CIDR"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
    description = "HTTPS to PrivateLink endpoints from within the VPC"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-vpce-sg"
  })
}

###############################################################################
# S3 Gateway endpoint — FREE; routed via the private route tables
###############################################################################
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = var.vpc_id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = var.private_route_table_ids

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-vpce-s3"
  })
}

###############################################################################
# Interface endpoints (PrivateLink) — STS, Secrets Manager, ECR api/dkr, Logs
###############################################################################
resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoints

  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${local.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-vpce-${each.value}"
  })
}

###############################################################################
# Outputs
###############################################################################
output "s3_endpoint_id" {
  description = "Gateway endpoint id for S3."
  value       = aws_vpc_endpoint.s3.id
}

output "interface_endpoint_ids" {
  description = "Map of service short-name -> interface endpoint id."
  value       = { for k, v in aws_vpc_endpoint.interface : k => v.id }
}

output "endpoints_security_group_id" {
  description = "Security group id fronting the interface endpoints."
  value       = aws_security_group.endpoints.id
}
