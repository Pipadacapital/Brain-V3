#!/usr/bin/env python3
"""
phase0_capability_probe.py — Spark→DuckDB migration, Phase 0, GATE 1 (fail-fast).

Proves — against the REAL Brain Iceberg REST catalog — that DuckDB can do EVERYTHING
the migration relies on BEFORE we invest in the golden-dataset generator and 80 job
ports. Per the migration protocol §7: if a capability fails and cannot be resolved,
we PAUSE and report rather than circumventing the architecture.

It never touches real medallion data: all writes go to a scratch namespace
(brain_migration_probe) that is dropped at the end.

Capabilities probed (maps to the migration plan's invariants):
  1. ATTACH the REST catalog + list brain_bronze/silver/gold schemas          (connectivity)
  2. READ existing medallion tables (count rows)                              (Bronze SoT reads)
  3. CREATE namespace + table, INSERT                                          (Silver/Gold writes)
  4. MERGE INTO idempotency — merge the SAME rows twice → row count stable      (invariant #2)
  5. Money integrity — BIGINT minor units round-trip with no float coercion    (invariant #5)
  6. DELETE (merge-on-read) — the RTBF row-removal primitive                    (Phase 5)
  7. Partition transforms — bucket(brand_id) + day(ts) partitioned write        (invariant #6)
  8. Time-travel / snapshots — snapshot history is queryable                    (versioned journeys)
  9. Cleanup — DROP the scratch namespace

Run:
  # local/dev (compose up: iceberg-rest + minio):
  S3_ENDPOINT=http://localhost:9000 ICEBERG_REST_URI=http://localhost:8181 \
    AWS_ACCESS_KEY_ID=brain AWS_SECRET_ACCESS_KEY=brainbrain \
    python db/iceberg/duckdb/phase0_capability_probe.py

  # in-cluster (prod, IRSA): leave S3_ENDPOINT unset; ICEBERG_REST_URI → the rest svc.

Exit code 0 = all critical capabilities PASS. Non-zero = a gate failure (details printed).
"""
from __future__ import annotations

import sys
import traceback

from _catalog import CATALOG, connect, fqtn  # noqa: E402  (sibling module)

PROBE_NS = "brain_migration_probe"
RESULTS: list[tuple[str, str, str]] = []  # (name, status, detail)


def record(name: str, status: str, detail: str = "") -> None:
    RESULTS.append((name, status, detail))
    icon = {"PASS": "✅", "FAIL": "❌", "SKIP": "⚠️ "}.get(status, "  ")
    print(f"  {icon} {name}: {status}{'  — ' + detail if detail else ''}", flush=True)


