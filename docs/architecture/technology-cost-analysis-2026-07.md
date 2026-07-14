# Brain V4 — Technology & Cost Analysis (architecture-invariant)

**Date:** 2026-07-14 · **Author:** platform review · **Constraint:** the *architecture*
is FIXED (medallion Bronze/Silver/Gold on Iceberg; real-time Kafka-Connect Bronze
landing; Spark transform; Trino+cache serving; PG operational; Neo4j identity;
EKS orchestration; LLM-gateway agentic layer). This document evaluates ONLY the
**technology** filling each architectural slot — no slot is added, removed, or
re-wired. Every recommendation preserves: *Capture Truth → Build Trust → Enable
Decisions*, real-time ingest, medallion, analytics, predictions, and agentic.

---

## 1. Scale we are designing for (make this explicit)

Two independent axes — do not conflate them:

| Axis | T0 — Today (~10 brands) | T1 — Growth (~50 brands) | T2 — Target/M4 (~100 brands) |
|---|---|---|---|
| **Ingest events/day** | 100k–1M (~1–12/s avg, flash-sale bursts ~500/s) | 5–10M (~60–120/s, bursts ~1k/s) | 10–50M (~120–600/s, bursts ~2k/s) |
| **Serving reads/day** (dashboard/API) | ~1M (mostly cache-served) | ~5M | ~10–20M |
| **Iceberg row volume** | low millions | tens of millions | low billions (cumulative) |
| **Concurrent dashboard users** | tens | low hundreds | hundreds |

**The single most important fact:** at T0–T1 Brain's *data* is small (millions of
rows), but the *stack* is distributed-big-data (Spark, Trino, Kafka, Neo4j — all
always-on). Most cost and most operational pain (Trino OOM, Spark OOM, Neo4j
throughput ceiling — all in the incident history) come from **that mismatch**, not
from wrong engine choices. So the theme is: **keep the architecture, right-size the
technology, and swap only where a lighter engine fills the same slot better.**

---

## 2. Current cost baseline (ap-south-1, est., credits masking real cash)

| Slot | Technology + prod sizing | Est. $/mo (T0) | Notes |
|---|---|---|---|
| Orchestration control plane | EKS **1.33** (AL2023, STANDARD support) | **$73** | ✅ upgraded 2026-07-12 — the former ~$360/mo extended-support fee is already GONE; `eks_support_type=STANDARD` guards against re-drift |
| System node group | 3× t4g.medium on-demand | ~$73 | control/system pods |
| Ingest bus | Kafka (Strimzi) 3 brokers, 1 vCPU/5Gi, **on-demand** + 3×50Gi gp3 | ~$160–200 | on-demand pin = +~$100 vs spot (post 07-12 quorum-loss incident) |
| Bronze sink | Kafka Connect ×1 (250m/1.8Gi) | bin-packs | sole Bronze landing writer |
| Transform | Spark crons, **local[*]** 6g driver, Spot batch pool | ~$20–40 | ephemeral (only during cron runs) |
| Serving query | Trino: 1 coord (on-demand, co-packed) + workers KEDA **min 1 / max 3** (Spot t4g.xlarge) | ~$40–110 | baseline 1 warm worker; bursts to 3 under load |
| Serving cache | ElastiCache **Valkey 8.0** 1× t4g.micro | ~$11 | just swapped from Redis (−20%) |
| Operational DB | Aurora PostgreSQL **Serverless v2**, 0.5–2 ACU, 1 writer | ~$67 | pay-per-use, bursty-fit |
| Identity | Neo4j **Community** 1 node, 3 CPU/4Gi/2g heap, 50Gi | co-packed on-demand | ADR-0004 SoR |
| Egress | fck-nat (~$4) + 2 VPC interface endpoints (~$14) | ~$18 | NAT-GW deferred |
| Observability | OTel → Grafana Cloud | usage | free-tier-ish at T0 |
| Agentic | LiteLLM gateway → Anthropic Haiku/Sonnet 4.5 (+OpenAI fallback), Opus for NLQ | usage, $20/brand cap | per-tenant budget caps |
| **Total infra** | | **~$450–550/mo** | EKS extended-support fee already removed; the remaining big lines (Kafka on-demand, Trino) are each already at their safe floor |

---

## 3. Per-slot technology analysis

Legend: **KEEP** (right tech, leave it) · **RIGHT-SIZE** (keep tech, cut cost) ·
**PILOT/SWAP** (a lighter tech fills the slot better) · **HOLD** (fine now, decision
point later).

