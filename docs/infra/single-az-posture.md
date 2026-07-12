# Single-AZ availability posture — recorded risk + upgrade triggers (AUD-INFRA-015)

**Status: ACCEPTED RISK, not a defect.** Every item below is a deliberate
ADR-0009 / AUD-PROD-008 cost-first tradeoff, ratified for the current stage
($500/mo budget, pre-revenue prod). This document exists so the tradeoffs are
re-examined at explicit TRIGGERS instead of being rediscovered during an
incident.

## The posture (measured 2026-07-11/12)

| Component | Live shape | Failure behavior |
|---|---|---|
| Aurora PostgreSQL | 1 writer, **no reader** (MultiAZ=false), Serverless v2 0.5–2 ACU | AZ/instance failure ⇒ instance REPLACEMENT: minutes–tens-of-minutes RTO, **no data loss** (storage is 6-way/3-AZ replicated regardless) |
| ElastiCache Redis | 1 node `cache.t4g.micro`, no auto-failover | Node loss ⇒ cache gone until rebuilt; **rebuildable serving cache**, Trino is the SoT — degraded latency, not data loss |
| Egress NAT | single fck-nat `t4g.nano` `aws_instance` (`modules/nat-instance`) — **plain instance, NO ASG**: nothing auto-replaces it | Instance/AZ loss ⇒ ALL private-subnet egress dies: connector syncs, outbound webhooks, SSM agent, public-API calls. S3 + ECR ride gateway/interface endpoints and KEEP WORKING |
| Kafka (Strimzi) | 3 brokers, but PVCs gp3 in whatever AZ each broker landed | broker AZ loss ⇒ under-replicated until reschedule; topic RF governs data safety |

Separate HYPOTHESIS from the audit, kept honest: `t4g.nano` baseline is
~32 Mbit/s sustained (burstable) — large connector backfills MAY throttle on
egress. Unproven; S3/ECR (the big movers) bypass the NAT via endpoints.

**NAT recovery today (no ASG — manual):**

1. Confirm: `aws ec2 describe-instances --filters Name=tag:Name,Values=*nat*` +
   private-subnet egress failing (connector runs erroring on non-AWS hosts).
2. Recover with terraform: `terraform apply -replace=module.nat_instance.aws_instance.nat`
   (envs/prod). The EIP + route-table entries re-associate via
   `aws_eip_association` / `aws_route` on the new ENI.
3. Expect minutes of egress outage; collector INGEST is unaffected (ALB is
   inbound), and spool/drainer absorbs downstream hiccups — no event loss.

## Upgrade triggers (re-open ADR-0009 when ANY fires)

| Trigger | Action | Rough cost delta |
|---|---|---|
| Real tenant revenue depends on prod dashboards/decisions | Add an Aurora READER in a second AZ (failover target ⇒ RTO seconds–minutes) | ~2x Aurora instance-hours |
| A connector backfill demonstrably saturates egress (throttled syncs, provider timeouts while NAT CPU/credits pegged) | Bump fck-nat to `t4g.micro`/`t4g.small` (`modules/nat-instance` `instance_type`) | ~$3–12/mo |
| Second NAT-loss incident, or SSM/private-only API access depends on NAT (post AUD-INFRA-008 close-out it DOES) | Wrap fck-nat in an ASG (min=max=1) for auto-replacement, or flip `enable_nat_gateway=true` (managed, HA) and drop the instance | ASG: ~$0; managed NAT: ~$35+/mo + data |
| Sessions/carts actively breaking on cache loss | 2-node Redis with auto-failover (`num_cache_nodes = 2` — the module then enables multi-AZ/failover) | ~2x cache spend |

Everything here is a terraform-side change in `infra/terraform/envs/prod` +
modules; no application change required by design.
