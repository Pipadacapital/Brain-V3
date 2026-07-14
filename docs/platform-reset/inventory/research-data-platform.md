# Data Platform + Platform Engineering Research (2026)

Current best-practice research mapped to Brain's stack. Brain is an AI-native commerce OS running
a Spark-on-Iceberg medallion (Bronze/Silver/Gold in `brain_{bronze,silver,gold}_local` REST-catalog
Iceberg over MinIO/S3), Kafka Connect Iceberg-sink Bronze landing (ADR-0010), Trino-over-Iceberg
serving fronted by a Redis analytics cache, PostgreSQL for `ops` state, and ArgoCD + Argo Workflows
GitOps on EKS. Brain is **mid-migration Spark → DuckDB** for the transform tier (PR #148 merged: 46
Silver + 48 Gold ported to DuckDB, money-byte-exact parity, maintenance/RTBF → Trino; ADDITIVE/inert,
Spark still runs — operational cutover pending). Recommendations below are written against that reality.

---

## 1. Kafka on Kubernetes via Strimzi

**2026 state of the art**
- **KRaft is the only path.** KRaft is production-ready since Kafka 3.5 and Kafka 4.0 runs KRaft-only
  (no ZooKeeper). All new Strimzi deployments should be KRaft; a ZK→KRaft migration is a guided Strimzi
  procedure, not a config flip.
- **Dedicated controller + broker node pools in prod** via `KafkaNodePool` (dual-role only for dev/test).
- **Tiered storage is production-ready from Kafka 3.9.** Offloads cold log segments to object storage
  (S3/MinIO or even NFS). Big operational wins: faster broker startup after unclean shutdown and much
  faster recovery when a broker + its local disk are lost (less data to re-replicate).
- **SSD-backed StorageClass is mandatory**; multi-node (≥3 broker, ≥3 controller) for HA.

