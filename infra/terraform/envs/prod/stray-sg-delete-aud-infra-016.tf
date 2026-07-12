################################################################################
# AUD-INFRA-016 — stray console SG deletion (two-phase, Terraform-native).
#
# sg-04325983d7354c4a9 "launch-wizard-1" was console-created 2026-07-07 with
# SSH 22 open to 0.0.0.0/0. Re-verified unattached 2026-07-12:
#   aws ec2 describe-network-interfaces --filters \
#     Name=group-id,Values=sg-04325983d7354c4a9  →  []
# No live exposure, but it silently grants world-SSH if ever reused. Terraform
# cannot import-and-destroy in one plan, so:
#
#   PHASE 1 (this file as-is): apply IMPORTS the SG into state. The resource
#     block below intentionally manages ONLY name/description/vpc (ingress/
#     egress on aws_security_group are Optional+Computed — omitted blocks are
#     left untouched), so the only in-place change is the default_tags add.
#   PHASE 2: DELETE THIS ENTIRE FILE — the next apply DESTROYS the SG.
#
# Do NOT keep this file long-term; it exists only to shepherd the deletion
# through the normal plan/apply lane. If the SG was deleted out-of-band first,
# drop this file (the import would fail on a missing id).
################################################################################

import {
  to = aws_security_group.stray_launch_wizard_1
  id = "sg-04325983d7354c4a9"
}

resource "aws_security_group" "stray_launch_wizard_1" {
  # Values MUST mirror the live SG exactly (all three force replacement).
  # NOTE: the SG sits in the account DEFAULT VPC (vpc-09eccb21d72404ce4),
  # NOT the brain-prod VPC (module.network.vpc_id = vpc-06ded56ae87bd2b68) —
  # hence the hardcoded id (verified via describe-security-groups 2026-07-12).
  name        = "launch-wizard-1"
  description = "launch-wizard-1 created 2026-07-07T13:05:52.939Z"
  vpc_id      = "vpc-09eccb21d72404ce4"
}
