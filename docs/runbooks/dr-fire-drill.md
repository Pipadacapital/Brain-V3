# DR fire drill — coordinated Aurora-PITR + S3-version restore

> **STATUS: PENDING EXECUTION — this drill has NOT been run.** It is the verification step for
> the two AUD-OPS-013 HYPOTHESES:
> (H1) a coordinated Aurora-catalog + S3-warehouse restore is viable within the 90-day
> noncurrent-version window; (H2) is deliberately descoped here (Neo4j rebuild from
> `silver_identity_map` — no rebuild job exists; see DR.md §6.3).
> **Do not run unattended**: it creates a billable restore cluster and needs the owner's
> per-service cost sign-off (cost-first posture). Everything below is prepared so the drill is a
> ~2-hour supervised exercise.

## What it proves

1. RB-1 works end-to-end (PITR to a new cluster, data verifiable).
2. `tools/dr/s3-version-restore.sh` restores a Bronze table's S3 objects to T correctly.
3. A PITR'd `iceberg_catalog` + version-restored S3 prefix = a READABLE Iceberg table at T
   (pointers resolve; duckdb-serving serves it) — the actual H1 claim.
4. Measured RTO numbers to replace the conservative estimates in DR.md §2.

## Blast-radius containment (why this is safe to run against prod data)

- The Aurora restore is **to a NEW cluster** — the live cluster is never written.
- The S3 restore targets a **COPY table** created for the drill — never a live table's prefix.
- Nothing is repointed; no live Secret/values change; writers are never frozen.
- Everything created carries the `drill-` prefix and is torn down in step 6.

## Cost (advise-once)

Restore cluster: Aurora Serverless v2 @ 0.5 ACU for ~2 h ≈ **well under $1** + restored-storage
hours. S3: request costs only (copies are within-bucket). Total: a few dollars.

## Procedure

### 0. Preconditions
- [ ] Owner sign-off (cost + prod-account access).
- [ ] EKS API reachable (`kubectl get nodes`), `aws sts get-caller-identity` = prod account.
- [ ] Pick the drill table: a SMALL real one, e.g. `brain_bronze.shopify_order_raw_connect`
      (or any modest `*_raw_connect` lane; NOT `collector_events_connect` — size).

### 1. Create the drill table (a real Iceberg table with history)
Via a DuckDB shell in-cluster (same brain-duckdb image as the crons — read-write `_catalog.connect()`):
```sql
CREATE TABLE iceberg.brain_bronze.drill_restore_target AS
  SELECT * FROM iceberg.brain_bronze.<drill-source-table>;
-- record: T0 = now(); count0 = SELECT count(*) ...
-- mutate to create post-T0 history:
DELETE FROM iceberg.brain_bronze.drill_restore_target WHERE true;  -- or a partial delete
-- record: count1 (≠ count0), T1 = now()
```

### 2. RB-1 — PITR the cluster to T0
Follow RB-1 §2 with `--restore-to-time T0` (skip §1 freeze and §4 repoint — drill mode).
Verify per RB-1 §3. **Record wall-clock: PITR start → verified.**

### 3. Harvest the catalog rows at T0
From the restored cluster, extract the drill table's catalog pointer:
```bash
psql "<restored>/iceberg_catalog" -c \
 "select metadata_location, previous_metadata_location from iceberg_tables where table_name='drill_restore_target';"
```
Write those T0 pointer values over the LIVE catalog's row for `drill_restore_target` ONLY
(single-row UPDATE — this is the drill-scale stand-in for DR.md §4's dump/load).

### 4. S3 point-in-time restore to T0
```bash
tools/dr/s3-version-restore.sh --bucket brain-bronze-prod-<acct> \
  --prefix brain_bronze/drill_restore_target/ --timestamp <T0>          # DRY-RUN — review plan
tools/dr/s3-version-restore.sh ... --execute
kubectl -n iceberg-rest rollout restart deploy && kubectl -n iceberg-rest rollout status deploy
```

### 5. Verify (the H1 acceptance gate)
- [ ] `SELECT count(*) FROM iceberg.brain_bronze.drill_restore_target` = **count0** via
      duckdb-serving (`POST /v1/query`).
- [ ] `iceberg_snapshots(...)` lists the T0 snapshot as current; no `NotFoundException` on metadata reads.
- [ ] A PyIceberg scan of the same table returns count0 (both clients resolve the restored pointers).
- [ ] Record wall-clock: total drill time = measured coordinated-restore RTO.

### 6. Teardown
```bash
DROP TABLE iceberg.brain_bronze.drill_restore_target;          # then let maintenance sweep files
aws rds delete-db-instance --db-instance-identifier brain-prod-postgres-restore-...-1 --skip-final-snapshot
aws rds delete-db-cluster  --db-cluster-identifier brain-prod-postgres-restore-... --skip-final-snapshot
```

### 7. Record the verdict (mandatory)
Update **DR.md**: flip §4's HYPOTHESIS → MEASURED (or document exactly where it failed), replace
the RTO estimates in §2 with the recorded wall-clocks, and note the drill date. If the drill
FAILS at step 5, the finding escalates: AUD-OPS-013's restore design needs rework (likely
candidates: expired metadata referenced by the T0 pointer — re-run with a T0 inside the snapshot
TTL window; or REST-catalog caching — verify the rollout-restart happened).
