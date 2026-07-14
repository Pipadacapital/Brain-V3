################################################################################
# Brain – ElastiCache (Valkey) Module
# Multi-AZ cache cluster. dev: apply; staging/prod: count=0.
# EC10: controlled by var.create.
#
# ENGINE = VALKEY (2026-07 swap from Redis OSS 7.1). Valkey is the BSD-licensed,
# Linux-Foundation drop-in for Redis 7 (same RESP protocol / commands / data
# structures → ZERO app-client change) and runs ~20% cheaper per node-hour on
# ElastiCache, with better per-key memory efficiency (fits more of the serving
# working set on the same cache.t4g.micro → defers the micro->small scale knob).
#
# IN-PLACE MIGRATION (existing prod group): the redis->valkey cross-engine
# upgrade is a NATIVE ElastiCache operation — the primary endpoint DNS is
# UNCHANGED (so REDIS_URL in Secrets Manager needs no edit), online, with only a
# few seconds of failover downtime. The Terraform AWS provider's in-place engine
# flip is unreliable (hashicorp/terraform-provider-aws#41181 no-ops, #40786
# replace-loops), so the migration is driven by the AWS CLI and Terraform then
# reconciles to a no-op. Full runbook: docs/ops/valkey-migration.md.
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

# Cache engine. VALKEY is the standard (BSD-licensed Redis-7 drop-in, ~20%
# cheaper per node-hour). Kept as a var so an env can pin "redis" for rollback
# (Valkey 7.2 -> Redis OSS 7.1 is the ONLY supported cross-engine downgrade).
variable "engine" {
  type    = string
  default = "valkey"
}

# Valkey 8.0 (GA on ElastiCache): cost-identical to 7.2 but better memory
# efficiency. Rollback caveat — only Valkey 7.2 downgrades to Redis OSS 7.1;
# for this REBUILDABLE serving cache (Trino is SoT, reads fail-soft to Trino on
# miss) that is a non-issue: rollback = flip var.engine back + recreate.
variable "engine_version" {
  type    = string
  default = "8.0"
}

# Cache parameter group. null → ElastiCache picks the engine default
# (default.valkey8 for Valkey 8.x). Set explicitly only for a custom group.
variable "parameter_group_name" {
  type    = string
  default = null
}

variable "num_cache_nodes" {
  type    = number
  default = 2
}

variable "enable_tripwire_alarms" {
  description = <<-EOT
    AUD-OPS-032: eviction/memory tripwires. Prod runs ONE cache.t4g.micro
    (~555MB) as the ENTIRE Trino serving cache — a correct cost-first choice
    TODAY (and ~20% cheaper still on Valkey, whose better per-key memory
    efficiency fits more of the working set on the same micro), but at 10x
    (100 brands' dashboards) it evicts constantly and a cache-miss storm lands
    on an OOM-prone 3-worker Trino fleet. The pre-agreed knob is node_type
    micro -> small (+~$14/mo); these alarms are the TRIGGER:
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

  # NOTE: id keeps the historical "-redis" suffix on purpose — renaming it would
  # force a destroy/recreate (new endpoint). The engine swap is in-place; the id
  # is just a stable name. Endpoint DNS is unchanged by the redis->valkey upgrade.
  replication_group_id       = "${var.project}-${var.environment}-redis"
  description                = "Brain ${var.engine} cache (${var.environment})"
  engine                     = var.engine
  engine_version             = var.engine_version
  parameter_group_name       = var.parameter_group_name
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
