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

variable "enable_tripwire_alarms" {
  description = <<-EOT
    AUD-OPS-032: eviction/memory tripwires. Prod runs ONE cache.t4g.micro
    (~555MB) as the ENTIRE Trino serving cache — a correct cost-first choice
    TODAY, but at 10x (100 brands' dashboards) it evicts constantly and a
    cache-miss storm lands on an OOM-prone 3-worker Trino fleet. The pre-agreed
    knob is node_type micro -> small (+~$14/mo); these alarms are the TRIGGER:
      1. Evictions sustained > 0                — the working set no longer fits.
      2. DatabaseMemoryUsagePercentage >= 90%   — eviction pressure imminent.
    No alarm_actions (matches modules/observability posture — alerts-only
    account); visible tripwires, not pagers. NOTE: no CloudWatch exporter runs
    in-cluster, so these cannot be Prometheus rules (loaded-but-dead).
    Decision record: docs/ops/scale-knobs.md.
  EOT
  type        = bool
  default     = true
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
  engine_version             = "7.1"
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
# AUD-OPS-032 — eviction/memory tripwires (see var.enable_tripwire_alarms).
# ElastiCache emits per-NODE metrics under CacheClusterId "<rg-id>-00N" — one
# alarm pair per member node. Additive + reversible (flip the var to drop).
###############################################################################
resource "aws_cloudwatch_metric_alarm" "evictions_tripwire" {
  count = var.create && var.enable_tripwire_alarms ? var.num_cache_nodes : 0

  alarm_name          = "${var.project}-${var.environment}-redis-evictions-${format("%03d", count.index + 1)}"
  alarm_description   = "Redis node evicting keys for 15m — the serving-cache working set no longer fits ${var.node_type}; pull the pre-agreed node_type knob (docs/ops/scale-knobs.md, AUD-OPS-032)"
  namespace           = "AWS/ElastiCache"
  metric_name         = "Evictions"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    CacheClusterId = format("%s-%03d", aws_elasticache_replication_group.redis[0].replication_group_id, count.index + 1)
  }

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "cache-tripwire"
  }
}

resource "aws_cloudwatch_metric_alarm" "memory_tripwire" {
  count = var.create && var.enable_tripwire_alarms ? var.num_cache_nodes : 0

  alarm_name          = "${var.project}-${var.environment}-redis-memory-${format("%03d", count.index + 1)}"
  alarm_description   = "Redis node dataset memory >= 90% for 15m — eviction pressure imminent on the Trino serving cache (docs/ops/scale-knobs.md, AUD-OPS-032)"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 90
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    CacheClusterId = format("%s-%03d", aws_elasticache_replication_group.redis[0].replication_group_id, count.index + 1)
  }

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "cache-tripwire"
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
