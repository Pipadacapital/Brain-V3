"""
gold_revenue_ledger.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_revenue_ledger.py
(itself db/dbt/models/marts/gold_revenue_ledger.sql, a 1:1 projection of the silver_order_recognition VIEW).

THE REVENUE KEYSTONE — money correctness is paramount. This is the realized-revenue RECOGNITION ledger:
one row per (brand_id, ledger_event_id) — i.e. one row per recognition EVENT (provisional / finalization /
cod_delivery_confirmed / cod_rto_clawback / cancellation / refund), carrying the SIGNED order amount in
BIGINT minor units + a sibling currency_code. It is NOT collapsed to one row per order (that is
silver_order_state); it stops at the recognition-event grain, exactly as the dbt mart does.

WHY IT FOLDS THE RECOGNITION CHAIN FROM BRONZE (like the Spark job): silver_order_recognition.sql is a dbt
VIEW — never materialized to any brain_silver table — so there is no Iceberg silver_order_recognition to
read. The recognition events are computed deterministically FROM the gated keystone
{CATALOG}.brain_silver.silver_collector_event (ADR-0006 P3) plus two small dimension reads. The proven
silver_order_state.py DuckDB port ALREADY folds this EXACT recognition chain (stg_order_events_bronze →
enriched → the 6 recognition event_types); this job reuses that IDENTICAL fold verbatim and STOPS at the
recognition-event grain, then applies the gold projection.

RECOGNITION RULES reproduced EXACTLY from silver_order_state.py / silver_order_recognition.sql (signed
BIGINT minor units):
  1. provisional_recognition  — every order (the booking).                            +amount_minor
  2. finalization             — PREPAID only, past the prepaid horizon, not reversed.  +amount_minor
  3. cod_delivery_confirmed   — COD recognized on terminal delivery.                   +amount_minor
  4. cod_rto_clawback         — COD returned (RTO).                                     -amount_minor
  5. cancellation             — order cancelled.                                        -amount_minor
  6. refund                   — refunded and not already a cancellation.                -amount_minor

GRAIN / PK: 1 row per (brand_id, ledger_event_id). PK = (brand_id, ledger_event_id).
  ledger_event_id = sha2(concat_ws('\\0', brand_id, order_id, event_type,
                         cast(economic_effective_at as string)), 256)  — dbt's deterministic replay key.
  In DuckDB: sha256(concat_ws(chr(0), brand_id, order_id, event_type, <sr_dt_str>)). DuckDB's sha256()
  returns lowercase hex of the UTF-8 bytes, byte-identical to Spark's sha2(x, 256). concat_ws(chr(0), …)
  emits the SAME NUL-byte separator dbt/Spark use.

  PARITY-CRITICAL — StarRocks datetime→string rendering (`_sr_dt_str`): the sha2 input casts
  economic_effective_at to STRING. dbt renders it in StarRocks: WHOLE seconds → 'yyyy-MM-dd HH:mm:ss'
  (no fraction); any SUB-second → 'yyyy-MM-dd HH:mm:ss.NNNNNN' (ALWAYS 6 microsecond digits). The Spark
  port reproduces this exactly (its _sr_dt_str), because a naive cast trims trailing zeros and would
  produce a DIFFERENT sha2 key. DuckDB behaves like Spark's naive cast (trims), so we reproduce the SAME
  StarRocks rendering here: strftime(ts,'%f') gives the 6-digit microsecond tail ('000000' for whole
  seconds); we emit no fraction when it is '000000', else 'HH:MM:SS.NNNNNN'. Byte-identical ledger_event_id.

MONEY: amount_minor / fee_minor are SIGNED BIGINT minor units paired with currency_code; per-currency,
  never blended, never a float. brand_id is the tenant key, FIRST column. The signed amount is carried
  STRAIGHT from the recognition fold — no money re-derivation.
  fee_minor = 0 (silver_order_recognition emits 0; gold casts coalesce(fee_minor,0)).
  recognition_label = 'provisional' for provisional_recognition else 'finalized'.
  billing_posted_period = date_format(economic_effective_at,'%Y-%m') → strftime(ee,'%Y-%m').
  data_source = 'live' (always — the 'synthetic' demo-seed override is never taken by a real build).

dbt/gold ADMISSION FILTER reproduced EXACTLY: `where ledger_event_id is not null and occurred_at is not
null`. ledger_event_id is a sha over non-null inputs so it is never null; occurred_at NOT NULL is kept.
(The recognition fold already drops order_id null/'' upstream, matching stg_order_events_bronze.)

IDEMPOTENT / REPLAY-SAFE: the Spark job does a full-fold overwritePartitions() (a COMPLETE re-fold of ALL
brands from Bronze every run — no watermark, no brand filter). A full-scan recompute + idempotent MERGE on
the (brand_id, ledger_event_id) PK is PARITY-EQUIVALENT here: ledger_event_id is a deterministic sha over
(brand_id, order_id, event_type, economic_effective_at), so re-running over the same gated source restates
byte-identical rows (UPDATE) and inserts none new. NOTE the one behavioral difference the Spark docstring
calls out: overwritePartitions() SHEDS orphans (a re-fold that changes an order's winning event replaces
the whole brand-bucket partition), whereas MERGE is UPDATE/INSERT-only and cannot delete a stale
ledger_event_id whose economic_effective_at shifted between runs. For the parity harness (a fresh
<table>_duckdb_test folded once from the current gated source) the admission set is identical, so this is
parity-equivalent; divergence would only appear across two runs where an order's recognition key changes.
Documented, not silently dropped.

── DIMENSION READS (Spark reads these over PG JDBC; reproduced faithfully) ──────────────────────────────
  • brain_id ← identity export. Same as silver_order_state.py: read the Iceberg SIBLINGS of the PG
    operational tables (silver_identity_alias = ops.silver_identity_link; silver_customer_identity 1:1),
    reproducing the EXACT PG query (identifier_type='pre_hashed_email', is_active, brain_id NOT NULL,
    MIN(COALESCE(merged_into, brain_id)) per (brand_id, identifier_value)). brain_id is NOT part of
    ledger_event_id, so it never affects the money key — only the resolved customer on-row.
  • prepaid recognition horizon ← Spark reads tenancy.brand.prepaid_recognition_horizon_days over PG JDBC.
    We reproduce this via the DuckDB `postgres` extension ATTACH (mirroring gold_contribution_margin.py's
    _try_attach_pg), with a GRACEFUL FALLBACK to the schema DEFAULT (7 days) per brand when PG is
    unreachable (the parity-harness / prod-local posture). The finalization filter already coalesces to 7
    (coalesce(prepaid_horizon, 7)); the finalization economic_effective_at uses the same per-brand horizon.
    On the current corpus every brand is at the default 7, so the ATTACH path and the fallback produce the
    IDENTICAL ledger (asserted by the parity run) — the single dimension caveat, same as silver_order_state.

FINALIZATION arithmetic: economic_effective_at = occurred_at + INTERVAL (N day) — N×24h with time-of-day
  PRESERVED (byte-identical to Spark's make_dt_interval / StarRocks date_add, NOT date_add-to-midnight).
  Compared against `now()` (Spark current_timestamp()); SILVER_NOW_OVERRIDE freezes "now" to a stale Spark
  run instant ONLY for the parity harness (proves the transform is byte-identical net of wall-clock drift).

QUARANTINE: none written — same as silver_order_state.py and the framework's other Gold/Silver ports. The
  Spark chain's Stage-1 dq quarantine side-write (brain_silver.silver_quarantine stage='dq') is NOT
  reproduced here (no _silver_technical analogue); Bronze keeps the originals so the ledger can be rebuilt.

AUDIT-G1 — ADDITIVE, FLAG-GATED brain_id_v2 (per-brand `identity.revenue_querytime`, DEFAULT OFF, fail-
  closed): alongside the legacy FLAT single-key brain_id (hashed_customer_email → silver_identity_alias),
  this job ALSO emits an additive `brain_id_v2` column resolved at QUERY TIME from the bi-temporal MULTI-KEY
  silver_identity_map (email + phone + platform_customer_id; identity_current predicate is_current=TRUE AND
  system_to IS NULL; merge-reconciled; never-guess on |B|>1) — the SAME canonical pattern
  gold_journey_events / gold_customer_360 use (via the shared _revenue_identity module). The two resolutions
  sit side-by-side on the row for PARALLEL-RUN parity comparison. brain_id_v2 is NOT part of ledger_event_id
  (like brain_id), so the money key + amounts are byte-identical regardless of the flag. When OFF for a brand
  (default) or the map is absent → brain_id_v2 is NULL and the legacy flat brain_id/ledger is UNCHANGED.

Parity target: brain_gold.gold_revenue_ledger (flag OFF → brain_id_v2 NULL, legacy columns byte-identical).
"""
from __future__ import annotations

