################################################################################
# Brain – Prod actionable alerting (ADR-0004, OE-1 / OE-2)
#
# Wires the net-new modules/alerting: ONE SNS topic `brain-prod-alerts` with an
# email subscription (var alert_email) + an OPTIONAL AWS Chatbot/Slack channel
# (var-gated, default off), and an EventBridge rule routing GuardDuty findings
# at/above a severity floor to the topic. The 5 existing CloudWatch alarms are
# routed here by passing module.alerting.sns_topic_arn into their owning module
# calls:
#   - composite EKS-unhealthy  -> envs/prod/observability.tf (alarm_sns_topic_arn)
#   - Aurora ACU-saturation    -> bootstrap.tf module.aurora (AUD-SEC-BASE)
#   - Redis eviction + memory  -> bootstrap.tf module.elasticache (AUD-SEC-BASE)
#   - fck-nat recover + reboot -> bootstrap.tf module.nat_instance (AUD-SEC-BASE)
#
# This is the fix for OE-1 "nothing pages anyone": every alarm above fires into
# the void today. SNS + EventBridge are effectively free at this alarm volume.
#
# ROLLBACK: `terraform destroy -target module.alerting` (+ blank the topic ARN
# passed to the alarm modules) or `git revert`. Additive, no data impact.
################################################################################

module "alerting" {
  source      = "../../modules/alerting"
  environment = local.environment
  project     = local.project
  kms_key_arn = module.kms.root_kms_key_arn

  # Email subscription — the operator MUST click the AWS confirmation email once
  # before delivery starts (subscription shows pending_confirmation until then).
  alert_email = var.alert_email

  # OPTIONAL Slack via AWS Chatbot — default off (needs a one-time console
  # workspace authorization before the workspace/channel ids below are valid).
  enable_slack_chatbot = var.enable_slack_chatbot
  slack_workspace_id   = var.slack_workspace_id
  slack_channel_id     = var.slack_channel_id

  # GuardDuty findings at/above this severity are routed to the topic; tie the
  # rule to the detector so it applies after GuardDuty exists.
  guardduty_finding_severity_floor = var.guardduty_finding_severity_floor
  guardduty_detector_id            = module.security_baseline.guardduty_detector_id
}

# ── Variables (ADR-0004) — sensible defaults so a bare plan works ────────────
variable "alert_email" {
  description = "Email subscribed to the brain-prod-alerts SNS topic (confirm once via the AWS email)."
  type        = string
  default     = "rishabhporwal95@gmail.com"
}

variable "enable_slack_chatbot" {
  description = "Enable an AWS Chatbot Slack channel on the alerts topic (needs a one-time console workspace auth)."
  type        = bool
  default     = false
}

variable "slack_workspace_id" {
  description = "Slack workspace id from AWS Chatbot console auth (required when enable_slack_chatbot=true)."
  type        = string
  default     = ""
}

variable "slack_channel_id" {
  description = "Slack channel id AWS Chatbot posts to (required when enable_slack_chatbot=true)."
  type        = string
  default     = ""
}

variable "guardduty_finding_severity_floor" {
  description = "Minimum GuardDuty finding severity routed to SNS (4 = MEDIUM+, 7 = HIGH)."
  type        = number
  default     = 4
}

output "alerts_sns_topic_arn" { value = module.alerting.sns_topic_arn }
