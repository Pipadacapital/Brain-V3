# NN-3: IRSA trust policies MUST use StringEquals on oidc:sub.
# Blocks StringLike (wildcard) on the OIDC subject claim.
# This rule fails terraform plan if any IRSA trust policy uses StringLike on :sub.

package brain.iac.irsa_no_wildcard

import future.keywords.if
import future.keywords.in

# Deny any IAM assume-role policy statement that uses StringLike on oidc :sub
deny[msg] if {
  # Walk all resources in the Terraform plan
  resource := input.resource_changes[_]
  resource.type == "aws_iam_role"

  # Parse the assume_role_policy (it's a JSON string)
  policy := json.unmarshal(resource.change.after.assume_role_policy)

  statement := policy.Statement[_]
  statement.Effect == "Allow"
  statement.Action[_] == "sts:AssumeRoleWithWebIdentity"

  condition := statement.Condition
  # NN-3 violation: StringLike is present on any oidc:sub condition key
  condition_test := condition.StringLike
  key := [k | k := concat("", [p, ":", s]); p := object.keys(condition_test)[_]; endswith(p, ".amazonaws.com"); s == "sub"][_]

  msg := sprintf(
    "NN-3 VIOLATION: IAM role '%s' uses StringLike on OIDC :sub — must use StringEquals. Role: %s",
    [resource.name, resource.change.after.name]
  )
}

# Also deny StringLike on any :sub variant (covers different OIDC provider URLs)
deny[msg] if {
  resource := input.resource_changes[_]
  resource.type == "aws_iam_role"

  policy := json.unmarshal(resource.change.after.assume_role_policy)
  statement := policy.Statement[_]
  statement.Effect == "Allow"
  statement.Action[_] == "sts:AssumeRoleWithWebIdentity"

  condition := statement.Condition
  string_like := condition.StringLike
  key := object.keys(string_like)[_]
  endswith(key, ":sub")

  msg := sprintf(
    "NN-3 VIOLATION: IAM role '%s' condition key '%s' uses StringLike — StringEquals required for namespace+SA binding. No wildcards on IRSA :sub.",
    [resource.name, key]
  )
}