**Mapped to Brain**
- Brain already runs Strimzi on EKS with rack-awareness (PR #165) to kill cross-AZ transfer (~638 GB/day,
  ~$194/mo — the #1 cost lever). Keep rack-awareness; verify KRaft mode (not lingering ZK).
- **Adopt tiered storage** for the collector + 9 raw lanes: since Bronze is the Kafka-Connect Iceberg
  sink and Bronze is source-of-truth, hot local Kafka retention can be short and cold segments tiered to
  the same MinIO/S3 that backs Iceberg — shrinks EBS/PVC spend and speeds broker recovery. Gate behind
  Kafka ≥3.9.
- Keep the Strimzi PVC/ALB drift guards already in GitOps.

Sources:
- https://strimzi.io/blog/2025/04/22/tha-various-tiers-of-apache-kafka-tiered-storage/
- https://strimzi.io/docs/operators/latest/deploying
- https://medium.com/@abdelrahmanelshahat00/deploying-production-ready-apache-kafka-on-kubernetes-with-strimzi-kraft-mode-644db3427332
- https://floriancourouge.com/en/blog/kafka-kubernetes-production

---

## 2. Apache Iceberg production layout

**2026 state of the art**
- **One catalog per table, REST-spec everywhere.** Every engine that writes a table must coordinate
  through the *same* catalog or concurrent writes corrupt it. The Iceberg REST Catalog spec is the
  convergence point — Polaris, Nessie, Gravitino, Unity, Glue REST endpoint, and S3 Tables all speak it,
  so PyIceberg/Spark/Trino/DuckDB are interchangeable clients.
- **Self-hosted REST catalog choices:** Apache Polaris (Snowflake/Dremio-originated, Quarkus + Postgres/
  MySQL/CockroachDB, full RBAC + credential vending) or Project Nessie (git-like branching, JDBC/Postgres/
  RocksDB backend). For high-concurrency prod, REST catalogs (Polaris/Nessie) beat a bare JDBC catalog.
  Nessie needs Polaris/OPA/custom authz for fine-grained perms. Both support MinIO/S3 with request signing.
- **Maintenance is NOT optional:** compaction (now with sort + z-order strategies), snapshot expiry, and
  orphan-file cleanup must run continuously. Fixed schedules are an anti-pattern at scale (they compact
  healthy tables and miss degraded ones) — prefer health/metrics-driven compaction.
- On AWS specifically, **S3 Tables** (GA Dec 2024) run these maintenance jobs automatically; self-managed
  Glue tables use the Glue optimizer. Self-hosted stacks must run maintenance themselves.

**Mapped to Brain**
- Brain runs a **REST catalog + MinIO/S3** already (`brain_{bronze,silver,gold}_local`). Prior incident
  (memory: iceberg-catalog SQLite lock) shows the catalog backend was SQLite — **this is a production
  liability.** Recommendation: standardize on a REST catalog backed by **PostgreSQL** (Brain already runs
  PG for `ops`), i.e. Polaris-on-Postgres or Nessie-on-Postgres, eliminating the single-writer SQLite
  lock class entirely and giving proper concurrency + credential vending.
- Bronze is append-only (dedup in Silver) — perfect for Iceberg. **Wire continuous, health-driven table
  maintenance** (compaction/expire-snapshots/remove-orphans) as Argo Workflows crons. Brain's Spark→DuckDB
  migration already moved maintenance/RTBF to Trino — good; make sure compaction targets sort order on the
  `brand_id`-first tenant key so tenant-scoped Trino serving reads prune efficiently.
- Keep `brand_id`-first partitioning/sort + `${BRAND_PREDICATE}` seam for isolation and file pruning.

Sources:
- https://lakeops.dev/blog/best-catalog-for-apache-iceberg
- https://www.dremio.com/blog/apache-iceberg-rest-catalog-what-it-is-and-how-to-use-it/
- https://projectnessie.org/guides/try-nessie/
- https://datablog.alexmerced.com/apache-iceberg-rest-catalog/
- https://bigdataboutique.com/blog/apache-iceberg-on-aws
- https://iceberglakehouse.com/iceberg/amazon-s3-tables/

---

## 3. Trino production deployment

**2026 state of the art**
- **Split clusters by workload:** an interactive/low-latency cluster with `QUERY` retry policy for many
  small queries, and a **separate batch/ETL cluster with `TASK` retry policy** for large queries.
- **Fault-Tolerant Execution (FTE)** spools intermediate exchange data to external storage (S3/MinIO) so a
  worker loss retries tasks, not whole queries. FTE is the enabler for **safe autoscaling** — workers can
  scale down gracefully without waiting for full query completion.
- **Exchange manager on external storage** is required for FTE with large result sets; use **multiple
  buckets** under high concurrency to avoid S3 request throttling.
- Deploy via the official `trinodb/charts` Helm chart; autoscale workers (e.g. EMR/K8s HPA patterns) with
  FTE on to avoid failing in-flight queries during resize.

**Mapped to Brain**
- Trino is Brain's **sole serving engine** (`brain_serving.mv_*` → `iceberg.brain_serving.*`) *and* now
  runs maintenance/RTBF post-DuckDB-migration. These are different workloads → **split them**: a small
  always-on interactive cluster (QUERY retry) behind the Redis cache for `mv_*` serving reads, and a
  FTE `TASK`-retry cluster for compaction/RTBF/maintenance batch SQL.
- Prior incident (memory: Trino OOM serving-outage) took down all BFF APIs when the single Trino died.
  **Bounded JVM heap (RAMPercentage ~70) + restart:unless-stopped is already applied — keep it, and add
  FTE + an HPA on the batch cluster** so maintenance load can't OOM the serving path.
- Point the FTE exchange manager at MinIO/S3 with multiple buckets. Keep the `${BRAND_PREDICATE}` brand
  injection on every serving read.

Sources:
- https://trino.io/docs/current/admin/fault-tolerant-execution.html
- https://trino.io/docs/current/installation/query-resiliency.html
- https://www.starburst.io/blog/solving-capacity-management-problems-for-trino-clusters/
- https://github.com/aws-samples/emr-trino-autoscale/blob/main/docs/fault-tolerant.md
- https://trinodb.github.io/charts/charts/trino/

---

## 4. DuckDB for production transform (vs Spark)

**2026 state of the art**
- DuckDB has matured into real analytical infrastructure: read Parquet/Iceberg from S3, transform in
  DuckDB, write back — replacing Spark ETL for **medium data**. Excellent up to ~1B rows / single-machine
  disk; out-of-core spilling (block-based buffer pool, jemalloc statically linked as of 2026) handles
  datasets several × RAM.
- **Hard boundaries / caveats:** single-machine ceiling; **multiple concurrent readers but only ONE
  writer**; OOM risk when several blocking operators (hash join + sort + agg) coincide or thread count is
  set too high. Tune **1–4 GB RAM per thread**, min 125 MB/thread. Distributed DuckDB ("Quack") is beta,
  targeting maturity ~fall 2026 — not prod-safe yet.
- **Spark remains the answer for petabyte/true-distributed** workloads. The emerging 2026 pattern is
  hybrid: a governed lakehouse for shared truth + DuckDB at the edges (pipelines, notebooks, apps).

**Mapped to Brain**
- Brain's transform tier is **already ported to DuckDB with byte-exact money parity** (PR #148) and
  maintenance/RTBF moved to Trino. This is a sound bet *because Brain is single-tenant-per-brand,
  commerce-scale data — well inside DuckDB's medium-data sweet spot.* The economics fit Brain's
  cost-first posture (memory: cost-first-decisions; ~$450–580/mo prod): DuckDB removes the Spark batch
  pool / JVM / cluster overhead entirely.
- **Migration guidance for the pending cutover:**
  1. Respect the **single-writer** rule — the Silver→Gold DuckDB jobs must serialize writes per Iceberg
     table (one job = one writer at a time), same discipline that fixed the SQLite catalog lock.
  2. Size the DuckDB worker with explicit `memory_limit` + `threads` at 1–4 GB/thread; set a temp-dir on
     fast disk for out-of-core spill; keep total under the pod's `mem_limit` to avoid OOM-kill (Brain has
     a history of transform-tier OOM).
  3. Keep the money = bigint minor units + `currency_code` invariant (no floats) — parity already proven.
  4. **Do NOT delete `db/iceberg/spark` until** the operational cutover (image swap + cronworkflow swap +
     batch-pool removal + `dev:up` e2e) is green; Spark is the rollback path.
  5. If any single mart ever approaches ~1B rows or needs distributed shuffle, that specific job stays on
     Spark (hybrid) — don't force DuckDB past its single-node ceiling.

