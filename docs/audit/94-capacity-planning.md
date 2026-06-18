# Capacity Planning

Scaling thresholds, the binding bottleneck at each milestone, and the required action. Synthesized from the Scalability + Cost board (10), with reliability (09) and database (04) inputs. Brand counts assume the product's brand-growth trajectory.

---

## The binding bottlenecks, in the order they bite

1. **Continuous ingest scheduler** (single-instance, sequential, re-pulls every connector every 45s tick, no shard/lease) — *first* to fail.
2. **Per-connector Pool + Kafka producer churn** (new pool/producer per dispatch) — compounds (1).
3. **Postgres as the Bronze + ledger sink** (unbounded, no partitioning/retention) — *first cost wall*.
4. **GUC-set-before-every-query** (2× statement load) + tiny un-pooled connection limits.
5. **8 consumer groups re-reading the whole live topic** (~6× consumption CPU).

---

## Thresholds & actions

| Brands / connectors | What breaks | Detail | Required action |
|---|---|---|---|
| **~100** (≈100–200 connectors) | Ingest tick crosses the 45s SLA | Tick ≈ Σ per-connector HTTP time ≈ ~300s at 100 connectors (7× over SLA); `inFlight` guard silently degrades near-real-time to multi-minute reconciliation fleet-wide. A second replica does **not** help — no claim/lease/shard (RISK-011). | **Re-architect ingest to a work-queue** with claim/lease/shard + leader election. Shared pool + Kafka producer (RISK-012). This is a *pre-100-brand* blocker, not a far-horizon optimization. |
| **~500** | Postgres OLTP becomes the cost + contention wall | bronze_events + ledgers grow unbounded in OLTP with no partitioning/retention (RISK-033); GUC round-trips double statement load (RISK-034); fixed pools (max 3/5/10) with no pooler saturate under BFF fan-out (RISK-036). Noisy-neighbor: no statement_timeout, no per-tenant quota. | **Tier Bronze off OLTP** (Iceberg or at minimum partitioned + retention'd Postgres with archival); add **PgBouncer** + a `max_connections` plan; add `statement_timeout` + per-tenant query budget. Begin C1 lakehouse migration (gets harder the longer it waits). |
| **~1,000** | Event-processing CPU + connection ceiling | 8 consumer groups in one process each deserialize the full live topic (~6× waste) → CPU-bound, lag risk on the billable live path (RISK-035); 12-partition topic caps per-group parallelism; scaling core replicas exhausts Postgres connections with no pooler. | **Split consumer groups** to filtered topics or dedicated processes; raise partition count with the per-ordering-unit key fix (RISK-028); horizontal core scaling **only after** the pooler lands. The C1/C2 ingest re-architecture and H2/H4 DB tiering are **pre-1k-brand blockers**. |
| **~5,000** | Lakehouse + analytics tier mandatory | Postgres-as-Bronze is untenable (storage cost, vacuum, no S3 export, no compaction); StarRocks isolation still rests on a single app seam with no engine row policy (RISK-024); per-connector secret/salt fetches (~2.6k/min at 1k connectors) hit secrets-manager rate limits (cost board M). | Iceberg lakehouse must be **live** (C1 done); managed StarRocks with **engine row policies**; memoize salt/token fetches; partition + retention enforced; cost dashboard + per-tenant DB/LLM budgets operational. |
| **~10,000** | The system as architected does not reach this | The continuous scheduler "never completes" at 10k (cost board's own words); single-process consumer fleet, OLTP Bronze, and no per-tenant fairness make this milestone unreachable on the current footprint. | Full sharded ingest fleet, partitioned topic-per-ordering-unit catalogue, lakehouse SoR, managed OLAP with row policies, connection pooler, and per-tenant quotas — i.e. the deferred Phase-3 architecture must be **built**, not documented. |

---

## Cost trajectory

| Driver | Current state | Cost behavior | First inflection |
|---|---|---|---|
| **Storage** | Bronze + ledgers in OLTP Postgres, no retention | OLTP-grade $ for object-store-grade data; monotonic growth + autovacuum lag | **~500 brands** — forces costly under-load migration before 1k |
| **DB compute** | GUC round-trip per query (2× statements); 8 groups × full-topic deserialize (~6×) | Doubled statement throughput + ~6× consumer CPU baked in | Compounds from day one; acute at ~1k |
| **LLM** | Defaults to Opus (Tier-4) while labelled Tier-3; no prompt-cache markers; no per-tenant cap | 1–2 orders of magnitude over budget per call; one tenant looping NLQ is unbounded | **Immediately** on any real NLQ traffic (RISK-047) |
| **Secrets/KMS** | Per-connector salt+token fetched in hot loop, no caching | ~2,667 reads/min at 1k connectors → direct $ + rate-limit pressure | ~1k connectors |
| **Connections** | Connect+TLS per connector run; no pooler | Fixed overhead dwarfs the actual sync work | Any concurrency fix without a pooler |

**Cost guardrails not yet built (required before scale, per `cost-routing-paradigms`):** effort-tier declarations are JSDoc-only with no runtime wrapper/CI gate; no cost-mix dashboard; no per-tenant LLM spend cap (gateway virtual-key budget); no litellm gateway config in repo. The doctrine's "measure from day one" phase-gate is unmet — these must be live *before* the highest-model-cost feature ships, and the model call currently mis-routes to Opus.

## Headroom summary

The data-plane **correctness** primitives (RLS design, idempotent Bronze, overlap locks, isolated backfill lane) are solid, but the **scaling envelope was not built to match the brand-growth ambition.** Realistic ceiling on the current footprint: **~100 brands** before the ingest scheduler breaches SLA, **~500** before the Postgres cost wall, and the architecture **does not reach 5k–10k** without the deferred work-queue + lakehouse + pooler + managed-OLAP re-architecture. None of these are far-horizon — C1/C2 and H2/H4 are **pre-1k-brand blockers.**
