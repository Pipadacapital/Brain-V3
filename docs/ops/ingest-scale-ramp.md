# Ingest scale ramp — on-demand growth triggers (ADR-0015)

Owner directive: infra grows WITH traffic (60 brands onboarding over ~8 months, ~40K events/sec
by month-8), never ahead of it. This runbook records WHAT to change, WHEN (measurable trigger),
and the rough cost step — so each scale-up is a deliberate, auditable values/tfvars change.

Baseline (today): partitions 12 · Strimzi 3 brokers · collector HPA 2→24 · stream-worker 1→3
(job-runner) · collector-lane log retention 48 h · Bronze collector TTL 15 d · Intelligent-Tiering
on the warehouse (day-0 transition; NEVER add Glacier lifecycle tiers — async restore breaks
catalog-referenced reads, see `infra/terraform/modules/s3-iceberg/main.tf`).

| Lever | Change | Trigger (measured, sustained) | Notes |
|---|---|---|---|
| **Collector fleet** | nothing — HPA 2→24 already covers the ramp | p99 ACK > 50 ms at p95 CPU < 70% → raise maxReplicas | Stateless; scales diurnally on its own. |
| **Topic partitions** | 12 → 24 → 48 (`strimzi-kafka` `topics.partitions`; RAISE the 6..12 template guard in `templates/kafka-topics.yaml` in the SAME PR) | per-partition ingress > ~3 MB/s sustained 1 h, OR consumer lag grows at stable throughput (~10K ev/s total at 1 KB) | Increase-only in Kafka. Per-brand ordering shifts once at the boundary — safe: identity is order-independent (deterministic canonical). Hot single brand → composite key `brand_id:bucket` for that brand (ADR-0015 §5.3). |
| **Broker capacity** | t4g.large → xlarge → +disk (strimzi values) | broker disk > 60% with 48 h retention, OR sustained ingress > ~15 MB/s per broker | RF=3 stays. Rack-awareness stays (cost-guard protected). |
| **Kafka Connect tasks** | collector sink `tasks.max` 2 → partitions/2 | sink commit lag > 2× commit interval | Scales with partitions, not before. |
| **stream-worker** | stays 1→3 — it is a job-runner now | pull-job overlap starves the cron window | Live-lane scaling is GONE by design (ADR-0015); do not re-add KEDA lag scaling here. |
| **Silver/Gold retention** | enable Silver 30 d / Gold 12 mo row-TTL | ONLY after `GOLD_INCREMENTAL` is validated (append-mode marts) | A Silver trim before append-mode Gold silently shrinks recomputed history. Until then Silver is keep-all (small at current scale). |
| **Redpanda swap** (owner-ratified direction) | replace Strimzi with Redpanda, Kafka wire unchanged | when broker count would grow past 3, OR JVM/operator ops burden becomes real — NOT before | Do compose-first spike, then staging soak. Touches cost-guard R-checks (Kafka rack-awareness rule) — amend the guard in the same PR. Clients/Connect unchanged (wire-compatible). |
| **Aurora / Redis / EKS** | unchanged by ADR-0015 | — | Spool removal REDUCED PG write load; no ingest-driven scale-up expected. |

Cost posture: each step is +$50–300/mo; the month-8 steady state lands ~$1.3–1.6K/mo
(owner-accepted estimate, 2026-07-17). Storage stays Intelligent-Tiering + row-TTL —
the tiering decision is automatic, the retention decision is explicit values.

Change process: every lever above is a values/tfvars PR → release → promotion; never a
live `kubectl edit`. Verify after each partition step: producer p99, consumer lag, Connect
file sizes (small-file regression = commit interval too short for the new partition count).
