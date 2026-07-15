################################################################################
# Brain – Aurora Serverless v2 (PostgreSQL) Module
# aurora-postgresql, engine_mode = provisioned + Serverless v2 ACU autoscaling.
# Private subnets only, no public access, SSE via the shared KMS CMK.
# dev: apply; staging/prod: declared (controlled by var.create), EC10.
#
# Naming: brain-{env}-postgres (cluster) — mirrors modules/rds identifier so the
# two are drop-in alternatives. See README.md for the migration implication.
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

variable "vpc_id" {
  type        = string
  description = "VPC the Aurora cluster (and its SG) live in."
}

variable "subnet_ids" {
  type        = list(string)
  description = "PRIVATE subnet ids only - Aurora is never publicly accessible."
}

variable "ingress_security_group_ids" {
  type        = list(string)
  description = "Source SGs allowed to reach Postgres on 5432 (e.g. EKS nodes SG). Empty = no ingress (locked down)."
  default     = []
}

variable "kms_key_arn" {
  type        = string
  description = "Existing KMS CMK ARN for storage + master-user-secret + Performance Insights SSE."
}

# EC10: set to false for staging/prod to skip resource creation.
variable "create" {
  type    = bool
  default = true
}

variable "engine_version" {
  type        = string
  description = "Aurora PostgreSQL engine version. Pin to an Aurora-supported version (NOT a bare RDS version)."
  default     = "16.4"
}

variable "min_capacity" {
  type        = number
  description = "Serverless v2 minimum capacity in ACU."
  default     = 0.5
}

variable "max_capacity" {
  type        = number
  description = "Serverless v2 maximum capacity in ACU."
  default     = 2
}

variable "instance_count" {
  type        = number
  description = "Number of db.serverless cluster instances (1 = single-writer; raise for HA readers)."
  default     = 1
}

# ADR-0005 (REL-3, T1 DR): add a SECOND db.serverless instance as a reader so
# the single-writer SPOF gains an in-region auto-failover target. Default false
# = single-writer (unchanged cost/topology). When true the effective instance
# count is max(instance_count, 2). Serverless v2 readers scale to the min ACU
# floor when idle, so the added cost is ~the 0.5-ACU floor, not a full node.
variable "enable_t1_reader" {
  type        = bool
  description = "Add a second db.serverless reader instance for in-region failover (ADR-0005 T1)."
  default     = false
}

locals {
  effective_instance_count = var.enable_t1_reader ? max(var.instance_count, 2) : var.instance_count
}

variable "enable_tripwire_alarms" {
  description = <<-EOT
    AUD-OPS-032: ACU-saturation tripwire. The prod cluster is deliberately
    capped at max_capacity=2 ACU (cost-first); the pre-agreed 10x knob is a
    tfvars bump (aurora_max_capacity 2 -> 8, pay-per-use so ~zero idle cost).
    This alarm is the TRIGGER for pulling that knob: sustained ACUUtilization
    >= 80% means the writer is pinned at its ceiling and OLTP + hourly exports
    are degrading. No alarm_actions (matches modules/observability posture —
    alerts-only account); a visible tripwire, not a pager. NOTE: no CloudWatch
    exporter runs in-cluster, so this cannot be a Prometheus rule (it would be
    loaded-but-dead). Decision record: docs/ops/scale-knobs.md.
  EOT
  type        = bool
  default     = true
}

# ADR-0004 (OE-1): SNS topic ARN the ACU-saturation tripwire pages. Empty
# default = today's alerts-only (un-paged) posture — additive. The prod root
# passes module.alerting.sns_topic_arn.
variable "alarm_sns_topic_arn" {
  type        = string
  description = "SNS topic ARN for the ACU tripwire alarm_actions/ok_actions. Empty = un-paged (unchanged)."
  default     = ""
}

###############################################################################
# Common tags
# Peer modules tag lowercase project/environment/purpose (+ provider default_tags);
# the platform standard additionally mandates Environment/Service/Owner/CostCenter.
# We merge BOTH so the module is consistent with neighbours AND policy-compliant.
###############################################################################
locals {
  common_tags = {
    project     = var.project
    environment = var.environment
    purpose     = "oltp"
    Environment = var.environment
    Service     = "postgres"
    Owner       = "data-team"
    CostCenter  = "brain-platform"
  }
}

###############################################################################
# DB Subnet Group — private subnets only
###############################################################################
resource "aws_db_subnet_group" "main" {
  count       = var.create ? 1 : 0
  name        = "${var.project}-${var.environment}-aurora"
  subnet_ids  = var.subnet_ids
  description = "Brain Aurora PostgreSQL subnet group (${var.environment}) - private subnets only"

  tags = merge(local.common_tags, {
    Name = "${var.project}-${var.environment}-aurora-subnet-group"
  })
}

