"""
trino_base.py — the shared Trino ⇄ Iceberg maintenance seam (Spark→Trino migration amendment).

This is the Trino analogue of db/iceberg/spark/iceberg_base.py: the ONE place that opens a Trino
connection to the SAME Iceberg REST catalog every Spark/DuckDB job uses, and the ONE place that
wraps the three Iceberg maintenance operations as Trino `ALTER TABLE … EXECUTE …` procedures.

WHY TRINO FOR MAINTENANCE (the amendment, approved):
  DuckDB cannot run the Iceberg maintenance stored procedures (rewrite/compaction, snapshot
  expiry, orphan-file removal). Trino CAN — via `ALTER TABLE <t> EXECUTE optimize`,
  `… EXECUTE expire_snapshots(retention_threshold => '7d')`,
  `… EXECUTE remove_orphan_files(retention_threshold => '7d')`. So the Spark jobs'
  `CALL rest.system.rewrite_data_files / expire_snapshots / remove_orphan_files` reproduce
  1:1 as Trino EXECUTE procedures against the same catalog.

CATALOG NAMING:
  Spark/DuckDB address the catalog as `rest` (ICEBERG_CATALOG). Trino addresses the SAME REST
  catalog + MinIO under the catalog CONFIGURED in db/trino/catalog/iceberg.properties — named
  `iceberg`. So a table is `iceberg.brain_bronze.<t>` here vs `rest.brain_bronze.<t>` in Spark.
  Namespaces (schemas) are identical: brain_bronze / brain_silver / brain_gold.

CONNECTION:
  Uses the `trino` python client (pip install trino) against the Trino coordinator. Locally the
  compose `trino` service maps host 8090 → container 8080 (docker-compose.yml). The env seams
  mirror the serving-tier conventions:
    TRINO_HOST   coordinator host                  (default "localhost")
    TRINO_PORT   coordinator port                  (default 8090 — the compose host mapping)
    TRINO_USER   Trino user                        (default "brain")
    TRINO_CATALOG Trino Iceberg catalog name        (default "iceberg")

RETENTION-THRESHOLD FORMAT (Trino vs Spark):
  Spark's expire_snapshots takes an absolute `older_than => TIMESTAMP '<cutoff>'` (the job computes
  now − ttl). Trino's procedures take a RELATIVE `retention_threshold => '<N>d'|'<N>h'|'<N>s'`
  duration string — semantically the SAME cutoff (now − duration). This module converts the Spark
  ms/hours/days windows into Trino duration strings so the retention windows are preserved EXACTLY.

  IMPORTANT — the 7-day minimum-retention guard: Trino refuses expire_snapshots/remove_orphan_files
  with a retention_threshold shorter than `iceberg.expire_snapshots.min-retention` (default 7d) /
  `iceberg.remove_orphan_files.min-retention` UNLESS the matching SESSION property is lowered. The
  RTBF/erasure path needs an IMMEDIATE (0s) purge of the pre-delete snapshots, so `expire()` sets
  those session properties to the requested threshold before issuing the EXECUTE. (The Spark jobs
  achieve the same with ttl_ms=0 → cutoff=now; Spark has no equivalent floor.)
"""
from __future__ import annotations

import os

# Trino addresses the SAME REST catalog Spark calls `rest`, but under its configured catalog name.
CATALOG = os.environ.get("TRINO_CATALOG", "iceberg")

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
SILVER_NAMESPACE = os.environ.get("SILVER_NAMESPACE", "brain_silver")
GOLD_NAMESPACE = os.environ.get("GOLD_NAMESPACE", "brain_gold")


def connect():
    """Return a DBAPI connection to the Trino coordinator (same catalog/namespaces as Spark)."""
    import trino  # lazy import so the module imports even where the client isn't installed

    return trino.dbapi.connect(
        host=os.environ.get("TRINO_HOST", "localhost"),
        port=int(os.environ.get("TRINO_PORT", "8090")),
        user=os.environ.get("TRINO_USER", "brain"),
        catalog=CATALOG,
        # Iceberg maintenance procedures target fully-qualified names, so the default schema is
        # informational only — every statement here qualifies iceberg.<namespace>.<table>.
        schema=BRONZE_NAMESPACE,
    )


def fqtn(namespace: str, table: str) -> str:
    """Fully-qualified table name in the Trino catalog: iceberg.brain_bronze.collector_events_connect."""
    return f"{CATALOG}.{namespace}.{table}"


# ── Retention-window conversion (Spark ms/h/d → Trino duration string) ──────────────────────────────


