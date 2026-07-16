# ADR-0014 — Remove Trino entirely: duckdb-serving for reads, PyIceberg for Iceberg maintenance

Status: **Accepted** (2026-07-16)
Relates to: ADR-0007 (analytics gateway / serving-tier PII posture); the StarRocks→Trino serving
replacement (PR #285) and the Spark→DuckDB transform cutover (PR #148) — this ADR completes that
consolidation arc; the `${BRAND_PREDICATE}` tenant-isolation seam; `v4-naming-guard.sh` R7.
Driver: owner decision — one analytical engine (DuckDB) across transform, serving, and maintenance;
Trino's JVM footprint (7 GiB local `mem_limit`, coordinator+worker split in prod, the historic
OOM-outage class) is cost and operational surface Brain no longer needs.

## Context

After the Spark→DuckDB cutover, Trino remained in the platform for exactly two jobs:

1. **Serving.** The app/BFF/metric-engine read the `brain_serving.mv_*` views over Trino's HTTP
   `/v1/statement` protocol. The seam is one port — `TrinoPool.query(sql, params)` in
   `packages/metric-engine` — behind engine-neutral aliases; the ~130 metric files, the brand gate,
   the Redis analytics cache, and the `${BRAND_PREDICATE}` predicate-injection seam are all
   engine-agnostic.
2. **Iceberg maintenance.** Compaction, snapshot expiry, retention, and RTBF erasure ran as
   `ALTER TABLE EXECUTE` against Trino (`db/iceberg/trino/**`).

Meanwhile DuckDB (≥1.5.3) — already the sole transform compute — gained first-class Iceberg REST
catalog support (read-only ATTACH included), and PyIceberg (0.11) gained snapshot expiry and
copy-on-write delete/overwrite. Phase-0 spikes against the real local REST catalog proved every
behavior the new design depends on: cursor-per-request concurrency off one attached connection,
local views shadowing the catalog namespace, `READ_ONLY` attach (writes rejected), snapshot
freshness on plain re-query (no re-attach needed), and TIMESTAMPTZ literal comparison under a UTC
session. The one true engine gap — distributed compaction — is covered by a PyIceberg COW
partition-rewrite fallback, gated by a capability probe.

**The single-query ceiling is accepted doctrine, not a regression:** a duckdb-serving query
executes on one node — there is no distributed shuffle, and there never will be in this tier.
Heavy compute belongs in the transform tier; serving reads pre-baked Gold/Silver mart slices
through thin views. A query that needs a cluster is a mart that should exist.

## Decision

Remove Trino entirely — image, charts, IRSA role, views runner, maintenance client, TS adapter,
and every `TRINO_*` config key — and replace it with:

1. **duckdb-serving** (`db/iceberg/duckdb/serving/`): a stateless Python HTTP service (FastAPI +
   uvicorn, one worker per pod). Each replica holds one DuckDB connection attached **read-only**
   to the Iceberg REST catalog as `iceberg`, applies the ported views (`db/iceberg/duckdb/views/`)
   into a **local** `brain_serving` schema at startup, and serves `POST /v1/query` returning
   Trino-shaped `{columns, data}` JSON. Per-replica `memory_limit`/`threads`/spill
   `temp_directory`, an admission semaphore, and an interrupt watchdog turn a pathological query
   into a clean 504 — never an OOM-killed pod. Freshness is native (live attaches see new commits
   on re-query); background **epoch rotation** (re-attach + re-apply views, atomic swap) exists as
   self-heal for skipped views, default 900 s. Horizontal scale = N replicas behind a Service +
   HPA, with the Redis analytics cache unchanged in front.
2. **TS serving port rename**: `duckdb-serving-adapter.ts` implements the same one-port seam
   (single POST, client-side param substitution kept verbatim); `TrinoPool`/`withTrinoBrand` →
   `ServingPool`/`withServingBrand` (`serving-deps.ts`, `serving-brand-gate.ts`); config keys
   `TRINO_HOST/PORT` → `DUCKDB_SERVING_HOST/PORT` (default `localhost:8091`). The
   `${BRAND_PREDICATE}` seam is untouched — it injects `brand_id = ?` into every serving read
   regardless of engine.