###############################################################################
# Security Group — Postgres (5432) from approved source SGs only, no public path
###############################################################################
resource "aws_security_group" "aurora" {
  count       = var.create ? 1 : 0
  name        = "${var.project}-${var.environment}-aurora"
  description = "Brain Aurora PostgreSQL security group - approved source SGs only"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = length(var.ingress_security_group_ids) > 0 ? [1] : []
    content {
      from_port       = 5432
      to_port         = 5432
      protocol        = "tcp"
      security_groups = var.ingress_security_group_ids
      description     = "Postgres from approved source security groups"
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = merge(local.common_tags, {
    Name = "${var.project}-${var.environment}-aurora-sg"
  })
}

###############################################################################
# Cluster Parameter Group — Aurora Postgres 16 (logging parity with modules/rds)
###############################################################################
resource "aws_rds_cluster_parameter_group" "aurora_postgres16" {
  count       = var.create ? 1 : 0
  name        = "${var.project}-${var.environment}-aurora-postgres16"
  family      = "aurora-postgresql16"
  description = "Brain Aurora PostgreSQL 16 cluster parameter group (${var.environment})"

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  tags = merge(local.common_tags, {
    Name = "${var.project}-${var.environment}-aurora-postgres16"
  })
}

###############################################################################
# Aurora Cluster — engine_mode provisioned + Serverless v2 ACU autoscaling
###############################################################################
resource "aws_rds_cluster" "postgres" {
  count = var.create ? 1 : 0

  cluster_identifier = "${var.project}-${var.environment}-postgres"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned" # Required for Serverless v2 ACU autoscaling
  engine_version     = var.engine_version

  database_name   = "brain"
  master_username = "brainadmin"

  # Password managed via Secrets Manager rotation — no plaintext here (parity w/ modules/rds)
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  serverlessv2_scaling_configuration {
    min_capacity = var.min_capacity
    max_capacity = var.max_capacity
  }

  db_subnet_group_name            = aws_db_subnet_group.main[0].name
  vpc_security_group_ids          = [aws_security_group.aurora[0].id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora_postgres16[0].name

  storage_encrypted = true
  kms_key_id        = var.kms_key_arn

  backup_retention_period   = 35
  preferred_backup_window   = "02:00-03:00"
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.project}-${var.environment}-aurora-final-snapshot"

  deletion_protection = var.environment == "prod" ? true : false

  # AUD-COST (2026-07-15): CloudWatch hold — Aurora postgresql log export OFF to stop
  # ongoing CloudWatch ingestion (paired with the held observability stack + disabled EKS
  # control-plane logging). Aurora's own error/slow logs remain queryable in-DB; re-enable
  # by restoring ["postgresql"] if a forensic window is needed.
  enabled_cloudwatch_logs_exports = []

  tags = merge(local.common_tags, {
    Name = "${var.project}-${var.environment}-postgres"
  })
}

###############################################################################
# Cluster Instance(s) — db.serverless (Serverless v2)
###############################################################################
resource "aws_rds_cluster_instance" "postgres" {
  count = var.create ? local.effective_instance_count : 0

  identifier         = "${var.project}-${var.environment}-postgres-${count.index + 1}"
  cluster_identifier = aws_rds_cluster.postgres[0].id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.postgres[0].engine
  engine_version     = aws_rds_cluster.postgres[0].engine_version

  db_subnet_group_name = aws_db_subnet_group.main[0].name
  publicly_accessible  = false

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = 7

  tags = merge(local.common_tags, {
    Name = "${var.project}-${var.environment}-postgres-${count.index + 1}"
  })
}

###############################################################################
# AUD-OPS-032 — ACU-saturation tripwire (see var.enable_tripwire_alarms).
# ACUUtilization = ServerlessDatabaseCapacity / max_capacity (%): sustained
# >=80% for 15m means the writer is effectively pinned at its deliberate 2-ACU
# cost cap — the pre-agreed response is the tfvars bump (aurora_max_capacity
# 2 -> 8), NOT a firefight. Additive + reversible (flip the var to drop it).
###############################################################################
resource "aws_cloudwatch_metric_alarm" "acu_utilization_tripwire" {
  count = var.create && var.enable_tripwire_alarms ? 1 : 0

  alarm_name          = "${var.project}-${var.environment}-aurora-acu-saturation"
  alarm_description   = "Aurora Serverless v2 ACUUtilization >= 80% for 15m — the ${var.max_capacity}-ACU ceiling is saturating; pull the pre-agreed max_capacity knob (docs/ops/scale-knobs.md, AUD-OPS-032)"
  namespace           = "AWS/RDS"
  metric_name         = "ACUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBClusterIdentifier = aws_rds_cluster.postgres[0].cluster_identifier
  }

  # ADR-0004: page the SNS topic when the ACU ceiling saturates (empty = none).
  alarm_actions = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []
  ok_actions    = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []

  tags = merge(local.common_tags, {
    Name = "${var.project}-${var.environment}-aurora-acu-saturation"
  })
}

###############################################################################
# Outputs
###############################################################################
output "endpoint" {
  description = "Writer (cluster) endpoint."
  value       = var.create ? aws_rds_cluster.postgres[0].endpoint : null
}

output "reader_endpoint" {
  description = "Reader endpoint (load-balances across reader instances)."
  value       = var.create ? aws_rds_cluster.postgres[0].reader_endpoint : null
}

output "port" {
  description = "Postgres port."
  value       = var.create ? aws_rds_cluster.postgres[0].port : null
}

output "security_group_id" {
  description = "Security group fronting the Aurora cluster."
  value       = var.create ? aws_security_group.aurora[0].id : null
}