Sources:
- https://www.birjob.com/blog/duckdb-in-production-2026
- https://www.icertglobal.com/community/apache-spark-vs-duckdb-for-data-engineering-2025
- https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads
- https://duckdb.org/docs/current/connect/concurrency
- https://duckdb.org/docs/current/operations_manual/limits
- https://www.dench.com/blog/duckdb-in-production

---

## 5. Redis / Valkey

**2026 state of the art**
- **Valkey (Linux Foundation, BSD-licensed) is the default new choice.** AWS ElastiCache and Google
  Memorystore now provision Valkey (not Redis) for new clusters; choosing Redis needs a commercial
  agreement. Redis OSS moved to a tri-license (AGPLv3/RSALv2/SSPLv1).
- Valkey 8.1+ is ~8% higher throughput, ~20% lower memory (redesigned hash table), ~22% better P99, and
  cheaper per-node than Redis OSS 7.2. Valkey Helm charts ship sane K8s defaults (PDBs, anti-affinity,
  PVCs). **Migration is drop-in:** swap the image to `valkey/valkey`, operate unchanged.

**Mapped to Brain**
- Brain uses Redis as the Trino serving analytics cache (TTL tiers, SETNX stampede lock, gold-rewritten
  invalidation). **Recommendation: migrate to Valkey** — drop-in image swap, lower memory (directly helps
  Brain's cost-first budget), permissive license, and if prod ever moves this to ElastiCache, Valkey is
  already the managed default. No code changes to the caching logic expected.

Sources:
- https://redis.io/compare/valkey/
- https://www.percona.com/blog/choosing-the-right-key-value-store-redis-vs-valkey/
- https://dev.to/synsun/redis-vs-valkey-in-2026-what-the-license-fork-actually-changed-1kni
- https://simplyblock.io/glossary/what-is-valkey/

---

## 6. ArgoCD + Argo Workflows GitOps

**2026 state of the art**
- **Repo layout = blast-radius boundary.** Each environment maps to its own path/branch; promotion is a
  git operation (commit/merge). Enterprises favor **separate ArgoCD instances per environment** for
  isolation/RBAC, or one instance managing many clusters via cluster secrets.
- **App-of-Apps** to onboard services as one YAML file and enforce consistent standards at scale.
- **No raw secrets in git** — External Secrets Operator or encrypted (SOPS/sealed-secrets) so the cluster
  fetches/decrypts at runtime.
- **Argo Rollouts** for progressive delivery (canary / blue-green) — ArgoCD syncs manifests but does not
  shift traffic; Rollouts does.

**Mapped to Brain**
- Brain's release-layer model (feature → `release` → owner-only `release`→`master` promotion; ArgoCD prod
  tracks `master`) already treats **promotion as a git operation** — aligned with best practice. Keep the
  staging-digest-bump → prod-promote values flow.
