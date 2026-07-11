################################################################################
# Brain – prod DNS + TLS under IaC (AUD-INFRA-005)
#
# The brain.pipadacapital.com hosted zone and the ACM certificate the three
# public ingresses terminate on existed ONLY in the live account (console-
# created at go-live): no IaC definition, no state, no recreate path — an
# account rebuild would silently break web/core/collector ingress TLS.
# These resources adopt the EXISTING zone + cert via the one-shot import
# blocks in imports-aud-infra-005.tf (state-only; never mutates AWS).
#
# POST-IMPORT INVARIANT: `terraform plan` must show NO changes to these two
# resources other than tag additions (provider default_tags — in-place).
# If the plan wants to REPLACE aws_acm_certificate.brain on
# subject_alternative_names (provider versions disagree on whether the primary
# domain is echoed into the SAN set), reconcile the list to what the plan
# reports as the current state — NEVER apply a plan that replaces the cert:
# the hard-coded ARN in the 3 values-prod files would dangle and all three
# ingresses would fail TLS.
#
# The certificate ARN output below is the DOCUMENTED SOURCE for the
# `alb.certificateArn` fills in:
#   infra/helm/web/values-prod.yaml
#   infra/helm/core/values-prod.yaml
#   infra/helm/collector/values-prod.yaml
#
# NOTE: a second, SUPERSEDED cert exists in the account
# (arn:…:certificate/5247056b-…, px+app+api only — lacks the apex, InUse=false).
# It is deliberately NOT imported; delete it manually once the imported cert is
# confirmed as the only one referenced (housekeeping, not IaC).
################################################################################

resource "aws_route53_zone" "brain" {
  name    = "brain.pipadacapital.com"
  comment = "Brain prod subdomain - external-dns managed"

  # The zone holds the delegated NS set + all external-dns-managed records;
  # destroying it is an outage of every public hostname. Deletion must be a
  # deliberate two-step (remove this guard first).
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_acm_certificate" "brain" {
  domain_name       = "brain.pipadacapital.com"
  validation_method = "DNS"
  key_algorithm     = "RSA_2048"

  # Captured live 2026-07-12 via `aws acm describe-certificate` on
  # …certificate/684f6184-f357-46ca-8ef9-3be62239c220 (ISSUED, covers apex +
  # the 3 service hosts — the prior 5247056b cert lacked the apex).
  subject_alternative_names = [
    "app.brain.pipadacapital.com",
    "api.brain.pipadacapital.com",
    "px.brain.pipadacapital.com",
  ]

  options {
    certificate_transparency_logging_preference = "ENABLED"
  }

  lifecycle {
    prevent_destroy = true
    # If a legitimate SAN change is ever needed, issue the new cert before the
    # old one disappears so the ingresses can be repointed without a TLS gap.
    create_before_destroy = true
  }
}

# The Brain zone id also feeds var.external_dns_zone_ids (terraform.tfvars) —
# keep the tfvars value in lockstep with this output.
output "brain_route53_zone_id" { value = aws_route53_zone.brain.zone_id }
output "brain_route53_name_servers" { value = aws_route53_zone.brain.name_servers }
output "brain_acm_certificate_arn" { value = aws_acm_certificate.brain.arn }