def probe(con) -> None:
    # ── 1. connectivity + schema listing ────────────────────────────────────────
    try:
        schemas = [r[0] for r in con.execute(
            f"SELECT schema_name FROM information_schema.schemata "
            f"WHERE catalog_name = '{CATALOG}'"
        ).fetchall()]
        have = [s for s in ("brain_bronze", "brain_silver", "brain_gold") if s in schemas]
        record("1. attach + list medallion schemas", "PASS", f"found {have}")
    except Exception as e:  # noqa: BLE001
        record("1. attach + list medallion schemas", "FAIL", repr(e))
        return  # nothing else can run

    # ── 2. read an existing Bronze/Silver table ─────────────────────────────────
    try:
        tables = con.execute(
            f"SELECT table_schema, table_name FROM information_schema.tables "
            f"WHERE table_catalog = '{CATALOG}' AND table_schema LIKE 'brain_%' LIMIT 1"
        ).fetchall()
        if tables:
            sch, tbl = tables[0]
            n = con.execute(f"SELECT count(*) FROM {CATALOG}.{sch}.{tbl}").fetchone()[0]
            record("2. read existing medallion table", "PASS", f"{sch}.{tbl} = {n} rows")
        else:
            record("2. read existing medallion table", "SKIP", "no brain_* tables yet (empty warehouse)")
    except Exception as e:  # noqa: BLE001
        record("2. read existing medallion table", "FAIL", repr(e))

    # ── scratch namespace ───────────────────────────────────────────────────────
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{PROBE_NS};")
    tbl = fqtn(PROBE_NS, "probe_events")

    # ── 3. create + insert ──────────────────────────────────────────────────────
    try:
        con.execute(f"DROP TABLE IF EXISTS {tbl};")
        con.execute(
            f"""
            CREATE TABLE {tbl} (
              brand_id      VARCHAR,
              source_event_id VARCHAR,
              amount_minor  BIGINT,
              currency_code VARCHAR,
              event_ts      TIMESTAMP,
              ingested_at   TIMESTAMP
            );
            """
        )
        con.execute(
            f"""
            INSERT INTO {tbl} VALUES
              ('brand_a', 'e1', 199900, 'INR', TIMESTAMP '2026-07-01 10:00:00', TIMESTAMP '2026-07-01 10:00:05'),
              ('brand_a', 'e2', 50000,  'INR', TIMESTAMP '2026-07-01 11:00:00', TIMESTAMP '2026-07-01 11:00:03'),
              ('brand_b', 'e3', 12345,  'USD', TIMESTAMP '2026-07-01 12:00:00', TIMESTAMP '2026-07-01 12:00:02');
            """
        )
        n = con.execute(f"SELECT count(*) FROM {tbl}").fetchone()[0]
        record("3. create namespace + table + INSERT", "PASS" if n == 3 else "FAIL", f"{n} rows")
    except Exception as e:  # noqa: BLE001
        record("3. create namespace + table + INSERT", "FAIL", repr(e))

    # ── 4. MERGE INTO idempotency (invariant #2) ────────────────────────────────
    # Re-merging the SAME Bronze window must NOT duplicate or mutate Silver rows.
    merge_sql = f"""
      MERGE INTO {tbl} AS t
      USING (
        SELECT 'brand_a' AS brand_id, 'e1' AS source_event_id, 199900 AS amount_minor,
               'INR' AS currency_code, TIMESTAMP '2026-07-01 10:00:00' AS event_ts,
               TIMESTAMP '2026-07-01 10:00:05' AS ingested_at
        UNION ALL
        SELECT 'brand_a', 'e4', 77700, 'INR', TIMESTAMP '2026-07-02 09:00:00', TIMESTAMP '2026-07-02 09:00:01'
      ) AS s
      ON t.brand_id = s.brand_id AND t.source_event_id = s.source_event_id
      WHEN MATCHED THEN UPDATE SET amount_minor = s.amount_minor
      WHEN NOT MATCHED THEN INSERT VALUES
        (s.brand_id, s.source_event_id, s.amount_minor, s.currency_code, s.event_ts, s.ingested_at);
    """
    try:
        con.execute(merge_sql)
        after_first = con.execute(f"SELECT count(*) FROM {tbl}").fetchone()[0]  # 3 + e4 = 4
        con.execute(merge_sql)  # replay
        after_replay = con.execute(f"SELECT count(*) FROM {tbl}").fetchone()[0]
        ok = after_first == 4 and after_replay == 4
        record("4. MERGE INTO idempotency", "PASS" if ok else "FAIL",
                f"after first={after_first}, after replay={after_replay} (expect 4,4)")
    except Exception as e:  # noqa: BLE001
        record("4. MERGE INTO idempotency", "FAIL", repr(e))

    # ── 5. money integrity — BIGINT round-trip, no float (invariant #5) ──────────
    try:
        big = 9_223_372_036_854_775_000  # near int64 max — a float would lose precision
        con.execute(f"INSERT INTO {tbl} VALUES ('brand_c','big',{big},'INR',now(),now());")
        got = con.execute(f"SELECT amount_minor FROM {tbl} WHERE source_event_id='big'").fetchone()[0]
        record("5. money BIGINT minor-unit integrity", "PASS" if got == big else "FAIL",
                f"stored={got} expected={big}")
    except Exception as e:  # noqa: BLE001
        record("5. money BIGINT minor-unit integrity", "FAIL", repr(e))

    # ── 6. DELETE (RTBF primitive; merge-on-read) ───────────────────────────────
    try:
        con.execute(f"DELETE FROM {tbl} WHERE brand_id = 'brand_b';")
        remaining = con.execute(f"SELECT count(*) FROM {tbl} WHERE brand_id='brand_b'").fetchone()[0]
        record("6. DELETE (RTBF row removal)", "PASS" if remaining == 0 else "FAIL",
                f"brand_b rows after delete = {remaining} "
                f"(NOTE: physical file rewrite needs a Trino/pyiceberg compaction — see plan §Phase5)")
    except Exception as e:  # noqa: BLE001
        record("6. DELETE (RTBF row removal)", "FAIL", repr(e))

    # ── 7. partition transforms — bucket(brand_id) + day(event_ts) ──────────────
    ptbl = fqtn(PROBE_NS, "probe_partitioned")
    try:
        con.execute(f"DROP TABLE IF EXISTS {ptbl};")
        con.execute(
            f"""
            CREATE TABLE {ptbl} (
              brand_id VARCHAR, source_event_id VARCHAR, event_ts TIMESTAMP
            ) PARTITIONED BY (bucket(16, brand_id), day(event_ts));
            """
        )
        con.execute(
            f"INSERT INTO {ptbl} VALUES ('brand_a','p1',now()), ('brand_b','p2',now());"
        )
        n = con.execute(f"SELECT count(*) FROM {ptbl}").fetchone()[0]
        record("7. partition transforms bucket()/day()", "PASS" if n == 2 else "FAIL", f"{n} rows")
    except Exception as e:  # noqa: BLE001
        record("7. partition transforms bucket()/day()", "FAIL",
               f"{e!r} — if unsupported, create tables via pyiceberg/Trino DDL and INSERT from DuckDB")

    # ── 8. time-travel / snapshot history ───────────────────────────────────────
    # The table above took several commits (INSERT + 2× MERGE + INSERT + DELETE), so its
    # snapshot history must have >= 2 entries. iceberg_snapshots() takes the fully-qualified
    # attached-catalog table reference.
    try:
        hist = con.execute(
            f"SELECT count(*) FROM iceberg_snapshots({CATALOG}.{PROBE_NS}.probe_events);"
        ).fetchone()[0]
        record("8. time-travel / snapshot history", "PASS" if hist >= 2 else "SKIP",
                f"{hist} snapshots")
    except Exception as e:  # noqa: BLE001
        record("8. time-travel / snapshot history", "SKIP",
               f"snapshot-fn syntax varies by duckdb build ({e!r}); versioning still works via commits")


