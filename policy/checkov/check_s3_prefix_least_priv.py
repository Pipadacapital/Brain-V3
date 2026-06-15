"""
Custom Checkov check: NN-5 — Per-brand S3 prefix isolation must be IAM-enforced.
Blocks bucket-root grants and s3:* wildcards on brain data buckets.
"""
from __future__ import annotations

import json
from typing import Any

from checkov.common.models.enums import CheckResult, CheckCategories
from checkov.terraform.checks.resource.base_resource_check import BaseResourceCheck


DANGEROUS_ROOT_ACTIONS = {
    "s3:*",
    "s3:GetObject",
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:GetObjectVersion",
}

BRAIN_DATA_BUCKET_PATTERNS = ["brain-bronze", "brain-audit"]


def _is_brain_data_bucket_arn(arn: str) -> bool:
    """Check if an ARN refers to a Brain data bucket."""
    return any(pattern in arn for pattern in BRAIN_DATA_BUCKET_PATTERNS)


def _is_bucket_root(arn: str) -> bool:
    """True if the ARN targets the bucket itself (no object path)."""
    # Bucket root: arn:aws:s3:::bucket-name (no trailing /*)
    # Object path: arn:aws:s3:::bucket-name/* or arn:aws:s3:::bucket-name/prefix/*
    parts = arn.split(":::")
    if len(parts) < 2:
        return False
    bucket_part = parts[1]
    return "/" not in bucket_part


class S3PrefixLeastPrivCheck(BaseResourceCheck):
    """
    NN-5: Workload IAM policies must scope S3 access to per-brand prefixes,
    never bucket root. stream-worker: PutObject on bronze/brand_id=*/* only.
    Analytics: GetObject on bronze prefix only. No bucket-root grants.
    """

    def __init__(self):
        name = "NN-5: IAM policies must scope S3 access to per-brand prefix (not bucket root)"
        id = "CKV_BRAIN_3"
        supported_resources = ["aws_iam_policy", "aws_iam_role_policy"]
        categories = [CheckCategories.IAM]
        super().__init__(name=name, id=id, categories=categories, supported_resources=supported_resources)

    def scan_resource_conf(self, conf: dict[str, Any]) -> CheckResult:
        policy_json = conf.get("policy", ["{}"])
        if isinstance(policy_json, list):
            policy_json = policy_json[0] if policy_json else "{}"

        if not policy_json:
            return CheckResult.PASSED

        try:
            policy = json.loads(policy_json) if isinstance(policy_json, str) else policy_json
        except (json.JSONDecodeError, TypeError):
            return CheckResult.UNKNOWN

        statements = policy.get("Statement", [])
        for statement in statements:
            if statement.get("Effect") != "Allow":
                continue

            actions = statement.get("Action", [])
            if isinstance(actions, str):
                actions = [actions]

            resources = statement.get("Resource", [])
            if isinstance(resources, str):
                resources = [resources]

            for action in actions:
                if action not in DANGEROUS_ROOT_ACTIONS:
                    continue

                for resource_arn in resources:
                    if not isinstance(resource_arn, str):
                        continue
                    if not _is_brain_data_bucket_arn(resource_arn):
                        continue
                    if _is_bucket_root(resource_arn):
                        # NN-5 VIOLATION: broad action on bucket root
                        return CheckResult.FAILED
                    if action == "s3:*":
                        # s3:* wildcard on any brain data resource is forbidden
                        return CheckResult.FAILED

        return CheckResult.PASSED


scanner = S3PrefixLeastPrivCheck()
