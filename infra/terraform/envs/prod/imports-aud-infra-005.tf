################################################################################
# AUD-INFRA-005 one-time imports — DELETE THIS FILE after the first successful
# `terraform apply` that adopts the Route53 zone + ACM certificate into state.
#
# Same one-shot pattern as imports-aud-infra-001.tf: the physical resources
# already EXIST in prod (console-created at go-live); these blocks adopt them
# into state so dns.tf manages them from now on. `terraform import`/import{}
# is state-only — it NEVER mutates AWS.
#
# Ids captured live 2026-07-12 (read-only):
#   aws route53 get-hosted-zone --id Z00011362R9ERGL7EC2J9
#     → brain.pipadacapital.com., 20 record sets
#   aws acm describe-certificate --certificate-arn …/684f6184-…
#     → ISSUED, DNS-validated, RSA-2048, SANs = apex + app + api + px
#
# VERIFY: the post-import plan must show NO changes to these resources beyond
# provider default_tags additions (see the invariant note in dns.tf).
################################################################################

import {
  to = aws_route53_zone.brain
  id = "Z00011362R9ERGL7EC2J9"
}

import {
  to = aws_acm_certificate.brain
  id = "arn:aws:acm:ap-south-1:380254378136:certificate/684f6184-f357-46ca-8ef9-3be62239c220"
}
