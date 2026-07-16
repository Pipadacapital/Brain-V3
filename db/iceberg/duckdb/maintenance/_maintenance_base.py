"""
_maintenance_base.py — the shared PyIceberg ⇄ Iceberg maintenance seam (Trino-removal migration,
ADR-0014).

This is the successor of db/iceberg/trino/trino_base.py: the ONE place that opens a PyIceberg
catalog handle (plus a DuckDB read connection) to the SAME Iceberg REST catalog every DuckDB
transform job uses, and the ONE place that implements the three Iceberg maintenance operations
Trino used to run as `ALTER TABLE … EXECUTE` procedures.

WHY PYICEBERG + DUCKDB FOR MAINTENANCE (the ADR-0014 amendment):
  Trino is removed from the platform entirely. PyIceberg ≥ 0.11 covers snapshot expiry
  (table.maintenance.expire_snapshots) and copy-on-write delete/overwrite (table.delete /
  table.overwrite) natively; the one true gap — compaction — is covered here by a COW partition
  rewrite (DuckDB read → arrow → table.overwrite(overwrite_filter)) gated by an inspect.files()
  skip heuristic. Orphan-file removal has NO PyIceberg API yet and is a loud, greppable SKIP
  (accepted deferred gap — revisit per pyiceberg release; see remove_orphans()).

CATALOG NAMING:
  DuckDB attaches the REST catalog under ICEBERG_CATALOG (default "rest"; the serving tier uses
  "iceberg"). PyIceberg addresses the SAME catalog by 2-part `<namespace>.<table>` identifiers —
  there is no catalog prefix. So a table is `brain_bronze.collector_events_connect` to PyIceberg
  and `rest.brain_bronze.collector_events_connect` in this module's DuckDB reads (_catalog.fqtn).

CONNECTION (env parity with ../_catalog.py — intentionally the same variables):
  ICEBERG_REST_URI   REST catalog endpoint                (default http://iceberg-rest:8181)
  ICEBERG_WAREHOUSE  warehouse root (or BRONZE_WAREHOUSE) (default s3://brain-bronze/)
  S3_ENDPOINT        MinIO endpoint for local/dev; EMPTY in prod → IRSA credential chain
  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   static keys for MinIO only
  AWS_REGION         (default ap-south-1)
  ICEBERG_REST_AUTH  'none' (local fixture, default) | 'sigv4' (AWS-signed REST) | 'oauth2'
                     (token server — ICEBERG_REST_TOKEN or ICEBERG_REST_CLIENT_ID/SECRET)

RETENTION-CUTOFF FORMAT (PyIceberg vs Trino):
  Trino's procedures took a RELATIVE `retention_threshold => '<N>d'` duration string; PyIceberg's
  expire_snapshots takes an ABSOLUTE `older_than(datetime)` cutoff — semantically the SAME window
  (now − duration). ms_to_cutoff()/hours_to_cutoff() convert the jobs' ms/hours env windows into
  UTC cutoff datetimes so the retention windows are preserved EXACTLY. There is NO 7-day
  minimum-retention floor to lower (that was a Trino session-property guard): a ttl of 0 ms is an
  immediate (cutoff = now) purge, which is exactly what the RTBF/erasure path needs.

EXPIRE IS METADATA-ONLY IN PYICEBERG 0.11 (capability-probe gate 4):
  expire_snapshots emits a RemoveSnapshotsUpdate and performs NO client-side file cleanup (and the
  REST catalog doesn't sweep either) — expire alone does NOT satisfy the RTBF bytes-gone
  requirement. expire() below therefore carries a documented supplement mirroring Java's
  cleanExpiredFiles: diff the pre-expire referenced-file set (data files, manifests, manifest
  lists) against what the remaining snapshots still reference, then tbl.io.delete() the
  unreferenced objects. Only after that sweep are the expired bytes physically gone from S3.

UPSTREAM BUG SHIM (pyiceberg 0.11.1, capability-probe gate 2):
  ManifestEntry.snapshot_id's SETTER writes self._data[0] — the STATUS slot — instead of
  self._data[1]. DuckDB writes spec-compliant manifests with null snapshot_id/sequence_number
  (metadata inheritance), so _inherit_from_manifest fires the buggy setter on every DuckDB-written
  entry, clobbers status with the snapshot id, which then also skips sequence-number inheritance
  (status != ADDED) → every PyIceberg rewrite path (delete/overwrite) dies with "Only entries with
  status ADDED can have null sequence number". PyIceberg-written manifests set snapshot_id
  explicitly, so upstream never sees it. The 2-line property monkeypatch below is applied at
  import and is MANDATORY until a fixed release is pinned (file/track the upstream issue).
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone

# The DuckDB attach seam is the sibling package one directory up (/opt/brain/duckdb/_catalog.py in
# the image). Every job in maintenance/ inserts BOTH its own dir and the parent on sys.path before
# importing this module, so a plain `import _catalog` resolves — same self-import convention as the
# transform jobs.
import _catalog

# ── pyiceberg 0.11.1 manifest-inheritance shim (see module docstring) ────────────────────────────
from pyiceberg.manifest import ManifestEntry

_orig_snapshot_id_getter = ManifestEntry.snapshot_id.fget


def _fixed_snapshot_id_setter(self, value):
    self._data[1] = value  # snapshot_id slot — upstream writes _data[0] (status) by mistake


ManifestEntry.snapshot_id = property(_orig_snapshot_id_getter, _fixed_snapshot_id_setter)

# PyIceberg addresses namespaces directly (no catalog prefix); reuse the _catalog.py env seams so
# the two clients can never disagree about which warehouse/namespaces they operate on.
BRONZE_NAMESPACE = _catalog.BRONZE_NAMESPACE
SILVER_NAMESPACE = _catalog.SILVER_NAMESPACE
GOLD_NAMESPACE = _catalog.GOLD_NAMESPACE

# Compaction knobs. TARGET matches the old Spark rewrite_data_files target-file-size-bytes=128MB
# (Trino delegated to the catalog's 512MB default — the optimizer being a no-op on compacted
# partitions is what actually mattered, and the skip heuristic reproduces that). MIN_INPUT_FILES
# mirrors the Spark min-input-files=2. MAX_REWRITE_BYTES is the COW-memory pressure valve (risk
# §D: a rewrite unit reads its surviving rows into arrow — a unit above the cap is loudly SKIPPED
# rather than OOMing the pod; force-mode erasure/retention rewrites ignore the cap deliberately,
# physical PII removal outranks the memory guard there).
OPTIMIZE_MIN_INPUT_FILES = int(os.environ.get("OPTIMIZE_MIN_INPUT_FILES", "2"))
OPTIMIZE_TARGET_FILE_SIZE_BYTES = int(os.environ.get("OPTIMIZE_TARGET_FILE_SIZE_BYTES", str(128 * 1024 * 1024)))
OPTIMIZE_MAX_REWRITE_BYTES = int(os.environ.get("OPTIMIZE_MAX_REWRITE_BYTES", str(2 * 1024 * 1024 * 1024)))
# Bounded optimistic-concurrency retry for COW commits racing the Kafka Connect appends (probe
# gate 6): on CommitFailedException the rewrite re-reads the survivors from the NEW snapshot and
# re-attempts, so a concurrent append is never clobbered.
MAINT_COMMIT_RETRIES = int(os.environ.get("MAINT_COMMIT_RETRIES", "3"))


def pyiceberg_catalog():
    """Return a PyIceberg handle to the Brain Iceberg REST catalog (same warehouse as _catalog.py).

    Env parity with _catalog.connect(): local/dev (S3_ENDPOINT set) uses MinIO path-style static
    keys; prod (S3_ENDPOINT empty) uses the default AWS credential chain (IRSA/WebIdentity) — no
    static keys, no endpoint override. ICEBERG_REST_AUTH selects the REST auth posture exactly as
    the DuckDB ATTACH does ('none' local fixture default | 'sigv4' | 'oauth2').
    """
    from pyiceberg.catalog import load_catalog  # lazy import, same posture as _catalog.connect()

    props: "dict[str, str]" = {
        "type": "rest",
        "uri": _catalog.REST_URI,
        # The bare warehouse NAME the catalog knows, not the s3:// URI — same gotcha as ATTACH.
        "warehouse": _catalog.WAREHOUSE_NAME,
        "s3.region": _catalog.REGION,
    }

    s3_endpoint = (os.environ.get("S3_ENDPOINT") or "").strip()
    if s3_endpoint:
        # Local/dev against MinIO: explicit endpoint + path-style + static keys (mirrors the
        # _catalog.py S3_ENDPOINT-set branch).
        props.update(
            {
                "s3.endpoint": s3_endpoint,
                "s3.access-key-id": os.environ.get("AWS_ACCESS_KEY_ID", "brain"),
                "s3.secret-access-key": os.environ.get("AWS_SECRET_ACCESS_KEY", "brainbrain"),
                "s3.path-style-access": "true",
            }
        )

    auth = os.environ.get("ICEBERG_REST_AUTH", "none").lower()
    if auth == "sigv4":
        props.update(
            {
                "rest.sigv4-enabled": "true",
                "rest.signing-region": _catalog.REGION,
                "rest.signing-name": os.environ.get("ICEBERG_REST_SIGNING_NAME", "execute-api"),
            }
        )
    elif auth == "oauth2":
        token = os.environ.get("ICEBERG_REST_TOKEN", "")
        if token:
            props["token"] = token
        else:
            client_id = os.environ.get("ICEBERG_REST_CLIENT_ID", "")
            client_secret = os.environ.get("ICEBERG_REST_CLIENT_SECRET", "")
            if client_id and client_secret:
                props["credential"] = f"{client_id}:{client_secret}"

    return load_catalog("brain", **props)


_duckdb_con = None


def duckdb_connect():
    """The module's shared DuckDB connection (lazy, cached) — the READ half of the maintenance
    seam: COW rewrites read surviving rows through DuckDB (which honours merge-on-read delete
    files), the retention job's string-typed `fetched_at` CAST lane issues its DELETE here, and
    the erasure job evaluates its JSON-path subject predicates here. Reuses _catalog.connect()
    verbatim (UTC session, brain_s3 secret, REST attach) plus the json extension the erasure
    predicates need."""
    global _duckdb_con
    if _duckdb_con is None:
        _duckdb_con = _catalog.connect()
        _duckdb_con.execute("INSTALL json; LOAD json;")
        # large_string arrow buffers: a rewrite unit of collector payload JSON overflows the 2GiB
        # regular-string offset space (hit on the real collector lane); pyiceberg accepts and
        # downcasts large types on write.
        _duckdb_con.execute("SET arrow_large_buffer_size=true;")
    return _duckdb_con


def fqtn(namespace: str, table: str) -> str:
    """Fully-qualified DuckDB name in the attached catalog: rest.brain_bronze.collector_events_connect."""
    return _catalog.fqtn(namespace, table)


def ident(namespace: str, table: str) -> str:
    """PyIceberg table identifier (no catalog prefix): brain_bronze.collector_events_connect."""
    return f"{namespace}.{table}"


# ── Retention-window conversion (Spark/Trino ms/h windows → absolute UTC cutoffs) ────────────────


def ms_to_cutoff(ms: int) -> datetime:
    """Absolute UTC expiry cutoff for a millisecond window. 0 → now (immediate — RTBF purge).
    Same window the Trino seam expressed as a relative duration string ('7d' / '0s')."""
    return datetime.now(timezone.utc) - timedelta(milliseconds=max(0, ms))


def hours_to_cutoff(hours: int) -> datetime:
    """Absolute UTC expiry cutoff for an hours window (bronze_raw_retention RAW_RETENTION_HOURS)."""
    return datetime.now(timezone.utc) - timedelta(hours=max(0, hours))


# ── Catalog introspection (PyIceberg — SHOW TABLES / information_schema analogues) ───────────────


def tables_in(cat, namespace: str) -> "list[str]":
    """Every table in a namespace, so new marts/lanes are covered without editing the job files —
    same auto-discovery the Spark/Trino jobs got from SHOW TABLES."""
    return sorted(t[-1] for t in cat.list_tables(namespace))


def table_exists(cat, namespace: str, table: str) -> bool:
    """True if the table exists in the catalog namespace (lane auto-created on first record)."""
    return cat.table_exists(ident(namespace, table))


def columns_of(cat, namespace: str, table: str) -> "set[str]":
    """Top-level column names in the table's Iceberg schema (for the erasure _col_exists guard and
    the brand_id tenant-key check)."""
    return {f.name for f in cat.load_table(ident(namespace, table)).schema().fields}


def column_types(cat, namespace: str, table: str) -> "dict[str, str]":
    """Top-level column name → lowercased Iceberg type string (the retention job's timestamp-vs-
    string ingest-column dispatch)."""
    return {f.name: str(f.field_type).lower() for f in cat.load_table(ident(namespace, table)).schema().fields}


# ── The three maintenance operations (Trino EXECUTE analogues) ───────────────────────────────────


def _referenced_files(tbl, manifest_cache: "dict[str, set[str]] | None" = None) -> "set[str]":
    """Every object the table's CURRENT snapshot set references: manifest lists, manifest files,
    and LIVE data/delete file entries. Live entries only — a delete-manifest's status=DELETED
    tombstone is not a live reference (same live-entry semantics as Java's expireSnapshots file
    cleanup), so a file superseded by a COW rewrite becomes sweepable once its snapshots expire.

    `manifest_cache` (manifest_path → live file paths) spans expire()'s before/after walks:
    manifests are immutable, and the retained snapshots reference mostly the same manifests, so
    the second walk is nearly free instead of re-fetching every avro from S3."""
    cache = manifest_cache if manifest_cache is not None else {}
    paths: "set[str]" = set()
    for snap in tbl.snapshots():
        paths.add(snap.manifest_list)
        for mf in snap.manifests(tbl.io):
            paths.add(mf.manifest_path)
            if mf.manifest_path not in cache:
                cache[mf.manifest_path] = {
                    entry.data_file.file_path
                    for entry in mf.fetch_manifest_entry(tbl.io, discard_deleted=True)
                }
            paths.update(cache[mf.manifest_path])
    return paths


def expire(cat, namespace: str, table: str, ttl_ms: int) -> None:
    """Snapshot expiry — PyIceberg analogue of Trino `EXECUTE expire_snapshots` (drop old history
    + physically delete the files only the expired snapshots referenced).

    `ttl_ms` is the retention window in milliseconds (0 → immediate/RTBF purge; branch heads are
    auto-protected by pyiceberg, so the current snapshot always survives). pyiceberg 0.11's expire
    is METADATA-ONLY (probe gate 4), so this carries the mandatory physical sweep: diff the
    pre-expire referenced-object set against what the remaining snapshots reference, then
    tbl.io.delete() the unreferenced objects — data files, manifests and manifest lists (manifest
    column bounds can carry payload/identifier fragments, so metadata bytes must go too).
    """
    name = ident(namespace, table)
    tbl = cat.load_table(name)
    if tbl.current_snapshot() is None:
        print(f"[maintenance] expire {name}: empty table (no snapshots) — nothing to expire", flush=True)
        return
    cutoff = ms_to_cutoff(ttl_ms)
    print(f"[maintenance] expire_snapshots {name} older_than {cutoff.isoformat()} …", flush=True)

    manifest_cache: "dict[str, set[str]]" = {}  # spans both walks — manifests are immutable
    before = _referenced_files(tbl, manifest_cache)
    # API shape (probe gate 4): 0.11 exposes ONLY the MaintenanceTable builder.
    tbl.maintenance.expire_snapshots().older_than(cutoff).commit()

    tbl = cat.load_table(name)  # reload post-commit
    unreferenced = before - _referenced_files(tbl, manifest_cache)
    for path in sorted(unreferenced):
        try:
            tbl.io.delete(path)
        except Exception as exc:  # noqa: BLE001 — a missing object is already-gone (idempotent re-run)
            print(f"[maintenance] WARN expire sweep {name}: could not delete {path}: {exc}", flush=True)
    if unreferenced:
        print(f"[maintenance] expire {name}: physically deleted {len(unreferenced)} unreferenced object(s)", flush=True)


def _rewrite_units(tbl) -> "list[tuple[str, object, str, int, int, tuple | None]]":
    """Partition the table into COW rewrite units: (label, iceberg overwrite_filter expression,
    DuckDB WHERE predicate, data_file_count, data_bytes, temporal_span_or_None).

    A unit's two predicates MUST select the same rows (the DuckDB read supplies the survivors the
    overwrite_filter deletes). Only ROW-expressible partition transforms qualify for per-partition
    chunking — identity, and day/month/year/hour on a timestamp source (value → half-open range
    predicate). bucket()/truncate() partition values have no row predicate, so any spec containing
    only those (or an unpartitioned table, e.g. collector_events_connect) is a single whole-table
    unit. A mixed spec chunks on its FIRST expressible field (the other dimensions ride along —
    correct, just coarser units).
    """
    from pyiceberg.expressions import (
        AlwaysTrue,
        And,
        EqualTo,
        GreaterThanOrEqual,
        IsNull,
        LessThan,
    )
    from pyiceberg.transforms import (
        DayTransform,
        HourTransform,
        IdentityTransform,
        MonthTransform,
        YearTransform,
    )

    try:
        files = tbl.inspect.files().to_pylist()
    except ValueError:
        # inspect.files() raises ("Must pass at least one table") when the current snapshot has no
        # manifests at all — e.g. a mart whose last run wrote 0 rows. Nothing to compact.
        return []
    data_files = [f for f in files if f["content"] == 0]
    if not data_files:
        return []

    from pyiceberg.types import DateType, TimestampType

    schema = tbl.schema()
    chunk_field = None  # (partition_field_name, source_column_name, transform, literal_kind)
    for pf in tbl.spec().fields:
        transform = pf.transform
        if isinstance(transform, (IdentityTransform, DayTransform, MonthTransform, YearTransform, HourTransform)):
            # The range literals must match the SOURCE column's type family: DATE columns take
            # date literals, naive timestamps reject a zone offset, timestamptz wants the offset.
            source_type = schema.find_field(pf.source_id).field_type
            kind = (
                "date"
                if isinstance(source_type, DateType)
                else "ts" if isinstance(source_type, TimestampType) else "tstz"
            )
            chunk_field = (pf.name, schema.find_column_name(pf.source_id), transform, kind)
            break

    if chunk_field is None:
        total_bytes = sum(f["file_size_in_bytes"] for f in data_files)
        return [("whole-table", AlwaysTrue(), "TRUE", len(data_files), total_bytes, None)]

    pf_name, col, transform, kind = chunk_field
    groups: "dict[object, list]" = {}
    for f in data_files:
        groups.setdefault((f.get("partition") or {}).get(pf_name), []).append(f)

    units = []
    for value, fs in sorted(groups.items(), key=lambda kv: str(kv[0])):
        nbytes = sum(f["file_size_in_bytes"] for f in fs)
        if value is None:
            units.append((f"{col} IS NULL", IsNull(col), f"{col} IS NULL", len(fs), nbytes, None))
        elif isinstance(transform, IdentityTransform):
            lit = str(value).replace("'", "''")
            units.append((f"{col}={value}", EqualTo(col, value), f"{col} = '{lit}'", len(fs), nbytes, None))
        else:
            # Temporal transform: partition value → half-open [start, end) UTC instant range.
            # inspect.files() renders the partition value either as a date object (day) or as the
            # spec's epoch-relative int (hours/days since epoch, months since 1970-01, years since
            # 1970) — normalize both shapes to a start datetime, then step one transform unit.
            epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
            if isinstance(transform, HourTransform):
                start = epoch + timedelta(hours=int(value))
                end = start + timedelta(hours=1)
            elif isinstance(transform, DayTransform):
                start = (
                    epoch + timedelta(days=int(value))
                    if isinstance(value, int)
                    else datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
                )
                end = start + timedelta(days=1)
            elif isinstance(transform, MonthTransform):
                if isinstance(value, int):
                    years, months = divmod(int(value), 12)
                    start = datetime(1970 + years, months + 1, 1, tzinfo=timezone.utc)
                else:
                    start = datetime(value.year, value.month, 1, tzinfo=timezone.utc)
                end = (
                    datetime(start.year + 1, 1, 1, tzinfo=timezone.utc)
                    if start.month == 12
                    else datetime(start.year, start.month + 1, 1, tzinfo=timezone.utc)
                )
            else:  # YearTransform
                year = 1970 + int(value) if isinstance(value, int) else value.year
                start = datetime(year, 1, 1, tzinfo=timezone.utc)
                end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
            units.append(_temporal_unit(col, start, end, len(fs), nbytes, kind))
    return units


def _temporal_unit(col: str, start: datetime, end: datetime, n_files: int, n_bytes: int, kind: str):
    """A rewrite unit over a half-open [start, end) range on `col` — the iceberg overwrite_filter
    and the DuckDB WHERE are built from the SAME bounds so they select the same rows by
    construction. `kind` selects the literal shape of the SOURCE column (all three hit by the
    live medallion): 'date' (the snap_* marts day()-partition a DATE column — a timestamp literal
    fails pyiceberg's date conversion), 'ts' (naive timestamp — pyiceberg rejects a zone offset),
    'tstz' (timestamptz — wants the offset). The trailing (col, start, end, kind) span is what
    _coalesce_temporal merges."""
    from pyiceberg.expressions import And, GreaterThanOrEqual, LessThan

    if kind == "date":
        lit_start, lit_end = start.date().isoformat(), end.date().isoformat()
        duck_pred = f"{col} >= DATE '{lit_start}' AND {col} < DATE '{lit_end}'"
    elif kind == "ts":
        lit_start, lit_end = start.replace(tzinfo=None).isoformat(), end.replace(tzinfo=None).isoformat()
        duck_pred = f"{col} >= TIMESTAMP '{lit_start}' AND {col} < TIMESTAMP '{lit_end}'"
    else:  # tstz
        lit_start, lit_end = start.isoformat(), end.isoformat()
        duck_pred = f"{col} >= TIMESTAMPTZ '{lit_start}' AND {col} < TIMESTAMPTZ '{lit_end}'"
    return (
        f"{col} in [{lit_start}, {lit_end})",
        And(GreaterThanOrEqual(col, lit_start), LessThan(col, lit_end)),
        duck_pred,
        n_files,
        n_bytes,
        (col, start, end, kind),
    )


def _coalesce_temporal(units: list) -> list:
    """Merge ADJACENT compactable temporal units (prev.end == next.start) into one range unit while
    the combined size stays under OPTIMIZE_MAX_REWRITE_BYTES. A first run against a fragmented
    daily-partitioned mart otherwise issues one COW commit per day (observed: 689 commits on one
    Silver mart) — coalescing turns that into a handful of bounded range rewrites. Only touching
    ranges merge, so partitions that were skipped as already-compacted are never re-rewritten."""
    spanned = sorted((u for u in units if u[5] is not None), key=lambda u: u[5][1])
    out = [u for u in units if u[5] is None]
    for unit in spanned:
        if out and out[-1][5] is not None:
            col, start, end, kind = out[-1][5]
            u_col, u_start, u_end, _ = unit[5]
            if u_col == col and u_start == end and out[-1][4] + unit[4] <= OPTIMIZE_MAX_REWRITE_BYTES:
                out[-1] = _temporal_unit(col, start, u_end, out[-1][3] + unit[3], out[-1][4] + unit[4], kind)
                continue
        out.append(unit)
    return out


def _overwrite_with_retry(cat, namespace: str, table: str, expr, duck_pred: str) -> None:
    """One COW rewrite unit: DuckDB-read the surviving rows (honours MoR delete files) → arrow →
    tbl.overwrite(overwrite_filter) — a single atomic Iceberg commit. On CommitFailedException
    (optimistic-concurrency loss to e.g. a Kafka Connect append) the survivors are RE-READ from
    the new snapshot before re-attempting, so concurrent writes are never clobbered."""
    from pyiceberg.exceptions import CommitFailedException
    from pyiceberg.io.pyarrow import schema_to_pyarrow

    con = duckdb_connect()
    name = ident(namespace, table)
    for attempt in range(1, MAINT_COMMIT_RETRIES + 1):
        # fetch_arrow_table(), not .arrow(): duckdb ≥1.5 returns a RecordBatchReader from .arrow(),
        # and pyiceberg's overwrite() requires a materialized pyarrow Table.
        surviving = con.execute(f"SELECT * FROM {fqtn(namespace, table)} WHERE {duck_pred}").fetch_arrow_table()
        tbl = cat.load_table(name)
        # DuckDB's arrow export marks EVERY field nullable, but the marts carry `required` Iceberg
        # fields — pyiceberg's schema-compat check rightly rejects optional→required. Cast to the
        # table schema's arrow shape (restores non-null flags + field ids; also folds the
        # large_string buffers back). A genuine NULL in a required column still fails the write —
        # the safe direction.
        surviving = surviving.cast(schema_to_pyarrow(tbl.schema()))
        try:
            tbl.overwrite(surviving, overwrite_filter=expr)
            return
        except CommitFailedException as exc:
            if attempt == MAINT_COMMIT_RETRIES:
                raise
            print(f"[maintenance] commit conflict on {name} (attempt {attempt}/{MAINT_COMMIT_RETRIES}): {exc} — re-reading + retrying", flush=True)
            time.sleep(attempt)  # linear backoff; the conflicting commit has already landed


def optimize(cat, namespace: str, table: str, force: bool = False) -> None:
    """Compaction — PyIceberg analogue of Trino `EXECUTE optimize` (coalesce small files), built as
    a COW partition rewrite: per rewrite unit, read the surviving rows through DuckDB and
    overwrite the unit atomically (probe gates 5/6).

    Skip heuristic (the "no-op on already-compacted partitions" behaviour the Trino optimizer
    gave us): a unit is rewritten only when it has >= OPTIMIZE_MIN_INPUT_FILES data files with an
    average size below OPTIMIZE_TARGET_FILE_SIZE_BYTES. `force=True` bypasses the heuristic AND
    the OPTIMIZE_MAX_REWRITE_BYTES memory valve — the retention/erasure paths use it after a
    merge-on-read DELETE so the deleted rows are guaranteed to leave the live data files
    (physical PII removal outranks the perf guards). NOTE (probe gate 7): a rewrite cannot drop
    already-referenced positional-delete FILES from metadata (pyiceberg carries DELETES-content
    manifests over verbatim) — scans stay correct and delete files hold only (file_path, pos),
    no row bytes; the erasure lane avoids MoR deletes entirely for this reason.
    """
    name = ident(namespace, table)
    tbl = cat.load_table(name)
    if tbl.current_snapshot() is None:
        print(f"[maintenance] optimize {name}: empty table — skipped", flush=True)
        return
    todo, skipped = [], 0
    for unit in _rewrite_units(tbl):
        label, _, _, n_files, n_bytes, _ = unit
        compactable = n_files >= OPTIMIZE_MIN_INPUT_FILES and (n_bytes / n_files) < OPTIMIZE_TARGET_FILE_SIZE_BYTES
        if not force and not compactable:
            skipped += 1
            continue
        if not force and n_bytes > OPTIMIZE_MAX_REWRITE_BYTES:
            print(
                f"[maintenance] SKIP optimize unit {name} [{label}]: {n_bytes}B exceeds "
                f"OPTIMIZE_MAX_REWRITE_BYTES={OPTIMIZE_MAX_REWRITE_BYTES} (COW memory valve)",
                flush=True,
            )
            skipped += 1
            continue
        todo.append(unit)
    merged = _coalesce_temporal(todo)
    for label, expr, duck_pred, n_files, n_bytes, _ in merged:
        print(f"[maintenance] optimize (COW rewrite) {name} [{label}]: {n_files} file(s), {n_bytes}B …", flush=True)
        _overwrite_with_retry(cat, namespace, table, expr, duck_pred)
    print(
        f"[maintenance] optimize {name}: {len(todo)} unit(s) rewritten in {len(merged)} commit(s), "
        f"{skipped} skipped (already compacted)",
        flush=True,
    )


def remove_orphans(cat, namespace: str, table: str, older_than_days: int) -> None:
    """Orphan-file removal — DEFERRED GAP (ADR-0014). PyIceberg 0.11 ships NO orphan-file sweep
    (files under the table location that no snapshot references — leftovers of failed/killed
    commits). This is a loud, greppable SKIP so the gap stays visible in every maintenance log;
    revisit per pyiceberg release and swap the real call in here when the API lands."""
    print(
        f"[maintenance] SKIP remove_orphan_files {ident(namespace, table)} (older_than={older_than_days}d): "
        "no pyiceberg API yet — deferred gap, ADR-0014",
        flush=True,
    )


def delete(cat, namespace: str, table: str, delete_filter) -> None:
    """Row erasure — PyIceberg copy-on-write delete (probe gate 3): tbl.delete(<expression>)
    REWRITES the data files containing matching rows (no merge-on-read delete files), so the
    deleted rows physically leave the live files in the same commit; a follow-up expire() purges
    the pre-delete snapshots/bytes. Bounded optimistic-concurrency retry, same posture as the
    rewrite path. Naturally idempotent — a re-run matches 0 rows."""
    from pyiceberg.exceptions import CommitFailedException

    name = ident(namespace, table)
    for attempt in range(1, MAINT_COMMIT_RETRIES + 1):
        tbl = cat.load_table(name)
        try:
            tbl.delete(delete_filter)
            return
        except CommitFailedException as exc:
            if attempt == MAINT_COMMIT_RETRIES:
                raise
            print(f"[maintenance] commit conflict on {name} (attempt {attempt}/{MAINT_COMMIT_RETRIES}): {exc} — retrying", flush=True)
            time.sleep(attempt)
