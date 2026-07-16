"""
silver_message_send.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_message_send.py.

The messaging-category canonical mart — the outbound send/delivery/read lifecycle for a message, collapsed
to ONE canonical row per (brand_id, message_id) carrying the most-advanced status. Folds
message.{send,delivery,read}.v1 out of the gated keystone via an idempotent latest-ingested-wins MERGE.

GRAIN : 1 row per (brand_id, message_id) — the three lifecycle events share the same message_id so the
        MERGE updates status in place (send→delivery→read collapse). message_id falls back to event_id when
        the payload omits it (so a malformed row still keys).
STATUS: queued|sent|delivered|read|failed|blocked. When the payload omits status it is derived from the
        event_type (read→read, delivery→delivered, send→sent).
MONEY : cost_minor is bigint MINOR units (provider per-message cost) + currency_code (default 0 / INR).
PII   : recipient_hash is the per-brand SALT hash ONLY (recipient_hash | subject_hash); never raw PII.
ISOLATION: brand_id first + bucket() anchor.

QUARANTINE SKIPPED: the Spark job runs a Stage-1 DQ gate (money over cost_minor/currency_code + timestamp
  over occurred_at) → silver_quarantine (stage='dq') before the MERGE. The migration framework has no
  quarantine seam, so — matching the other ports — this port does NOT write the side-table and does NOT
  re-implement the dq drop; Bronze keeps the originals (replay-safe). Mart admission (brand_id + message_id
  present) is preserved. Good rows are identical.

DATA AVAILABILITY: Bronze holds ZERO message.* today (the WhatsApp connector is `coming_soon`), so this
  writes a correct EMPTY table; an outbound-messaging connector landing message.*.v1 populates it, no change.

Parity target: brain_silver.silver_message_send (NEW — no dbt/StarRocks baseline).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import (  # noqa: E402
    GATED_SOURCE, ensure_table, incremental_window, json_str, merge_on_pk, prop,
    read_gated_events_sql, run_job,
)
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_message_send_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_message_send{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

EVENT_TYPES = ["message.send.v1", "message.delivery.v1", "message.read.v1"]

# brand_id-first; recipient_hash = hashed-PII ONLY; money = bigint minor + currency_code; occurred_at drives day().
COLUMNS_SQL = """
  brand_id            string    NOT NULL,
  message_id          string    NOT NULL,
  source              string,
  channel             string,
  recipient_hash      string,
  status              string,
  template            string,
  provider            string,
  provider_message_id string,
  error_reason        string,
  cost_minor          bigint,
  currency_code       string,
  sent_at             timestamp,
  delivered_at        timestamp,
  read_at             timestamp,
  occurred_at         timestamp NOT NULL,
  ingested_at         timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "message_id", "source", "channel", "recipient_hash", "status", "template", "provider",
    "provider_message_id", "error_reason", "cost_minor", "currency_code", "sent_at", "delivered_at",
    "read_at", "occurred_at", "ingested_at",
]

# Derive status from the event_type when the payload omits an explicit one — a delivery/read event IS the
# receipt for that lifecycle stage (verbatim port of the Spark CASE).
_STATUS_FROM_TYPE = (
    "CASE WHEN event_type = 'message.read.v1' THEN 'read' "
    "WHEN event_type = 'message.delivery.v1' THEN 'delivered' "
    "WHEN event_type = 'message.send.v1' THEN 'sent' END"
)


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) — GRAIN = entity_fold ───────────────────────
    #   MANY lifecycle events (message.{send,delivery,read}.v1 — DIFFERENT event_id, SAME message_id)
    #   collapse into ONE (brand_id, message_id) row via the latest-ingested-wins MERGE. A message's
    #   final status therefore depends on events that may be BELOW the watermark, so we must NOT window
    #   the fold input directly (that would drop the earlier send/delivery below the watermark and mis-
    #   collapse status). Instead: window the source ONLY to discover CHANGED (brand_id, message_id)
    #   keys, then re-fold each changed entity over its FULL history via a semi-join. Default OFF →
    #   lo=None → NO changed-set / semi-join → byte-identical full recompute.
    lo, hi = incremental_window(con, "silver-message-send", GATED_SOURCE, ts_col="ingested_at")

    # CHANGED-KEY set: the SAME entity-key derivation + not-null guards the fold uses, over a WINDOWED
    # read of the source. Only referenced when lo is not None (guarded semi-join below).
    changed = f"""
      SELECT DISTINCT brand_id, coalesce({prop('pj','message_id')}, event_id) AS message_id
      FROM ({read_gated_events_sql(EVENT_TYPES, lo=lo, hi=hi)})
      WHERE brand_id IS NOT NULL AND coalesce({prop('pj','message_id')}, event_id) IS NOT NULL
    """

    # The fold reads the FULL, UNWINDOWED source; when incremental is on, a semi-join restricts it to
    # ONLY the changed entities so each re-folds over its complete history (send→delivery→read collapse).
    fold_source = f"({read_gated_events_sql(EVENT_TYPES)})"
    if lo is not None:
        fold_source = f"""(
          SELECT * FROM ({read_gated_events_sql(EVENT_TYPES)})
          WHERE (brand_id, coalesce({prop('pj','message_id')}, event_id)) IN (
            SELECT brand_id, message_id FROM ({changed})
          )
        )"""

    staged = f"""
      SELECT {', '.join(COLUMNS)} FROM (
        SELECT
          brand_id,
          coalesce({prop('pj','message_id')}, event_id)                       AS message_id,
          {prop('pj','source')}                                               AS source,
          {prop('pj','channel')}                                              AS channel,
          coalesce({prop('pj','recipient_hash')}, {prop('pj','subject_hash')}) AS recipient_hash,
          coalesce(
            coalesce({prop('pj','status')}, {json_str('pj','status')}),
            {_STATUS_FROM_TYPE}
          )                                                                   AS status,
          coalesce({prop('pj','template')}, {prop('pj','notification_type')}) AS template,
          {prop('pj','provider')}                                             AS provider,
          {prop('pj','provider_message_id')}                                  AS provider_message_id,
          {prop('pj','error_reason')}                                         AS error_reason,
          coalesce(CAST({prop('pj','cost_minor')} AS BIGINT), CAST(0 AS BIGINT)) AS cost_minor,
          coalesce({prop('pj','currency_code')}, 'INR')                       AS currency_code,
          CAST({prop('pj','sent_at')} AS TIMESTAMP)                           AS sent_at,
          CAST({prop('pj','delivered_at')} AS TIMESTAMP)                      AS delivered_at,
          CAST({prop('pj','read_at')} AS TIMESTAMP)                           AS read_at,
          occurred_at, ingested_at
        FROM {fold_source}
      )
      WHERE brand_id IS NOT NULL AND message_id IS NOT NULL
    """

    # Latest-ingested-wins on the message grain → send→delivery→read collapse to the most-recent status.
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "message_id"],
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("silver-message-send", build, target_table="silver_message_send")
