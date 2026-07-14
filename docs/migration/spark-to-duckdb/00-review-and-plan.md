# Spark → DuckDB migration — review & plan (Phase 0 gate)

**Status:** Phase 0 in progress. **Decision needed before Phase 1.**
**Goal:** replace every Spark *transform* job (Silver, Gold, identity, maintenance,
RTBF) with DuckDB, decommission the Spark `batch` compute, keep the architecture
(medallion, Iceberg, Trino, Valkey, BFF, agentic) unchanged.

---

## A. Feasibility verdict — GO (linchpin verified)

The program hinges on one thing: **can DuckDB write Iceberg through Brain's REST
catalog (the same one Kafka Connect writes and Trino reads), including `MERGE INTO`?**

**Yes**, as of **DuckDB v1.5.3 (2026-05)**. The iceberg extension supports
`INSERT` / `UPDATE` / `DELETE` / `MERGE INTO`, `ALTER TABLE`, partition transforms,
and Iceberg V3 — and *all writes go through the attached REST catalog and commit as
new snapshots*, so Trino + Kafka Connect see identical metadata. Brain's catalog is
`type=rest` (`iceberg_base.py`), so DuckDB attaches the same catalog with the same
`{catalog}.{namespace}.{table}` identifiers. Splink's DuckDB backend is first-class,
making the probabilistic-stitch port near-mechanical.

Sources: DuckDB Iceberg writes (duckdb.org/2025/11/28), v1.5.3 features
(duckdblab.org), Splink backends (moj-analytical-services.github.io/splink).

---

## B. Corrections to the original plan (before we build)

1. **Bronze Spark sinks are already gone.** The plan's "remove `spark-bronze-sink` /
   `spark-bronze-raw-sink`" (§4 local) is stale — they were retired 2026-07-05 in the
   Kafka Connect cutover (ADR-0010). Bronze landing is **not** Spark. Scope = the
   **transform tier only** (Silver/Gold + maintenance + identity + Splink).

2. **There is no Spark cluster.** Prod Spark already runs
   `spark-submit --master local[*]` in Argo cron pods (no Spark Operator/cluster).
   We're removing single-JVM cron pods, which makes DuckDB an even cleaner drop-in.
   The success criterion `kubectl get pods -n spark-jobs` is wrong — there is no such
   namespace; verify via "no `spark-submit` cron pods on the `batch` pool".

3. **Iceberg maintenance → Trino, not DuckDB (Phase 5).** DuckDB does **not** expose
   Iceberg stored procedures (`rewrite_data_files`, `expire_snapshots`,
   `remove_orphan_files`). Brain already runs **Trino**, which supports
   `ALTER TABLE … EXECUTE optimize / expire_snapshots / remove_orphan_files`. Route
   compaction/expiry/orphan-cleanup through Trino (or pyiceberg). Do **not** bet
   maintenance on DuckDB.

4. **RTBF erasure = DuckDB DELETE + Trino compaction (Phase 5).** DuckDB `DELETE` on
   Iceberg is *merge-on-read* (positional deletes) — the PII bytes physically remain
   in old data files until compaction. For GDPR/DPDP true erasure, the DuckDB delete
   MUST be followed by a Trino `optimize` + `expire_snapshots` to physically rewrite.
   The invariant (crypto-shred / physical removal) is preserved only with that second
   step.

5. **Success bar = data-equivalent, not "byte-identical".** Parquet bytes, row order,
   and file sizes differ between engines by design. The gate is: **identical row sets
   + money exact to the minor unit + checksum over sorted, normalized rows**. Byte
   equality is neither achievable nor necessary.

**Sequencing flip:** run the **DuckDB capability probe FIRST**, before building the
50k golden generator (fail-fast, per protocol §7). No point generating fixtures if
the write path surprises us.

---

## C. Phase 0 gate — artifacts & how to run

