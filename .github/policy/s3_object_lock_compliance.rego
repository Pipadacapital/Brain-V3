# NN-4: S3 Object Lock MUST be COMPLIANCE mode + 7-year retention on purpose=audit/bronze buckets.
# Rejects GOVERNANCE mode and retention periods below 7 years on tagged buckets.

package brain.iac.s3_object_lock_compliance

import future.keywords.if
import future.keywords.in

# Protected purposes that require Object Lock COMPLIANCE + 7yr
protected_purposes := {"audit", "bronze"}

# Deny: bucket with purpose=audit or purpose=bronze that lacks object_lock_enabled
deny[msg] if {
  resource := input.resource_changes[_]
  resource.type == "aws_s3_bucket"
  after := resource.change.after

  # Check purpose tag
  purpose := after.tags.purpose
  purpose in protected_purposes

  # object_lock_enabled must be true
  not after.object_lock_enabled

  msg := sprintf(
    "NN-4 VIOLATION: S3 bucket '%s' has purpose='%s' but object_lock_enabled is false or unset. Object Lock must be enabled at bucket creation.",
    [resource.name, purpose]
  )
}

# Deny: object lock configuration using GOVERNANCE mode on protected buckets
deny[msg] if {
  resource := input.resource_changes[_]
  resource.type == "aws_s3_bucket_object_lock_configuration"
  after := resource.change.after

  # Find the associated bucket to check its purpose tag
  bucket_resource := input.resource_changes[_]
  bucket_resource.type == "aws_s3_bucket"
  bucket_resource.change.after.bucket == after.bucket

  purpose := bucket_resource.change.after.tags.purpose
  purpose in protected_purposes

  # Violation: GOVERNANCE mode (only COMPLIANCE accepted)
  rule := after.rule[_]
  retention := rule.default_retention[_]
  retention.mode == "GOVERNANCE"

  msg := sprintf(
    "NN-4 VIOLATION: S3 bucket '%s' (purpose='%s') uses Object Lock GOVERNANCE mode. Only COMPLIANCE mode is permitted for audit/bronze buckets (GOVERNANCE can be bypassed by s3:BypassGovernanceRetention).",
    [bucket_resource.name, purpose]
  )
}

# Deny: object lock retention period < 7 years on protected buckets
deny[msg] if {
  resource := input.resource_changes[_]
  resource.type == "aws_s3_bucket_object_lock_configuration"
  after := resource.change.after

  bucket_resource := input.resource_changes[_]
  bucket_resource.type == "aws_s3_bucket"
  bucket_resource.change.after.bucket == after.bucket

  purpose := bucket_resource.change.after.tags.purpose
  purpose in protected_purposes

  rule := after.rule[_]
  retention := rule.default_retention[_]

  # Must be exactly years=7 (not days, not months, not years < 7)
  not retention.years
  msg := sprintf(
    "NN-4 VIOLATION: S3 bucket '%s' (purpose='%s') retention must specify 'years' (not 'days'). Retention must be 7 years.",
    [bucket_resource.name, purpose]
  )
}

deny[msg] if {
  resource := input.resource_changes[_]
  resource.type == "aws_s3_bucket_object_lock_configuration"
  after := resource.change.after

  bucket_resource := input.resource_changes[_]
  bucket_resource.type == "aws_s3_bucket"
  bucket_resource.change.after.bucket == after.bucket

  purpose := bucket_resource.change.after.tags.purpose
  purpose in protected_purposes

  rule := after.rule[_]
  retention := rule.default_retention[_]
  retention.years < 7

  msg := sprintf(
    "NN-4 VIOLATION: S3 bucket '%s' (purpose='%s') has retention=%d years — minimum is 7 years.",
    [bucket_resource.name, purpose, retention.years]
  )
}
