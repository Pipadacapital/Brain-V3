"""
Custom Checkov check: NN-3 — IRSA trust policies must use StringEquals on oidc:sub.
Blocks StringLike (wildcard) on any OIDC :sub condition in aws_iam_role resources.
"""
from __future__ import annotations

import json
from typing import Any

from checkov.common.models.enums import CheckResult, CheckCategories
from checkov.terraform.checks.resource.base_resource_check import BaseResourceCheck


class IRSANoWildcardCheck(BaseResourceCheck):
    """
    NN-3: IRSA trust policies must use StringEquals on oidc:sub.
    StringLike with wildcards collapses workload isolation to cluster-level.
    """

    def __init__(self):
        name = "NN-3: IRSA trust policy must use StringEquals (not StringLike) on oidc:sub"
        id = "CKV_BRAIN_1"
        supported_resources = ["aws_iam_role"]
        categories = [CheckCategories.IAM]
        super().__init__(name=name, id=id, categories=categories, supported_resources=supported_resources)

    def scan_resource_conf(self, conf: dict[str, Any]) -> CheckResult:
        assume_role_policy = conf.get("assume_role_policy", [{}])
        if isinstance(assume_role_policy, list):
            assume_role_policy = assume_role_policy[0]

        if not assume_role_policy:
            return CheckResult.PASSED

        # Parse policy JSON if it's a string
        if isinstance(assume_role_policy, str):
            try:
                policy = json.loads(assume_role_policy)
            except (json.JSONDecodeError, TypeError):
                return CheckResult.UNKNOWN
        elif isinstance(assume_role_policy, dict):
            policy = assume_role_policy
        else:
            return CheckResult.UNKNOWN

        statements = policy.get("Statement", [])
        for statement in statements:
            if statement.get("Effect") != "Allow":
                continue

            actions = statement.get("Action", [])
            if isinstance(actions, str):
                actions = [actions]

            if "sts:AssumeRoleWithWebIdentity" not in actions:
                continue

            # Check conditions for StringLike on :sub
            conditions = statement.get("Condition", {})
            if "StringLike" in conditions:
                string_like = conditions["StringLike"]
                for key in string_like:
                    if key.endswith(":sub"):
                        # NN-3 VIOLATION: StringLike on :sub
                        return CheckResult.FAILED

        return CheckResult.PASSED


scanner = IRSANoWildcardCheck()
