# NN-5: Per-brand S3 prefix isolation MUST be IAM-enforced (not convention-only).
# Blocks IAM policies granting s3:* or broad GetObject/PutObject on bucket root.
# Workload roles must scope to prefix patterns (bronze/brand_id=*/*).

package brain.iac.s3_prefix_least_priv

import future.keywords.if
import future.keywords.in

# S3 actions that are dangerous at bucket-root level for data buckets
dangerous_root_actions := {
  "s3:*",
  "s3:GetObject",
  "s3:PutObject",
  "s3:DeleteObject",
  "s3:GetObjectVersion",
}

# Deny: IAM policy statement that grants broad S3 actions on bucket root (no prefix)
deny[msg] if {
  resource := input.resource_changes[_]
  resource.type in {"aws_iam_policy", "aws_iam_role_policy"}

  after := resource.change.after
  policy := json.unmarshal(after.policy)
  statement := policy.Statement[_]
  statement.Effect == "Allow"

  action := statement.Action[_]
  action in dangerous_root_actions

  # Resource matches bucket root (no object path — just the bucket ARN)
  res_arn := statement.Resource[_]
  # Bucket root = no trailing /* and no prefix path after the bucket name
  not contains(res_arn, "/")
  startswith(res_arn, "arn:aws:s3:::")

  msg := sprintf(
    "NN-5 VIOLATION: IAM policy '%s' grants '%s' on S3 bucket root '%s'. Scope must be per-brand prefix (e.g., bucket/bronze/brand_id=*/*). Bucket-root grants allow cross-brand data access.",
    [resource.name, action, res_arn]
  )
}

# Deny: wildcard action (s3:*) on any S3 resource for workload policies
deny[msg] if {
  resource := input.resource_changes[_]
  resource.type in {"aws_iam_policy", "aws_iam_role_policy"}

  after := resource.change.after
  policy := json.unmarshal(after.policy)
  statement := policy.Statement[_]
  statement.Effect == "Allow"

  # s3:* wildcard is forbidden on any brain bucket
  action := statement.Action[_]
  action == "s3:*"

  res_arn := statement.Resource[_]
  contains(res_arn, "brain-bronze")  # Only enforce on brain data buckets

  msg := sprintf(
    "NN-5 VIOLATION: IAM policy '%s' uses 's3:*' on brain data bucket. Use explicit minimum actions scoped to a brand prefix.",
    [resource.name]
  )
}
