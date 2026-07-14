################################################################################
# Brain – Prod Observability wiring (ADR-0004 OE-2)
#
# The Well-Architected review (OE-2) found module.observability is invoked in
# dev/staging main.tf but NOT in prod — so the composite EKS-unhealthy
# safety-net alarm, the per-service CloudWatch log groups, the CrashLoopBackOff
# metric filter, and the OTel-collector IRSA role were all DEAD CODE in prod.
# This file wires the SAME module the dev/staging roots call, with the same
# inputs, resolving OE-2 explicitly ("wire module.observability into prod").
#
# NOTE — log-group name collision: modules/observability creates the
# /aws/eks/<cluster>/cluster group (retention 365) AND envs/prod already ADOPTS
# that live group via import in log-retention-aud-infra-014.tf (retention 30/14).
# To avoid a duplicate-resource clash, this module is invoked with
# manage_eks_audit_log_group=false so the env-level import stays the single
# owner of that group; observability owns only the per-service /brain/prod/*
# groups + the alarms + IRSA.
#
# The composite EKS-unhealthy alarm is PAGED by passing the alerting SNS topic
# (module.alerting.sns_topic_arn) — the fix for OE-1 "nothing pages anyone".
################################################################################

module "observability" {
  source            = "../../modules/observability"
  environment       = local.environment
  project           = local.project
  kms_key_arn       = module.kms.root_kms_key_arn
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url
  cluster_name      = module.eks.cluster_name

  # OE-2 collision guard: the EKS control-plane log group is owned by the
  # env-level import (log-retention-aud-infra-014.tf) so this module must not
  # also declare it. See var docs in modules/observability.
  manage_eks_audit_log_group = false

  # OE-1: page the composite EKS-unhealthy alarm to the actionable SNS topic.
  alarm_sns_topic_arn = module.alerting.sns_topic_arn
}

output "otel_collector_role_arn" { value = module.observability.otel_collector_role_arn }
output "eks_unhealthy_composite_alarm_arn" { value = module.observability.composite_alarm_arn }