---

### 3.1 Real-time ingest bus — Kafka (Strimzi on EKS) + Kafka Connect Iceberg sink

- **Role:** the real-time Bronze-landing backbone. Append-only, replayable,
  brand_id-keyed, ordered per partition. Underwrites "no event loss" and feeds the
  agentic/real-time surfaces.
- **Alternatives in the same slot:** MSK Serverless, MSK Provisioned, Confluent Cloud, Redpanda.
- **Cost, crystal clear:**
  - Self-managed Strimzi today ≈ **$160–200/mo** (3 on-demand broker nodes + gp3).
  - **MSK Serverless base = $0.75/hr/cluster ≈ $547/mo** *before* partition
    ($0.0015/hr each) and $0.10/GB traffic — **3× more expensive than today** at
    Brain's throughput, and Brain already owns the EKS capacity.
  - Confluent Cloud: lowest tier competitive but adds per-partition + egress; not cheaper at this volume.
- **Pros of staying self-managed:** cheapest at steady low volume; full control
  (ACLs, schema registry, Connect co-located); no per-GB egress tax.
- **Cons:** you run the brokers; the 07-12 Spot-reclaim quorum loss forced the
  on-demand pin (+~$100/mo); ops burden grows with scale.
- **Scale fit:** self-managed on Graviton spot scales cleanly to T2 (10–50M/day is
  well under one broker's capacity; 3 brokers is for HA, not throughput).
- **✅ Recommendation: KEEP (self-managed Strimzi) — already cost-optimal within its
  safety envelope. Do NOT re-spot the brokers.** MSK Serverless is decisively more
  expensive here. Two levers were considered; **both are already resolved**:
  - **Spot for brokers — REJECTED with cause.** Tried on 2026-07-12; it **broke KRaft
    quorum 3× in ~40 min** (ap-south-1a t4g spot is volatile). A PDB `minAvailable=2`
    was in place and did **not** prevent it — spot reclaims are *involuntary* and
    bypass PDBs. Brokers are deliberately pinned to on-demand (~+$100/mo) because "no
    event loss" is a core rule. Re-spotting re-introduces a known, thrice-repeated
    outage — not worth ~$100/mo. (An earlier draft wrongly proposed a PDB-guarded
    re-spot; the PDB approach had already been tried and failed.)
  - **Broker node right-size — ALREADY DONE.** Broker resources (1 vCPU / 5Gi req,
    3Gi heap) are already sized so Karpenter picks the *cheaper* t4g.large, not xlarge.
  - **Net safe saving available: ~$0** — Kafka is already at its cost floor given the
    reliability contract.

---

### 3.2 Medallion table format — Apache Iceberg + REST catalog

- **Role:** system of record for Bronze/Silver/Gold on S3. The open format is *what
  makes every other engine swap cheap* (store once, query with the cheapest engine).
- **Alternatives:** Delta Lake, Hudi. **Cost:** format is free either way.
- **✅ Recommendation: KEEP — non-negotiable.** Iceberg V3 is GA across DuckDB,
  Spark, Trino, Flink (2026); its engine-agnosticism is the strategic asset that
  makes §3.4 (DuckDB pilot) possible without touching storage. No reason to move to
  Delta/Hudi (would re-tie you to a narrower engine set). Keep the REST catalog.

---

### 3.3 Object storage — S3

- **✅ Recommendation: KEEP.** Add **S3 lifecycle → Intelligent-Tiering** on the
  Bronze warehouse prefix (Bronze is append-only and rarely re-read after Silver
  folds it). At T2's billions of rows this is a real cumulative saving; at T0 it's
  pennies but free to set now. Low effort, set-and-forget.

---

### 3.4 Transform compute — Apache Spark (Silver/Gold) ⭐ THE LEVER

- **Role:** the sole TRANSFORM compute — Silver canonicalization, Gold marts,
  Bronze maintenance/retention/erasure.
- **Critical finding:** prod Spark runs in **`local[*]` single-node mode** (6g
  driver, no distributed executors). **It is already a single JVM process** — you
  are paying Spark's cluster-grade overhead (JVM startup, Catalyst, shuffle
  machinery, OOM-proneness) for a single-node workload on *millions* of rows.
- **Alternative in the same slot:** **DuckDB** (or Polars) — single-process,
  in-memory, native Iceberg read + write (v1.5+ INSERT/UPDATE/DELETE/MERGE).