import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402
from _revenue_identity import enabled_brands as _revenue_qt_brands  # noqa: E402
from _revenue_identity import resolve_brain_id_v2_sql  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_revenue_ledger_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_revenue_ledger{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# BOTH order lanes — live webhook + historical connector backfill (parity with the Spark stg CTE).
ORDER_EVENTS = ["order.live.v1", "order.backfill.v1"]
# LIVE forward-logistics lane driving COD recognition (retired gokwik.awb_status.v1 repointed here — 0117).
AWB_EVENT = "shiprocket.shipment_status.v1"

# Iceberg siblings of the PG operational dimensions (see module docstring / silver_order_state.py).
IDENTITY_ALIAS = f"{CATALOG}.{SILVER_NAMESPACE}.silver_identity_alias"
CUSTOMER_IDENTITY = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer_identity"
# audit-G1: the bi-temporal MULTI-KEY identity map — the query-time (flag-ON) brain_id_v2 resolution source.
IDENTITY_MAP = f"{CATALOG}.{SILVER_NAMESPACE}.silver_identity_map"

# tenancy.brand.prepaid_recognition_horizon_days DEFAULT — the graceful fallback when PG is unreachable.
DEFAULT_PREPAID_HORIZON = 7

# Operational Postgres (config tier) — the SAME source the Spark job reads for the per-brand prepaid
# recognition horizon. Reachable → exact Spark path; unreachable → per-brand DEFAULT (7). Best-effort.
PG_JDBC_URL = os.environ.get("GOLD_PG_JDBC_URL", os.environ.get("SILVER_PG_JDBC_URL",
                                                                "jdbc:postgresql://postgres:5432/brain"))
PG_USER = os.environ.get("GOLD_PG_USER", os.environ.get("SILVER_PG_USER", "brain"))
PG_PASSWORD = os.environ.get("GOLD_PG_PASSWORD", os.environ.get("SILVER_PG_PASSWORD", "brain"))

# The "now" instant the finalization horizon is compared against (Spark current_timestamp()). Default
# now(); SILVER_NOW_OVERRIDE (ISO instant) exists ONLY so the parity harness can reproduce a stale Spark
# snapshot's finalization boundary. Unset in production → live now(). Identical seam to silver_order_state.
_NOW_SQL = (
    f"TIMESTAMPTZ '{os.environ['SILVER_NOW_OVERRIDE']}'"
    if os.environ.get("SILVER_NOW_OVERRIDE")
    else "now()"
)

# StarRocks datetime→string rendering of economic_effective_at for the sha2 ledger_event_id (see docstring):
# whole seconds → 'yyyy-MM-dd HH:mm:ss' (no fraction); sub-second → append '.' + 6-digit microseconds.
# strftime(ts,'%f') yields the 6-digit microsecond tail ('000000' for whole seconds).
_SR_DT_STR = (
    "CASE WHEN strftime(economic_effective_at, '%f') = '000000' "
    "THEN strftime(economic_effective_at, '%Y-%m-%d %H:%M:%S') "
    "ELSE strftime(economic_effective_at, '%Y-%m-%d %H:%M:%S') || '.' "
    "|| strftime(economic_effective_at, '%f') END"
)

# Mirrors gold_revenue_ledger.sql column order/types. Timestamp cols are plain `timestamp` (framework GOLD
# convention). Money = bigint minor + sibling currency.
COLUMNS_SQL = """
  brand_id               string    NOT NULL,
  ledger_event_id        string    NOT NULL,
  order_id               string,
  brain_id               string,
  brain_id_v2            string,
  event_type             string,
  amount_minor           bigint,
  currency_code          string,
  fee_minor              bigint,
  occurred_at            timestamp,
  economic_effective_at  timestamp,
  recognition_label      string,
  billing_posted_period  string,
  ingested_at            timestamp,
  data_source            string    NOT NULL,
  updated_at             timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "ledger_event_id", "order_id", "brain_id", "brain_id_v2", "event_type", "amount_minor",
    "currency_code", "fee_minor", "occurred_at", "economic_effective_at", "recognition_label",
    "billing_posted_period", "ingested_at", "data_source", "updated_at",
]


def _jdbc_to_libpq(jdbc_url: str) -> str:
    """jdbc:postgresql://host:port/db → a libpq DSN for the DuckDB postgres extension ATTACH."""
    rest = jdbc_url.replace("jdbc:postgresql://", "").replace("postgresql://", "")
    hostport, _, dbname = rest.partition("/")
    dbname = (dbname.split("?")[0] or "brain")
    host, _, port = hostport.partition(":")
    parts = [f"host={host or 'postgres'}", f"port={port or '5432'}", f"dbname={dbname}",
             f"user={PG_USER}", f"password={PG_PASSWORD}"]
    return " ".join(parts)


def _try_horizons_view(con) -> bool:
    """Register `_horizons` (brand_id → prepaid_recognition_horizon_days) from PG when reachable.

    Mirrors gold_contribution_margin.py's _try_attach_pg: ATTACH operational Postgres READ-ONLY via the
    DuckDB postgres extension and project tenancy.brand.prepaid_recognition_horizon_days. On ANY failure
    (extension missing / PG unreachable — the parity-harness / prod-local posture) returns False and the
    caller falls back to the schema DEFAULT (7) per brand — parity-equivalent whenever every brand is at the
    default (the current corpus). Best-effort, non-fatal.
    """
    try:
        con.execute("INSTALL postgres; LOAD postgres;")
        dsn = _jdbc_to_libpq(PG_JDBC_URL)
        con.execute(f"ATTACH IF NOT EXISTS '{dsn}' AS pg (TYPE postgres, READ_ONLY);")
        con.execute("SELECT 1 FROM pg_catalog.pg_class LIMIT 1;")
        con.execute("""
            CREATE OR REPLACE TEMP VIEW _horizons AS
            SELECT CAST(id AS VARCHAR) AS brand_id,
                   CAST(prepaid_recognition_horizon_days AS INTEGER) AS prepaid_horizon
            FROM pg.tenancy.brand;
        """)
        return True
    except Exception as exc:  # noqa: BLE001 — PG optional; degrade to the schema DEFAULT horizon.
        print(f'{{"job":"gold-revenue-ledger","pg":"unreachable","detail":"{str(exc)[:120]}",'
              f'"fallback":"prepaid_horizon = default {DEFAULT_PREPAID_HORIZON} per brand"}}', flush=True)
        return False


def _identity_link_sql() -> str:
    """hashed-email → canonical brain_id, reproducing the Spark _read_identity_link PG query over the
    Iceberg siblings — IDENTICAL to silver_order_state.py so brain_id matches byte-for-byte. brain_id is
    NOT part of ledger_event_id, so the money key + amounts are byte-identical regardless."""
    return f"""
      SELECT l.brand_id, l.identifier_value AS hashed_customer_email,
             MIN(COALESCE(c.merged_into, l.brain_id)) AS brain_id
      FROM {IDENTITY_ALIAS} l
      LEFT JOIN {CUSTOMER_IDENTITY} c
        ON c.brand_id = l.brand_id AND c.brain_id = l.brain_id
      WHERE l.identifier_type = 'pre_hashed_email'
        AND l.is_active = true
        AND l.brain_id IS NOT NULL
      GROUP BY l.brand_id, l.identifier_value
    """


# audit-G1: the dev salt SoR for the SALTED external_id space (byte-identical to silver_session_identity /
# the connector normalize salt derivation) so a payload storefront_customer_id hashes to the SAME value the
# identity graph stored for that brand. Email/phone are already pre-hashed on the payload (no salt).
_DEV_SALT_PREFIX = os.environ.get("DEV_IDENTITY_SALT_PREFIX", "brain-dev-identity-salt-v1")


def _dev_salt(brand_id: str) -> str:
    return hashlib.sha256(f"{_DEV_SALT_PREFIX}||{brand_id.lower()}".encode("utf-8")).hexdigest()


def _table_exists(con, fq: str) -> bool:
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent map → no query-time resolution (fail-closed).
        return False


def _brain_id_v2_join_sql(con, stg_sql: str) -> str:
    """The additive, FLAG-GATED query-time resolver: (brand_id, order_id, brain_id_v2) for the flag-ON
    brands, from the bi-temporal MULTI-KEY silver_identity_map. Fail-closed to an EMPTY result (every order
    → NULL brain_id_v2 via the caller's LEFT JOIN) when the flag is OFF for all brands or the map is absent —
    so the legacy flat single-key output stays byte-identical (parity preserved)."""
    empty = (
        "SELECT NULL::VARCHAR AS brand_id, NULL::VARCHAR AS order_id, "
        "NULL::VARCHAR AS brain_id_v2 WHERE FALSE"
    )
    if not _table_exists(con, IDENTITY_MAP):
        return empty
    try:
        brands = [r[0] for r in con.execute(f"SELECT DISTINCT brand_id FROM ({stg_sql})").fetchall() if r[0]]
    except Exception:  # noqa: BLE001 — stg unreadable → nothing to resolve.
        return empty
    on_brands = _revenue_qt_brands(con, brands)
    if not on_brands:
        return empty

    # Per-order hashes for the MULTI-KEY resolution: email/phone pass through (pre-hashed); the platform id
    # is SALT-hashed with the per-brand dev salt via a CASE ladder (small, driver-known brand set).
    salt_cases = " ".join(
        f"WHEN brand_id = '{b}' THEN '{_dev_salt(b)}'" for b in on_brands
    )
    # external_id space hash — byte-identical to _raw_normalize.hash_identifier / silver_session_identity:
    # sha256( salt_hex || '||' || trim(value) ). trim (NOT lower) matches the normalize/connector SoR.
    platform_hash_expr = (
        "CASE WHEN storefront_customer_id IS NULL OR trim(storefront_customer_id) = '' THEN NULL "
        f"ELSE sha256(concat(CASE {salt_cases} ELSE '' END, '||', trim(storefront_customer_id))) END"
    )
    orders_cte = f"""
      SELECT brand_id, order_id,
             hashed_customer_email,
             hashed_customer_phone,
             {platform_hash_expr} AS platform_customer_id_hash
      FROM ({stg_sql})
    """
    return resolve_brain_id_v2_sql(IDENTITY_MAP, orders_cte, on_brands)


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id)")

    # Per-brand prepaid horizon: PG when reachable, else the schema DEFAULT (7). The finalization branch
    # LEFT JOINs _horizons and coalesces to DEFAULT_PREPAID_HORIZON, so a missing brand row → default.
    pg_ok = _try_horizons_view(con)
    horizon_col = "coalesce(h.prepaid_horizon, {d})".format(d=DEFAULT_PREPAID_HORIZON) if pg_ok \
        else f"CAST({DEFAULT_PREPAID_HORIZON} AS INTEGER)"
    horizon_join = "LEFT JOIN _horizons h ON h.brand_id = o.brand_id" if pg_ok else ""

    # ── stg_order_events_bronze: type + dedup order.{live,backfill}.v1 to (brand_id, order_id)
    #    latest-ingested (ingested_at DESC, occurred_at DESC, event_id DESC). IDENTICAL to
    #    silver_order_state.py. ingested_at is read from the PAYLOAD ($.ingested_at ISO string), NOT the
    #    gated source's top-level column — verbatim with the Spark stg CTE. ────────────────────────────────
    stg_typed = f"""
      SELECT brand_id, event_id, occurred_at,
             CAST(json_extract_string(pj, '$.ingested_at') AS TIMESTAMP)  AS ingested_at,
             {prop('pj','order_id')}                                   AS order_id,
             CAST({prop('pj','amount_minor')} AS BIGINT)               AS amount_minor,
             {prop('pj','currency_code')}                              AS currency_code,
             lower({prop('pj','payment_method')})                      AS payment_method_raw,
             {prop('pj','financial_status')}                           AS financial_status,
             {prop('pj','cancelled_at')}                               AS cancelled_at,
             {prop('pj','hashed_customer_email')}                      AS hashed_customer_email,
             -- audit-G1 (flag-ON only): additional MULTI-KEY hashes for query-time brain_id_v2. Extra
             -- columns — they do NOT change the flat single-key output (which reads hashed_customer_email
             -- alone). phone is pre-hashed on the payload; the platform id is salt-hashed below.
             {prop('pj','hashed_customer_phone')}                      AS hashed_customer_phone,
             {prop('pj','storefront_customer_id')}                     AS storefront_customer_id
      FROM ({read_gated_events_sql(ORDER_EVENTS)})
    """
    stg = f"""
      SELECT brand_id, event_id, order_id, amount_minor, currency_code,
             CASE WHEN payment_method_raw = 'cod' THEN 'cod' ELSE 'prepaid' END AS payment_method,
             financial_status, cancelled_at, hashed_customer_email,
             hashed_customer_phone, storefront_customer_id,
             occurred_at, ingested_at
      FROM (
        SELECT *, row_number() OVER (
                 PARTITION BY brand_id, order_id
                 ORDER BY ingested_at DESC, occurred_at DESC, event_id DESC) AS _dedup_rn
        FROM ({stg_typed})
        WHERE order_id IS NOT NULL AND order_id <> ''
      ) WHERE _dedup_rn = 1
    """

    # ── latest forward-shipment terminal_class per order (COD recognition signal) — IDENTICAL to
    #    silver_order_state.py. ONLY the forward shiprocket.shipment_status.v1 lane (the return lane's
    #    "delivered" would be the SR-4 false-delivery bug). ─────────────────────────────────────────────────
    awb_latest = f"""
      SELECT brand_id, order_id, terminal_class FROM (
        SELECT brand_id,
               {prop('pj','order_id')}       AS order_id,
               {prop('pj','terminal_class')} AS terminal_class,
               occurred_at,
               row_number() OVER (PARTITION BY brand_id, {prop('pj','order_id')}
                                  ORDER BY occurred_at DESC) AS _rn
        FROM ({read_gated_events_sql([AWB_EVENT])})
        WHERE {prop('pj','order_id')} IS NOT NULL AND {prop('pj','order_id')} <> ''
      ) WHERE _rn = 1
    """

    # ── audit-G1: additive, FLAG-GATED query-time brain_id_v2 (default OFF → NULL, parity preserved). ──
    # For the brands whose identity.revenue_querytime flag is ON, resolve brain_id at query time from the
    # bi-temporal MULTI-KEY silver_identity_map (email + phone + platform_customer_id; identity_current;
    # merge-reconciled; never-guess) — the SAME canonical pattern gold_journey_events/gold_customer_360 use.
    # The legacy flat single-key brain_id (b.brain_id below) is UNCHANGED. OFF/absent-map → empty → NULL.
    brain_id_v2_join = _brain_id_v2_join_sql(con, stg)

    # ── silver_order_recognition.enriched: one enriched canonical order (+ brain_id, prepaid horizon, awb) ──
    enriched = f"""
      SELECT o.brand_id, o.order_id, b.brain_id, v2.brain_id_v2, o.amount_minor, o.currency_code,
             o.payment_method, o.financial_status, o.cancelled_at, o.occurred_at, o.ingested_at,
             CAST({horizon_col} AS INTEGER) AS prepaid_horizon,
             a.terminal_class AS awb_terminal_class
      FROM ({stg}) o
      LEFT JOIN ({_identity_link_sql()}) b
        ON b.brand_id = o.brand_id AND b.hashed_customer_email = o.hashed_customer_email
      LEFT JOIN ({awb_latest}) a
        ON a.brand_id = o.brand_id AND a.order_id = o.order_id
      LEFT JOIN ({brain_id_v2_join}) v2
        ON v2.brand_id = o.brand_id AND v2.order_id = o.order_id
      {horizon_join}
    """

    # ── the 6 recognition event_types (signed money). FINALIZATION: occurred_at + INTERVAL (N day) —
    #    N×24h with time-of-day preserved (byte-identical to Spark make_dt_interval, NOT date_add-to-midnight).
    fin_interval = "occurred_at + (prepaid_horizon * INTERVAL 1 DAY)"
    fin_threshold = f"occurred_at + (coalesce(prepaid_horizon, {DEFAULT_PREPAID_HORIZON}) * INTERVAL 1 DAY)"
    recognition = f"""
      WITH e AS ({enriched})
      SELECT brand_id, order_id, brain_id, brain_id_v2, 'provisional_recognition' AS event_type,
             amount_minor, currency_code, occurred_at, occurred_at AS economic_effective_at, ingested_at
      FROM e
      UNION ALL
      SELECT brand_id, order_id, brain_id, brain_id_v2, 'finalization' AS event_type,
             amount_minor, currency_code, occurred_at,
             {fin_interval} AS economic_effective_at, ingested_at
      FROM e
      WHERE payment_method = 'prepaid'
        AND {fin_threshold} < {_NOW_SQL}
        AND cancelled_at IS NULL
        AND coalesce(financial_status, '') NOT IN ('refunded', 'voided', 'cancelled')
      UNION ALL
      SELECT brand_id, order_id, brain_id, brain_id_v2, 'cod_delivery_confirmed' AS event_type,
             amount_minor, currency_code, occurred_at, occurred_at AS economic_effective_at, ingested_at
      FROM e
      WHERE payment_method = 'cod' AND awb_terminal_class = 'delivered'
      UNION ALL
      SELECT brand_id, order_id, brain_id, brain_id_v2, 'cod_rto_clawback' AS event_type,
             -amount_minor AS amount_minor, currency_code, occurred_at, occurred_at AS economic_effective_at, ingested_at
      FROM e
      WHERE payment_method = 'cod' AND awb_terminal_class = 'rto'
      UNION ALL
      SELECT brand_id, order_id, brain_id, brain_id_v2, 'cancellation' AS event_type,
             -amount_minor AS amount_minor, currency_code, occurred_at, occurred_at AS economic_effective_at, ingested_at
      FROM e
      WHERE cancelled_at IS NOT NULL
      UNION ALL
      SELECT brand_id, order_id, brain_id, brain_id_v2, 'refund' AS event_type,
             -amount_minor AS amount_minor, currency_code, occurred_at, occurred_at AS economic_effective_at, ingested_at
      FROM e
      WHERE coalesce(financial_status, '') = 'refunded' AND cancelled_at IS NULL
    """

    # ── silver_order_recognition final SELECT → gold_revenue_ledger projection. ──
    # ledger_event_id = sha256(concat_ws(chr(0), brand_id, order_id, event_type, <sr_dt_str>)) — byte-
    # identical to Spark's sha2(...,256). fee_minor=0, recognition_label, billing_posted_period, data_source
    # 'live', updated_at now(); dbt/gold filter: order_id NOT NULL AND occurred_at NOT NULL.
    ledger = f"""
      SELECT
        brand_id,
        sha256(concat_ws(chr(0), brand_id, order_id, event_type, {_SR_DT_STR}))    AS ledger_event_id,
        order_id,
        brain_id,
        brain_id_v2,
        event_type,
        CAST(amount_minor AS BIGINT)                                               AS amount_minor,
        currency_code,
        CAST(0 AS BIGINT)                                                          AS fee_minor,
        occurred_at,
        economic_effective_at,
        CASE WHEN event_type = 'provisional_recognition' THEN 'provisional' ELSE 'finalized' END
                                                                                   AS recognition_label,
        strftime(economic_effective_at, '%Y-%m')                                   AS billing_posted_period,
        ingested_at,
        CAST('live' AS VARCHAR)                                                     AS data_source,
        now() AT TIME ZONE 'UTC'                                                    AS updated_at
      FROM ({recognition})
      WHERE order_id IS NOT NULL
        AND occurred_at IS NOT NULL
    """

    # Idempotent MERGE on the (brand_id, ledger_event_id) PK — replay-safe restatement (the sha2 key is
    # deterministic, so a re-fold over the same gated source restates byte-identical rows). See the module
    # docstring on overwritePartitions() orphan-shedding vs MERGE (parity-equivalent for the harness).
    return merge_on_pk(con, TARGET, ledger, COLUMNS,
                       ["brand_id", "ledger_event_id"],
                       order_by_desc=["updated_at", "amount_minor"])


if __name__ == "__main__":
    run_job("gold-revenue-ledger", build, target_table="gold_revenue_ledger")