def ms_to_duration(ms: int) -> str:
    """Trino duration string for a millisecond window. 0 → '0s' (immediate — RTBF purge)."""
    if ms <= 0:
        return "0s"
    # Prefer whole days when clean (matches how the Spark windows are expressed: 7d / 14d).
    if ms % 86_400_000 == 0:
        return f"{ms // 86_400_000}d"
    if ms % 3_600_000 == 0:
        return f"{ms // 3_600_000}h"
    if ms % 1_000 == 0:
        return f"{ms // 1_000}s"
    # Sub-second is meaningless for snapshot windows; round up to 1s.
    return "1s"


def hours_to_duration(hours: int) -> str:
    """Trino duration string for an hours window (bronze_raw_retention RAW_RETENTION_HOURS)."""
    if hours <= 0:
        return "0s"
    if hours % 24 == 0:
        return f"{hours // 24}d"
    return f"{hours}h"


# ── The three maintenance procedures (Trino EXECUTE) ────────────────────────────────────────────────


def optimize(cur, namespace: str, table: str) -> None:
    """Compaction — Trino analogue of Spark `system.rewrite_data_files` (coalesce small files).

    `ALTER TABLE … EXECUTE optimize` rewrites the table's data files into target-sized files.
    Trino chooses the file-size target from `iceberg.target-max-file-size` (default 512MB / the
    catalog config), which subsumes the Spark job's explicit target-file-size-bytes=128MB +
    min-input-files knobs — there is no per-EXECUTE min-input-files argument in Trino, and the
    optimizer is a no-op on already-compacted partitions, so the behaviour matches.
    """
    t = fqtn(namespace, table)
    print(f"[maintenance] optimize (compaction) {t} …", flush=True)
    cur.execute(f"ALTER TABLE {t} EXECUTE optimize")
    cur.fetchall()


def expire(cur, namespace: str, table: str, retention: str) -> None:
    """Snapshot expiry — Trino analogue of Spark `system.expire_snapshots` (drop old history + files).

    `retention` is a Trino duration string (e.g. '7d', '14d', '0s'). When the requested retention is
    below Trino's configured minimum (default 7d) — which the RTBF/erasure path REQUIRES ('0s' →
    purge pre-delete snapshots immediately) — the matching session property is lowered for the
    statement so the purge is not silently refused.
    """
    t = fqtn(namespace, table)
    print(f"[maintenance] expire_snapshots {t} retention_threshold => '{retention}' …", flush=True)
    # Lower the min-retention floor for this connection so a sub-7d (RTBF 0s) purge is honoured.
    # Setting it unconditionally to the requested threshold is safe: for the >=7d maintenance windows
    # it equals the default; for the 0s erasure purge it lifts the guard exactly as intended.
    cur.execute(f"SET SESSION iceberg.expire_snapshots_min_retention = '{retention}'")
    cur.fetchall()
    cur.execute(f"ALTER TABLE {t} EXECUTE expire_snapshots(retention_threshold => '{retention}')")
    cur.fetchall()


def remove_orphans(cur, namespace: str, table: str, retention: str) -> None:
    """Orphan-file removal — Trino analogue of Spark `system.remove_orphan_files`.

    Deletes files under the table location that no snapshot references (leftovers of failed/killed
    commits). `retention` is a Trino duration string. Same min-retention session guard as expire().
    """
    t = fqtn(namespace, table)
    print(f"[maintenance] remove_orphan_files {t} retention_threshold => '{retention}' …", flush=True)
    cur.execute(f"SET SESSION iceberg.remove_orphan_files_min_retention = '{retention}'")
    cur.fetchall()
    cur.execute(f"ALTER TABLE {t} EXECUTE remove_orphan_files(retention_threshold => '{retention}')")
    cur.fetchall()


# ── Catalog introspection (Trino information_schema — SHOW TABLES analogue) ──────────────────────────


def tables_in(cur, namespace: str) -> "list[str]":
    """Every table in a namespace (Trino `SHOW TABLES`), so new marts/lanes are covered without
    editing the job files — same auto-discovery the Spark jobs get from `SHOW TABLES IN`."""
    cur.execute(f"SHOW TABLES FROM {CATALOG}.{namespace}")
    return sorted(r[0] for r in cur.fetchall())


def table_exists(cur, namespace: str, table: str) -> bool:
    """True if the table exists in the catalog namespace (lane auto-created on first record)."""
    cur.execute(
        "SELECT 1 FROM information_schema.tables "
        "WHERE table_schema = ? AND table_name = ?",
        (namespace, table),
    )
    return cur.fetchone() is not None


def columns_of(cur, namespace: str, table: str) -> "set[str]":
    """Column names present in the table's Trino/Iceberg schema (for the erasure _col_exists guard
    and the brand_id tenant-key check)."""
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = ? AND table_name = ?",
        (namespace, table),
    )
    return {r[0] for r in cur.fetchall()}
