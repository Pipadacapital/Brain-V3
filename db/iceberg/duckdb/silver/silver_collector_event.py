"""
silver_collector_event.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_collector_event.py.

THE KEYSTONE / ADMISSION GATE (ADR-0006 P2 / ADR-0010). Every other Silver job reads this table, so it is
the single most important port: it lifts the retired Spark Bronze sink's gate_and_map into Silver.

  brain_bronze.collector_events_connect  →  [envelope-scalar lift + R2 tenant + R3 consent gate + lane
                                             split + dedup]  →  brain_silver.silver_collector_event

SOURCE (ADR-0010 — the ONLY source): the Kafka Connect Iceberg sink lands the collector topic into the
TRULY-RAW brain_bronze.collector_events_connect as {payload (verbatim envelope JSON), kafka_topic,
kafka_partition, kafka_offset, kafka_timestamp}. NO lifted scalars, NO gate, NO dedup on the Bronze side.
This job lifts the envelope scalars the gate needs from the `payload` JSON in SQL (json_extract_string) —
the SAME JSON paths the Spark build() lifts ($.event_id / $.brand_id / $.event_name / $.occurred_at /
$.ingested_at / $.correlation_id) — and keeps `payload` verbatim so downstream get_json_object readers work
unchanged.

THE GATE (faithful port of gate_and_map / _process_window — reproduced EXACTLY):
  - malformed drop: event_id / brand_id / occurred_at NULL → excluded (never written).
  - LEDGER_ONLY (settlement.live.v1) → excluded (an intentional routing exclusion, the ledger bridge).
  - SERVER_TRUSTED lane (order.live.v1, spend.live.v1, … — the VERBATIM set below): brand_id is already
    server-derived → trust the CLAIMED brand_id (no install_token, no consent signal).
  - PIXEL lane (everything else):
      R3 = consent_flags object must be PRESENT (else drop); PLUS the SPEC A.1.2 / AMD-04 identify
           denied-VALUE drop (an IDENTIFY whose consent value denies → dropped).
      R2 = resolve brand from properties.install_token via PG pixel.pixel_installation (INNER join →
           an unresolved token is dropped as tenant_unresolved); drop claimed≠derived (brand_mismatch).
           brand_id = the DERIVED brand.
  - DEDUP on (brand_id, event_id) keeping latest ingested_at (the Connect sink is at-least-once).

IDEMPOTENT: MERGE on (brand_id, event_id) via _base.merge_on_pk (in-batch dedup latest-ingested-wins +
WHEN MATCHED UPDATE / NOT MATCHED INSERT). Re-running over the same raw Bronze yields identical rows.

SIDE-WRITES SKIPPED (parity-preserving, per the task): the Spark gate ROUTES every rejected row through
_silver_technical.write_quarantine (schema / tenant_unresolved / brand_mismatch → silver_quarantine) and
write_consent_rejected (consent_missing / consent_denied → silver_consent_rejected). Those are append-only
DIAGNOSTIC ledgers, NOT part of the good-row keystone set. This port produces ONLY the main
silver_collector_event good-row set (the parity target); the reject side-writes are intentionally NOT
reproduced. The good-row admission set is byte-identical either way.

PG READ (R2): the DuckDB postgres extension (INSTALL/LOAD postgres → ATTACH READ_ONLY) reads
pg.pixel.pixel_installation (install_token, brand_id) — the DuckDB analogue of the Spark JDBC
_load_installs superuser read. Graceful fallback if PG is unreachable: R2 treats EVERY pixel-lane row as
tenant_unresolved (empty install map → INNER join yields nothing), so pixel rows are dropped exactly as the
Spark INNER-join drop would — server-trusted + ledger lanes are unaffected. (PG IS up here with 5 tokens.)

Parity target: brain_silver.silver_collector_event (Spark oracle = 125,516 rows from raw = 1,882,037).
Honors MIGRATION_TABLE_SUFFIX (→ silver_collector_event_duckdb_test) for the parallel-run parity harness.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, BRONZE_NAMESPACE, SILVER_NAMESPACE  # noqa: E402
from _silver_technical_ports import event_category, identify_consent_denied  # noqa: E402

# ADR-0010: the collector lane lands VERBATIM in collector_events_connect (payload + kafka coords only).
CONNECT_TABLE = (
    f"{CATALOG}.{BRONZE_NAMESPACE}."
    f"{os.environ.get('COLLECTOR_CONNECT_TABLE', 'collector_events_connect')}"
)

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_collector_event_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# ── LANE POLICY — copied VERBATIM from the Spark file (this DuckDB port is the exact twin) ─────────────
SERVER_TRUSTED = {
    "order.live.v1", "order.backfill.v1", "spend.live.v1", "shopflo.checkout_abandoned.v1",
    "gokwik.rto_predict.v1", "shiprocket.shipment_status.v1",
    # SR-4: shiprocket.return_status.v1 is the SEPARATE return canonical (server-derived; not the shipment lane).
    "shiprocket.return_status.v1",
    # GoKwik webhook-first canonicals (server-derived from gokwik_appid; no install_token/consent).
    "checkout.abandoned.v1", "gokwik.checkout_started.v1", "gokwik.checkout_step.v1",
    "payment.attempted.v1", "payment.authorized.v1",
    # CRIT-4: Shopify CONNECTOR-derived RESOURCE events (server-derived brand_id, no pixel signal).
    "product.upsert.v1", "customer.upsert.v1", "refund.recorded.v1", "fulfillment.recorded.v1",
    # P1 webhook expansion: inventory.level.v1 (Shopify connector-derived, server-trusted).
    "inventory.level.v1",
    # WOO-3: coupon.upsert.v1 is the NEW canonical coupon grain (WooCommerce connector-derived).
    "coupon.upsert.v1",
    # AD-1: ad.entity.updated is the SHARED Meta+Google entity-metadata canonical (connector-derived).
    "ad.entity.updated",
    # SHOPFLO lifecycle: the NEW Shopflo checkout-funnel canonicals (webhook-first, server-derived).
    "shopflo.checkout_started.v1", "shopflo.checkout_step.v1", "shopflo.checkout_completed.v1",
}
LEDGER_ONLY = {"settlement.live.v1"}

# Postgres pixel_installation — install_token → brand_id for R2. Superuser read (cross-brand, RLS-bypass
# ETL posture), mirroring the retired Bronze sink's load_pixel_installations + the Spark _load_installs JDBC.
PG_JDBC_URL = os.environ.get("BRONZE_PG_JDBC_URL", "jdbc:postgresql://localhost:5432/brain")
PG_USER = os.environ.get("BRONZE_PG_USER", "brain")
PG_PASSWORD = os.environ.get("BRONZE_PG_PASSWORD", "brain")

# ── COLUMN CONTRACT — identical to the Spark COLUMNS_SQL (same order, same types) ──────────────────────
COLUMNS_SQL = """
  event_id          string    NOT NULL,
  brand_id          string    NOT NULL,
  occurred_at       timestamp NOT NULL,
  ingested_at       timestamp NOT NULL,
  schema_name       string    NOT NULL,
  schema_version    int       NOT NULL,
  event_type        string    NOT NULL,
  event_category    string,
  correlation_id    string,
  partition_key     string    NOT NULL,
  anonymous_id      string,
  device_id         string,
  silver_version    int,
  payload           string    NOT NULL
