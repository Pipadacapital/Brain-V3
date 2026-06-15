################################################################################
# Brain – ElastiCache (Redis) Module
# Multi-AZ Redis cluster. dev: apply; staging/prod: count=0.
# EC10: controlled by var.create.
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

variable "subnet_ids" {
  type = list(string)
}

variable "redis_sg_id" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

# EC10: false for staging/prod
variable "create" {
  type    = bool
  default = true
}

variable "node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "num_cache_nodes" {
  type    = number
  default = 2
}

###############################################################################
# Subnet Group
###############################################################################
resource "aws_elasticache_subnet_group" "main" {
  count       = var.create ? 1 : 0
  name        = "${var.project}-${var.environment}-redis"
  subnet_ids  = var.subnet_ids
  description = "Brain Redis subnet group (${var.environment})"
}

###############################################################################
# Redis Replication Group (Multi-AZ)
###############################################################################
resource "aws_elasticache_replication_group" "redis" {
  count = var.create ? 1 : 0

  replication_group_id       = "${var.project}-${var.environment}-redis"
  description                = "Brain Redis cache (${var.environment})"
  engine                     = "redis"
  engine_version             = "7.2"
  node_type                  = var.node_type
  num_cache_clusters         = var.num_cache_nodes
  automatic_failover_enabled = var.num_cache_nodes > 1
  multi_az_enabled           = var.num_cache_nodes > 1

  subnet_group_name  = aws_elasticache_subnet_group.main[0].name
  security_group_ids = [var.redis_sg_id]

  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true

  maintenance_window       = "Mon:05:00-Mon:06:00"
  snapshot_window          = "03:00-04:00"
  snapshot_retention_limit = 7

  apply_immediately = var.environment != "prod"

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "cache"
  }
}

###############################################################################
# Outputs
###############################################################################
output "redis_primary_endpoint" {
  value = var.create ? aws_elasticache_replication_group.redis[0].primary_endpoint_address : null
}

output "redis_port" {
  value = 6379
}
