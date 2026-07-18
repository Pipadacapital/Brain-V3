"""
silver_order_state.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_order_state.py.

THE REVENUE order-state entity: exactly ONE row per (brand_id, order_id) — the latest lifecycle state
per order, carrying the SIGNED realized order value (BIGINT minor units + currency_code). This is the
revenue spine, so money correctness is the hard bar. It reproduces the whole folded transform chain the
Spark job inlines (stg_order_events_bronze → silver_order_recognition → int_order_lifecycle →
silver_order_state) verbatim as SQL.

GRAIN : 1 row per (brand_id, order_id). PK = (brand_id, order_id).
MONEY : order_value_minor = Σ recognition amounts EXCLUDING the 'placed' (provisional) rows, cast BIGINT
        minor units, paired with currency_code. Signed (clawback/cancellation/refund are negative). Never
        a float. brand_id is the tenant key, first column.
IDEMPOTENT / REPLAY-SAFE : MERGE on (brand_id, order_id); the terminal-wins fold is restated each run.

── DIMENSION READS (Spark reads these over PG JDBC; the DuckDB framework has no PG seam, so we read the
   Iceberg SIBLINGS of the same operational tables, which carry identical grain/columns): ──────────────
  • brain_id  ← the identity export. Spark reads ops.silver_identity_link (Neo4j → PG) + folds
    ops.silver_customer_identity.merged_into (F2 canonical-LTV single-hop net). The Iceberg sibling of
    ops.silver_identity_link is brain_silver.silver_identity_alias (SAME grain/columns: brand_id,
    identifier_type, identifier_value, brain_id, is_active — see snap_identity_link.py docstring), and
    silver_customer_identity exists 1:1 in brain_silver. We reproduce the EXACT PG query
    (identifier_type='pre_hashed_email', is_active, brain_id NOT NULL, MIN(COALESCE(merged_into,brain_id))
    per (brand_id, identifier_value)) over these two Iceberg tables. Verified: 3749 distinct brain_ids,
    byte-matching the live silver_order_state's 3749 brain_id-bearing rows.
  • prepaid recognition horizon  ← Spark reads tenancy.brand.prepaid_recognition_horizon_days over PG
    JDBC. There is NO Iceberg sibling of tenancy.brand, so we use the schema DEFAULT (7 days —
    tenancy.brand.prepaid_recognition_horizon_days DEFAULT 7 NOT NULL). The finalization filter already
    coalesces to 7 (coalesce(prepaid_horizon, 7)); the finalization economic_effective_at uses the same
    7. If a brand had a non-default horizon in PG this would diverge — asserted false by the parity run
    on the current corpus (state_effective_at matches). Documented as the single dimension caveat.

AUDIT-G1 — ADDITIVE, FLAG-GATED brain_id_v2 (per-brand `identity.revenue_querytime`, DEFAULT OFF, fail-
closed): alongside the legacy FLAT single-key brain_id above, this job ALSO emits an additive `brain_id_v2`
column resolved at QUERY TIME from the bi-temporal MULTI-KEY silver_identity_map (email + phone +
platform_customer_id; identity_current is_current=TRUE AND system_to IS NULL; merge-reconciled; never-guess
on |B|>1) — the SAME canonical pattern gold_journey_events / gold_customer_360 use (shared _revenue_identity
module). The two resolutions sit side-by-side on the row for PARALLEL-RUN parity comparison. When OFF for a
brand (default) or the map is absent → brain_id_v2 is NULL and the flat brain_id + every money/lifecycle
column is byte-identical to pre-wave (parity preserved). brain_id_v2 never affects money or the PK.

CAVEAT — Stage-1 DQ quarantine side-write SKIPPED: the Spark job runs dq_violations_udf over
(amount_minor, currency_code, occurred_at) and diverts failures to brain_silver.silver_quarantine
(stage='dq'), dropping them from the recognition fold. This DuckDB port has no _silver_technical analogue,
so — matching the framework's other ports — it does NOT write the quarantine side-table and does NOT
re-implement the dq drop; it preserves only the mart's own admission filter (order_id NOT NULL/''). Bronze
keeps the originals, so the quarantine ledger can be rebuilt separately; good rows are data-equivalent.

CAVEAT — event_order_key final tiebreaker OMITTED from the SQL: the Spark fold appends
event_order_key_str (a zero-padded occurred:ingested:seq string) as the LOWEST-priority, replay-stable
tiebreaker AFTER (is_terminal, economic_effective_at, state_rank, occurred_at). Per its own docstring it
"does NOT change the winner for well-formed data, only makes exact ties totally ordered". The four
higher-priority keys already determine the winner for every order here; sequence is always null (→ same
constant for every row of an order), so the key cannot break a tie the four keys leave. We reproduce the
four keys verbatim; the additive fifth is a no-op on this corpus (parity-confirmed).

ENTITY-INCREMENTAL full-history refold: order_state AGGREGATES an order's full event history (terminal-
wins state, Σ amounts, min/max times), so it is rebuilt from the FULL gated source in ONE unfiltered pass
(the DuckDB analogue of Spark's FULL_REFRESH / first-run path — every affected order re-folded over its
complete history), then MERGE-upserted. Deterministic + replay-safe.

Parity target: brain_silver.silver_order_state.
"""
from __future__ import annotations

