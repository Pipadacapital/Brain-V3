# ADR-0002 — Additive rebuild: Iceberg REST catalog SQLite→Aurora PG, and Trino interactive/batch split

**Status:** Proposed
**Date:** 2026-07-14
**Deciders:** Engineering Program Lead, Data Platform owner (owner sign-off required)
**Relates to:** ADR-0001 (selective rebuild), `06-redesign-proposal.md` §2.6, `inventory/research-data-platform.md` §2–§4

## Context

Under the selective-rebuild decision (ADR-0001), only two data-platform components warrant a
genuine "rebuild." Both are single-writer liabilities on paths that matter, and both have a
documented incident history:

1. **Iceberg REST catalog backend is SQLite.** The catalog is the single coordination point every
   engine that writes a table must share (research-data-platform §2). On a single SQLite file this
   has produced the *"database table is locked: iceberg_tables"* incident under concurrent
   Bronze-sink + refresh + DDL, mitigated only by pinning `CATALOG_CLIENTS=1` (serialized catalog
   ops) — a throughput ceiling, not a fix. A data snapshot without a consistent, recoverable
   catalog snapshot is unrecoverable (DR §4).
2. **Trino is a single cluster serving both interactive `mv_*` reads and batch maintenance/RTBF.**
   Trino is the sole serving engine and has an OOM history; a cache-miss burst and a heavy
   compaction job contend on the same coordinator/workers. `TASK`-retry Fault-Tolerant Execution
   (FTE) is appropriate for batch but wrong for low-latency interactive reads, so one cluster
   cannot be tuned correctly for both.

The transform tier is separately mid-cutover Spark→DuckDB (PR #148 merged, parity-proven, additive);
completing that operational cutover is in-scope for the same phase but is not a "rebuild" (it is a
finish of an already-landed migration).

## Decision

**Rebuild both components additively, each with the existing path retained as rollback until the new
path is verified green. Neither is a teardown.**

1. **Catalog:** move the Iceberg REST catalog backend off SQLite onto **Aurora PostgreSQL** (a new
   `iceberg_catalog` DB co-located on the existing prod Aurora Serverless v2 cluster, ADR-0003).
   Point `iceberg-rest` `JdbcCatalog` at Aurora PG behind a flag. Keep the SQLite path until reads
   and writes are verified. This retires the SQLite-lock class entirely, unblocks catalog
   concurrency, and gives the catalog Aurora's 35-day PITR for free.
2. **Trino:** split into **two clusters** — an always-warm **interactive** cluster (`QUERY` retry)
   behind the Valkey cache for `mv_*` serving reads, and a **batch** cluster with **FTE** (`TASK`
   retry, exchange on S3 across multiple buckets) for compaction / RTBF / maintenance. Keep bounded
   JVM heap + restart-on-OOM. KEDA scales the batch cluster to zero between runs; the interactive
   cluster keeps a warm floor. Keep the `${BRAND_PREDICATE}` tenant-isolation seam.
3. **Transform (finish, not rebuild):** complete the Spark→DuckDB operational cutover (image swap,
   cronworkflow swap, batch-pool removal, `dev:up` e2e), with single-writer serialization per
   Iceberg table. Keep `db/iceberg/spark` as rollback until e2e is green. Any mart nearing ~1B
   rows / distributed shuffle stays on Spark (documented hybrid escape hatch).
4. **Maintenance:** wire health/metrics-driven compaction (`brand_id`-sort + z-order),
   expire-snapshots, and remove-orphans as Argo Workflows — not fixed schedules.

## Alternatives Considered

- **Nessie / Polaris on their own dedicated DB.** Viable and REST-spec-compatible, but adds new
  operational surface; Aurora-PG-backed REST catalog reuses the existing prod PG + PITR with less
  net-new. Kept as a T2 option if catalog RBAC / branching needs grow.
- **AWS S3 Tables (auto-maintenance).** Rejected: moves the catalog off Brain's self-hosted
  REST-catalog control and adds per-table cost; the team already operates the REST catalog.
- **Keep a single Trino cluster, just raise limits.** Rejected: cannot tune one cluster for both
  `QUERY`-retry interactive latency and `TASK`-retry FTE batch resilience simultaneously; the OOM
  contention persists.
- **Keep Spark for transform.** Rejected: Spark-`local[*]` is the OOM root-cause; the DuckDB port is
  parity-proven (PR #148). Hybrid retained only for billion-row/shuffle marts.

## Consequences

- **Positive:** retires the SQLite-lock and Trino-serving-OOM incident classes; makes catalog DR
  trivial (Aurora PITR); interactive serving isolated from batch contention; batch scales to zero.
- **Positive:** transform OOM class removed and batch cost cut on DuckDB cutover completion.
- **Negative / accepted:** two Trino clusters add a small always-warm interactive footprint
  (bounded); DuckDB's single-node ceiling means the Spark hybrid escape hatch must remain
  maintained until no mart needs it.
- **Dependency:** the catalog move co-locates a second logical DB on prod Aurora — governed by
  ADR-0003 (sizing/reader) and its blast-radius note.

## Rollback

- **Catalog:** flip the `iceberg-rest` backend flag back to SQLite; the SQLite file remains intact
  until explicitly retired post-verification.
- **Trino:** re-point serving reads at the original single cluster manifest via `git revert`;
  ArgoCD self-heals. The batch/FTE cluster is additive and can be deleted with no serving impact.
- **Transform:** re-enable the `db/iceberg/spark` cronworkflows; the Spark tree is retained until
  DuckDB e2e is green. All three are independent `git revert`s of their respective PRs.