- **Cost/perf, crystal clear (2026 benchmarks):**
  - DuckDB is **10–100× faster** than Spark on <100GB data and shows up to **~98%
    cost reduction** for small-to-mid ETL — because it drops the shuffle/serialization/JVM overhead Spark pays for parallelism you don't use.
  - A single $200–400/mo NVMe VM (or your existing batch node) holds hundreds of GB
    of Parquet and serves as a high-throughput transform node.
- **Pros of swapping:** kills the recurring Spark OOM class; far faster cron
  wall-time; simpler ops (a Python/CLI process, no Spark session tuning); cheaper
  batch nodes. **Same Iceberg tables, same medallion, same Argo cron slot.**
- **Cons / risks:** DuckDB Iceberg *write*/catalog-commit maturity is newer than
  Spark's battle-tested path; you must **re-validate parity** on every migrated mart
  (Brain has parity-lock discipline already); very large future joins (T2 billions)
  may still favor Spark. UDF-heavy Silver logic (`_silver_technical`, `_customer_360`)
  needs a Python port.
- **Scale fit:** DuckDB comfortably covers T0–T1 and most of T2. Keep Spark
  available for any genuinely distributed job that emerges.
- **🔬 Recommendation: PILOT DuckDB on one Silver→Gold mart, measure, then migrate
  incrementally.** Because Spark is *already local-mode*, this is a low-architecture-
  risk swap that fills the exact same slot. Keep Spark for Bronze
  maintenance/erasure until DuckDB parity is proven per-mart. **This is the highest-
  upside move in this document** (cost + the OOM pain + agentic/prediction pipelines
  get a faster, cheaper feature-fold engine).

---

### 3.5 Serving query engine — Trino over Iceberg

- **Role:** the multi-tenant serving engine behind `brain_serving.mv_*`, fronted by
  the Valkey cache, with the `${BRAND_PREDICATE}` isolation seam.
- **Current sizing (corrected):** 1 coordinator (on-demand, co-packed w/ Neo4j) +
  workers **scaled by KEDA `min 1 / max 3`**. NOTE: `replicaCount: 3` in the values
  is **inert** — when KEDA is enabled the worker Deployment omits static replicas, so
  the **baseline is 1 warm worker**, not 3. There is no "3 always-on" to cut; the only
  knob is `maxReplicas` (the burst ceiling).
- **Alternatives:** StarRocks (benchmarks: **5.5× faster on Iceberg, ~66% less
  compute**), ClickHouse, DuckDB-as-server.
- **Why not swap despite StarRocks being faster:** StarRocks was **deliberately
  removed** from Brain (ratified) in favor of Trino-over-Iceberg + Redis cache;
  re-introducing it reopens a closed decision and re-adds a MySQL-protocol serving
  DB the naming-guard now forbids. At Brain's QPS the cache absorbs the hot path
  anyway — the speed delta rarely materializes.
- **✅ Recommendation: KEEP Trino as-is; DO NOT blindly cut `maxReplicas`.** The
  baseline is already 1 warm worker (KEDA), so there is no easy static saving. Cutting
  `maxReplicas 3 → 2` would cap the **sole serving engine** (which has an OOM history)
  under burst load → *fewer* workers absorb the same queries → *higher* per-worker
  memory pressure → *more* OOM risk. That is the wrong direction to cut blind. The
  correct path: let the new `serving_cache_requests_total` hit-rate metric collect a
  few days; **if** hit-rate is high AND worker utilization sits near-idle even during
  refresh, *then* lower `maxReplicas` on evidence. **Safe immediate saving: ~$0**
  (baseline is already minimal). Revisit StarRocks *only* if a genuine
  high-concurrency, cache-miss-heavy workload appears at T2 (additive lane, not a
  rip-out).

---

### 3.6 Serving cache — Valkey 8.0 (was Redis 7.1) ✅ DONE

- **Done this session** (#144/#145 merged). ~20% cheaper per node-hour, drop-in
  Redis-7 compatible (zero app change), better per-key memory efficiency (fits more
  working set on the same t4g.micro → defers the micro→small knob).
- **✅ Recommendation: COMPLETE.** Run the CLI migration per
  `docs/ops/valkey-migration.md` when ready (endpoint DNS unchanged; online).

---

### 3.7 Operational store — Aurora PostgreSQL Serverless v2

- **Role:** the `ops` schema — identity/journey export, ML inference log, connector
  instances, audit, stitch shim. Operational-only (analytics live on Iceberg).
- **Current:** Serverless v2, 0.5–2 ACU, 1 writer, ~$67/mo.
- **Cost analysis:** Serverless v2 at $0.12/ACU-hr wins **only** when peak/average is
  bursty (>3×) — which is exactly Brain's profile (OAuth/token writes spike during
  flash sales, idle otherwise). A provisioned db.r6g.large would be ~$120–211/mo
  flat; Brain's 0.5–2 ACU pay-per-use is **cheaper for this workload**.
