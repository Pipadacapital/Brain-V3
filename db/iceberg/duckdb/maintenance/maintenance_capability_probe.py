#!/usr/bin/env python3
"""
maintenance_capability_probe.py — Trino-removal migration (ADR-0014), plan §D3, merge-precondition gate.

Proves — against the REAL Brain Iceberg REST catalog — that the PyIceberg + DuckDB maintenance tier
(_maintenance_base.py) can do EVERYTHING the Trino maintenance client did, codifying what the Phase-0
spikes established. Per the migration protocol §7: if a capability fails and cannot be resolved, we
PAUSE and report rather than circumventing the architecture.

It never touches real medallion data: all writes go to a scratch namespace
(brain_maintenance_probe) that is dropped at the end.

Capabilities probed (maps to the plan §D invariants; letters = the Phase-0 spike gates they codify):
  1. PyIceberg REST-catalog connectivity + medallion namespace listing        (env parity)
  2. DuckDB-write → PyIceberg-read parity + manifest-inheritance shim          (the 0.11.1 setter bug)
     + money BIGINT minor-unit integrity across the two clients                (invariant #5)
  3. COW delete — table.delete() rewrites data files, ZERO delete files        (spike g; RTBF primitive)
  4. expire_snapshots + physical sweep — old bytes GONE from S3                (spike h; RTBF bytes-gone)
  5. optimize — COW rewrite compacts small files; skip heuristic no-ops        (the Trino EXECUTE
     on the already-compacted table                                             optimize replacement)
  6. Overwrite atomicity — a stale-snapshot commit racing a concurrent         (plan risk #4;
     append FAILS (CommitFailedException) and the bounded re-read retry         commit-conflict retry)
     preserves the concurrent write
  7. MoR positional-delete posture — PyIceberg scans honour DuckDB delete      (spike i, the mitigation
     files; forced rewrite gets deleted rows out of the live data files;        boundary: delete files
     the delete parquet carries NO row data (file_path+pos only)                are metadata-permanent)
  8. RTBF erasure e2e mini — brand-scoped COW delete + expire(0) leaves         (the D4/I-S05 proof:
     0 rows in BOTH engines and the pre-delete objects absent from S3           bytes physically gone)
  9. remove_orphan_files — EXPECTED loud SKIP (no pyiceberg API yet;            (accepted deferred gap,
     the gap must stay greppable in every run)                                  ADR-0014)

Run:
  # local/dev (compose up: iceberg-rest + minio):
  S3_ENDPOINT=http://localhost:9000 ICEBERG_REST_URI=http://localhost:8181 \
    AWS_ACCESS_KEY_ID=brain AWS_SECRET_ACCESS_KEY=brainbrain \
    python db/iceberg/duckdb/maintenance/maintenance_capability_probe.py

  # in-cluster (prod, IRSA): leave S3_ENDPOINT unset; ICEBERG_REST_URI → the rest svc; run as a
  # one-off Argo Workflow with the brain-jobs ServiceAccount before flipping the crons (plan §D3).

Exit code 0 = all critical capabilities PASS (gate 9 SKIP is expected). Non-zero = a gate failure.
"""
from __future__ import annotations

import os
import sys
import traceback

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))  # parent dir: _catalog.py (the DuckDB attach seam)

import _catalog  # noqa: E402
import _maintenance_base as mb  # noqa: E402  (importing it applies the manifest shim under test)

PROBE_NS = "brain_maintenance_probe"
RESULTS: list[tuple[str, str, str]] = []  # (name, status, detail)


def record(name: str, status: str, detail: str = "") -> None:
    RESULTS.append((name, status, detail))
    icon = {"PASS": "✅", "FAIL": "❌", "SKIP": "⚠️ "}.get(status, "  ")
    print(f"  {icon} {name}: {status}{'  — ' + detail if detail else ''}", flush=True)