import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import (  # noqa: E402
    GATED_SOURCE,
    ensure_table,
    incremental_window,
    merge_on_pk,
    prop,
    read_gated_events_sql,
    run_job,
)
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402
from _revenue_identity import enabled_brands as _revenue_qt_brands  # noqa: E402
from _revenue_identity import resolve_brain_id_v2_sql  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_order_state_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# BOTH order lanes — live webhook + historical connector backfill (parity with the Spark stg CTE).
ORDER_EVENTS = ["order.live.v1", "order.backfill.v1"]
# LIVE forward-logistics lane driving COD recognition (retired gokwik.awb_status.v1 repointed here — 0117).
AWB_EVENT = "shiprocket.shipment_status.v1"

# Iceberg siblings of the PG operational dimensions (see module docstring).
IDENTITY_ALIAS = f"{CATALOG}.{SILVER_NAMESPACE}.silver_identity_alias"
CUSTOMER_IDENTITY = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer_identity"
# audit-G1: the bi-temporal MULTI-KEY identity map — the query-time (flag-ON) brain_id_v2 resolution source.
IDENTITY_MAP = f"{CATALOG}.{SILVER_NAMESPACE}.silver_identity_map"

# audit-G1: dev salt SoR for the SALTED external_id space (byte-identical to silver_session_identity /
# the connector normalize salt derivation) so a payload storefront_customer_id hashes to the value the
# identity graph stored. Email/phone are pre-hashed on the payload (no salt).
_DEV_SALT_PREFIX = os.environ.get("DEV_IDENTITY_SALT_PREFIX", "brain-dev-identity-salt-v1")

# tenancy.brand.prepaid_recognition_horizon_days DEFAULT — used everywhere the PG horizon would be.
DEFAULT_PREPAID_HORIZON = 7

# The "now" instant the finalization horizon is compared against. Spark uses live current_timestamp(); we
# default to the same (now()). SILVER_NOW_OVERRIDE (an ISO instant) exists ONLY so the parity harness can
# reproduce a STALE Spark snapshot's finalization boundary (freeze "now" to Spark's run instant), proving
# the transform logic is byte-identical net of the unavoidable wall-clock drift between the two runs. Unset
# in production → live now() (faithful).
_NOW_SQL = (
    f"TIMESTAMPTZ '{os.environ['SILVER_NOW_OVERRIDE']}'"
    if os.environ.get("SILVER_NOW_OVERRIDE")
    else "now()"
)