- **✅ Recommendation: KEEP — already optimal.** Do **not** set min ACU to 0
  (auto-pause) — the ops DB holds constant pgbouncer connections, so it would never
  pause and you'd only add cold-start latency risk. The pre-agreed 10× knob (max
  2→8 ACU) is the right scale lever. Add a **read replica only at T2** if dashboard
  reads on `ops` grow (they shouldn't — analytics is on Trino).

---

### 3.8 Identity graph — Neo4j (Community, single node)

- **Role:** identity resolution SoR (ADR-0004) — `ALIAS_OF` intervals, brain_id
  canonicalization. The "Build Trust" spine.
- **Current + the real risk:** Community edition, **single writer**, measured
  **~109 events/s ceiling at 3 cores** — a genuine throughput bottleneck for
  *real-time* identity at T1/T2 (single-writer is architectural, not a tuning knob).
- **Alternatives in the same slot:** Neo4j Enterprise (causal cluster, licensed),
  Amazon Neptune, Postgres union-find.
- **Cost/fit:**
  - Neptune: single-writer too (same bottleneck), replicas eventually-consistent
    (bad for real-time read-after-write identity), consumption-priced, AWS-lock-in.
  - Postgres union-find: reopens ADR-0004 (identity was *moved off* PG on purpose).
  - Neo4j Enterprise: removes the ceiling via clustering but adds licensing $$.
- **✅ Recommendation: KEEP Neo4j Community at T0/T1; RIGHT-SIZE via write-batching;
  HOLD an Enterprise-vs-Neptune decision for T2.** The 109/s ceiling is fine at T0
  (~12/s avg) and survivable at T1 with **batched/queued identity writes** (the
  identity-bridge already drains from Kafka — widen the batch, coalesce alias writes).
  Do **not** swap engines now (Neptune's eventual-consistency actively hurts
  real-time identity). Put a **tripwire on identity-lag**; when sustained ingest
  approaches ~80/s, that's the trigger to evaluate Neo4j Enterprise clustering.

---

### 3.9 Predictions / ML runtime

- **Current state (finding):** thin. `ml.prediction_log` + client hooks
  (`useCustomerScore`, model registry) over an **external/implicit inference
  endpoint** — no in-cluster scoring jobs, honest `no_data` fallback. Features are
  folded at runtime from the Silver spine (no permanent feature table, by design).
- **Goal gap:** "Predictions" (churn/LTV/RFM/propensity) needs a real, owned runtime
  to be AI-native — but it must fit the existing slots (Iceberg features + Argo cron
  compute + PG inference log), not a new platform.
- **Alternatives:** SageMaker (heavy, costly, AWS-lock-in), in-cluster Python
  (scikit/XGBoost/LightGBM) as Argo crons, **DuckDB-based scoring**.
- **✅ Recommendation: BUILD on the existing cron+Iceberg+PG slots — in-cluster
  Python/DuckDB batch scoring, NOT SageMaker.** Add Argo cron jobs that read Silver
  (same pattern as Spark/DuckDB transforms), score with a lightweight model
  (XGBoost/LightGBM), and write to `ml.prediction_log`. This reuses §3.4's DuckDB
  feature-fold, keeps money out of a managed ML platform, and stays inside the
  medallion. Reserve SageMaker/Bedrock only if you need managed training at T2 scale.
  For the *generative* side, the agentic layer (§3.10) is already the AI-native
  surface — classical ML here is the deterministic complement (Brain rule:
  "deterministic first").

---

### 3.10 Agentic / AI layer — LiteLLM gateway → Anthropic (+ OpenAI fallback)

- **Role:** the AI-native surface — NLQ resolution, classify/summarize/synthesis,
  MCP tool dispatch (read-only, contract-tested to have no direct Trino/SQL deps),
  per-tenant virtual keys with budget caps ($20/brand), prompt caching, tiered
  routing (Haiku-4.5 small / Sonnet-4.5 large / Opus for NLQ resolver).
- **Assessment:** this is **well-architected** — gateway indirection means a model
  swap is a one-line `litellm.config.yaml` edit; cost is capped per tenant; prompt
  caching + Haiku-first routing already control spend; fail-closed (no retry storms).
- **✅ Recommendation: KEEP — strongest slot in the stack.** Cost/quality tuning
  only: (1) keep **Haiku-first** routing, escalate to Sonnet/Opus only on task-class
  need; (2) ensure **prompt caching** covers the stable medallion/schema system
  prefixes (big token saving on repetitive NLQ); (3) because the gateway makes it
  trivial, **periodically re-point tiers to the latest models** (e.g. Opus 4.8 for
  the resolver, newest Haiku for classify) — quality up, often cost-neutral. No
  provider change needed; the OpenAI fallback is correct resilience.

---

### 3.11 Orchestration — EKS + Karpenter + KEDA + ArgoCD

- **Status (verified live 2026-07-14):** cluster is on **EKS 1.33**, all nodes on
  **Amazon Linux 2023** (`AL2023_ARM_64_STANDARD` system MNG), on **STANDARD
  support**. The AL2→AL2023 migration + 1.32→1.33 roll were **executed 2026-07-12**
  (AUD-OPS-028), and `eks_support_type = "STANDARD"` in `terraform.tfvars` makes a
  plan **fail-fast** if the cluster ever drifts into paid extended support again.
- **The former ~$360/mo extended-support surcharge is already eliminated** — this is
  a *realized* saving, not an available one. (An earlier draft of this doc mis-read
  the Terraform module *default* of `1.32` as the live state; the prod `tfvars`
  override and the live cluster are both 1.33.)
- **✅ Recommendation: KEEP — done and well-guarded.** Karpenter (spot pools +
  consolidation), KEDA (lag scaling), ArgoCD (GitOps) are all correct at this scale.
  The only forward action is **cadence**: 1.33 standard support ends ~late-2026, so
  schedule the routine **1.33 → 1.34+** bump (now a no-AMI-migration, single-step
  roll since you're already on AL2023) before that window to avoid re-incurring the
  extended-support fee — the `STANDARD` guard will surface it.

---

### 3.12 Observability — OpenTelemetry → Grafana Cloud

- **✅ Recommendation: KEEP.** OTel is vendor-neutral (no lock-in); Grafana Cloud's
  free/low tier covers T0–T1. Watch metric/log cardinality at T2 (that's where
  Grafana Cloud bills bite) — the new `serving_cache_requests_total{metric_id}` and
  friends are bounded-cardinality, which is the right discipline. Revisit only if
  Grafana Cloud egress/ingest cost climbs at T2.

---

### 3.13 App runtime — Node/TypeScript (core/collector/stream-worker) + Next.js (web)

- **✅ Recommendation: KEEP.** No performance or cost case to move off Node/Next at
  any tier here; the BFF + collector + stream-worker split is sound. Not a lever.

---

## 4. Ranked recommendations (value × effort)

| # | Action | Type | Est. saving / benefit | Effort | Risk |
|---|---|---|---|---|---|
| — | ✅ **EKS 1.32 → 1.33 + AL2023** (dropped extended support) | Done 07-12 | **~$360/mo — already realized** | — | — |
| 1 | **DuckDB pilot → migrate transform tier** (Spark is already local-mode) | Pilot/Swap | Big: cost + kills Spark OOM + faster crons | Med–High | Med (parity re-validate) |
| 2 | **Predictions runtime = in-cluster Python/DuckDB crons** (not SageMaker) | Build-in-slot | avoids managed-ML $$; unlocks the goal | Med | Low |
| 3 | **S3 Intelligent-Tiering on Bronze prefix** | Right-size | grows with T2 volume | Low | None |
| 4 | ✅ **Valkey swap** (done #144/#145; run CLI migration) | Swap | ~20% of cache (~$3/mo) + licensing | Done | Low |
| 5 | **AI gateway: Haiku-first + prompt-cache stable prefixes + refresh model tiers** | Tune | LLM spend down | Low | Low |
| 6 | **Trino `maxReplicas` cut — DATA-DRIVEN ONLY** (after hit-rate metric proves near-idle burst) | Hold→Right-size | small burst-only | Low | Med (OOM on sole serving engine if cut blind) |
| 7 | **Neo4j: identity write-batching + lag tripwire** (Enterprise decision at T2) | Right-size/Hold | headroom to T1 | Low–Med | Med at T2 |
| — | **Cadence: schedule EKS 1.33 → 1.34+** before 1.33 standard-support ends (~late-2026) | Maintenance | avoids re-incurring extended-support fee | Low | Low |

> **Config right-sizing is exhausted, safely.** The two config levers an earlier
> draft listed (Kafka spot; Trino static 3→2) are **NOT safe**: re-spotting Kafka
> re-creates the 2026-07-12 triple quorum-loss outage (a PDB does not stop involuntary
> spot reclaims), and Trino's baseline is already 1 warm worker (KEDA) so cutting the
> burst ceiling only *raises* OOM risk on the sole serving engine. Kafka and Trino are
> each already at their safe cost floor.

**The biggest EKS lever is already banked** (−$360/mo, 07-12), and Kafka/Trino are
already at their safe floors. So the top remaining moves are **structural, not config**:
**#1 the DuckDB transform pilot** (cost + reliability) and **#2 the predictions
runtime**, plus the zero-risk **#3 S3 Intelligent-Tiering**.

---

## 5. What NOT to change, and why (closed decisions)

- **Kafka → SQS/Kinesis:** already evaluated and rejected (loses replay/ordering/
  ecosystem; breaks the Bronze-landing contract).
- **Kafka brokers → Spot:** re-creates the 2026-07-12 triple quorum-loss outage
  (spot reclaims are involuntary and bypass PDBs). Brokers stay on-demand; "no event
  loss" outranks the ~$100/mo.
- **Trino `maxReplicas` cut without data:** baseline is already 1 warm worker (KEDA);
  capping the burst ceiling of the sole serving engine only raises OOM risk. Cut only
  on hit-rate + utilization evidence.
- **Trino → StarRocks:** faster on paper, but StarRocks was deliberately removed;
  Trino+cache is the ratified serving path and the cache absorbs Brain's QPS.
- **Neo4j → Postgres/Neptune:** identity was moved to Neo4j on purpose (ADR-0004);
  Neptune's eventual-consistency harms real-time identity. Keep Neo4j.
- **Iceberg → Delta/Hudi:** Iceberg's engine-agnosticism is the strategic asset;
  moving narrows the engine set and gains nothing.
- **Managed ML platform (SageMaker) / provisioned Aurora:** both cost more for
  Brain's bursty, small-data profile than the current serverless/in-cluster choices.

---

## 6. Bottom line

Brain's *architecture* is right for an AI-native commerce OS. The *technology* in
each slot is mostly right too. The **biggest cost lever — EKS extended support
(~$360/mo) — is already banked** (upgraded to 1.33/AL2023 on 2026-07-12, with a
`STANDARD`-support guard). The one remaining structural opportunity is **(b): you're
running Spark's cluster overhead for a single-node, small-data transform that DuckDB
does faster and ~cheaper in the exact same medallion slot.** Pursue the DuckDB pilot,
right-size Kafka/Trino (~$100–150/mo of reversible config wins), keep everything
else, and build the predictions runtime inside the existing cron+Iceberg+PG slots —
all **without changing one line of the architecture.**

---

### Sources
- DuckDB vs Spark cost/perf: [Walmart Global Tech study](https://medium.com/walmartglobaltech/duckdb-vs-the-titans-spark-elasticsearch-mongodb-a-comparative-study-in-performance-and-cost-5366b27d5aaa), [dataexpert.io benchmark](https://blog.dataexpert.io/p/duckdb-can-be-100x-faster-than-spark), [Estuary — Iceberg query engines](https://estuary.dev/blog/comparison-query-engines-for-apache-iceberg/)
- Trino vs StarRocks vs ClickHouse: [StarRocks benchmark](https://www.starrocks.io/blog/benchmark-test), [Onehouse comparison](https://www.onehouse.ai/blog/apache-spark-vs-clickhouse-vs-presto-vs-starrocks-vs-trino-comparing-analytics-engines)
- Aurora Serverless v2 pricing: [Usage.ai guide](https://www.usage.ai/blogs/aws/rds/aurora-serverless-v2/), [Bytebase](https://www.bytebase.com/blog/understanding-aws-aurora-pricing/)
- MSK Serverless vs self-managed: [AxonOps Kafka cost 2026](https://axonops.com/blog/kafka-cost-comparison-2026-self-hosted-vs-amazon-msk-vs-confluent-cloud/), [AutoMQ MSK pricing](https://www.automq.com/blog/aws-msk-pricing-provisioned-serverless-express)
- Neo4j vs Neptune: [PuppyGraph](https://www.puppygraph.com/blog/aws-neptune-vs-neo4j), [Neo4j pricing](https://neo4j.com/pricing/)
