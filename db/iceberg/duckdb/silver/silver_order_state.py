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

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

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
    "brand_id", "order_id", "brain_id", "lifecycle_state", "is_terminal",
    "order_value_minor", "currency_code", "first_event_at", "state_effective_at",
    "max_ingested_at", "updated_at",
]


def _identity_link_sql() -> str:
    """hashed-email → canonical brain_id, reproducing the Spark _read_identity_link PG query over the
    Iceberg siblings (silver_identity_alias = ops.silver_identity_link; silver_customer_identity 1:1).
    MIN(COALESCE(c.merged_into, l.brain_id)) per (brand_id, identifier_value) — the F2 single-hop net that
    rolls a merged (dead) brain_id onto its survivor before the aggregate; a non-merged customer's
    merged_into IS NULL → COALESCE = the original brain_id (parity-exact no-op)."""
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


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id)")

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
             {prop('pj','hashed_customer_email')}                      AS hashed_customer_email
      FROM ({read_gated_events_sql(ORDER_EVENTS)})
    """
    stg = f"""
      SELECT brand_id, event_id, order_id, amount_minor, currency_code,
             CASE WHEN payment_method_raw = 'cod' THEN 'cod' ELSE 'prepaid' END AS payment_method,
             financial_status, cancelled_at, hashed_customer_email,
             occurred_at, ingested_at
      FROM (
        SELECT *, row_number() OVER (
                 PARTITION BY brand_id, order_id
                 ORDER BY ingested_at DESC, occurred_at DESC, event_id DESC) AS _dedup_rn
        FROM ({stg_typed})
        WHERE order_id IS NOT NULL AND order_id <> ''
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
        WHERE {prop('pj','order_id')} IS NOT NULL AND {prop('pj','order_id')} <> ''
      ) WHERE _rn = 1
    """

    # ── silver_order_recognition: enriched order (+ brain_id, prepaid horizon default, awb class) ──
    enriched = f"""
      SELECT o.brand_id, o.order_id, b.brain_id, o.amount_minor, o.currency_code,
             o.payment_method, o.financial_status, o.cancelled_at, o.occurred_at, o.ingested_at,
             CAST({DEFAULT_PREPAID_HORIZON} AS INTEGER) AS prepaid_horizon,
             a.terminal_class AS awb_terminal_class
      FROM ({stg}) o
      LEFT JOIN ({_identity_link_sql()}) b
        ON b.brand_id = o.brand_id AND b.hashed_customer_email = o.hashed_customer_email
      LEFT JOIN ({awb_latest}) a
        ON a.brand_id = o.brand_id AND a.order_id = o.order_id
    """

    # ── the 6 recognition event_types (signed money). FINALIZATION arithmetic:
    #    occurred_at + INTERVAL (N day) — N×24h with time-of-day preserved (byte-identical to Spark's
    #    make_dt_interval / gold_revenue_ledger, NOT date_add which snaps to midnight). ──────────────────
    fin_interval = f"occurred_at + (prepaid_horizon * INTERVAL 1 DAY)"
    fin_threshold = f"occurred_at + (coalesce(prepaid_horizon, {DEFAULT_PREPAID_HORIZON}) * INTERVAL 1 DAY)"
    recognition = f"""
      WITH e AS ({enriched})
      SELECT brand_id, order_id, brain_id, 'provisional_recognition' AS event_type,
             amount_minor, currency_code, occurred_at, occurred_at AS economic_effective_at, ingested_at
      FROM e
      UNION ALL
      SELECT brand_id, order_id, brain_id, 'finalization' AS event_type,
             amount_minor, currency_code, occurred_at,
             {fin_interval} AS economic_effective_at, ingested_at
      FROM e
      WHERE payment_method = 'prepaid'
        AND {fin_threshold} < {_NOW_SQL}
        AND cancelled_at IS NULL
        AND coalesce(financial_status, '') NOT IN ('refunded', 'voided', 'cancelled')
      UNION ALL
      SELECT brand_id, order_id, brain_id, 'cod_delivery_confirmed' AS event_type,
             amount_minor, currency_code, occurred_at, occurred_at AS economic_effective_at, ingested_at
      FROM e
      WHERE payment_method = 'cod' AND awb_terminal_class = 'delivered'
      UNION ALL
      SELECT brand_id, order_id, brain_id, 'cod_rto_clawback' AS event_type,
             -amount_minor AS amount_minor, currency_code, occurred_at, occurred_at AS economic_effective_at, ingested_at
      FROM e
      WHERE payment_method = 'cod' AND awb_terminal_class = 'rto'
      UNION ALL
      SELECT brand_id, order_id, brain_id, 'cancellation' AS event_type,
             -amount_minor AS amount_minor, currency_code, occurred_at, occurred_at AS economic_effective_at, ingested_at
      FROM e
      WHERE cancelled_at IS NOT NULL
      UNION ALL
      SELECT brand_id, order_id, brain_id, 'refund' AS event_type,
             -amount_minor AS amount_minor, currency_code, occurred_at, occurred_at AS economic_effective_at, ingested_at
      FROM e
      WHERE coalesce(financial_status, '') = 'refunded' AND cancelled_at IS NULL
    """

    # ── int_order_lifecycle: event_type → lifecycle_state / is_terminal / state_rank. ──
    lifecycle = f"""
      SELECT brand_id, order_id, brain_id, amount_minor, currency_code,
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
        SELECT brand_id, order_id, brain_id, lifecycle_state, is_terminal, currency_code,
               row_number() OVER (
                 PARTITION BY brand_id, order_id
                 ORDER BY is_terminal DESC, economic_effective_at DESC, state_rank DESC, occurred_at DESC
               ) AS _win_rn
        FROM lc
      ),
      winner AS (
        SELECT brand_id, order_id, brain_id, lifecycle_state, is_terminal, currency_code
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
        w.brand_id, w.order_id, w.brain_id, w.lifecycle_state, w.is_terminal,
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
