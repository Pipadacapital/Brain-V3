################################################################################
# Brain – Redpanda Cloud Module
# Declares Redpanda Cloud cluster + topic resources.
# Cloud-side only — the local docker-compose equivalents are data-engineer owned.
# Topics: {env}.{domain}.{event}.v{n}; live vs backfill lanes.
################################################################################

terraform {
  required_version = ">= 1.9"
  required_providers {
    # Redpanda Cloud Terraform provider
    # https://registry.terraform.io/providers/redpanda-data/redpanda/latest
    redpanda = {
      source  = "redpanda-data/redpanda"
      version = "~> 0.7"
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

variable "redpanda_client_id" {
  type      = string
  sensitive = true
}

variable "redpanda_client_secret" {
  type      = string
  sensitive = true
}

variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

###############################################################################
# Provider
###############################################################################
provider "redpanda" {
  client_id     = var.redpanda_client_id
  client_secret = var.redpanda_client_secret
}

###############################################################################
# Redpanda Cloud Cluster
###############################################################################
resource "redpanda_cluster" "main" {
  name            = "${var.project}-${var.environment}"
  connection_type = "public"
  cloud_provider  = "aws"
  region          = var.aws_region
  cluster_type    = "dedicated"

  # Dev: smallest dedicated cluster; staging/prod: tune throughput
  throughput_tier = var.environment == "prod" ? "tier-3-aws-v2-arm" : "tier-1-aws-v2-arm"

  zones = [
    "${var.aws_region}a",
    "${var.aws_region}b",
    "${var.aws_region}c",
  ]

  tags = {
    project     = var.project
    environment = var.environment
  }
}

###############################################################################
# Topics
# Naming: {env}.{domain}.{event}.v{n}
###############################################################################

resource "redpanda_topic" "collector_event_live" {
  cluster_api_url    = redpanda_cluster.main.cluster_api_url
  name               = "${var.environment}.collector.event.v1"
  partition_count    = 12
  replication_factor = 3

  configuration = {
    # 24-month retention aligned with Bronze SoR (I-E02)
    "retention.ms"        = tostring(730 * 24 * 60 * 60 * 1000)
    "retention.bytes"     = tostring(-1)
    "compression.type"    = "lz4"
    "min.insync.replicas" = "2"
  }
}

resource "redpanda_topic" "collector_event_backfill" {
  cluster_api_url    = redpanda_cluster.main.cluster_api_url
  name               = "${var.environment}.collector.event.backfill.v1"
  partition_count    = 6
  replication_factor = 3

  configuration = {
    "retention.ms"        = tostring(730 * 24 * 60 * 60 * 1000)
    "compression.type"    = "lz4"
    "min.insync.replicas" = "2"
  }
}

resource "redpanda_topic" "dlq" {
  cluster_api_url    = redpanda_cluster.main.cluster_api_url
  name               = "${var.environment}.collector.dlq.v1"
  partition_count    = 3
  replication_factor = 3

  configuration = {
    "retention.ms"     = tostring(90 * 24 * 60 * 60 * 1000)
    "compression.type" = "lz4"
  }
}

###############################################################################
# Outputs
###############################################################################
output "cluster_api_url" {
  description = "Redpanda cluster API URL for topic management"
  value       = redpanda_cluster.main.cluster_api_url
}

output "bootstrap_servers" {
  description = "Bootstrap server addresses for KafkaJS clients"
  value       = redpanda_cluster.main.cluster_api_url
  sensitive   = true
}

output "live_topic_name" {
  value = redpanda_topic.collector_event_live.name
}

output "backfill_topic_name" {
  value = redpanda_topic.collector_event_backfill.name
}

output "dlq_topic_name" {
  value = redpanda_topic.dlq.name
}
