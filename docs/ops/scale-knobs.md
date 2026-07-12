# Data-tier scale knobs — pre-agreed 10× responses (AUD-OPS-032, AUD-OPS-010/011)

**Status: DECISION RECORD (Wave-3 scale-infra, 2026-07-12).** Prod's data tier is deliberately
cost-first today (~$81/mo for Aurora + Redis combined). The audit's 10×-target review
(`audit/04-operational-gaps.md`, AUD-OPS-032) found the ceilings are real but the *correct* posture is
to pre-agree the knobs and wire tripwires — NOT to upsize now. This file is that agreement: when a
tripwire fires, the response below is already decided; pull the knob, don't re-litigate.

## 1. Aurora Serverless v2 — ACU ceiling

| | Today | Pre-agreed 10× knob |
|---|---|---|
| Capacity | min 0.5 / **max 2 ACU** (4GB), single writer | `aurora_max_capacity = 8` |
| Where | `infra/terraform/envs/prod/terraform.tfvars` (`aurora_max_capacity`) | same line, one number |
| Cost | ~$67/mo at current load | pay-per-use — ~$0 extra while idle; ceiling only |

- **Tripwire:** CloudWatch alarm `brain-prod-aurora-acu-saturation` (modules/aurora,
  `enable_tripwire_alarms`, default ON): `ACUUtilization >= 80%` avg for 15m. Sustained firing =
  the writer is pinned at the 2-ACU cap → bump `aurora_max_capacity` to 8 and `terraform apply`.
- Why not a Prometheus rule: `ACUUtilization` lives in CloudWatch and **no CloudWatch exporter runs
  in-cluster** — a PromQL rule would be loaded-but-dead (false safety). Same reasoning for Redis below.
- A second `db.serverless` instance (reader/failover, `instance_count = 2`) remains a separate
  availability decision (AUD-OPS-016 — accepted single-writer for now).

## 2. ElastiCache Redis — the entire Trino serving cache

| | Today | Pre-agreed 10× knob |
|---|---|---|
| Node | **1× cache.t4g.micro** (~555MB, no replica) | `node_type = "cache.t4g.small"` (~1.4GB) |
| Where | `infra/terraform/envs/prod/bootstrap.tf` (module "elasticache" `node_type`) | same line |
| Cost | ~$14/mo | +~$14/mo |

- **Tripwires:** CloudWatch alarms (modules/elasticache, `enable_tripwire_alarms`, default ON):
  `brain-prod-redis-evictions-001` (`Evictions` sum > 0 for 15m — working set no longer fits) and
  `brain-prod-redis-memory-001` (`DatabaseMemoryUsagePercentage >= 90%` for 15m). Either firing
  sustained → bump `node_type` micro → small.
- Why this matters more than a normal cache: Redis fronts Trino — the **sole serving engine** with a
  documented OOM history. A cache-miss storm IS a serving outage; evictions are the leading indicator.
- Adding a replica (`num_cache_nodes = 2` → automatic_failover + multi-AZ) stays deferred: the cache
  is rebuildable and the app tolerates a cold cache (AUD-OPS-016 verdict).

## 3. Trino — scale the fleet WITH the cache, not after it

When the Redis knob is pulled (cache grows → more misses initially, more concurrent scans), raise the
worker ceiling alongside: `infra/helm/trino/values-prod.yaml` `workers.autoscaling.maxReplicas: 3 → 4`
(KEDA CPU trigger, trino NodePool limit is 8 CPU = 2 × t4g.xlarge; 4 workers × 2CPU requests fit).
Anything beyond that needs the NodePool `limits` raised too (see AUD-OPS-033 ceiling note in
`infra/helm/karpenter/values.yaml`).

## 4. SPOF replica review (AUD-OPS-010/011 + theme scope)

| Service | Today | Verdict |
|---|---|---|
| **iceberg-rest** | ~~1 replica~~ → **2 replicas** (this wave, `infra/helm/iceberg-rest/values-prod.yaml`) | FIXED. Stateless REST facade over the JDBC catalog (Aurora) — concurrent replicas are safe (Iceberg commits are optimistic-lock CAS at the catalog DB); every Spark job, Trino query and Kafka-Connect commit rides through it, so the single replica was the widest-blast-radius cheap fix. Cost: one more 500m/1Gi pod. |
| **pgbouncer** | 2 replicas (`values-prod.yaml`) | Already HA — no change. |
| **trino coordinator** | 1 replica | ACCEPTED. Trino architecturally runs ONE coordinator (multi-coordinator needs an external resource-manager tier — not warranted). Restart is tolerated: Redis fronts the BFF and in-flight queries simply re-run. Mitigation stays "fast restart + cache", per the values-prod comment. |
| **kafka-connect** | 1 replica | Out of this wave's scope (AUD-OPS-010 alert half → AUD-INFRA-028): idempotent/stateless recovery, task-failure alert rule already loaded (`BronzeConnectTaskFailed`), lag alert (`BronzeConnectLagHigh`) covers the freshness gap. |

## 5. Related tripwires that ARE Prometheus rules

The Spark tier wall-time/failed tripwires (AUD-IMPL-027/AUD-OPS-029) and their DEFINED
k8s-cutover trigger live in `infra/observe/alerts/scale-tripwires.rules.yml` (canonical) ↔
kube-prometheus-stack `additionalPrometheusRulesMap.scale-tripwires`; the stream-worker lag scaling
(AUD-OPS-030) is a KEDA ScaledObject in the stream-worker chart. Those series exist in Prometheus —
the CloudWatch-only series above deliberately do not.