def files_by_content(tbl) -> "tuple[list[str], list[str]]":
    """inspect.files() → (data_file_paths, delete_file_paths) for the CURRENT snapshot."""
    data, deletes = [], []
    for row in tbl.inspect.files().to_pylist():
        (data if row["content"] == 0 else deletes).append(row["file_path"])
    return data, deletes


def s3_exists(tbl, path: str) -> bool:
    """Object existence through the table's own FileIO (works local/MinIO AND prod/IRSA)."""
    return tbl.io.new_input(path).exists()


def probe(con, cat) -> None:
    big = 9_223_372_036_854_775_000  # near int64 max — a float coercion anywhere would lose precision

    # ── 1. PyIceberg connectivity + medallion namespaces ────────────────────────
    try:
        namespaces = {ns[-1] for ns in cat.list_namespaces()}
        have = [n for n in ("brain_bronze", "brain_silver", "brain_gold") if n in namespaces]
        cat.create_namespace_if_not_exists(PROBE_NS)
        record("1. pyiceberg REST connectivity + namespaces", "PASS", f"found {have}; scratch ns ready")
    except Exception as e:  # noqa: BLE001
        record("1. pyiceberg REST connectivity + namespaces", "FAIL", repr(e))
        return  # nothing else can run

    tbl_fq = mb.fqtn(PROBE_NS, "probe_t")  # DuckDB name
    tbl_id = mb.ident(PROBE_NS, "probe_t")  # PyIceberg name

    # ── 2. DuckDB-write → PyIceberg-read parity + manifest shim + BIGINT money ──
    # DuckDB writes spec-compliant manifests with null snapshot_id (metadata inheritance) — the
    # exact shape that trips the un-shimmed pyiceberg 0.11.1 setter bug on EVERY read-for-rewrite.
    try:
        con.execute(f"DROP TABLE IF EXISTS {tbl_fq};")
        con.execute(f"CREATE TABLE {tbl_fq} (brand_id VARCHAR, id BIGINT, amount_minor BIGINT);")
        con.execute(f"INSERT INTO {tbl_fq} VALUES ('brand_a', 1, 100), ('brand_a', 2, 250), ('brand_b', 3, {big});")
        tbl = cat.load_table(tbl_id)
        rows = tbl.scan().to_arrow().to_pylist()
        got_big = next(r["amount_minor"] for r in rows if r["id"] == 3)
        ok = len(rows) == 3 and got_big == big
        record("2. duckdb-write → pyiceberg-read + shim + BIGINT", "PASS" if ok else "FAIL",
               f"{len(rows)} rows (expect 3); amount_minor={got_big} (expect {big})")
    except Exception as e:  # noqa: BLE001
        record("2. duckdb-write → pyiceberg-read + shim + BIGINT", "FAIL", repr(e))
        return  # every later gate rewrites duckdb-written manifests

    # ── 3. COW delete — rewrites data files, zero delete files (spike g) ────────
    pre_cow_files: "list[str]" = []
    try:
        tbl = cat.load_table(tbl_id)
        pre_cow_files, pre_del = files_by_content(tbl)
        assert pre_cow_files and not pre_del, f"unexpected pre-state: deletes={pre_del}"
        from pyiceberg.expressions import EqualTo
        mb.delete(cat, PROBE_NS, "probe_t", EqualTo("id", 2))
        tbl = cat.load_table(tbl_id)
        post_data, post_del = files_by_content(tbl)
        ids = sorted(r["id"] for r in tbl.scan().to_arrow().to_pylist())
        n_duck = con.execute(f"SELECT count(*) FROM {tbl_fq}").fetchone()[0]
        ok = ids == [1, 3] and n_duck == 2 and not post_del and set(post_data) != set(pre_cow_files)
        record("3. COW delete (zero delete files)", "PASS" if ok else "FAIL",
               f"ids={ids} duckdb={n_duck}; delete_files={len(post_del)}; files rewritten={set(post_data) != set(pre_cow_files)}")
    except Exception as e:  # noqa: BLE001
        record("3. COW delete (zero delete files)", "FAIL", repr(e))

    # ── 4. expire + physical sweep — pre-COW bytes GONE from S3 (spike h) ───────
    try:
        tbl = cat.load_table(tbl_id)
        assert pre_cow_files, "gate 3 did not record pre-delete files"
        assert all(s3_exists(tbl, p) for p in pre_cow_files), "pre-delete files already missing before expire"
        mb.expire(cat, PROBE_NS, "probe_t", 0)  # ttl 0ms → cutoff=now (the RTBF shape)
        tbl = cat.load_table(tbl_id)
        snaps = len(tbl.inspect.snapshots().to_pylist())
        still = [p for p in pre_cow_files if s3_exists(tbl, p)]
        n = len(tbl.scan().to_arrow())
        ok = snaps == 1 and not still and n == 2
        record("4. expire + sweep physically deletes S3 bytes", "PASS" if ok else "FAIL",
               f"snapshots={snaps} (expect 1); pre-COW objects remaining={still or 'none'}; rows intact={n}")
    except Exception as e:  # noqa: BLE001
        record("4. expire + sweep physically deletes S3 bytes", "FAIL", repr(e))

    # ── 5. optimize — compacts small files; skip heuristic no-ops when compact ──
    try:
        opt_fq, opt_id = mb.fqtn(PROBE_NS, "probe_opt"), mb.ident(PROBE_NS, "probe_opt")
        con.execute(f"DROP TABLE IF EXISTS {opt_fq};")
        con.execute(f"CREATE TABLE {opt_fq} (brand_id VARCHAR, amount_minor BIGINT);")
        for i in range(3):  # three separate commits → three small data files (the Connect-sink shape)
            con.execute(f"INSERT INTO {opt_fq} VALUES ('brand_a', {100 + i}), ('brand_b', {big});")
        pre_files, _ = files_by_content(cat.load_table(opt_id))
        pre_sum = con.execute(f"SELECT count(*), sum(amount_minor) FROM {opt_fq}").fetchone()
        mb.optimize(cat, PROBE_NS, "probe_opt")
        tbl = cat.load_table(opt_id)
        post_files, _ = files_by_content(tbl)
        post_sum = con.execute(f"SELECT count(*), sum(amount_minor) FROM {opt_fq}").fetchone()
        snap_before_noop = tbl.current_snapshot().snapshot_id
        mb.optimize(cat, PROBE_NS, "probe_opt")  # already compacted → heuristic must no-op
        snap_after_noop = cat.load_table(opt_id).current_snapshot().snapshot_id
        ok = (len(pre_files) >= 3 and len(post_files) < len(pre_files)
              and pre_sum == post_sum and snap_before_noop == snap_after_noop)
        record("5. optimize compaction + skip heuristic", "PASS" if ok else "FAIL",
               f"files {len(pre_files)}→{len(post_files)}; (count,sum) {pre_sum}→{post_sum}; noop={snap_before_noop == snap_after_noop}")
    except Exception as e:  # noqa: BLE001
        record("5. optimize compaction + skip heuristic", "FAIL", repr(e))

    # ── 6. overwrite atomicity + commit-conflict bounded retry (plan risk #4) ───
    try:
        from pyiceberg.exceptions import CommitFailedException
        from pyiceberg.expressions import AlwaysTrue
        stale = cat.load_table(mb.ident(PROBE_NS, "probe_opt"))
        stale_rows = stale.scan().to_arrow()
        con.execute(f"INSERT INTO {mb.fqtn(PROBE_NS, 'probe_opt')} VALUES ('brand_c', 777);")  # concurrent append
        conflicted = False
        try:
            stale.overwrite(stale_rows, overwrite_filter=AlwaysTrue())
        except CommitFailedException:
            conflicted = True  # the catalog rejected the stale-snapshot commit — atomicity holds
        assert conflicted, "stale-snapshot overwrite COMMITTED (concurrent append silently clobbered)"
        # The retry path re-reads from the NEW snapshot, so the concurrent append survives.
        mb._overwrite_with_retry(cat, PROBE_NS, "probe_opt", AlwaysTrue(), "TRUE")
        n = con.execute(f"SELECT count(*) FROM {mb.fqtn(PROBE_NS, 'probe_opt')} WHERE brand_id='brand_c'").fetchone()[0]
        record("6. overwrite atomicity + conflict retry", "PASS" if n == 1 else "FAIL",
               f"stale commit rejected; retry preserved concurrent append (brand_c rows={n})")
    except Exception as e:  # noqa: BLE001
        record("6. overwrite atomicity + conflict retry", "FAIL", repr(e))

    # ── 7. MoR positional-delete posture (spike i mitigation boundary) ──────────
    try:
        mor_fq, mor_id = mb.fqtn(PROBE_NS, "probe_mor"), mb.ident(PROBE_NS, "probe_mor")
        con.execute(f"DROP TABLE IF EXISTS {mor_fq};")
        con.execute(f"CREATE TABLE {mor_fq} (id BIGINT, amount_minor BIGINT);")
        con.execute(f"INSERT INTO {mor_fq} VALUES (1, 10), (2, 20), (3, 30), (4, 40);")
        con.execute(f"DELETE FROM {mor_fq} WHERE id = 2;")  # DuckDB merge-on-read positional delete
        tbl = cat.load_table(mor_id)
        _, mor_dels = files_by_content(tbl)
        ids = sorted(tbl.scan().to_arrow()["id"].to_pylist())
        assert ids == [1, 3, 4], f"pyiceberg scan wrong over duckdb MoR delete: {ids}"
        # Delete files must carry NO row data — coordinates only (file_path, pos), never PII bytes.
        import pyarrow.parquet as pq
        del_cols: "list[str]" = []
        for p in mor_dels:
            with tbl.io.new_input(p).open() as f:
                del_cols = pq.read_schema(f).names
            assert set(del_cols) <= {"file_path", "pos"}, f"delete file carries row data: {del_cols}"
        # Forced rewrite (the retention-lane shape) gets the deleted rows out of the live data files.
        mb.optimize(cat, PROBE_NS, "probe_mor", force=True)
        n_duck = con.execute(f"SELECT count(*) FROM {mor_fq}").fetchone()[0]
        n_pyi = len(cat.load_table(mor_id).scan().to_arrow())
        ok = n_duck == 3 and n_pyi == 3
        note = f"{len(mor_dels)} delete file(s) cols={del_cols or 'n/a'}" if mor_dels else "duckdb delete was COW (no delete files)"
        record("7. MoR delete posture + forced rewrite", "PASS" if ok else "FAIL",
               f"{note}; post-rewrite duckdb={n_duck} pyiceberg={n_pyi} (expect 3/3)")
    except Exception as e:  # noqa: BLE001
        record("7. MoR delete posture + forced rewrite", "FAIL", repr(e))

    # ── 8. RTBF erasure e2e mini — brand-scoped, bytes physically gone ──────────
    try:
        from pyiceberg.expressions import EqualTo
        rt_fq, rt_id = mb.fqtn(PROBE_NS, "probe_rtbf"), mb.ident(PROBE_NS, "probe_rtbf")
        con.execute(f"DROP TABLE IF EXISTS {rt_fq};")
        con.execute(f"CREATE TABLE {rt_fq} (brand_id VARCHAR, identifier_hash VARCHAR, amount_minor BIGINT);")
        con.execute(
            f"INSERT INTO {rt_fq} VALUES "
            f"('erase-me', 'aa', 1), ('erase-me', 'bb', 2), ('keep-me', 'cc', 3);"
        )
        tbl = cat.load_table(rt_id)
        pre_files, _ = files_by_content(tbl)
        # The erasure sequence the ported jobs run: COW delete (brand_id FIRST) → expire(0) + sweep.
        mb.delete(cat, PROBE_NS, "probe_rtbf", EqualTo("brand_id", "erase-me"))
        mb.expire(cat, PROBE_NS, "probe_rtbf", 0)
        tbl = cat.load_table(rt_id)
        n_duck = con.execute(f"SELECT count(*) FROM {rt_fq} WHERE brand_id = 'erase-me'").fetchone()[0]
        n_pyi = len(tbl.scan(row_filter=EqualTo("brand_id", "erase-me")).to_arrow())
        kept = con.execute(f"SELECT count(*) FROM {rt_fq} WHERE brand_id = 'keep-me'").fetchone()[0]
        still = [p for p in pre_files if s3_exists(tbl, p)]
        snaps = len(tbl.inspect.snapshots().to_pylist())
        ok = n_duck == 0 and n_pyi == 0 and kept == 1 and not still and snaps == 1
        record("8. RTBF erasure e2e (bytes gone, tenant-scoped)", "PASS" if ok else "FAIL",
               f"erased rows duckdb={n_duck}/pyiceberg={n_pyi}; other-brand kept={kept}; "
               f"pre-delete objects remaining={still or 'none'}; snapshots={snaps}")
    except Exception as e:  # noqa: BLE001
        record("8. RTBF erasure e2e (bytes gone, tenant-scoped)", "FAIL", repr(e))

    # ── 9. remove_orphan_files — EXPECTED loud SKIP (deferred gap, ADR-0014) ────
    try:
        mb.remove_orphans(cat, PROBE_NS, "probe_t", 3)
        record("9. remove_orphan_files (deferred gap)", "SKIP",
               "no pyiceberg API — loud greppable SKIP is the accepted posture; revisit per release")
    except Exception as e:  # noqa: BLE001
        record("9. remove_orphan_files (deferred gap)", "FAIL", f"SKIP path itself failed: {e!r}")