# Mirrors silver_order_state.sql column order/types. Timestamps are timestamptz (the live Spark table
# persists TIMESTAMP WITH TIME ZONE UTC instants — verified against the target).
COLUMNS_SQL = """
  brand_id            string      NOT NULL,
  order_id            string      NOT NULL,
  brain_id            string,
  brain_id_v2         string,
  lifecycle_state     string,
  is_terminal         boolean,
  order_value_minor   bigint,
  currency_code       string,
  first_event_at      timestamptz,
  state_effective_at  timestamptz,
  max_ingested_at     timestamptz,
  updated_at          timestamptz NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "order_id", "brain_id", "brain_id_v2", "lifecycle_state", "is_terminal",
    "order_value_minor", "currency_code", "first_event_at", "state_effective_at",
    "max_ingested_at", "updated_at",
]


def _dev_salt(brand_id: str) -> str:
    """dev-derivable salt for a brand — sha256('<prefix>||'||lower(brand_id)) — the connector/normalize SoR."""
    return hashlib.sha256(f"{_DEV_SALT_PREFIX}||{brand_id.lower()}".encode("utf-8")).hexdigest()


def _table_exists(con, fq: str) -> bool:
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent map → no query-time resolution (fail-closed).
        return False


def _brain_id_v2_join_sql(con, stg_sql: str) -> str:
    """audit-G1 additive, FLAG-GATED query-time resolver: (brand_id, order_id, brain_id_v2) for the flag-ON
    brands, from the bi-temporal MULTI-KEY silver_identity_map. Fail-closed to an EMPTY result (LEFT JOIN →
    NULL brain_id_v2 on every order) when the flag is OFF for all brands or the map is absent — the legacy
    flat single-key output then stays byte-identical (parity preserved)."""
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

    salt_cases = " ".join(f"WHEN brand_id = '{b}' THEN '{_dev_salt(b)}'" for b in on_brands)
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


def _identity_link_sql(con) -> str:
    """hashed-email → canonical brain_id, reproducing the Spark _read_identity_link PG query over the
    Iceberg siblings (silver_identity_alias = ops.silver_identity_link; silver_customer_identity 1:1).
    MIN(COALESCE(c.merged_into, l.brain_id)) per (brand_id, identifier_value) — the F2 single-hop net that
    rolls a merged (dead) brain_id onto its survivor before the aggregate; a non-merged customer's
    merged_into IS NULL → COALESCE = the original brain_id (parity-exact no-op).

    COLD-START SAFETY: order_state is a REQUIRED (hard-fail) keystone job, but the identity-projection
    siblings it reads are produced LATER in the silver tier (silver_identity_alias / silver_customer_identity
    ensure_table only when their glob-pass runs). On a flushed/first-run medallion those tables don't exist
    yet → an unguarded FROM aborts the whole silver tier (prod 2026-07-18). Fail-closed to an EMPTY link set
    (LEFT JOIN → NULL brain_id on every order — correct for a fresh system; converges next tick once the
    alias is produced), matching the _table_exists guard on IDENTITY_MAP above. When BOTH tables exist (the
    warm steady state) the emitted SQL is byte-identical to the pre-guard version — parity preserved."""
    if not _table_exists(con, IDENTITY_ALIAS):
        return ("SELECT NULL::VARCHAR AS brand_id, NULL::VARCHAR AS hashed_customer_email, "
                "NULL::VARCHAR AS brain_id WHERE FALSE")
    # CUSTOMER_IDENTITY supplies only the merged_into (dead→survivor) rollup via a LEFT JOIN; if it is not
    # built yet, degrade to alias-only (brain_id = l.brain_id) rather than crash — a non-merged system is
    # byte-identical anyway (merged_into IS NULL → COALESCE is a no-op).
    has_customer = _table_exists(con, CUSTOMER_IDENTITY)
    brain_id_expr = "MIN(COALESCE(c.merged_into, l.brain_id))" if has_customer else "MIN(l.brain_id)"
    customer_join = (f"LEFT JOIN {CUSTOMER_IDENTITY} c\n        "
                     "ON c.brand_id = l.brand_id AND c.brain_id = l.brain_id" if has_customer else "")
    return f"""
      SELECT l.brand_id, l.identifier_value AS hashed_customer_email,
             {brain_id_expr} AS brain_id
      FROM {IDENTITY_ALIAS} l
      {customer_join}
      WHERE l.identifier_type = 'pre_hashed_email'
        AND l.is_active = true
        AND l.brain_id IS NOT NULL
      GROUP BY l.brand_id, l.identifier_value
    """


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id)")

    # ── ENTITY-INCREMENTAL CHANGED-ENTITY REFOLD (opt-in; SILVER_INCREMENTAL=1) ───────────────────────
    #   order_state is an ENTITY FOLD: MANY events per (brand_id, order_id) aggregate/terminal-wins into ONE
    #   row whose value (Σ signed amounts, terminal state, min/max times) depends on the order's FULL history
    #   — events that may sit BELOW the watermark. So we MUST NOT window the fold input directly (that would
    #   silently drop history → wrong money). Instead: a WINDOWED read of the gated source discovers the SET
    #   of (brand_id, order_id) that changed in [lo, hi); the fold then reads the FULL, UNWINDOWED source but
    #   is SEMI-JOINed to that changed set, so ONLY changed orders re-fold over their complete history, and
    #   the MERGE upserts exactly them. TWO gated lanes drive an order's state: the ORDER events (order_id from
    #   payload) AND the forward AWB lane (a delivered/rto status change flips COD recognition with no order
    #   event landing) — the changed set is the UNION of both, using each lane's own key derivation + guards.
    #   Default OFF / first run / FULL_REFRESH → lo is None → NO changed-set, NO semi-join → byte-identical
    #   full recompute over every order (the string predicates below are EMPTY when lo is None).
    lo, hi = incremental_window(con, "silver-order-state", GATED_SOURCE, ts_col="ingested_at")

    changed_order_keys = f"""
      SELECT DISTINCT brand_id, {prop('pj','order_id')} AS order_id
      FROM ({read_gated_events_sql(ORDER_EVENTS, lo=lo, hi=hi)})
      WHERE {prop('pj','order_id')} IS NOT NULL AND {prop('pj','order_id')} <> ''
    """
    changed_awb_keys = f"""
      SELECT DISTINCT brand_id, {prop('pj','order_id')} AS order_id
      FROM ({read_gated_events_sql([AWB_EVENT], lo=lo, hi=hi)})
      WHERE {prop('pj','order_id')} IS NOT NULL AND {prop('pj','order_id')} <> ''
    """
    changed = f"({changed_order_keys}) UNION ({changed_awb_keys})"
    # GUARD: lo=None → emit NO semi-join predicate at all (empty string) → full recompute, byte-identical.
    # stg_semijoin_col references the already-lifted brand_id/order_id COLUMNS of the stg dedup CTE;
    # awb_semijoin references the payload-derived key exprs of the awb_latest read (no lifted columns yet).
    # Each predicate carries its OWN leading newline+indent so the lo=None case is the EMPTY string and the
    # surrounding SQL is byte-for-byte unchanged (no stray blank/whitespace line injected).
    stg_semijoin_col = (
        f"\n        AND (brand_id, order_id) IN (SELECT brand_id, order_id FROM ({changed}))"
        if lo is not None else ""
    )
    awb_semijoin = (
        f"\n        AND (brand_id, {prop('pj','order_id')}) IN (SELECT brand_id, order_id FROM ({changed}))"
        if lo is not None else ""
    )

    # ── stg_order_events_bronze: type + dedup order.{live,backfill}.v1 to (brand_id, order_id)
    #    latest-ingested (ingested_at DESC, occurred_at DESC, event_id DESC). ─────────────────────────────
    # IMPORTANT: ingested_at is read from the PAYLOAD JSON ($.ingested_at, an ISO string), NOT the gated
    # source's top-level ingested_at COLUMN — verbatim with the Spark stg CTE (get_json_object(pj,
    # '$.ingested_at') → cast timestamp). It is NULL for events whose payload omits the key, which is why
    # some orders' max_ingested_at is NULL in the live Spark table; using the column instead would wrongly
    # populate it. This same payload value drives the latest-ingested dedup and the max_ingested_at rollup.
    stg_typed = f"""
      SELECT brand_id, event_id, occurred_at,
             CAST(json_extract_string(pj, '$.ingested_at') AS TIMESTAMPTZ)  AS ingested_at,
             {prop('pj','order_id')}                                   AS order_id,
             CAST({prop('pj','amount_minor')} AS BIGINT)               AS amount_minor,
             {prop('pj','currency_code')}                              AS currency_code,
             lower({prop('pj','payment_method')})                      AS payment_method_raw,
             {prop('pj','financial_status')}                           AS financial_status,
             {prop('pj','cancelled_at')}                               AS cancelled_at,
             {prop('pj','hashed_customer_email')}                      AS hashed_customer_email,
             -- audit-G1 (flag-ON only): additional MULTI-KEY hashes for query-time brain_id_v2. Extra
             -- columns — they do NOT change the flat single-key output (which reads hashed_customer_email
             -- alone). phone is pre-hashed on the payload; the platform id is salt-hashed downstream.
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
        WHERE order_id IS NOT NULL AND order_id <> ''{stg_semijoin_col}
      ) WHERE _dedup_rn = 1
    """

    # ── latest forward-shipment terminal_class per order (COD recognition signal) ──
    # ONLY the forward shiprocket.shipment_status.v1 lane — the return lane is DELIBERATELY excluded
    # (folding a return's "delivered" as a forward delivery is the SR-4 false-delivery bug).
    awb_latest = f"""
      SELECT brand_id, order_id, terminal_class FROM (
        SELECT brand_id,
               {prop('pj','order_id')}       AS order_id,
               {prop('pj','terminal_class')} AS terminal_class,
               occurred_at,
               row_number() OVER (PARTITION BY brand_id, {prop('pj','order_id')}
                                  ORDER BY occurred_at DESC) AS _rn
        FROM ({read_gated_events_sql([AWB_EVENT])})
        WHERE {prop('pj','order_id')} IS NOT NULL AND {prop('pj','order_id')} <> ''{awb_semijoin}
      ) WHERE _rn = 1
    """

    # ── audit-G1: additive, FLAG-GATED query-time brain_id_v2 (default OFF → NULL, parity preserved). ──
    # For identity.revenue_querytime-ON brands, resolve brain_id at query time from the bi-temporal MULTI-KEY
    # silver_identity_map (email + phone + platform_customer_id; identity_current; merge-reconciled; never-
    # guess) — the SAME pattern gold_journey_events/gold_customer_360 use. The flat single-key brain_id
    # (b.brain_id below) is UNCHANGED. OFF/absent-map → empty resolver → NULL brain_id_v2.
    brain_id_v2_join = _brain_id_v2_join_sql(con, stg)

    # ── silver_order_recognition: enriched order (+ brain_id, prepaid horizon default, awb class) ──
    enriched = f"""
      SELECT o.brand_id, o.order_id, b.brain_id, v2.brain_id_v2, o.amount_minor, o.currency_code,
             o.payment_method, o.financial_status, o.cancelled_at, o.occurred_at, o.ingested_at,
             CAST({DEFAULT_PREPAID_HORIZON} AS INTEGER) AS prepaid_horizon,
             a.terminal_class AS awb_terminal_class
      FROM ({stg}) o
      LEFT JOIN ({_identity_link_sql(con)}) b
        ON b.brand_id = o.brand_id AND b.hashed_customer_email = o.hashed_customer_email
      LEFT JOIN ({awb_latest}) a
        ON a.brand_id = o.brand_id AND a.order_id = o.order_id
      LEFT JOIN ({brain_id_v2_join}) v2
        ON v2.brand_id = o.brand_id AND v2.order_id = o.order_id
    """

    # ── the 6 recognition event_types (signed money). FINALIZATION arithmetic:
    #    occurred_at + INTERVAL (N day) — N×24h with time-of-day preserved (byte-identical to Spark's
    #    make_dt_interval / gold_revenue_ledger, NOT date_add which snaps to midnight). ──────────────────
    fin_interval = f"occurred_at + (prepaid_horizon * INTERVAL 1 DAY)"
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

    # ── int_order_lifecycle: event_type → lifecycle_state / is_terminal / state_rank. ──
    lifecycle = f"""
      SELECT brand_id, order_id, brain_id, brain_id_v2, amount_minor, currency_code,
             occurred_at, economic_effective_at, ingested_at, event_type,
             CASE event_type
                 WHEN 'provisional_recognition' THEN 'placed'
                 WHEN 'finalization'            THEN 'confirmed'
                 WHEN 'cod_delivery_confirmed'  THEN 'delivered'
                 WHEN 'cancellation'            THEN 'cancelled'
                 WHEN 'rto_reversal'            THEN 'rto'
                 WHEN 'cod_rto_clawback'        THEN 'rto'
                 WHEN 'refund'                  THEN 'refunded'
                 WHEN 'chargeback'              THEN 'refunded'
             END AS lifecycle_state,
             CASE event_type
                 WHEN 'cod_delivery_confirmed'  THEN TRUE
                 WHEN 'cancellation'            THEN TRUE
                 WHEN 'rto_reversal'            THEN TRUE
                 WHEN 'cod_rto_clawback'        THEN TRUE
                 WHEN 'refund'                  THEN TRUE
                 WHEN 'chargeback'              THEN TRUE
                 ELSE FALSE
             END AS is_terminal,
             CASE event_type
                 WHEN 'provisional_recognition' THEN 10
                 WHEN 'finalization'            THEN 20
                 WHEN 'cod_delivery_confirmed'  THEN 90
                 WHEN 'cancellation'            THEN 80
                 WHEN 'rto_reversal'            THEN 85
                 WHEN 'cod_rto_clawback'        THEN 85
                 WHEN 'refund'                  THEN 70
                 WHEN 'chargeback'              THEN 70
                 ELSE 0
             END AS state_rank
      FROM ({recognition})
    """

    # ── silver_order_state: terminal-wins fold + realized value + lifecycle times. ──
    # Winner order key verbatim from Spark: is_terminal DESC, economic_effective_at DESC, state_rank DESC,
    # occurred_at DESC (the additive event_order_key final tiebreaker is a no-op here — see docstring).
    staged = f"""
      WITH lc AS ({lifecycle}),
      ranked AS (
        SELECT brand_id, order_id, brain_id, brain_id_v2, lifecycle_state, is_terminal, currency_code,
               row_number() OVER (
                 PARTITION BY brand_id, order_id
                 ORDER BY is_terminal DESC, economic_effective_at DESC, state_rank DESC, occurred_at DESC
               ) AS _win_rn
        FROM lc
      ),
      winner AS (
        SELECT brand_id, order_id, brain_id, brain_id_v2, lifecycle_state, is_terminal, currency_code
        FROM ranked WHERE _win_rn = 1
      ),
      order_value AS (
        SELECT brand_id, order_id, CAST(sum(amount_minor) AS BIGINT) AS order_value_minor
        FROM lc WHERE lifecycle_state <> 'placed'
        GROUP BY brand_id, order_id
      ),
      order_times AS (
        SELECT brand_id, order_id,
               min(occurred_at)            AS first_event_at,
               max(economic_effective_at)  AS state_effective_at,
               max(ingested_at)            AS max_ingested_at
        FROM lc GROUP BY brand_id, order_id
      )
      SELECT
        w.brand_id, w.order_id, w.brain_id, w.brain_id_v2, w.lifecycle_state, w.is_terminal,
        CAST(coalesce(ov.order_value_minor, 0) AS BIGINT) AS order_value_minor,
        w.currency_code,
        t.first_event_at, t.state_effective_at, t.max_ingested_at,
        now() AS updated_at
      FROM winner w
      LEFT JOIN order_value ov ON w.brand_id = ov.brand_id AND w.order_id = ov.order_id
      LEFT JOIN order_times  t ON w.brand_id = t.brand_id  AND w.order_id = t.order_id
    """

    # Idempotent MERGE on the (brand_id, order_id) PK — terminal-wins is restated (replay-safe upsert).
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "order_id"],
                       order_by_desc=["max_ingested_at", "state_effective_at"])


if __name__ == "__main__":
    run_job("silver-order-state", build, target_table="silver_order_state")