| Artifact | Path | Purpose |
|---|---|---|
| Catalog seam | `db/iceberg/duckdb/_catalog.py` | DuckDB ⇄ Iceberg REST attach; env-parity with `iceberg_base.py` (same `ICEBERG_REST_URI` / `ICEBERG_WAREHOUSE` / `S3_ENDPOINT`/IRSA) |
| **GATE 1 — capability probe** | `db/iceberg/duckdb/phase0_capability_probe.py` | proves attach + read medallion + INSERT + **MERGE idempotency** + BIGINT money + DELETE + partition transforms + snapshots, in a scratch namespace it drops |
| Deps | `db/iceberg/duckdb/requirements.txt` | `duckdb>=1.5.3`, numpy, splink, pyiceberg |
| Golden generator | _next_ (`phase0_golden_dataset.py`) | deterministic ~50k Bronze events — **built after GATE 1 passes** |
| Parity harness + CI | _next_ | run golden through Spark (reference) and DuckDB, assert row/money/checksum equivalence |

**Run GATE 1 against the dev lakehouse** (compose `iceberg-rest` + `minio` up):

```bash
pip install -r db/iceberg/duckdb/requirements.txt
S3_ENDPOINT=http://localhost:9000 ICEBERG_REST_URI=http://localhost:8181 \
  AWS_ACCESS_KEY_ID=brain AWS_SECRET_ACCESS_KEY=brainbrain \
  python db/iceberg/duckdb/phase0_capability_probe.py
# exit 0 = all critical capabilities pass → proceed to the golden dataset
# non-zero = a capability gap → PAUSE and report (protocol §7)
```

In-cluster (prod, IRSA): leave `S3_ENDPOINT` unset, point `ICEBERG_REST_URI` at the
`brain-prod-iceberg-rest` service.

---

## D. Adjusted phase map (unchanged where the plan was right)

| Phase | Scope | Engine | Cutover |
|---|---|---|---|
| **0** | golden dataset + capability probe + parity CI | DuckDB | — (gate) |
| 1 | ~8 simplest Gold marts (pure SQL aggregations) | DuckDB SQL | parallel 3d → switch Trino view → suspend Spark cron |
| 2 | remaining Gold + Markov attribution (numpy solve) | DuckDB + numpy | same |
| 3 | Silver 2-stage (validate/DQ/dedup/canonicalize), watermark-incremental | DuckDB SQL/UDF | same |
| 4 | identity bridge (DuckDB+Neo4j), deterministic stitch (SQL), Splink (DuckDB backend) | DuckDB | **last Spark job removed** |
| 5 | **maintenance + RTBF via Trino/pyiceberg** (correction #3/#4) | Trino/pyiceberg | — |
| infra | remove `batch` Karpenter pool; cron templates → DuckDB pods | Terraform | after Phase 4 |

**Cost note:** the earlier estimate of "$85/mo" for the batch pool is likely high —
the `batch` pool is **Spot + ephemeral** (runs only during crons), so the realized
saving is probably ~$20–40/mo plus the real wins (no JVM OOM class, faster crons,
<1GB local RAM). Keep the "≥$50/mo" success target aspirational, not a gate.

---

## E. Invariants preserved (mapping)

| Invariant | How it's held under DuckDB |
|---|---|
| Bronze append-only SoT | DuckDB only READS Bronze; never writes it (Connect stays the sole Bronze writer) |
| Silver idempotent MERGE | `MERGE INTO … ON (brand_id, source_event_id)` — probe #4 asserts replay-stability |
| Versioned journeys | new snapshots per commit; journey_events reversion logic ported verbatim |
| Deterministic attribution | Markov reads the deterministic corpus only; Splink output never feeds revenue credit |
| Money = bigint minor units | `BIGINT` end-to-end — probe #5 asserts int64 round-trip, no float |
| brand_id-first multi-tenancy | leading column in every ported table + every predicate (unchanged) |
| Privacy/consent/crypto-shred | consent gating ported to SQL; erasure = DuckDB DELETE **+ Trino compaction** (correction #4) |
| Backward-compatible rollback | each Spark cron suspended (not deleted); re-enable + repoint Trino view = instant revert |

---

## F. Ask (protocol §7 gate)

Approve to:
1. Accept corrections **#3 (maintenance→Trino)** and **#4 (erasure→DELETE+compaction)** as plan amendments.
2. **Run GATE 1** (the capability probe) against the dev lakehouse.
3. On green, build the **golden dataset generator + parity CI**, completing Phase 0.

If GATE 1 reveals a DuckDB limitation (e.g. partition-transform DDL), the fallback is
already noted inline: create table DDL via pyiceberg/Trino, `INSERT`/`MERGE` from
DuckDB — the write path still holds.