""".strip("\n")

# Projection order for the good-row SELECT + the MERGE column list (matches the Spark project()).
COLUMNS = [
    "event_id", "brand_id", "occurred_at", "ingested_at", "schema_name", "schema_version",
    "event_type", "event_category", "correlation_id", "partition_key", "anonymous_id", "device_id",
    "silver_version", "payload",
]


def _in_list(vals) -> str:
    return ", ".join(f"'{v}'" for v in sorted(vals))


def _register_udfs(con) -> None:
    """Expose the two VENDORED pure Stage-1 ports as DuckDB scalar UDFs — the DuckDB analogue of the Spark
    event_category_udf() / identify_consent_denied_udf() (which udf-wrap the SAME functions)."""
    con.create_function(
        "sce_event_category", event_category, ["VARCHAR"], "VARCHAR", null_handling="special",
    )
    con.create_function(
        "sce_identify_consent_denied", identify_consent_denied,
        ["VARCHAR", "VARCHAR", "VARCHAR"], "BOOLEAN", null_handling="special",
    )


def _jdbc_to_libpq(jdbc_url: str) -> str:
    """jdbc:postgresql://host:port/db → a DuckDB postgres-extension libpq DSN (host=… port=… dbname=…)."""
    rest = jdbc_url.replace("jdbc:postgresql://", "").replace("postgresql://", "")
    hostport, _, dbname = rest.partition("/")
    dbname = (dbname.split("?")[0] or "brain")
    host, _, port = hostport.partition(":")
    return " ".join([
        f"host={host or 'localhost'}", f"port={port or '5432'}", f"dbname={dbname}",
        f"user={PG_USER}", f"password={PG_PASSWORD}",
    ])


