# SPEC:C.2.6
"""
gold_measurement_inventory.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_measurement_inventory.py.

OPTIONAL inventory-MOVEMENT fact (Brain V4 Wave C). Inventory MOVEMENT events derived from the
point-in-time level history in brain_silver.silver_inventory_level (product.upsert.v1 → per-variant stock
observations). A movement = the delta between consecutive stock observations for a (product, variant):
movement_qty = quantity − prev_quantity. Append-only fact; the FIRST observation of a variant has
prev_quantity = NULL and movement_qty = NULL (no prior baseline — honest, not fabricated as the full stock).

FLAG-GATED PER BRAND (§0.5 / SPEC:C.2.6): OPTIONAL — emitted ONLY for brands whose
`measurement.inventory_movement` flag is ON (default OFF, fail-closed via is_flag_enabled). A brand with
the flag OFF contributes ZERO movement rows (byte-identical to pre-wave). No money (stock is a count, never
money) — so this mart has NO amount_minor / currency_code column.

GRAIN / PK: (brand_id, product_id, variant_id, event_id) — EXACT match to the Spark merge_on_pk
  ["brand_id","product_id","variant_id","event_id"]. event_id = sha256(brand, product, variant, observed_at) —
  deterministic per observation, idempotent MERGE.

── PORT NOTES ───────────────────────────────────────────────────────────────────────────────────────────
  - sha2(concat_ws('\\0', …), 256) → sha256(concat_ws(chr(0), …)) — DuckDB's sha256 returns the same
    lowercase-hex digest over the same NUL-joined byte string, so event_id / source_event_id are identical.
  - lag(cast(inventory_quantity AS bigint)) OVER (partition …, ORDER BY observed_at) → identical DuckDB
    window function (same partition/order → same prev_quantity).
  - current_timestamp() → now() AT TIME ZONE 'UTC' (the UTC session is set in _catalog.connect).
  - cast(inventory_quantity AS bigint) stays integer — inventory is a COUNT, no float, no money.
  - silver_exists(...) (Spark probes .schema) → _exists(...) probes with `LIMIT 0` (schema-only touch): a
    table that EXISTS but is EMPTY reads TRUE (its lane runs, yields 0 rows), only a truly ABSENT table
    → FALSE → the empty target is created and the job exits clean.

VENDORED HELPER: is_flag_enabled — a byte-faithful copy of db/iceberg/spark/_platform_flags.is_flag_enabled
  (the RESP2-over-socket, zero-dependency Redis flag read). The Spark helper is a PURE, framework-free
  module (stdlib socket only), so it is vendored verbatim here rather than reaching across into spark/. Same
  key shape ("{brand_id}:flag:{flag}"), same DEFAULT-OFF / FAIL-CLOSED semantics (any error → False → the
  brand emits an empty fact). Writes stay TypeScript-only; this only reads.

DATA NOTE: silver_inventory_level is EMPTY / possibly ABSENT live (product/inventory resource unsynced), and
  even when it populates the movement fact stays EMPTY until a brand turns the measurement.inventory_movement
  flag ON. Either way this writes a correct EMPTY Gold mart today (Spark oracle = 0 rows / possibly absent —
  HONEST-EMPTY). It populates with no code change once a product/inventory sync lands AND the flag is on.

QUARANTINE: none — the Spark job reads already-gated Silver and has NO Stage-1/quarantine side-write to
  mirror. Nothing to skip.

REPLAY-SAFE: full recompute from Silver, MERGE-UPDATE'd on the mart PK. Idempotent (re-run over the same
  Silver yields identical rows). MATCHED-UPDATE / NOT-MATCHED-INSERT only — the Spark merge_on_pk passes no
  delete_orphans, so no orphan-shedding divergence.

Honors MIGRATION_TABLE_SUFFIX (→ gold_measurement_inventory_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_measurement_inventory (0 rows — honest-empty).
"""
from __future__ import annotations

import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TABLE = "gold_measurement_inventory"

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_measurement_inventory_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_INVENTORY_LEVEL = f"{CATALOG}.{SILVER_NAMESPACE}.silver_inventory_level"

# SPEC: C.2.6 — per-brand gate for the OPTIONAL movement fact. OFF (default) → the brand emits no rows.
FLAG_MEASUREMENT_INVENTORY_MOVEMENT = "measurement.inventory_movement"

