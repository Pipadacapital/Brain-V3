"""
silver_razorpay_normalize.py (DuckDB) — faithful port of
db/iceberg/spark/silver/silver_razorpay_normalize.py (ADR-0006 P4).

Reads the RAW Razorpay settlement-recon Bronze (the ADR-0010 Kafka-Connect `razorpay_settlement_raw_connect`
lane — the verbatim recon item nested under `settlement`), reconstructs the canonical settlement.live.v1
envelope in `payload`, and MERGEs the silver_collector_event 14-column contract into the SHADOW table
silver_collector_event_razorpay_shadow (dual-run parity; TARGET_TABLE / MIGRATION_TABLE_SUFFIX override).

CORRECTNESS: shared crypto/PII goes through the VENDORED ports (_raw_normalize_ports.hash_salted_bytes /
uuid_shaped); the connector-LOCAL pure helpers (paisa passthrough money, unix-seconds→ISO, entity/recon,
settlement event_id seeds) are ported HERE byte-for-byte with the Spark job. Money is INTEGER paisa (already
minor units) — a strict /^\\d+$/ passthrough, never a float; emitted with a sibling currency_code.
PII (C1/DPDP): payment_id (pay_*) and utr are hashed via hash_salted_bytes = sha256(bytes.fromhex(salt) ++
utf8(lower(trim(value)))). PCI (C4): card.* is NEVER selected off the raw item.

STAGE-1 QUARANTINE SKIPPED (parity-preserving, per the migration rule): the Spark job routes the inline
drop-gate complement (un-seedable event_id / malformed paisa / unparseable ts) to silver_quarantine
(stage='dq'). This port does NOT write that diagnostic ledger — Bronze keeps the originals (replay-safe). The
ADMITTED (good-row) set is IDENTICAL: the same `event_id & occurred_at_iso & amount_minor & fee_minor &
tax_minor IS NOT NULL` predicate is applied before the MERGE.

Parity target: brain_silver.silver_collector_event_razorpay_shadow (empty lane today → 0 rows, HONEST-EMPTY).
"""
from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402
from _normalize_base import (  # noqa: E402
    advance_lane_watermark, connect_source_table, ensure_shadow, lane_window, lane_window_predicate,
    merge_collector_event, register_salts, run_normalize_job, source_present,
)
import _raw_normalize_ports as rn  # noqa: E402
from _silver_technical_ports import event_category  # noqa: E402

LANE = "razorpay_settlement_raw"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get(
    "TARGET_TABLE", "silver_collector_event_razorpay_shadow"
) + os.environ.get("MIGRATION_TABLE_SUFFIX", "")
NEST = os.environ.get("RAZORPAY_RAW_NEST", "settlement")

_ENTITY_TYPES = {"payment", "refund", "adjustment", "reserve_deduction"}


# ── Connector-local pure ports (byte-for-byte with the Spark job / @brain/razorpay-mapper) ────────────
def paisa_to_minor_string(value):
    """paisaToMinorString — Razorpay amounts are INTEGER paisa (already minor). null/'' → '0'; non-int →
    None (quarantine; never a float, never blended)."""
    if value is None:
        return "0"
    s = str(value).strip()
    if s == "":
        return "0"
    if not re.match(r"^\d+$", s):
        return None
    return s


def razorpay_unix_to_iso(value):
    """toIso — created_at/settled_at are UNIX SECONDS (or ISO string). None/'' → None; always .mmmZ."""
    if value is None:
        return None
    s = str(value).strip()
    if s == "":
        return None
    if re.match(r"^\d+$", s):
        dt = datetime.fromtimestamp(int(s), tz=timezone.utc)
    else:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def resolve_entity_type(raw):
    v = (raw or "").strip().lower()
    return v if v in _ENTITY_TYPES else "payment"


def reconciliation_type(entity_type, raw_payment_id):
    if not raw_payment_id or entity_type == "adjustment":
        return "brand_level"
    return "per_order"


def settlement_event_id(brand_id, settlement_id, raw_payment_id, entity_type):
    if not (brand_id and settlement_id):
        return None
    if raw_payment_id:
        return rn.uuid_shaped(f"{brand_id}:{settlement_id}:{raw_payment_id}:{entity_type}:settlement.live.v1")
    return rn.uuid_shaped(f"{brand_id}:{settlement_id}:summary:settlement.live.v1")