def _register_installs(con) -> bool:
    """Register the _sce_installs (install_token → derived_brand_id) view for R2.

    From PG pixel.pixel_installation via the postgres extension when reachable (the DuckDB analogue of the
    Spark _load_installs superuser JDBC read). On ANY failure (extension missing / PG unreachable) returns
    False and registers an EMPTY typed view — R2's INNER join then resolves NOTHING, so every pixel-lane row
    drops as tenant_unresolved, EXACTLY the Spark INNER-join drop for an absent install map (server-trusted
    + ledger lanes unaffected). Best-effort, non-fatal. PG IS up here with 5 tokens."""
    try:
        con.execute("INSTALL postgres; LOAD postgres;")
        dsn = _jdbc_to_libpq(PG_JDBC_URL)
        con.execute(f"ATTACH IF NOT EXISTS '{dsn}' AS _pg (TYPE postgres, READ_ONLY);")
        con.execute("SELECT 1 FROM pg_catalog.pg_class LIMIT 1;")  # probe: unreachable fails HERE
        con.execute(
            """
            CREATE OR REPLACE TEMP VIEW _sce_installs AS
            SELECT install_token::text AS install_token, brand_id::text AS derived_brand_id
            FROM _pg.pixel.pixel_installation
            WHERE install_token IS NOT NULL;
            """
        )
        n = con.execute("SELECT count(*) FROM _sce_installs").fetchone()[0]
        print(f'{{"job":"silver-collector-event","pg":"ok","install_tokens":{n}}}', flush=True)
        return True
    except Exception as exc:  # noqa: BLE001 — PG optional; degrade to the tenant_unresolved-drop posture.
        con.execute(
            "CREATE OR REPLACE TEMP VIEW _sce_installs AS "
            "SELECT CAST(NULL AS VARCHAR) AS install_token, CAST(NULL AS VARCHAR) AS derived_brand_id "
            "WHERE FALSE;"
        )
        print(f'{{"job":"silver-collector-event","pg":"unreachable","detail":"{str(exc)[:120]}",'
              f'"fallback":"pixel-lane R2 all tenant_unresolved (dropped)"}}', flush=True)
        return False


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")
    _register_udfs(con)
    _register_installs(con)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   The keystone is PER-EVENT admission: each Bronze row → 0..1 silver row via the idempotent MERGE on
    #   (brand_id, event_id), so windowing the source read is safe — a row's output depends only on itself.
    #   Bronze collector_events_connect has no lifted ingested_at column; its physical arrival key is
    #   kafka_timestamp (the watermark tracks max(kafka_timestamp), with a trailing lookback so a slightly
    #   out-of-order Kafka arrival can never be skipped). Default OFF → (None, None) → full scan, unchanged.
    lo, hi = incremental_window(con, "silver-collector-event", CONNECT_TABLE, ts_col="kafka_timestamp")
    win = []
    if lo is not None:
        win.append(f"kafka_timestamp >= '{lo}'")
    if hi is not None:
        win.append(f"kafka_timestamp <= '{hi}'")
    src_window = f"WHERE {' AND '.join(win)}" if win else ""

    # ── ENVELOPE-SCALAR LIFT — the exact JSON paths the Spark build() lifts, plus the R2/R3 signals the
    #    gate parses out of the payload. `payload` stays VERBATIM. ─────────────────────────────────────
    #   ingested_at coalesces the envelope ingest clock → now() as the last resort (Spark: coalesce(
    #   ingested_at, received_at, current_timestamp()); received_at == the same envelope $.ingested_at
    #   under the Connect writer, so it collapses to this).
    lifted = f"""
      SELECT
        json_extract_string(payload, '$.event_id')       AS event_id,
        json_extract_string(payload, '$.brand_id')        AS claimed_brand_id,
        json_extract_string(payload, '$.event_name')      AS event_type,
        try_cast(json_extract_string(payload, '$.occurred_at') AS TIMESTAMP) AS occurred_at,
        coalesce(
          try_cast(json_extract_string(payload, '$.ingested_at') AS TIMESTAMP),
          now() AT TIME ZONE 'UTC'
        )                                                 AS ingested_at,
        json_extract_string(payload, '$.correlation_id')  AS correlation_id,
        json_extract_string(payload, '$.properties.install_token')   AS install_token,
        -- R3 presence signal: the consent_flags OBJECT present (non-null) vs absent (null).
        json_extract_string(payload, '$.consent_flags')              AS consent_flags_raw,
        -- SPEC A.1.2 (AMD-04) denied-VALUE signals for identify events.
        json_extract_string(payload, '$.properties.consent_state')   AS consent_state_raw,
        json_extract_string(payload, '$.consent_flags.analytics')    AS consent_analytics_raw,
        -- promoted identifiers (Gap D).
        json_extract_string(payload, '$.properties.brain_anon_id')   AS anonymous_id,
        json_extract_string(payload, '$.properties.device_id')       AS device_id,
        payload
      FROM {CONNECT_TABLE}
      {src_window}
    """

    # ── SCHEMA gate: malformed envelope (missing event_id / brand_id / occurred_at) → excluded.
    #    LEDGER_ONLY → excluded (intentional routing exclusion). ────────────────────────────────────────
    base = f"""
      SELECT * FROM ({lifted})
      WHERE event_id IS NOT NULL AND claimed_brand_id IS NOT NULL AND occurred_at IS NOT NULL
        AND event_type NOT IN ({_in_list(LEDGER_ONLY)})
    """

    # ── SERVER_TRUSTED lane: trust the claimed brand_id (no install/consent). brand_id = claimed. ───────
    server = f"""
      SELECT event_id, claimed_brand_id AS brand_id, event_type, occurred_at, ingested_at,
             correlation_id, anonymous_id, device_id, payload
      FROM ({base})
      WHERE event_type IN ({_in_list(SERVER_TRUSTED)})
    """

    # ── PIXEL lane: everything else. R3 consent presence + SPEC A.1.2 identify denied-value + R2 tenant. ─
    #    R3 (presence): consent_flags object must be present.
    #    A.1.2: an IDENTIFY whose consent VALUE denies → dropped (consent_denied).
    #    R2: INNER join to _sce_installs on install_token (unresolved → dropped: tenant_unresolved),
    #        then admit only claimed == derived (mismatch dropped). brand_id = derived. ─────────────────
    pixel = f"""
      SELECT c.event_id, i.derived_brand_id AS brand_id, c.event_type, c.occurred_at, c.ingested_at,
             c.correlation_id, c.anonymous_id, c.device_id, c.payload
      FROM (
        SELECT * FROM ({base})
        WHERE event_type NOT IN ({_in_list(SERVER_TRUSTED)})
          AND consent_flags_raw IS NOT NULL                               -- R3 presence
          AND NOT sce_identify_consent_denied(event_type, consent_state_raw, consent_analytics_raw)  -- A.1.2
      ) c
      JOIN _sce_installs i ON c.install_token = i.install_token           -- R2 INNER: unresolved dropped
      WHERE c.claimed_brand_id = i.derived_brand_id                       -- R2: drop brand_mismatch
    """

    # ── PROJECT to the column contract (identical to the Spark project()): schema_name/version pinned,
    #    event_category via the vendored UDF, partition_key = brand_id:event_id, silver_version seed 1. ──
    def project(src_sql: str) -> str:
        return f"""
          SELECT
            event_id,
            brand_id,
            occurred_at,
            ingested_at,
            'brain.collector.event.v1'                       AS schema_name,
            CAST(1 AS INTEGER)                               AS schema_version,
            event_type,
            sce_event_category(event_type)                   AS event_category,
            correlation_id,
            concat(brand_id, ':', event_id)                  AS partition_key,
            anonymous_id,
            device_id,
            CAST(1 AS INTEGER)                               AS silver_version,
            payload
          FROM ({src_sql})
        """

    gated = f"({project(server)}) UNION ALL BY NAME ({project(pixel)})"

    # DEDUP on (brand_id, event_id), latest-ingested-wins — done by merge_on_pk's in-batch row_number.
    return merge_on_pk(
        con, TARGET, gated, COLUMNS, ["brand_id", "event_id"], order_by_desc=["ingested_at"]
    )


if __name__ == "__main__":
    # The keystone's watermark tracks the Bronze arrival clock (kafka_timestamp on collector_events_connect),
    # not the gated keystone's ingested_at — see incremental_window's ts_col.
    run_job(
        "silver-collector-event", build, target_table="silver_collector_event",
        source_table=CONNECT_TABLE, ts_col="kafka_timestamp",
    )
