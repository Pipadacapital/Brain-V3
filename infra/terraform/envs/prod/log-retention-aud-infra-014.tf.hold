################################################################################
# AUD-INFRA-014 — CloudWatch log-group retention adoption.
#
# EKS auto-creates /aws/eks/brain-prod/cluster (all 5 control-plane log types,
# modules/eks enabled_cluster_log_types) and RDS auto-creates the Aurora
# postgresql export group — BOTH outside Terraform, BOTH retention=never-expire
# (verified 2026-07-12: 727 MB in 4 days on the EKS group ≈ 5.5 GB/mo ingest,
# storage compounding forever). No drift guard could cover them because no TF
# resource existed.
#
# Fix: ADOPT the live groups via import blocks + set a 30-day retention.
# The import is idempotent — once the groups are in state the blocks no-op, so
# (unlike imports-aud-infra-001.tf) this file is permanent config, not a
# delete-after-apply shim. First plan shows: 2 imports + 2 in-place updates
# (retention + tags). No KMS is attached (the auto-created groups are
# SSE-default; adding a CMK would also need a logs-service key-policy grant).
################################################################################


# ADR-0004 / 07 cost trim: EKS control-plane logs are OPERATIONAL (api/audit/
# authenticator/controllerManager/scheduler), not a compliance store — the
# tamper-evident audit-of-record is CloudTrail -> the WORM bucket (7yr,
# immutable). At ~5.5 GB/mo ingest, dropping 30d -> 14d roughly halves the
# retained volume with no compliance impact. Bump back to 30 for a deep incident
# forensics window if needed.
resource "aws_cloudwatch_log_group" "eks_cluster" {
  name              = "/aws/eks/${module.eks.cluster_name}/cluster"
  retention_in_days = 14

  tags = {
    purpose = "eks-control-plane-logs"
  }
}


resource "aws_cloudwatch_log_group" "aurora_postgresql" {
  # Name mirrors modules/aurora cluster_identifier = brain-prod-postgres.
  name              = "/aws/rds/cluster/${local.project}-${local.environment}-postgres/postgresql"
  retention_in_days = 30

  tags = {
    purpose = "aurora-postgresql-logs"
  }
}
