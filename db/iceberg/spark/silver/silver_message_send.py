"""
silver_message_send.py — GAP canonical Silver `message_send` entity (Brain V4 Phase 1b, GROUP messaging).

Closes the **messaging-category** coverage gap from docs/architecture/v4/_category-coverage-matrix.md §1:
the `messaging` connector category (WhatsApp / outbound — registry.ts category='messaging') emits
send / delivery / read lifecycle events that, until now, had NO normalized canonical Silver table. This is
that table — a Spark→Iceberg Silver job reading raw Iceberg Bronze, dual-run BESIDE the dbt brain_silver
(it repoints no reader and changes no app/dbt code; parity status=NEW — no dbt predecessor exists).

SOURCE  : rest.brain_bronze.collector_events WHERE event_type IN
            ('message.send.v1', 'message.delivery.v1', 'message.read.v1')
          — the outbound-messaging lifecycle event-names a WhatsApp/SMS/email outbound connector (or the
          @brain/notification chokepoint, I-ST05) would emit per the existing `<verb>.<noun>.v1` mapper
          convention (cf. order.live.v1 / settlement.live.v1 / spend.live.v1). One Bronze row per lifecycle
          transition of a message; they all carry the SAME `message_id` so the latest-ingested-wins MERGE
          collapses send→delivery→read into ONE canonical row carrying the most-advanced status.
GRAIN   : exactly 1 row per (brand_id, message_id) — the message identity. A re-pull (or a later
          delivery/read event for the same message) re-emits the SAME message_id → latest-ingested-wins
          MERGE updates `status` in place (idempotent; replay-safe; the Bronze MERGE discipline at the
          message grain).
STATUS  : the outbound lifecycle, mirroring the operational PG send_log (migration 0033) status ladder
          plus the post-send provider receipts:
            queued | sent | delivered | read | failed | blocked
          (send_log persists queued/sent/failed/blocked pre-/at-send; delivered/read are the provider
          delivery receipts that only a streamed outbound connector surfaces — both fold here.)
PII     : recipient_hash is the identity-core per-brand SALT hash ONLY (the send_log `subject_hash`
          contract, I-S02). Raw email / phone is NEVER read or stored — the mapper drops it at its
          boundary (C1) exactly like the razorpay *_hash identifiers. This job NEVER derives or persists
          a raw recipient identifier. template is an opaque template/notification-type name (not PII).
MONEY   : messaging carries a per-message provider COST (e.g. the WhatsApp per-message price). It is
          modeled as bigint MINOR units (`cost_minor`) + a sibling `currency_code` — the SAME money
          discipline as every other Silver mart (I-S07) — defaulting to 0 / 'INR' when absent.
ISOLATION: brand_id is the FIRST column + the bucket() partition anchor (tenant key on every row).

STAGE-1 GATE (Brain V4 two-stage): a message_send carries provider cost (cost_minor + currency_code) and a
  timestamp, so the applicable Stage-1 DQ rules are the MONEY gate over (cost_minor, currency_code)
  (negative_amount / non_integer_amount / invalid_currency / missing_currency) and the TIMESTAMP gate over
  occurred_at (future_occurred_at / unparseable_timestamp) — _silver_technical.dq_check. A message with a
  negative/non-integer cost, a non-ISO-4217 currency, or a future/unparseable occurred_at is diverted to
  brain_silver.silver_quarantine (stage='dq') and NEVER written to silver_message_send; Bronze keeps the
  original (replay-safe). recipient_hash stays on the existing hash-only path (the gate never touches it);
  template is an opaque type name (not a human display name), so clean_name/clean_string do NOT apply. Good
  rows are byte-identical to before (parity-faithful).

DATA AVAILABILITY (this session): current Bronze has ZERO message.* rows — the WhatsApp connector is
`coming_soon` (registry.ts) and no outbound connector streams send/delivery/read events into Bronze yet.
This job therefore writes a correct EMPTY table over current Bronze (0 rows is the expected, honest
result). The schema + transform are the deliverable: the moment an outbound-messaging connector lands
message.*.v1 in Bronze, a re-run populates this table with NO code change. Parity status=NEW.
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer `str | None` annotation eval.

from _silver_base import (
    ensure_silver_table,
    merge_on_pk,
    prop,
    read_bronze_events,
    run_job,
)
from _silver_technical import dq_violations_udf, write_quarantine
from pyspark.sql.functions import array_join, coalesce, col, get_json_object, lit, size, to_timestamp

TABLE = "silver_message_send"

# The outbound-messaging lifecycle events (mapper convention <verb>.<noun>.v1). All three carry the same
# message_id; the MERGE collapses them to the most-advanced status per message.
EVENT_TYPES = ["message.send.v1", "message.delivery.v1", "message.read.v1"]

# brand_id-first; recipient_hash = hashed-PII ONLY (send_log subject_hash contract); money = bigint minor +
# currency_code; sent_at/delivered_at/read_at are the lifecycle timestamps; occurred_at drives days().
COLUMNS_SQL = """
          brand_id        string    NOT NULL,
          message_id      string    NOT NULL,
          source          string,
          channel         string,
          recipient_hash  string,
          status          string,
          template        string,
          provider        string,
          provider_message_id string,
          error_reason    string,
          cost_minor      bigint,
          currency_code   string,
          sent_at         timestamp,
          delivered_at    timestamp,
          read_at         timestamp,
          occurred_at     timestamp NOT NULL,
          ingested_at     timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)"
    )

    raw = read_bronze_events(spark, EVENT_TYPES)
    staged = (
        raw.select(
            col("brand_id"),
            # message_id: the message identity (mapper-seeded, stable across the send/delivery/read
            # lifecycle). Fall back to event_id only so a malformed payload still produces a keyed row.
            coalesce(prop("pj", "message_id"), col("event_id")).alias("message_id"),
            prop("pj", "source").alias("source"),
            # channel: transactional_email | marketing_email | whatsapp | sms (send_log ContactChannel).
            prop("pj", "channel").alias("channel"),
            # recipient_hash: the identity-core per-brand SALT hash ONLY (send_log subject_hash). Accept
            # either `recipient_hash` or the send_log-native `subject_hash` property name; never raw PII.
            coalesce(prop("pj", "recipient_hash"), prop("pj", "subject_hash")).alias("recipient_hash"),
            # status: the outbound lifecycle ladder. If the payload omits an explicit status, derive it
            # from the event_type (delivery → delivered, read → read, send → sent).
            coalesce(
                prop("pj", "status"),
                get_json_object(col("pj"), "$.status"),
            ).alias("_status_raw"),
            col("event_type"),
            # template: the opaque template / notification_type name (send_log notification_type).
            coalesce(prop("pj", "template"), prop("pj", "notification_type")).alias("template"),
            prop("pj", "provider").alias("provider"),
            prop("pj", "provider_message_id").alias("provider_message_id"),
            prop("pj", "error_reason").alias("error_reason"),
            # Money: BIGINT minor units (provider per-message cost) — cast the string property, default 0.
            coalesce(prop("pj", "cost_minor").cast("bigint"), lit(0).cast("bigint")).alias("cost_minor"),
            coalesce(prop("pj", "currency_code"), lit("INR")).alias("currency_code"),
            to_timestamp(prop("pj", "sent_at")).alias("sent_at"),
            to_timestamp(prop("pj", "delivered_at")).alias("delivered_at"),
            to_timestamp(prop("pj", "read_at")).alias("read_at"),
            col("occurred_at"),
            col("ingested_at"),
            # Carry the raw payload so a quarantined reject is replayable from the quarantine row alone.
            col("pj").alias("_payload"),
        )
        .where(col("brand_id").isNotNull() & col("message_id").isNotNull())
    )

    # Derive status from the event_type when the payload didn't carry one explicitly: a delivery/read
    # event IS the receipt for that lifecycle stage. Keep an explicit payload status if present.
    from pyspark.sql.functions import expr

    staged = staged.withColumn(
        "status",
        coalesce(
            col("_status_raw"),
            expr(
                "CASE "
                "WHEN event_type = 'message.read.v1' THEN 'read' "
                "WHEN event_type = 'message.delivery.v1' THEN 'delivered' "
                "WHEN event_type = 'message.send.v1' THEN 'sent' "
                "END"
            ),
        ),
    ).drop("_status_raw", "event_type")

    # ── Stage-1 DQ gate: money (cost_minor + currency_code) + timestamp validity ──────────────────────
    gated = staged.withColumn(
        "_dq",
        dq_violations_udf()(
            col("cost_minor"),
            col("currency_code"),
            col("occurred_at").cast("string"),
        ),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            col("source"),
            col("message_id").alias("bronze_event_id"),
            lit(TABLE).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            col("_payload").alias("payload"),
        ),
        stage="dq",
    )
    good = gated.where(size(col("_dq")) == 0).drop("_dq", "_payload")

    # Latest-ingested-wins on the message grain → send→delivery→read collapse to the most-recent status.
    merge_on_pk(
        spark,
        fqtn,
        good,
        ["brand_id", "message_id"],
        order_by_desc=["ingested_at", "occurred_at"],
    )
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-message-send", build)
