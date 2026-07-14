################################################################################
# Brain – Prod detective-control baseline (ADR-0004, SEC-1 / SEC-4)
#
# Wires the net-new modules/security-baseline: an account multi-region
# CloudTrail (log-file validation ON) delivering to the EXISTING immutable audit
# bucket (module.s3_audit — Object Lock COMPLIANCE 7yr) under the audit CMK, a
# GuardDuty detector in ap-south-1, and an OPTIONAL AWS Config recorder
# (var-gated, default off). This finally feeds the WORM audit store the AWS
# control-plane trail it was built for, and gives a paid PII-holding account the
# threat-detection + tamper-evident audit trail it lacked.
#
# Dependencies (all in-lane, all additive):
#   - modules/s3-audit gains `enable_cloudtrail_delivery` + `cloudtrail_s3_key_prefix`
#     (see enable below) so its bucket policy grants the CloudTrail principal.
#   - modules/kms gains `isolate_audit_cmk_policy` (SEC-4) so the audit CMK gets
#     its own non-blanket policy that still lets CloudTrail encrypt log files.
# Both flags are set on the existing module.s3_audit / module.kms calls in
# bootstrap.tf (search AUD-SEC-BASE there).
#
# ROLLBACK: `terraform destroy -target module.security_baseline` (+ flip the two
# module flags back to false) or `git revert`. No destructive dependency.
################################################################################

module "security_baseline" {
  source      = "../../modules/security-baseline"
  environment = local.environment
  project     = local.project

  audit_bucket_name = module.s3_audit.audit_bucket_name
  audit_bucket_arn  = module.s3_audit.audit_bucket_arn
  audit_kms_key_arn = module.kms.audit_kms_key_arn

  enable_cloudtrail = var.enable_cloudtrail
  enable_guardduty  = var.enable_guardduty
  # OPTIONAL AWS Config — default false (per-item + per-rule cost). Enable via
  # tfvars once the Config cost is accepted (ADR-0004 fast-follow).
  enable_config = var.enable_aws_config

  # Must match the prefix the audit bucket policy grants (bootstrap.tf s3_audit).
  cloudtrail_s3_key_prefix = var.cloudtrail_s3_key_prefix
}

# ── Variables (ADR-0004) — sensible defaults so a bare plan works ────────────
variable "enable_cloudtrail" {
  description = "Create the account multi-region CloudTrail -> WORM audit bucket (ADR-0004 SEC-1)."
  type        = bool
  default     = true
}

variable "enable_guardduty" {
  description = "Create the GuardDuty detector in ap-south-1 (ADR-0004 SEC-1)."
  type        = bool
  default     = true
}

variable "enable_aws_config" {
  description = "OPTIONAL AWS Config recorder (per-item + per-rule cost). Default false — deliberate opt-in fast-follow."
  type        = bool
  default     = false
}

variable "cloudtrail_s3_key_prefix" {
  description = "Key prefix under the audit bucket for CloudTrail logs. Must match the s3_audit bucket-policy grant."
  type        = string
  default     = "cloudtrail"
}

output "cloudtrail_arn" { value = module.security_baseline.cloudtrail_arn }
output "guardduty_detector_id" { value = module.security_baseline.guardduty_detector_id }
