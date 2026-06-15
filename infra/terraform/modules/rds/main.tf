################################################################################
# Brain – RDS Module
# PostgreSQL 16 Multi-AZ + PITR.
# dev: apply; staging: count=0 (module present, no resources); prod: declared.
# EC10: staging/prod compute not created — controlled by var.create.
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

variable "subnet_ids" {
  type = list(string)
}

variable "rds_sg_id" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "db_password_secret_arn" {
  type        = string
  description = "SM secret ARN holding DB password"
}

# EC10: set to false for staging/prod to skip resource creation
variable "create" {
  type    = bool
  default = true
}

variable "instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "allocated_storage" {
  type    = number
  default = 100
}

variable "multi_az" {
  type    = bool
  default = true
}

###############################################################################
# DB Subnet Group
###############################################################################
resource "aws_db_subnet_group" "main" {
  count       = var.create ? 1 : 0
  name        = "${var.project}-${var.environment}-rds"
  subnet_ids  = var.subnet_ids
  description = "Brain RDS subnet group (${var.environment})"

  tags = {
    project     = var.project
    environment = var.environment
  }
}

###############################################################################
# RDS Parameter Group — Postgres 16
###############################################################################
resource "aws_db_parameter_group" "postgres16" {
  count  = var.create ? 1 : 0
  name   = "${var.project}-${var.environment}-postgres16"
  family = "postgres16"

  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  tags = {
    project     = var.project
    environment = var.environment
  }
}

###############################################################################
# RDS Instance
###############################################################################
resource "aws_db_instance" "postgres" {
  count = var.create ? 1 : 0

  identifier        = "${var.project}-${var.environment}-postgres"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.instance_class
  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true
  kms_key_id        = var.kms_key_arn

  db_name  = "brain"
  username = "brainadmin"

  # Password managed via Secrets Manager rotation — no plaintext here
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  db_subnet_group_name   = aws_db_subnet_group.main[0].name
  vpc_security_group_ids = [var.rds_sg_id]
  parameter_group_name   = aws_db_parameter_group.postgres16[0].name

  multi_az                  = var.multi_az
  backup_retention_period   = 35
  backup_window             = "02:00-03:00"
  maintenance_window        = "Mon:03:00-Mon:04:00"
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.project}-${var.environment}-final-snapshot"

  deletion_protection = var.environment == "prod" ? true : false
  publicly_accessible = false

  enabled_cloudwatch_logs_exports = [
    "postgresql",
    "upgrade",
  ]

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = 7

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "oltp"
  }
}

###############################################################################
# Outputs
###############################################################################
output "db_endpoint" {
  value = var.create ? aws_db_instance.postgres[0].endpoint : null
}

output "db_port" {
  value = var.create ? aws_db_instance.postgres[0].port : null
}

output "db_name" {
  value = var.create ? aws_db_instance.postgres[0].db_name : null
}