def _register_udfs(con) -> None:
    con.create_function("rn_paisa", paisa_to_minor_string, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_iso", razorpay_unix_to_iso, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_entity", resolve_entity_type, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_hash", lambda v, salt: rn.hash_salted_bytes(v, salt) if v else None,
                        ["VARCHAR", "VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_eid", settlement_event_id, ["VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR"],
                        "VARCHAR", null_handling="special")
    con.create_function("rn_recon", reconciliation_type, ["VARCHAR", "VARCHAR"], "VARCHAR",
                        null_handling="special")
    con.create_function("rn_event_category", event_category, ["VARCHAR"], "VARCHAR", null_handling="special")


def build(con):
    ensure_shadow(con, TARGET)
    if not source_present(con, LANE):
        print(f"[silver-razorpay-normalize] {connect_source_table(LANE)} absent/empty — skipping "
              f"(empty lane; table auto-creates on first record, ADR-0010)", flush=True)
        return TARGET, 0
    _register_udfs(con)
    register_salts(con)
    src = connect_source_table(LANE)
    s = NEST

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   PER-EVENT grain: each raw recon item → 0..1 shadow row via the idempotent MERGE on
    #   (brand_id, event_id), so windowing the raw lane read is safe. Default OFF / first run / FULL_REFRESH
    #   → lo=None → lane_window_predicate == "" → BYTE-IDENTICAL full scan (unchanged SQL).
    lo_razorpay, hi_razorpay = lane_window(con, "silver-razorpay-normalize", LANE)

    # C4: only allowlisted recon-item fields; card.* NEVER read → PCI boundary held.
    df = f"""
      SELECT
        CAST(brand_id AS VARCHAR)                        AS brand_id,
        CAST(fetched_at AS VARCHAR)                      AS fetched_at,
        CAST("{s}".settlement_id AS VARCHAR)             AS settlement_id,
        CAST("{s}".payment_id AS VARCHAR)                AS payment_id,
        CAST("{s}".order_id AS VARCHAR)                  AS order_id,
        CAST("{s}".amount AS VARCHAR)                    AS amount,
        CAST("{s}".fee AS VARCHAR)                       AS fee,
        CAST("{s}".tax AS VARCHAR)                       AS tax,
        CAST("{s}".utr AS VARCHAR)                       AS utr,
        CAST("{s}".status AS VARCHAR)                    AS status,
        CAST("{s}".created_at AS VARCHAR)                AS created_at,
        CAST("{s}".settled_at AS VARCHAR)                AS settled_at,
        CAST("{s}".currency AS VARCHAR)                  AS currency,
        CAST("{s}".entity_type AS VARCHAR)               AS entity_type_raw
      FROM {src}
      {lane_window_predicate(lo_razorpay, hi_razorpay)}
    """

    # Per-brand salt LEFT join for the C1 PII hash (bytes.fromhex(salt); a miss → NULL salt → NULL hash).
    joined = f"SELECT d.*, sl.salt_hex FROM ({df}) d LEFT JOIN _salts sl ON d.brand_id = sl.brand_id"

    canon = f"""
      SELECT *,
        rn_entity(entity_type_raw)                                AS entity_type,
        rn_iso(settled_at)                                        AS settlement_at_iso,
        coalesce(rn_iso(settled_at), rn_iso(created_at))          AS occurred_at_iso,
        rn_paisa(amount)                                          AS amount_minor,
        rn_paisa(fee)                                             AS fee_minor,
        rn_paisa(tax)                                             AS tax_minor,
        upper(trim(coalesce(currency, 'INR')))                    AS currency_code,
        rn_hash(payment_id, salt_hex)                             AS payment_id_hash,
        rn_hash(utr, salt_hex)                                    AS utr_hash,
        rn_recon(rn_entity(entity_type_raw), payment_id)          AS reconciliation_type,
        rn_eid(brand_id, settlement_id, payment_id, rn_entity(entity_type_raw)) AS event_id
      FROM ({joined})
    """

    # Reconstruct the canonical settlement.live.v1 envelope. json_object drops NULL keys (Spark parity).
    props = (
        "json_object("
        "'source','razorpay',"
        "'settlement_id', settlement_id,"
        "'payment_id_hash', payment_id_hash,"
        "'order_id', order_id,"
        "'utr_hash', utr_hash,"
        "'amount_minor', amount_minor,"
        "'fee_minor', fee_minor,"
        "'tax_minor', tax_minor,"
        "'currency_code', currency_code,"
        "'entity_type', entity_type,"
        "'status', status,"
        "'settlement_at', settlement_at_iso,"
        "'occurred_at', occurred_at_iso,"
        "'reconciliation_type', reconciliation_type)"
    )
    payload = (
        "json_object('event_name','settlement.live.v1','occurred_at', occurred_at_iso, 'properties', "
        f"{props})"
    )

    good = f"""
      SELECT
        event_id,
        brand_id,
        CAST(occurred_at_iso AS TIMESTAMP)               AS occurred_at,
        CAST(fetched_at AS TIMESTAMP)                    AS ingested_at,
        'brain.collector.event.v1'                       AS schema_name,
        CAST(1 AS INTEGER)                               AS schema_version,
        'settlement.live.v1'                             AS event_type,
        rn_event_category('settlement.live.v1')          AS event_category,
        CAST(NULL AS VARCHAR)                            AS correlation_id,
        brand_id                                         AS partition_key,
        CAST(NULL AS VARCHAR)                            AS anonymous_id,
        CAST(NULL AS VARCHAR)                            AS device_id,
        CAST(1 AS INTEGER)                               AS silver_version,
        {payload}                                        AS payload
      FROM ({canon})
      WHERE event_id IS NOT NULL AND occurred_at_iso IS NOT NULL
        AND amount_minor IS NOT NULL AND fee_minor IS NOT NULL AND tax_minor IS NOT NULL
    """

    n = merge_collector_event(con, TARGET, good)
    advance_lane_watermark(con, "silver-razorpay-normalize", LANE, hi_razorpay)
    return TARGET, n


if __name__ == "__main__":
    run_normalize_job("silver-razorpay-normalize", build,
                      target_table="silver_collector_event_razorpay_shadow")
