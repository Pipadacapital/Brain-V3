# Iceberg Bronze — Schema Evolution Policy

**Invariant: I-E02 (non-retrofittable decision, established at table creation)**

## The rule: additive-optional only

The Bronze layer is the system of record for all raw events (24-month retention, append-only).
Schema evolution of the Bronze table is **additive-optional only**:

| Change | Allowed | Rationale |
|--------|---------|-----------|
| Add a new nullable column with a default | YES | Readers of prior snapshots read `null`; writer is compatible |
| Change a column type (widening, e.g. int→long) | YES (with care) | Only if ALL prior readers can handle the widened type |
| Remove a column | NO | Prior snapshots would lose data on re-read; Avro FULL_TRANSITIVE rejects this |
| Rename a column | NO (use `alterColumn` alias) | Breaks all readers of prior column name |
| Make a nullable column required | NO | Prior nulls become invalid |
| Change a column type (incompatible, e.g. string→int) | NO | Type mismatch on prior data |
| Change the partition spec | PARTITION EVOLUTION ONLY | Add new partition fields via `ALTER TABLE ... ADD PARTITION FIELD` — never replace |
| Increase bucket count | YES, via partition evolution | Creates a new sort order for new files; old files remain on prior spec |

## Why FULL_TRANSITIVE in Apicurio

`FULL_TRANSITIVE` means every schema version must be both forward- and backward-compatible with
**every prior version**, not just the immediately preceding one. This ensures:
- A stream-worker on schema v3 can read events written under v1 and v2 (backward).
- A stream-worker on schema v1 can read events written under v3 (forward — new optional fields are ignored).
- Replay from any point in the 24-month window is always decodable.

## Enforcement

1. **CI gate:** Apicurio rejects non-additive schema changes on PR. The `test:contract` job in
   `pr.yml` registers the PR's Avro schema and asserts the registry returns HTTP 200 (compatible)
   or fails the build.
2. **Manual check:** Before any Bronze DDL change, run `DESCRIBE EXTENDED brain_bronze.collector_events`
   and confirm no existing column is modified.
3. **Partition spec changes:** Use Iceberg's `ALTER TABLE ... ADD PARTITION FIELD` — never
   `REPLACE PARTITION FIELD` on an existing field. Old files keep their prior partition layout;
   new files use the extended spec. Both are queryable transparently.

## Replay invariant

Because Bronze is append-only and immutable, any Silver/Gold table is rebuildable from Bronze
by re-running the stream-worker + dbt pipeline over the same snapshot range. This is the
replayability guarantee of I-E02.

Replay procedure:
1. Identify the target date range and affected brands.
2. Produce Bronze events for that range to the backfill Redpanda lane (`{env}.collector.event.v1.backfill`).
3. The stream-worker backfill consumer group processes them with the same pipeline code as live.
4. Dedup on `(brand_id, event_id)` prevents double-counting in Bronze (idempotent write via
   `MERGE INTO ... WHEN NOT MATCHED THEN INSERT`).
5. Re-run dbt Silver/Gold models for the affected date range.

## Per-brand S3 prefix layout

```
s3://brain-bronze/
  brand_id=<uuid>/
    year=YYYY/
      month=MM/
        day=DD/
          <parquet-files>
```

The per-brand prefix is enforced by the IRSA IAM policy (`NN-5`): the stream-worker's IAM role
can only `PutObject` under its own brand prefix. The Analytics API / StarRocks reader role can
only `GetObject` under the prefix its query scope authorizes.