- Brain already runs **Argo Workflows crons** for the medallion (Silver→Gold→mv refresh, and now DuckDB
  transform + Trino maintenance/RTBF). Extend this to host **Iceberg maintenance** (§2) and **DR backup**
  (§8) as scheduled Workflows.
- **Adopt App-of-Apps** if not already (memory shows per-app additions like metrics-server-prod) to make
  onboarding one YAML. Confirm secrets go through External Secrets (Brain already uses AWS Secrets Manager/
  KMS) rather than committed values. Consider **Argo Rollouts** for the BFF/web serving layer so a bad
  serving deploy can't take down all APIs (given the Trino/serving fragility history).

Sources:
- https://devops-daily.com/posts/gitops-argocd-repository-structure-multi-environment
- https://dev.to/instadevops/argocd-gitops-deployment-guide-app-of-apps-and-progressive-delivery-7c7
- https://akuity.io/blog/gitops-best-practices-whitepaper
- https://medium.com/@ashish.mnnit777/argocd-enterprise-gitops-implementation-guide-97e0fc139093

---

## 7. Observability (Prometheus / Grafana / OpenTelemetry)

**2026 state of the art**
- **OTel to instrument once, export anywhere**; Prometheus remains the metrics TSDB + PromQL engine.
- **Collector deployment split:** metrics collector as a **Deployment/StatefulSet (single replica)** — a
  DaemonSet duplicates metrics; logs collector as a **DaemonSet** (one per node). Add the
  `k8sattributes` processor to stamp `k8s.node.name`/pod metadata onto telemetry.
- **Enable Prometheus out-of-order ingestion** (~10-min window) to absorb retries/network delay.
- **Cardinality discipline:** no dynamic labels (user IDs, URLs, and — for Brain — no `brand_id` as a raw
  metric label); drop/relabel at the Collector; downsample + shorter retention for high-frequency series.
- Grafana Labs recommends **Grafana Alloy** (a supported OTel Collector distro bundling Prometheus
  exporters) for production.

**Mapped to Brain**
- Brain has a live obs stack (real `/metrics`, JMX exporter, SLO/dashboards repointed to Kafka-JMX). Fold
  in OTel: standardize app/BFF instrumentation on OTel, keep Prometheus as TSDB, add `k8sattributes`.
- **Cardinality is a tenant-isolation trap for Brain:** do NOT emit `brand_id` as a raw Prometheus label
  (multi-tenant → unbounded cardinality + isolation leak). Bucket/drop it at the Collector; use exemplars/
  traces for per-brand drill-down instead.
- Wire freshness/confidence as first-class metrics (Brain's "confidence + freshness measurable" review
  rule) — surface Iceberg snapshot age, medallion refresh lag, and cache staleness as gauges.

Sources:
- https://grafana.com/blog/a-practical-guide-to-data-collection-with-opentelemetry-and-prometheus/
- https://opentelemetry.io/blog/2024/prom-and-otel/
- https://grafana.com/docs/grafana-cloud/monitor-infrastructure/kubernetes-monitoring/configuration/config-other-methods/otel-collector/
- https://www.stackgenie.io/kubernetes-observability-prometheus-opentelemetry-grafana/

---

## 8. Disaster recovery & backup

**2026 state of the art**
- **Tier workloads by RTO/RPO:** critical (RTO <1h, RPO <15m → active-active / continuous replication);
  important (RTO <4h, RPO <1h → hourly replication); standard (RTO <24h, RPO <24h → backup-and-restore).
- Lakehouse DR must replicate **all four layers in sync:** open-format data (Iceberg/Parquet in object
  storage), **catalog metadata**, workspace/job assets, and governance/RBAC config — the catalog is the
  hardest and most-forgotten piece.
