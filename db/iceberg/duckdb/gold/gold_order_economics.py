# SPEC: C.3
"""
gold_order_economics.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_order_economics.py.

Wave-C per-order contribution-margin mart (AMD-17). One row per (brand_id, order_id), recomputed
IDEMPOTENTLY as facts arrive (MERGE on the PK). Fact-based CM1/CM2/CM3 from MEASURED facts, spec
numbering — the live gold_contribution_margin is left UNTOUCHED (AMD-17).

  CM1 = net_revenue − COGS
  CM2 = CM1 − shipping(forward + reverse) − packaging − payment/platform fees
  CM3 = CM2 − allocated marketing spend   (cm3_allocation_basis recorded per row)

MONEY (§1.2): every column is signed BIGINT minor units + the sibling currency_code — per-currency,
NEVER blended, NEVER a float (all math is bigint add/sub/floor-div, so GCC 3-decimal fils reconcile
with ZERO rounding loss). brand_id is the tenant key, FIRST column + partition anchor.

READS (recognized/reversal basis + WC-C2 facts, degrading gracefully where a fact is not yet built):
  - gold_revenue_ledger        — the recognition ledger (money SoR). net_revenue = Σ amount_minor over
                                 an order's NON-provisional events; event_types set → economics_state
                                 (AMD-15: provisional | settled | reversed).
  - silver_order_state         — is_new_customer window (C.5.5), over first_event_at per brain_id.
  - silver_order_line          — order-line quantities for COGS (× gold_product_costs).
  - silver_marketing_spend     — day×(brand,currency) spend, day-pro-rata allocated to CM3 (exact-sum
                                 largest-remainder; cm3_allocation_basis='day_channel_prorata').
  - gold_product_costs         — COGS per sku (WC-C2 C.2.4). ABSENT today → cogs degraded to 0.
  - gold_measurement_costs     — shipping (fwd+reverse) + packaging (WC-C2 C.2.4). ABSENT → 0.
  - gold_measurement_fees      — per-order payment/platform fees (WC-C2 C.2.3). ABSENT → 0.
Each degraded component is recorded (components_source) so a null is never mistaken for a measured 0.

── EXISTENCE-not-emptiness probe (parity-critical) ─────────────────────────────────────────────────
The Spark _gold_exists probes the table's .schema — TRUE for a table that EXISTS but is EMPTY. So when
gold_product_costs / gold_measurement_costs / gold_measurement_fees exist with 0 rows (the current live
state), the component reads run (LEFT JOIN misses → 0) and components_source records 'measured', NOT
'degraded0'. This DuckDB port mirrors that byte-for-byte: _gold_exists here probes with `LIMIT 0` (a
schema probe), so an existing-but-empty fact table is `measured`, an ABSENT one is `degraded0`.

── PG portability ──────────────────────────────────────────────────────────────────────────────────
This mart reads ONLY Iceberg tables (ledger + Silver + optional Gold facts) — there is NO Postgres/JDBC
read in the Spark job, so no DuckDB `postgres` ATTACH is needed (unlike gold_contribution_margin).

── PORT NOTES (integer minor units) ────────────────────────────────────────────────────────────────
  - Spark `div` (integer division, truncating toward zero) → DuckDB `//` (integer division). For the
    non-negative day_spend/order-count here `//` == floor == trunc == Spark `div` — largest-remainder
    apportionment sums EXACTLY to the day's spend (first `remainder` orders, order_id asc, get +1 minor).
  - Spark bigint +/− stays bigint; the CM waterfall is pure integer add/sub. No float touches money.
  - `current_timestamp()` → `now() AT TIME ZONE 'UTC'` (UTC session set in _catalog.connect).
  - `cast(x as date)` (spend_date bucketing) → DuckDB `CAST(x AS DATE)`.

GRAIN / PK: exactly 1 row per (brand_id, order_id) — the mart PK (EXACT match to the Spark merge_on_pk
  ["brand_id","order_id"]).
QUARANTINE: none — this Gold mart reads already-gated Silver + the Gold ledger; no Stage-1/quarantine
  side-write to skip (there is none in the Spark job either).
REPLAY-SAFE: full recompute from the ledger + facts, MERGE-UPDATE'd on (brand_id, order_id). The Spark
  job is FULL recompute every run (NOT entity-incremental) — this port matches that exactly.

ORPHAN-SHEDDING (2026-07-17): on a FULL recompute (incremental window off / first run / FULL_REFRESH)
  this job now passes delete_orphans=True — a (brand_id, order_id) row whose order vanished from the
  ledger (brand wiped from source, seed residue) is shed after the MERGE, so the mart converges to the
  current ledger truth. (The retired Spark job was UPDATE/INSERT-only here and retained phantoms; live
  validation found 5 phantom brands Σ27.5M minor retained that way.) Under an incremental window the
  staged batch is a changed-order SUBSET, so shedding is disabled for that run.

Honors MIGRATION_TABLE_SUFFIX (→ gold_order_economics_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_order_economics (12830 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TABLE = "gold_order_economics"

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_order_economics_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

LEDGER = f"{CATALOG}.{GOLD_NAMESPACE}.gold_revenue_ledger"
SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
SILVER_ORDER_LINE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_line"
SILVER_MARKETING = f"{CATALOG}.{SILVER_NAMESPACE}.silver_marketing_spend"

# WC-C2 fact tables this mart reads WHEN BUILT (AMD-16 measurement namespace). Absent → degrade to 0.
_PRODUCT_COSTS = f"{CATALOG}.{GOLD_NAMESPACE}.gold_product_costs"   # COGS per sku (× order lines)
_COSTS_FACT = f"{CATALOG}.{GOLD_NAMESPACE}.gold_measurement_costs"  # shipping (fwd+reverse) + packaging
_FEES_FACT = f"{CATALOG}.{GOLD_NAMESPACE}.gold_measurement_fees"    # payment/platform fees per order

# job_version bumps when the economics math changes (lineage endpoint C.5.1 surfaces it).
JOB_VERSION = "c3.economics.v1"

COLUMNS_SQL = """
  brand_id                   string    NOT NULL,
  order_id                   string    NOT NULL,
  brain_id                   string,
  currency_code              string    NOT NULL,
  economics_state            string    NOT NULL,
  is_new_customer            boolean,
  net_revenue_minor          bigint    NOT NULL,
  cogs_minor                 bigint    NOT NULL,
  shipping_fwd_minor         bigint    NOT NULL,
  shipping_rev_minor         bigint    NOT NULL,
  packaging_minor            bigint    NOT NULL,
  fees_minor                 bigint    NOT NULL,
  cm1_minor                  bigint    NOT NULL,
  cm2_minor                  bigint    NOT NULL,
  marketing_minor            bigint    NOT NULL,
  cm3_minor                  bigint    NOT NULL,
  cm3_allocation_basis       string    NOT NULL,
  components_source          string    NOT NULL,
  order_recognized_at        timestamp,
  source_system              string    NOT NULL,
  source_event_id            string,
  job_version                string    NOT NULL,
  updated_at                 timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "order_id", "brain_id", "currency_code", "economics_state", "is_new_customer",
    "net_revenue_minor", "cogs_minor", "shipping_fwd_minor", "shipping_rev_minor", "packaging_minor",
    "fees_minor", "cm1_minor", "cm2_minor", "marketing_minor", "cm3_minor", "cm3_allocation_basis",
    "components_source", "order_recognized_at", "source_system", "source_event_id", "job_version",
    "updated_at",
]

