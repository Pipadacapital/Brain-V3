################################################################################
# Brain – Observability Module
# Scope-reduced per ruling: CloudWatch log groups + ONE composite EKS-unhealthy
# alarm. Grafana Cloud owns SLOs (no CloudWatch dashboards).
# OTel collector IRSA is provisioned here.
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

variable "kms_key_arn" {
  type = string
}

variable "oidc_provider_arn" {
  type = string
}

variable "oidc_provider_url" {
  type = string
}

variable "cluster_name" {
  type = string
}

locals {
  services           = ["collector", "stream-worker", "core", "web"]
  log_retention_days = 90
}

###############################################################################
# CloudWatch Log Groups — one per service + cluster-level audit
###############################################################################
resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(local.services)
  name              = "/brain/${var.environment}/${each.key}"
  retention_in_days = local.log_retention_days
  kms_key_id        = var.kms_key_arn

  tags = {
    project     = var.project
    environment = var.environment
    service     = each.key
  }
}

resource "aws_cloudwatch_log_group" "eks_audit" {
  name              = "/aws/eks/${var.cluster_name}/cluster"
  retention_in_days = 365
  kms_key_id        = var.kms_key_arn

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "eks-audit"
  }
}

###############################################################################
# Metric filter: count CrashLoopBackOff events
###############################################################################
resource "aws_cloudwatch_log_metric_filter" "crashloop" {
  name           = "${var.project}-${var.environment}-crashloop"
  pattern        = "{ $.reason = \"BackOff\" && $.involvedObject.kind = \"Pod\" }"
  log_group_name = aws_cloudwatch_log_group.eks_audit.name

  metric_transformation {
    name          = "PodCrashLoopCount"
    namespace     = "Brain/${var.environment}/EKS"
    value         = "1"
    default_value = "0"
  }
}

###############################################################################
# Child alarms (inputs to the composite alarm)
###############################################################################
resource "aws_cloudwatch_metric_alarm" "pod_crashloop" {
  alarm_name          = "${var.project}-${var.environment}-pod-crashloop"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "PodCrashLoopCount"
  namespace           = "Brain/${var.environment}/EKS"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "Pod CrashLoopBackOff rate elevated in ${var.environment}"
  treat_missing_data  = "notBreaching"

  tags = {
    project     = var.project
    environment = var.environment
  }
}

resource "aws_cloudwatch_metric_alarm" "node_not_ready" {
  alarm_name          = "${var.project}-${var.environment}-node-not-ready"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "cluster_node_count"
  namespace           = "ContainerInsights"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "EKS nodes below minimum in ${var.environment}"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = var.cluster_name
  }

  tags = {
    project     = var.project
    environment = var.environment
  }
}

###############################################################################
# Composite alarm — the ONE EKS-unhealthy alarm (scope-reduced ruling)
###############################################################################
resource "aws_cloudwatch_composite_alarm" "eks_unhealthy" {
  alarm_name        = "${var.project}-${var.environment}-eks-cluster-unhealthy"
  alarm_description = "Composite: EKS cluster health degraded (${var.environment}). See child alarms."

  alarm_rule = "ALARM(${aws_cloudwatch_metric_alarm.pod_crashloop.alarm_name}) OR ALARM(${aws_cloudwatch_metric_alarm.node_not_ready.alarm_name})"

  tags = {
    project     = var.project
    environment = var.environment
    purpose     = "eks-health"
  }
}

###############################################################################
# OTel Collector IRSA
###############################################################################
module "otel_collector_irsa" {
  source = "../irsa"

  role_name            = "otel-collector"
  oidc_provider_arn    = var.oidc_provider_arn
  oidc_provider_url    = var.oidc_provider_url
  namespace            = "observability"
  service_account_name = "otel-collector"
  environment          = var.environment
  project              = var.project
}

data "aws_iam_policy_document" "otel_cloudwatch" {
  statement {
    sid    = "CloudWatchPut"
    effect = "Allow"
    actions = [
      "cloudwatch:PutMetricData",
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "otel_cloudwatch" {
  name   = "${var.project}-${var.environment}-otel-cloudwatch"
  role   = module.otel_collector_irsa.role_name
  policy = data.aws_iam_policy_document.otel_cloudwatch.json
}

###############################################################################
# Outputs
###############################################################################
output "otel_collector_role_arn" {
  value = module.otel_collector_irsa.role_arn
}

output "composite_alarm_arn" {
  value = aws_cloudwatch_composite_alarm.eks_unhealthy.arn
}

output "log_group_names" {
  value = {
    for k, v in aws_cloudwatch_log_group.service : k => v.name
  }
}