# Mirrors the Spark COLUMNS_SQL order/types EXACTLY. brand_id tenant key first; NO money (stock is a count).
# timestamp cols are plain `timestamp` (Iceberg timestamptz UTC instants under the UTC session).
COLUMNS_SQL = """
  brand_id         string    NOT NULL,
  product_id       string    NOT NULL,
  variant_id       string    NOT NULL,
  event_id         string    NOT NULL,
  observed_at      timestamp NOT NULL,
  prev_quantity    bigint,
  quantity         bigint,
  movement_qty     bigint,
  source           string,
  source_event_id  string,
  updated_at       timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "product_id", "variant_id", "event_id", "observed_at", "prev_quantity",
    "quantity", "movement_qty", "source", "source_event_id", "updated_at",
]

PK = ["brand_id", "product_id", "variant_id", "event_id"]


# ── VENDORED: is_flag_enabled (byte-faithful copy of db/iceberg/spark/_platform_flags) ─────────────────────
# A zero-dependency RESP2-over-socket Redis flag read. DEFAULT OFF, FAIL-CLOSED — any error → False.
# Same key shape "{brand_id}:flag:{flag}" the TS platform-flags service writes; reads only, never writes.
_ENABLED_VALUE = b"true"
_DEFAULT_REDIS_URL = "redis://localhost:6379"
_DEFAULT_TIMEOUT_SECONDS = 2.0


def _flag_key(brand_id: str, flag: str) -> str:
    if not brand_id:
        raise ValueError("flag_key: brand_id is required")
    if not flag:
        raise ValueError("flag_key: flag is required")
    if ":" in brand_id or ":" in flag:
        raise ValueError("flag_key: segments must not contain ':'")
    return "{0}:flag:{1}".format(brand_id, flag)


def _parse_redis_url(url: str):
    """redis://[:password@]host[:port][/db] → (host, port, password, db)."""
    rest = url
    if rest.startswith("redis://"):
        rest = rest[len("redis://"):]
    elif rest.startswith("rediss://"):
        rest = rest[len("rediss://"):]
    password = None
    if "@" in rest:
        auth, rest = rest.rsplit("@", 1)
        password = auth.split(":", 1)[1] if ":" in auth else (auth or None)
    db = 0
    if "/" in rest:
        rest, db_part = rest.split("/", 1)
        if db_part.strip():
            db = int(db_part.strip())
    host, port = rest, 6379
    if ":" in rest:
        host, port_part = rest.split(":", 1)
        port = int(port_part)
    return host or "localhost", port, password, db


def _encode_command(args) -> bytes:
    out = [b"*" + str(len(args)).encode("ascii") + b"\r\n"]
    for arg in args:
        data = arg if isinstance(arg, bytes) else str(arg).encode("utf-8")
        out.append(b"$" + str(len(data)).encode("ascii") + b"\r\n" + data + b"\r\n")
    return b"".join(out)


def _read_reply(reader):
    line = reader.readline()
    if not line:
        raise ConnectionError("redis: connection closed mid-reply")
    prefix, body = line[:1], line[1:].rstrip(b"\r\n")
    if prefix == b"+":
        return body
    if prefix == b"-":
        raise ConnectionError("redis error reply: {0}".format(body.decode("utf-8", "replace")))
    if prefix == b":":
        return int(body)
    if prefix == b"$":
        length = int(body)
        if length == -1:
            return None
        data = reader.read(length + 2)
        if data is None or len(data) < length + 2:
            raise ConnectionError("redis: short bulk read")
        return data[:length]
    raise ConnectionError("redis: unexpected reply prefix {0!r}".format(prefix))


def _redis_get(url: str, key: str, timeout_seconds: float):
    host, port, password, db = _parse_redis_url(url)
    sock = socket.create_connection((host, port), timeout=timeout_seconds)
    try:
        sock.settimeout(timeout_seconds)
        reader = sock.makefile("rb")
        try:
            if password:
                sock.sendall(_encode_command(["AUTH", password]))
                _read_reply(reader)
            if db:
                sock.sendall(_encode_command(["SELECT", str(db)]))
                _read_reply(reader)
            sock.sendall(_encode_command(["GET", key]))
            return _read_reply(reader)
        finally:
            reader.close()
    finally:
        sock.close()