PK = ["brand_id", "order_id"]


def _gold_exists(con, fqtn: str) -> bool:
    """True iff a sibling Gold fact table EXISTS (WC-C2 output). Absent → the component degrades to 0.

    Mirrors the Spark _gold_exists (probes .schema): a table that EXISTS but is EMPTY returns True — so an
    existing-but-empty fact table reads as 'measured' (LEFT JOIN misses → 0), NOT 'degraded0'. Only a truly
    ABSENT table is 'degraded0'. Probes with `LIMIT 0` (a schema-only touch, no scan)."""
    try:
        con.execute(f"SELECT 1 FROM {fqtn} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent WC-C2 fact → graceful degradation
        return False


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY REFOLD ────────────────────────
    #   GRAIN = entity_fold: MANY gold_revenue_ledger recognition-event rows aggregate into ONE
    #   (brand_id, order_id) economics row whose net_revenue/CM waterfall depend on the order's FULL set of
    #   ledger events — including rows BELOW the watermark. Windowing the fold input directly would silently
    #   drop recognition events → wrong money. So we window ONLY to DISCOVER which orders changed (a new
    #   recognition event landed since the last run), then re-fold each changed order over its FULL,
    #   UNWINDOWED ledger history. The MERGE on the PK (brand_id, order_id) upserts exactly those restated
    #   rows. The fold-driving source is the revenue ledger (ts_col=ingested_at — the order-event arrival
    #   clock carried onto each ledger row; a newly-landed order event produces ledger rows with a fresh
    #   ingested_at, which is exactly "which orders had new recognition activity"). The GOLD_INCREMENTAL
    #   gate flips Gold INDEPENDENTLY of the already-ON Silver tier.
    #   Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the ledger fold
    #   below is byte-identical to the pre-incremental full recompute. Only _econ_ledger (the fold-driving
    #   source) is narrowed; is_new_customer / COGS / costs / fees / marketing are ALL still computed over
    #   their full inputs and LEFT-JOINed, so a changed order's every component re-derives from full history.
    lo, hi = incremental_window(con, "gold-order-economics", LEDGER, ts_col="ingested_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over
    # the ledger's arrival clock otherwise. Same entity-key guard as the fold (order_id NOT NULL).
    win = []
    if lo is not None:
        win.append(f"ingested_at >= '{lo}'")
    if hi is not None:
        win.append(f"ingested_at <= '{hi}'")
    ledger_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: orders whose ledger changed within [lo, hi], using the SAME (brand_id, order_id) key +
    # order_id-NOT-NULL guard the _econ_ledger fold uses. Built ONLY when incremental (lo not None).
    changed = f"""
      SELECT DISTINCT brand_id, order_id
      FROM {LEDGER}
      WHERE order_id IS NOT NULL{ledger_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history ledger fold to only the changed orders so
    # each re-folds over its ENTIRE recognition history. EMPTY when lo is None → unwindowed full recompute.
    refold_filter = (
        f"        AND (brand_id, order_id) IN (SELECT brand_id, order_id FROM ({changed}))\n"
        if lo is not None else ""
    )

    # ── Money SoR: the recognition ledger. net revenue = Σ non-provisional; event_types → state ──
    # brain_id + currency + occurred basis carried from the ledger. One group per (brand, order).
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW _econ_ledger AS
        SELECT
            brand_id,
            order_id,
            max(brain_id)        AS brain_id,
            max(currency_code)   AS currency_code,
            -- provisional booking EXCLUDED (== silver_order_state.order_value_minor semantics).
            CAST(sum(CASE WHEN event_type <> 'provisional_recognition'
                          THEN amount_minor ELSE 0 END) AS BIGINT) AS net_revenue_minor,
            -- economics_state (AMD-15): reversed > settled > provisional.
            CASE
              WHEN max(CASE WHEN event_type IN
                    ('cod_rto_clawback','cancellation','refund','chargeback','rto_reversal')
                    THEN 1 ELSE 0 END) = 1 THEN 'reversed'
              WHEN max(CASE WHEN event_type IN ('finalization','cod_delivery_confirmed')
                    THEN 1 ELSE 0 END) = 1 THEN 'settled'
              ELSE 'provisional'
            END AS economics_state,
            min(economic_effective_at) AS order_recognized_at,
            -- lineage: the earliest recognition event that seeded this order's economics.
            min(ledger_event_id)       AS source_event_id
        FROM {LEDGER}
        WHERE order_id IS NOT NULL
{refold_filter}        GROUP BY brand_id, order_id
    """)

    # ── is_new_customer (C.5.5): first recognized order per brain_id (window over order_state) ──
    # NULL brain_id → NULL is_new_customer (honest unknown). Ordered by first_event_at; ties broken by
    # order_id for determinism.
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW _econ_newcust AS
        WITH ranked AS (
            SELECT brand_id, order_id, brain_id, first_event_at,
                   CASE WHEN brain_id IS NULL THEN NULL ELSE
                     row_number() OVER (
                       PARTITION BY brand_id, brain_id
                       ORDER BY first_event_at ASC, order_id ASC
                     ) END AS _rank
            FROM {SILVER_ORDER_STATE}
            WHERE brand_id IS NOT NULL
        )
        SELECT brand_id, order_id,
               CASE WHEN _rank IS NULL THEN NULL WHEN _rank = 1 THEN true ELSE false END AS is_new_customer
        FROM ranked
    """)

    # ── COGS (WC-C2 C.2.4): gold_product_costs × silver_order_line quantities. Degrade → 0. ──
    have_cogs = _gold_exists(con, _PRODUCT_COSTS)
    if have_cogs:
        con.execute(f"""
            CREATE OR REPLACE TEMP VIEW _econ_cogs AS
            SELECT ol.brand_id, ol.order_id,
                   CAST(coalesce(sum(coalesce(pc.cost_minor, 0) * coalesce(ol.quantity, 0)), 0) AS BIGINT)
                     AS cogs_minor
            FROM {SILVER_ORDER_LINE} ol
            LEFT JOIN {_PRODUCT_COSTS} pc
              ON pc.brand_id = ol.brand_id AND pc.sku = ol.sku AND pc.currency_code = ol.currency_code
            GROUP BY ol.brand_id, ol.order_id
        """)
    else:
        con.execute(
            "CREATE OR REPLACE TEMP VIEW _econ_cogs AS "
            "SELECT '' AS brand_id, '' AS order_id, CAST(0 AS BIGINT) AS cogs_minor WHERE 1=0"
        )

    # ── shipping (fwd+reverse) + packaging (WC-C2 C.2.4). Degrade → 0. ──
    have_costs = _gold_exists(con, _COSTS_FACT)
    if have_costs:
        con.execute(f"""
            CREATE OR REPLACE TEMP VIEW _econ_costs AS
            SELECT brand_id, order_id,
                   CAST(coalesce(sum(CASE WHEN cost_type = 'shipping_forward' THEN amount_minor ELSE 0 END), 0) AS BIGINT) AS shipping_fwd_minor,
                   CAST(coalesce(sum(CASE WHEN cost_type = 'shipping_reverse' THEN amount_minor ELSE 0 END), 0) AS BIGINT) AS shipping_rev_minor,
                   CAST(coalesce(sum(CASE WHEN cost_type = 'packaging'        THEN amount_minor ELSE 0 END), 0) AS BIGINT) AS packaging_minor
            FROM {_COSTS_FACT}
            GROUP BY brand_id, order_id
        """)
    else:
        con.execute(
            "CREATE OR REPLACE TEMP VIEW _econ_costs AS "
            "SELECT '' AS brand_id, '' AS order_id, CAST(0 AS BIGINT) AS shipping_fwd_minor, "
            "CAST(0 AS BIGINT) AS shipping_rev_minor, CAST(0 AS BIGINT) AS packaging_minor WHERE 1=0"
        )

    # ── per-order payment/platform fees (WC-C2 C.2.3). Degrade → 0. ──
    have_fees = _gold_exists(con, _FEES_FACT)
    if have_fees:
        con.execute(f"""
            CREATE OR REPLACE TEMP VIEW _econ_fees AS
            SELECT brand_id, order_id,
                   CAST(coalesce(sum(coalesce(fee_minor, 0)), 0) AS BIGINT) AS fees_minor
            FROM {_FEES_FACT}
            GROUP BY brand_id, order_id
        """)
    else:
        con.execute(
            "CREATE OR REPLACE TEMP VIEW _econ_fees AS "
            "SELECT '' AS brand_id, '' AS order_id, CAST(0 AS BIGINT) AS fees_minor WHERE 1=0"
        )

    # provenance flag: which components were MEASURED vs degraded-to-0 (a null is never a measured 0).
    components_source = "|".join([
        f"cogs={'measured' if have_cogs else 'degraded0'}",
        f"costs={'measured' if have_costs else 'degraded0'}",
        f"fees={'measured' if have_fees else 'degraded0'}",
    ])

    # ── marketing day-pro-rata allocation (CM3 basis). Deterministic exact-sum largest-remainder. ──
    # For each (brand, currency, day) with recognized orders: split that day's silver_marketing_spend
    # equally across the orders; the first `remainder` orders (order_id asc) get +1 minor so Σ == spend
    # EXACTLY. currency-matched (M1): a KWD order only draws KWD spend. No spend for the day → 0, basis
    # 'none'.
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW _econ_spend_day AS
        SELECT brand_id, currency_code, CAST(stat_date AS DATE) AS spend_date,
               CAST(sum(coalesce(spend_minor, 0)) AS BIGINT) AS day_spend_minor
        FROM {SILVER_MARKETING}
        WHERE brand_id IS NOT NULL AND spend_minor IS NOT NULL
        GROUP BY brand_id, currency_code, CAST(stat_date AS DATE)
    """)

    con.execute("""
        CREATE OR REPLACE TEMP VIEW _econ_marketing AS
        WITH orders_day AS (
            SELECT l.brand_id, l.order_id, l.currency_code,
                   CAST(l.order_recognized_at AS DATE) AS spend_date
            FROM _econ_ledger l
        ),
        joined AS (
            SELECT od.brand_id, od.order_id, od.currency_code,
                   coalesce(sd.day_spend_minor, 0) AS day_spend_minor,
                   row_number() OVER (
                     PARTITION BY od.brand_id, od.currency_code, od.spend_date
                     ORDER BY od.order_id ASC
                   ) AS _rn,
                   count(*) OVER (
                     PARTITION BY od.brand_id, od.currency_code, od.spend_date
                   ) AS _n_orders
            FROM orders_day od
            LEFT JOIN _econ_spend_day sd
              ON sd.brand_id = od.brand_id AND sd.currency_code = od.currency_code
             AND sd.spend_date = od.spend_date
        )
        SELECT brand_id, order_id,
               CAST(
                 (day_spend_minor // _n_orders)
                 + CASE WHEN _rn <= (day_spend_minor - (day_spend_minor // _n_orders) * _n_orders)
                        THEN 1 ELSE 0 END
               AS BIGINT) AS marketing_minor,
               CASE WHEN day_spend_minor > 0 THEN 'day_channel_prorata' ELSE 'none' END AS cm3_allocation_basis
        FROM joined
    """)

    # ── assemble the economics waterfall (integer minor units, spec numbering AMD-17) ──
    staged = f"""
        SELECT
            l.brand_id,
            l.order_id,
            l.brain_id,
            l.currency_code,
            l.economics_state,
            nc.is_new_customer,
            l.net_revenue_minor,
            coalesce(cg.cogs_minor, 0)                       AS cogs_minor,
            coalesce(ct.shipping_fwd_minor, 0)               AS shipping_fwd_minor,
            coalesce(ct.shipping_rev_minor, 0)               AS shipping_rev_minor,
            coalesce(ct.packaging_minor, 0)                  AS packaging_minor,
            coalesce(fe.fees_minor, 0)                       AS fees_minor,
            (l.net_revenue_minor - coalesce(cg.cogs_minor, 0)) AS cm1_minor,
            (l.net_revenue_minor - coalesce(cg.cogs_minor, 0)
              - coalesce(ct.shipping_fwd_minor, 0) - coalesce(ct.shipping_rev_minor, 0)
              - coalesce(ct.packaging_minor, 0) - coalesce(fe.fees_minor, 0)) AS cm2_minor,
            coalesce(mk.marketing_minor, 0)                  AS marketing_minor,
            (l.net_revenue_minor - coalesce(cg.cogs_minor, 0)
              - coalesce(ct.shipping_fwd_minor, 0) - coalesce(ct.shipping_rev_minor, 0)
              - coalesce(ct.packaging_minor, 0) - coalesce(fe.fees_minor, 0)
              - coalesce(mk.marketing_minor, 0))             AS cm3_minor,
            coalesce(mk.cm3_allocation_basis, 'none')        AS cm3_allocation_basis,
            '{components_source}'                            AS components_source,
            l.order_recognized_at,
            'gold_revenue_ledger'                            AS source_system,
            l.source_event_id,
            '{JOB_VERSION}'                                  AS job_version,
            now() AT TIME ZONE 'UTC'                         AS updated_at
        FROM _econ_ledger l
        LEFT JOIN _econ_newcust nc ON nc.brand_id = l.brand_id AND nc.order_id = l.order_id
        LEFT JOIN _econ_cogs cg     ON cg.brand_id = l.brand_id AND cg.order_id = l.order_id
        LEFT JOIN _econ_costs ct    ON ct.brand_id = l.brand_id AND ct.order_id = l.order_id
        LEFT JOIN _econ_fees fe      ON fe.brand_id = l.brand_id AND fe.order_id = l.order_id
        LEFT JOIN _econ_marketing mk ON mk.brand_id = l.brand_id AND mk.order_id = l.order_id
        WHERE l.currency_code IS NOT NULL
    """

    # Full-recompute MERGE on (brand_id, order_id). The _econ_ledger GROUP BY already yields exactly one row
    # per PK, so the in-batch dedup is a no-op; order_by is a nominal tie-break.
    # delete_orphans on FULL recompute only (lo is None): the ledger fold is then complete truth, so any
    # target row whose (brand_id, order_id) vanished from the ledger (a brand wiped from source, seed
    # residue) must be shed — verified live 2026-07-17: 5 phantom brands (b444444a Σ27,000,000 ×220 rows,
    # b111111a, aa100a1a, b333333a, d1517a01) survived MERGE-no-delete after their sources were removed.
    # Under an INCREMENTAL window (lo not None) the staged batch is only the changed-order subset, so
    # shedding is DISABLED (the anti-join would wipe every unchanged order).
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at", "net_revenue_minor"],
                       delete_orphans=(lo is None))


if __name__ == "__main__":
    # The watermark tracks the revenue ledger's arrival clock (gold_revenue_ledger.ingested_at) — the
    # fold-driving source for the changed-order refold, NOT the gated keystone default.
    run_job("gold-order-economics", build, target_table=TABLE,
            source_table=LEDGER, ts_col="ingested_at")
