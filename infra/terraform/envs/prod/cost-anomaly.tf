################################################################################
# Brain – Prod cost-anomaly detection (2026-07-18)
#
# Codifies the AWS Cost Anomaly Detection monitor + DAILY email subscription that
# were previously AWS-auto-created ("Default-Services-*") and hand-tuned via the
# CLI. Rationale for the tuning: the auto-created subscription fired only when an
# anomaly was >= $100 AND >= 40% impact — but prod's ENTIRE daily spend is ~$12,
# so it could never trip and nothing was ever alerted. We lowered it to a single
# $5 absolute-impact gate (~40% of a normal day) so batch-refresh spikes and any
# new cost leak surface within a day, and added the operator email alongside the
# team alias.
#
# Cost Explorer is a GLOBAL service reached via the us-east-1 endpoint; like the
# aws_budgets_budget resources in bootstrap.tf, these need no region-aliased
# provider — the AWS provider routes CE calls to the global endpoint.
#
# IMPORT (these already exist live — do NOT let plan try to create duplicates;
# import into state first, run once as part of the owner-gated infra apply):
#   terraform import aws_ce_anomaly_monitor.services \
#     arn:aws:ce::380254378136:anomalymonitor/6bc4ca5b-49f6-402c-b374-f27af10bd0fb
#   terraform import aws_ce_anomaly_subscription.services_daily \
#     arn:aws:ce::380254378136:anomalysubscription/3d571612-4b3e-4950-94ff-3146685f58c4
#
# ROLLBACK: `git revert` (config only) or raise cost_anomaly_impact_threshold_usd
# back up. Additive, alerts-only, no data impact.
################################################################################

variable "cost_anomaly_impact_threshold_usd" {
  description = "Minimum absolute daily $ impact for a detected anomaly to send the DAILY alert email. Baseline spend is ~$12/day; raise toward \"10\" if it gets chatty. String to match the CE API's stored form exactly (avoids 5.0-vs-5 plan drift)."
  type        = string
  default     = "5.0"
}

variable "cost_anomaly_alert_emails" {
  description = "Recipients of the DAILY cost-anomaly email (team alias + operator). var.alert_email is the operator address defined in alerting.tf."
  type        = list(string)
  default     = null
}

locals {
  # Default to the team alias + the shared operator email (var.alert_email), but
  # allow a full override via var.cost_anomaly_alert_emails.
  cost_anomaly_emails = coalesce(
    var.cost_anomaly_alert_emails,
    ["tech@pipadacapital.com", var.alert_email],
  )
}

# ML baseline monitor across all AWS services (DIMENSIONAL/SERVICE). AWS learns
# per-service spend patterns and flags deviations; no thresholds live here — the
# subscription below decides what impact is worth an email.
resource "aws_ce_anomaly_monitor" "services" {
  name              = "Default-Services-Monitor"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

# DAILY batched email whenever the monitor detects an anomaly at/above the
# $-impact gate. EMAIL subscribers on CE anomaly subscriptions auto-confirm
# (no click required, unlike SNS).
resource "aws_ce_anomaly_subscription" "services_daily" {
  name             = "Default-Services-Subscription"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  dynamic "subscriber" {
    for_each = local.cost_anomaly_emails
    content {
      type    = "EMAIL"
      address = subscriber.value
    }
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      values        = [var.cost_anomaly_impact_threshold_usd]
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }
}

output "cost_anomaly_subscription_arn" {
  value = aws_ce_anomaly_subscription.services_daily.arn
}