def is_flag_enabled(brand_id: str, flag: str, redis_url: str = None,
                    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS) -> bool:
    """Is `flag` enabled for `brand_id`? DEFAULT OFF, FAIL-CLOSED — NEVER raises (any failure → pre-wave
    behavior → an empty fact for that brand). Mirrors the Spark _platform_flags.is_flag_enabled exactly."""
    try:
        if not brand_id or not flag:
            return False
        key = _flag_key(brand_id, flag)
        url = redis_url or os.environ.get("REDIS_URL") or _DEFAULT_REDIS_URL
        value = _redis_get(url, key, timeout_seconds)
        return value == _ENABLED_VALUE
    except Exception:  # noqa: BLE001 — FAIL-CLOSED
        return False


def _exists(con, fq: str) -> bool:
    """True iff the source table EXISTS (empty or not). Mirrors Spark silver_exists (probes .schema): an
    existing-but-empty table returns True (its lane runs, yields 0 rows); only a truly ABSENT table → False.
    Probes with `LIMIT 0` (schema-only touch, no scan)."""
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent source → the empty target is created, job exits clean
        return False


def build(con):
    # Spark partitions bucket(64, brand_id), days(observed_at). DuckDB's Iceberg writer does not implement
    # the days() transform, so we keep the brand-bucket anchor only (physical layout only — no effect on the
    # rows/PK/parity). Matches the established DuckDB gold pattern (e.g. gold_measurement_refunds).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # ABSENT/EMPTY upstream → the empty target is already created — nothing to MERGE. Exit clean.
    if not _exists(con, SILVER_INVENTORY_LEVEL):
        print(f"[gold-measurement-inventory] source {SILVER_INVENTORY_LEVEL} absent — wrote empty {TABLE}, "
              f"exiting", flush=True)
        return 0

    # Flag gate (driver-side, mirrors the Spark job): only brands with measurement.inventory_movement ON
    # participate. Read distinct brands, filter by the fail-closed flag read. No brand ON → empty fact.
    brands = [r[0] for r in con.execute(
        f"SELECT DISTINCT brand_id FROM {SILVER_INVENTORY_LEVEL} WHERE brand_id IS NOT NULL"
    ).fetchall()]
    enabled = [b for b in brands if is_flag_enabled(b, FLAG_MEASUREMENT_INVENTORY_MOVEMENT)]
    if not enabled:
        print("[gold-measurement-inventory] no brand has measurement.inventory_movement ON → empty fact",
              flush=True)
        return 0

    in_list = ", ".join("'" + b.replace("'", "''") + "'" for b in enabled)

    # Faithful SQL port of the Spark staged CTE. lag() over (brand,product,variant ORDER BY observed_at) →
    # prev_quantity; movement_qty = quantity − prev_quantity (NULL on the first observation — honest, not
    # the full stock). event_id / source_event_id = sha256 over the NUL-joined natural key (deterministic).
    staged = f"""
        WITH lvl AS (
            SELECT brand_id, product_id, variant_id, observed_at,
                   CAST(inventory_quantity AS BIGINT) AS quantity, source,
                   lag(CAST(inventory_quantity AS BIGINT)) OVER (
                       PARTITION BY brand_id, product_id, variant_id ORDER BY observed_at
                   ) AS prev_quantity
            FROM {SILVER_INVENTORY_LEVEL}
            WHERE brand_id IN ({in_list})
        )
        SELECT
            brand_id, product_id, variant_id,
            sha256(concat_ws(chr(0), brand_id, product_id, variant_id, CAST(observed_at AS VARCHAR)))  AS event_id,
            observed_at, prev_quantity, quantity,
            CASE WHEN prev_quantity IS NULL THEN NULL ELSE quantity - prev_quantity END                AS movement_qty,
            source,
            sha256(concat_ws(chr(0), brand_id, product_id, variant_id, CAST(observed_at AS VARCHAR)))  AS source_event_id,
            now() AT TIME ZONE 'UTC'                                                                    AS updated_at
        FROM lvl
    """

    # Full-recompute MERGE on (brand_id, product_id, variant_id, event_id). event_id is per-observation so
    # the in-batch dedup keeps the latest-observed row on the rare re-pull; order_by_desc is a tie-break.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["observed_at"])


if __name__ == "__main__":
    run_job("gold-measurement-inventory", build, target_table=TABLE)