3. **PyIceberg maintenance tier** (`db/iceberg/duckdb/maintenance/`): the four scripts port 1:1
   with **unchanged env contracts** (Argo templates and `EraseSubjectUseCase` change minimally).
   Expiry = `table.maintenance.expire_snapshots()` **plus a documented unreferenced-file sweep**
   (PyIceberg's expire is metadata-only; the sweep makes RTBF bytes physically gone from S3 —
   probe-asserted). Deletes/compaction = COW `table.delete(filter)` / per-partition
   `table.overwrite(...)` with commit-conflict retry. The erasure lane NEVER issues DuckDB MoR
   DELETEs (PyIceberg 0.11 cannot clear the resulting positional-delete files) — surviving rows
   are computed via DuckDB read-only and applied purely through PyIceberg COW. A 2-line
   `ManifestEntry.snapshot_id` property shim in `_maintenance_base.py` works around a PyIceberg
   0.11.1 setter bug that corrupts entries inherited from DuckDB-written manifests (upstream issue
   filed). All of it is gated by `maintenance_capability_probe.py` — a merge/deploy precondition.
4. **Guard inversion**: `v4-naming-guard.sh` **R7** forbids new Trino coupling on live lines —
   the `trinodb/trino` image, `TRINO_*` env tokens, the retired client identifiers
   (`createTrinoPool`/`withTrinoBrand`/`TrinoPool`), `db/trino/` + `db/iceberg/trino` paths,
   `/opt/brain/trino` invocations, and `trino:8080`/`trino…:8090` host forms. Deliberately NOT a
   bare `:8090` ban — that is the stream-worker metrics port.

## Consequences

- **One engine everywhere.** DuckDB is transform + serving compute; PyIceberg is the catalog
  mutation client. No JVM in the analytics path; local serving footprint drops 7 GiB → 4 GiB;
  prod drops the coordinator/worker topology for identical stateless replicas.
- **Serving scales horizontally, queries don't.** Throughput scales with replicas; a single
  query's ceiling is one node (see doctrine above). Regressions here are fixed by adding marts,
  not nodes.
- **Views apply themselves.** `run-trino-views.sh` is gone; view provisioning is the service's
  startup/rotation epoch, observable at `/readyz` (`views_applied`/`views_skipped`). Runbook
  "apply views" steps become "verify `/readyz`".
- **Orphan-file sweep is DEFERRED** — PyIceberg has no `remove_orphan_files` yet. The maintenance
  tier logs a **loud SKIP** (never a silent pass); orphans accumulate bounded by snapshot expiry's
  referenced-file sweep. Revisit each PyIceberg release; this is the one accepted gap.
- **Type-drift surface moved.** Trino's rendering quirks are replaced by DuckDB's (HUGEINT sums,
  integer division → DOUBLE, `+00:00` timestamptz suffix) — handled centrally in the serving
  serializer (money stays BIGINT minor units end-to-end; >2^53 serialized as string) and pinned by
  parity probes on money SUM / timestamptz / LIST<STRUCT> / ratio metrics.
- **Rollback window depends on git history**, not on kept-around infrastructure — Trino is not
  left deployed-but-idle after the removal PR.

## Rollback

Every stage is a git revert; no data migration is involved (views and maintenance are
reconstructable from SQL/scripts; Iceberg tables are untouched by the engine swap).

1. Revert the removal PR (restores `infra/helm/trino`, `infra/argocd/envs/prod/trino.yaml`,
   `db/trino/**`, `db/iceberg/trino/**`, the compose `trino` block, and the `TRINO_*` config
   keys), then `argocd app create` from the restored Application file and sync.
2. Cron paths revert to `/opt/brain/trino/*.py` — the previously digest-pinned brain-duckdb image
   still carries those scripts, so no image rebuild is required for the first rollback deploy.
3. Re-seed `TRINO_*` keys via `tools/deploy/seed-prod-secrets.sh`; re-run
   `db/trino/views/run-trino-views.sh`; flip the serving adapter back by reverting the
   composition-swap commit (the metric files never changed — the seam is one port).
4. Terraform: revert the `irsa_duckdb_serving`-for-`irsa_trino` swap in `envs/prod/bootstrap.tf`
   and apply.