def main() -> int:
    print("=" * 78)
    print("Trino-removal migration · plan §D3 · PyIceberg+DuckDB maintenance capability probe")
    print("=" * 78)
    try:
        con = mb.duckdb_connect()
        cat = mb.pyiceberg_catalog()
    except Exception as e:  # noqa: BLE001
        print(f"\n❌ Could not open the DuckDB/PyIceberg catalog seams: {e}\n")
        traceback.print_exc()
        return 2
    try:
        probe(con, cat)
    finally:
        # Scratch cleanup — purge (drop + delete files) each probe table, then drop the namespace.
        try:
            for t in ("probe_t", "probe_opt", "probe_mor", "probe_rtbf"):
                try:
                    cat.purge_table(mb.ident(PROBE_NS, t))
                except Exception:  # noqa: BLE001 — table may not exist if an early gate bailed
                    pass
            cat.drop_namespace(PROBE_NS)
            record("cleanup scratch namespace", "PASS", PROBE_NS)
        except Exception as e:  # noqa: BLE001
            record("cleanup scratch namespace", "SKIP", f"manual drop needed: {e!r}")

    fails = [r for r in RESULTS if r[1] == "FAIL"]
    print("-" * 78)
    print(f"RESULT: {sum(1 for r in RESULTS if r[1] == 'PASS')} pass · "
          f"{len(fails)} fail · {sum(1 for r in RESULTS if r[1] == 'SKIP')} skip (orphan SKIP expected)")
    if fails:
        print("\n⛔ GATE FAILED — pause the migration and report these (protocol §7):")
        for name, _, detail in fails:
            print(f"     • {name}: {detail}")
        return 1
    print("\n✅ MAINTENANCE GATE PASSED — PyIceberg+DuckDB can fill the Trino maintenance slot.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
