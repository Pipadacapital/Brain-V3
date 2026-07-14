"""
silver_order_line.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_order_line.py.

The order LINE-ITEM grain: explode the line_items array of the LATEST order.* event per
(brand_id, order_id) into ONE row per line. Reimplements the Spark entity-incremental fold as a
single set-based DuckDB pass over the gated keystone (same data, no per-order bucketing needed —
DuckDB folds the whole source in one query; the window functions give the identical grain).

FOLDED TRANSFORM (mirrors the Spark _fold_and_merge, which itself ports stg_order_line_events.sql):
  1. From the gated keystone WHERE event_type LIKE 'order.%' AND the line_items array is non-empty,
     pick the LATEST order event per (brand_id, order_id) (occurred_at DESC, event_id DESC).
     order_id = coalesce(payload.properties.order_id, payload.order_id) — the Spark coalesce verbatim.
  2. UNNEST payload.properties.line_items → one row per line item (json string per element).
  3. line_index = a DETERMINISTIC content-ordered row_number (parity with StarRocks/Spark; there is no
     WITH ORDINALITY): order by sku, variant_id, unit_price_minor, quantity, title, <full item json>.
     1..N, stable. See the Spark docstring's line_index parity CAVEAT (final serialized-item tiebreak can
     swap 1↔2 on byte-identical-on-leading-keys lines; the LINE CONTENT is identical, only the label).
  4. Type money + quantity to BIGINT minor units with a regexp guard (non-numeric → 0, never float).
     quantity uses '^[0-9]+$'; the three money cols use '^-?[0-9]+$' (signed) — verbatim.
  5. Defensive dedup on (brand_id, order_id, line_index), occurred_at DESC.

GRAIN : 1 row per (brand_id, order_id, line_index).
MONEY : unit_price_minor / line_total_minor / line_discount_minor are BIGINT minor units + currency_code
        (never a float). currency_code = payload.properties.currency_code (the order's currency).
PK    : (brand_id, order_id, line_index). order_by_desc = (occurred_at) — matches the Spark defensive
        dedup window (partition by grain, order by occurred_at DESC).

CAVEAT — Stage-1 DQ quarantine side-write SKIPPED: the Spark job runs dq_violations_udf over
(line_total_minor, currency_code, occurred_at, quantity) and diverts failures to
brain_silver.silver_quarantine (stage='dq'), dropping them from the mart. This DuckDB port has no
_silver_technical analogue, so — matching the framework's other ports (silver_payment/silver_cod_rto) —
it does NOT write the quarantine side-table and does NOT re-implement the dq drop; it preserves the
mart's own admission (a line only exists if the latest order event carried a non-empty line_items array).
Bronze keeps the originals, so the quarantine ledger can be rebuilt separately; good lines are identical.
Parity target: brain_silver.silver_order_line.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_order_line_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_line{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# BOTH order lanes: live webhook + historical connector backfill land under 'order.%'. The Spark filter
# is event_type LIKE 'order.%'; the keystone's order events are order.live.v1 / order.backfill.v1.
ORDER_EVENTS = ["order.live.v1", "order.backfill.v1"]

# order_id = coalesce(properties.order_id, top-level order_id) — the Spark coalesce, verbatim.
_ORDER_ID = "coalesce(json_extract_string(pj, '$.properties.order_id'), json_extract_string(pj, '$.order_id'))"
# The line_items array as a JSON string (payload.properties.line_items).
_LINE_ITEMS = "json_extract_string(pj, '$.properties.line_items')"
_CURRENCY = "json_extract_string(pj, '$.properties.currency_code')"

COLUMNS_SQL = """
  brand_id             string    NOT NULL,
  order_id             string    NOT NULL,
  line_index           bigint    NOT NULL,
  sku                  string,
  title                string,
  quantity             bigint,
  unit_price_minor     bigint,
  line_total_minor     bigint,
  line_discount_minor  bigint,
  product_id           string,
  variant_id           string,
  currency_code        string,
  occurred_at          timestamp