- For relaxed RPO (24h), **cross-region S3 backup-and-restore is cheaper than continuous CRR** for large,
  infrequently-changing datasets; use CRR only for tight RPO tiers.
- **Test DR at least quarterly** — untested backups are not a recovery plan.

**Mapped to Brain**
- Brain's system of record is **Iceberg over MinIO/S3 + the REST catalog + PostgreSQL `ops`**. A credible
  DR plan must cover **all three together and consistently:**
  1. **Iceberg data:** S3 cross-region replication (or scheduled backup for a 24h RPO tier) of the MinIO/S3
     buckets. Because Bronze is append-only source-of-truth, Silver/Gold are reproducible — so Bronze +
     catalog is the true RPO-critical set; Silver/Gold can be **rebuilt via the refresh loop** (cheaper
     than replicating derived marts).
  2. **Catalog metadata:** back up the REST-catalog DB — a strong reason to move off SQLite to PostgreSQL
     (§2), since PG has mature PITR/snapshot backup (Aurora is already in prod). A data snapshot without a
     consistent catalog snapshot is unrecoverable.
  3. **PostgreSQL `ops`:** Aurora automated backups / PITR + snapshot to another region.
- Ensure Iceberg snapshot-expiry retention ≥ RPO window so time-travel can recover recent corruption.
  Run backups + a **quarterly restore drill** (rebuild Silver/Gold from restored Bronze+catalog) as Argo
  Workflows. Match the DR tier to Brain's cost posture — start standard/backup-and-restore, not
  active-active.

Sources:
- https://docs.databricks.com/aws/en/lakehouse-architecture/deployment-guide/ha-dr
- https://telefonicatech.uk/blog/disaster-recovery-data-platforms/
- https://repost.aws/questions/QUd92uKIKbSqqEO1hStW-AzA/cross-region-s3-backup-and-restore-v-s-cross-region-s3-replication
- https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html

---

## 9. Multi-environment deployment patterns

**2026 state of the art**
- Environment = its own git path/branch; **promotion is a merge/commit**, reviewed and auditable.
- Repo layout is the real isolation boundary; per-env ArgoCD instances (or per-cluster app destinations)
  for strong RBAC separation.
- Config as data (Helm/Kustomize overlays per env); no drift — cluster state converges to git.

**Mapped to Brain**
- Brain's dev / staging / prod flow with owner-gated `release`→`master` promotion, staging digest bumps,
  and ArgoCD-prod-tracks-master is **already aligned**. Keep the drift guards (ALB/Strimzi PVC). The one
  gap worth closing: make the same **Iceberg-maintenance + DR-backup Argo Workflows** environment-scoped
  via overlays so staging exercises them before prod.

Sources:
- https://devops-daily.com/posts/gitops-argocd-repository-structure-multi-environment
- https://squareops.com/blog/gitops-with-argocd-step-by-step-tutorial/

---

## Highest-leverage moves for Brain (priority order)
1. **Move the Iceberg REST catalog + DuckDB write coordination off SQLite onto PostgreSQL** — kills the
   catalog-lock class, unblocks concurrency, and makes catalog DR trivial (Aurora PITR).
2. **Split Trino into interactive (QUERY-retry, serving) + batch (TASK-retry + FTE, maintenance/RTBF)**
   clusters so maintenance can't OOM the serving path; FTE exchange on MinIO/S3.
3. **Complete the Spark→DuckDB cutover safely** (single-writer serialization, per-thread RAM sizing,
   spill temp-dir, keep Spark as rollback until e2e green).
4. **Wire health-driven Iceberg maintenance** (compaction w/ `brand_id` sort + z-order, expire-snapshots,
   remove-orphans) as Argo Workflows.
5. **Adopt Kafka tiered storage (≥3.9)** to shrink EBS + speed broker recovery; keep KRaft + rack-awareness.
6. **Migrate Redis → Valkey** (drop-in, lower memory, permissive license, managed-default alignment).
7. **Instrument with OTel + Prometheus**, and **never emit `brand_id` as a raw metric label** (cardinality
   + isolation).
8. **Define a tiered DR plan** replicating Bronze + catalog + `ops` PG consistently; rebuild Silver/Gold
   from Bronze; quarterly restore drills.
