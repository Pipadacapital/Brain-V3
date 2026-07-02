"""
Custom Checkov check: NN-4 — S3 Object Lock must be COMPLIANCE mode + 7yr
on purpose=audit buckets.

AUD-COST-016: "bronze" is no longer a protected purpose — the bronze bucket is
the Iceberg medallion warehouse, and Object Lock is incompatible with Iceberg
MERGE/compaction, the raw-PII row-TTL DELETE (AUD-PERF-003) and DPDP/GDPR
right-to-erasure. WORM retention lives on the audit bucket only (this check
still validates ANY aws_s3_bucket_object_lock_configuration, i.e. the audit
bucket's — the purpose-tag scoping is the OPA rule's job).
"""
from __future__ import annotations

from typing import Any

from checkov.common.models.enums import CheckResult, CheckCategories
from checkov.terraform.checks.resource.base_resource_check import BaseResourceCheck


class S3ObjectLockComplianceCheck(BaseResourceCheck):
    """
    NN-4: S3 Object Lock must be COMPLIANCE mode (not GOVERNANCE) with 7-year
    retention on buckets tagged purpose=audit (bronze exempted — AUD-COST-016).
    GOVERNANCE mode can be bypassed by s3:BypassGovernanceRetention — not acceptable.
    Object Lock retention < 7 years does not satisfy the legal/audit requirement.
    """

    def __init__(self):
        name = "NN-4: S3 purpose=audit must use Object Lock COMPLIANCE mode + 7yr retention"
        id = "CKV_BRAIN_2"
        supported_resources = ["aws_s3_bucket_object_lock_configuration"]
        categories = [CheckCategories.ENCRYPTION]
        super().__init__(name=name, id=id, categories=categories, supported_resources=supported_resources)

    def scan_resource_conf(self, conf: dict[str, Any]) -> CheckResult:
        # This check validates the configuration resource.
        # The bucket tag check (purpose=audit) is enforced at the plan level
        # via the OPA conftest rule; here we validate the lock configuration itself.

        rules = conf.get("rule", [])
        if not rules:
            # No rule = no default retention = FAIL for any lock config
            return CheckResult.FAILED

        for rule in rules:
            if isinstance(rule, list):
                rule = rule[0] if rule else {}

            retentions = rule.get("default_retention", [])
            if not retentions:
                return CheckResult.FAILED

            for retention in retentions:
                if isinstance(retention, list):
                    retention = retention[0] if retention else {}

                mode = retention.get("mode", [""])[0] if isinstance(retention.get("mode"), list) else retention.get("mode", "")

                # NN-4: Must be COMPLIANCE
                if mode != "COMPLIANCE":
                    return CheckResult.FAILED

                # NN-4: Must be 7 years (specified in years, not days)
                years = retention.get("years")
                if isinstance(years, list):
                    years = years[0] if years else None

                if years is None:
                    # Days specified instead of years — also check
                    days = retention.get("days")
                    if isinstance(days, list):
                        days = days[0] if days else None
                    if days is None or int(days) < (7 * 365):
                        return CheckResult.FAILED
                elif int(years) < 7:
                    return CheckResult.FAILED

        return CheckResult.PASSED


scanner = S3ObjectLockComplianceCheck()
