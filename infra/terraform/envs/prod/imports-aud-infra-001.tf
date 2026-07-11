################################################################################
# AUD-INFRA-001 one-time imports — DELETE THIS FILE after the first successful
# `terraform apply` of the elasticache SG rule conversion.
#
# The network module's inline elasticache SG rules became standalone
# aws_vpc_security_group_*_rule resources (see modules/network/main.tf). The
# physical rules already EXIST in prod (created by the old inline blocks), so
# the first plan must IMPORT them — without these blocks the create would fail
# with InvalidPermission.Duplicate. Rule ids captured live 2026-07-12 via
# `aws ec2 describe-security-group-rules` on sg-0b7dbe1cb6c2eaa10
# (brain-prod-elasticache).
#
# ORDERING: this apply MUST precede any other envs/prod terraform apply — the
# pre-fix plan's only pending change is the silent revoke of the
# Redis-from-EKS-cluster-SG rule (guaranteed prod cache outage).
################################################################################

import {
  to = module.network.aws_vpc_security_group_ingress_rule.elasticache_redis_from_eks_nodes
  id = "sgr-08a5d1761fbc1c211"
}

import {
  to = module.network.aws_vpc_security_group_egress_rule.elasticache_all_outbound
  id = "sgr-0a0b80119eda9986e"
}