""".strip("\n")

COLUMNS = [
    "brand_id", "order_id", "line_index", "sku", "title", "quantity",
    "unit_price_minor", "line_total_minor", "line_discount_minor",
    "product_id", "variant_id", "currency_code", "occurred_at",
]


def _item(path: str) -> str:
    """Extract a leaf field of the per-line item JSON (the unnested array element) as a string —
    DuckDB equivalent of Spark get_json_object(item, '$.<path>')."""
    return f"json_extract_string(item, '$.{path}')"


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id)")

    # ── Step 1: latest order.* event per (brand_id, order_id) with a non-empty line_items array ──────────
    # json_array_length over the parsed array is the DuckDB analogue of size(from_json(..,'array<string>')).
    latest_order = f"""
      SELECT brand_id, event_id, occurred_at, order_id, currency_code, line_items_json
      FROM (
        SELECT
          brand_id, event_id, occurred_at,
          {_ORDER_ID}   AS order_id,
          {_CURRENCY}   AS currency_code,
          {_LINE_ITEMS} AS line_items_json,
          row_number() OVER (
            PARTITION BY brand_id, {_ORDER_ID}
            ORDER BY occurred_at DESC, event_id DESC
          ) AS rn
        FROM ({read_gated_events_sql(ORDER_EVENTS)})
        WHERE {_LINE_ITEMS} IS NOT NULL
          AND json_array_length(CAST({_LINE_ITEMS} AS JSON)) > 0
      ) l
      WHERE l.rn = 1
    """

    # ── Step 2: unnest line_items → one row per line item (each element parsed as a JSON string) ─────────
    # unnest(from_json(json, '["json"]')) yields one `item` per array element; json_extract_string then
    # reads its leaf fields. Mirrors Spark's `lateral view explode(from_json(.., 'array<string>'))`.
    exploded = f"""
      SELECT
        brand_id, event_id, order_id, currency_code, occurred_at,
        unnest(from_json(CAST(line_items_json AS JSON), '["json"]')) AS item
      FROM ({latest_order})
    """

    # ── Step 3: content-ordered deterministic line_index + leaf projection ──────────────────────────────
    lines_raw = f"""
      SELECT
        brand_id, event_id, order_id, currency_code, occurred_at,
        item AS _item,
        row_number() OVER (
          PARTITION BY brand_id, order_id
          -- NULLS FIRST on every key: Spark's ASC default is NULLS FIRST, DuckDB's is NULLS LAST.
          -- Without this a NULL-sku line (e.g. a free gift with no SKU) lands at the opposite end,
          -- shifting every line_index for that order. Matching Spark's ASC-NULLS-FIRST is the fix.
          ORDER BY {_item('sku')}              ASC NULLS FIRST,
                   {_item('variant_id')}       ASC NULLS FIRST,
                   {_item('unit_price_minor')} ASC NULLS FIRST,
                   {_item('quantity')}         ASC NULLS FIRST,
                   {_item('title')}            ASC NULLS FIRST,
                   CAST(item AS VARCHAR)       ASC NULLS FIRST
        ) AS line_index,
        {_item('sku')}   AS sku,
        {_item('title')} AS title,
        coalesce({_item('quantity')},            '0') AS quantity_raw,
        coalesce({_item('unit_price_minor')},    '0') AS unit_price_minor_raw,
        coalesce({_item('line_total_minor')},    '0') AS line_total_minor_raw,
        coalesce({_item('line_discount_minor')}, '0') AS line_discount_minor_raw,
        {_item('product_id')} AS product_id,
        {_item('variant_id')} AS variant_id
      FROM ({exploded})
    """

    # ── Step 4: regexp-guarded BIGINT typing (never float/fail) + Step 5: defensive dedup on the grain ──
    # quantity: unsigned '^[0-9]+$'; money cols: signed '^-?[0-9]+$' — verbatim to the Spark rlike guards.
    typed = f"""
      SELECT
        brand_id, order_id, line_index, sku, title,
        CASE WHEN regexp_full_match(quantity_raw,            '^[0-9]+$')   THEN CAST(quantity_raw AS BIGINT)            ELSE CAST(0 AS BIGINT) END AS quantity,
        CASE WHEN regexp_full_match(unit_price_minor_raw,    '^-?[0-9]+$') THEN CAST(unit_price_minor_raw AS BIGINT)    ELSE CAST(0 AS BIGINT) END AS unit_price_minor,
        CASE WHEN regexp_full_match(line_total_minor_raw,    '^-?[0-9]+$') THEN CAST(line_total_minor_raw AS BIGINT)    ELSE CAST(0 AS BIGINT) END AS line_total_minor,
        CASE WHEN regexp_full_match(line_discount_minor_raw, '^-?[0-9]+$') THEN CAST(line_discount_minor_raw AS BIGINT) ELSE CAST(0 AS BIGINT) END AS line_discount_minor,
        product_id, variant_id, currency_code,
        CAST(occurred_at AS TIMESTAMP) AS occurred_at
      FROM ({lines_raw})
    """

    # NOTE: Stage-1 DQ quarantine side-write skipped (see module docstring). The defensive dedup on the
    # grain key (occurred_at DESC) is folded into merge_on_pk's in-batch dedup, matching the Spark path.
    return merge_on_pk(con, TARGET, typed, COLUMNS, ["brand_id", "order_id", "line_index"],
                       order_by_desc=["occurred_at"])


if __name__ == "__main__":
    run_job("silver-order-line", build, target_table="silver_order_line")