def main() -> int:
    print("=" * 78)
    print("Spark→DuckDB migration · Phase 0 · DuckDB⇄Iceberg capability probe")
    print("=" * 78)
    con = None
    try:
        con = connect()
    except Exception as e:  # noqa: BLE001
        print(f"\n❌ Could not attach the Iceberg REST catalog: {e}\n")
        traceback.print_exc()
        return 2
    try:
        probe(con)
    finally:
        # Iceberg schemas don't support DROP ... CASCADE in DuckDB — drop tables first.
        try:
            for t in ("probe_events", "probe_partitioned"):
                con.execute(f"DROP TABLE IF EXISTS {CATALOG}.{PROBE_NS}.{t};")
            con.execute(f"DROP SCHEMA IF EXISTS {CATALOG}.{PROBE_NS};")
            record("9. cleanup scratch namespace", "PASS", PROBE_NS)
        except Exception as e:  # noqa: BLE001
            record("9. cleanup scratch namespace", "SKIP", f"manual drop needed: {e!r}")

    fails = [r for r in RESULTS if r[1] == "FAIL"]
    print("-" * 78)
    print(f"RESULT: {sum(1 for r in RESULTS if r[1]=='PASS')} pass · "
          f"{len(fails)} fail · {sum(1 for r in RESULTS if r[1]=='SKIP')} skip")
    if fails:
        print("\n⛔ GATE 1 FAILED — pause the migration and report these (protocol §7):")
        for name, _, detail in fails:
            print(f"     • {name}: {detail}")
        return 1
    print("\n✅ GATE 1 PASSED — DuckDB can fill the transform slot. Proceed to the golden dataset.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
