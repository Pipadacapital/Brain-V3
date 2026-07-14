"""
silver_shiprocket_normalize.py (DuckDB) — faithful port of
db/iceberg/spark/silver/silver_shiprocket_normalize.py (ADR-0006 P4; SR-8 shadow-only parity oracle).

Reads the RAW Shiprocket shipment Bronze (the ADR-0010 Kafka-Connect `shiprocket_shipments_raw_connect` lane —
the verbatim forward-shipment record nested under `shipment`), reconstructs the canonical
shiprocket.shipment_status.v1 envelope in `payload`, and MERGEs the silver_collector_event 14-column contract
into the SHADOW table silver_collector_event_shiprocket_shadow (dual-run parity; TARGET_TABLE /
MIGRATION_TABLE_SUFFIX override). RETURNS are OUT OF SCOPE (they flow on the disjoint return_status event).

CORRECTNESS: shared crypto/PII/time goes through the VENDORED ports (_raw_normalize_ports.hash_salted_bytes /
iso_ms / uuid_shaped); the logistics-status terminal_class authority + NDR/exception sub-class + payment
resolver + event_id seed are ported HERE byte-for-byte with the Spark job (which tracks
@brain/logistics-status). LOGISTICS IS MONEY-FREE. PII = the AWB only, hashed via hash_salted_bytes; the raw
AWB is dropped.

STAGE-1 QUARANTINE SKIPPED (parity-preserving, per the migration rule): the Spark job routes the inline
drop-gate complement (empty order_id / un-seedable event_id / unparseable ts) to silver_quarantine
(stage='dq'). This port does NOT write that diagnostic ledger — Bronze keeps the originals (replay-safe). The
ADMITTED (good-row) set is IDENTICAL: the same `event_id & occurred_at_iso IS NOT NULL AND order_id_norm
non-empty` predicate is applied before the MERGE.

Parity target: brain_silver.silver_collector_event_shiprocket_shadow (empty lane today → 0 rows, HONEST-EMPTY).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402
from _normalize_base import (  # noqa: E402
    connect_source_table, ensure_shadow, merge_collector_event, register_salts, run_normalize_job,
    source_present,
)
import _raw_normalize_ports as rn  # noqa: E402
from _raw_normalize_ports import classify_terminal_class as _classify_shipment_status, normalize_status  # noqa: E402
from _silver_technical_ports import event_category  # noqa: E402

LANE = "shiprocket_shipments_raw"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get(
    "TARGET_TABLE", "silver_collector_event_shiprocket_shadow"
) + os.environ.get("MIGRATION_TABLE_SUFFIX", "")
RECORD_KEY = os.environ.get("SHIPROCKET_RECORD_KEY", "shipment")

# SR-5 NON-TERMINAL exception/NDR sub-class — lockstep with @brain/logistics-status (EXCEPTION_STATES).
_EXCEPTION = {
    "delayed", "exception", "ndr", "undelivered",
    "address issue", "customer unavailable", "failed delivery attempt",
}


def _classify_exception(raw):
    s = normalize_status(raw)
    if s == "delayed":
        return "delayed"
    if s in _EXCEPTION:
        return "ndr"
    return None


def _resolve_payment_method(raw):
    s = (raw or "").strip().lower()
    if s in ("cod", "cash_on_delivery", "cash on delivery"):
        return "cod"
    if s in ("prepaid", "online", "paid"):
        return "prepaid"
    return None


def _event_id_shipment(brand_id, awb, status, status_changed_at_iso):
    """uuidV5FromShipment(brand, awb, status, statusChangedAt) — raw (untrimmed) awb/status + the ISO ts."""
    return rn.uuid_shaped(
        f"{brand_id}:{awb}:{status}:{status_changed_at_iso}:shiprocket.shipment_status.v1"
    )


def _register_udfs(con) -> None:
    con.create_function("rn_iso", lambda a: rn.iso_ms(a) if a else None, ["VARCHAR"], "VARCHAR",
                        null_handling="special")
    con.create_function("rn_awb_hash", lambda v, salt: rn.hash_salted_bytes(v, salt) if v else None,
                        ["VARCHAR", "VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_classify", lambda s: _classify_shipment_status(s), ["VARCHAR"], "VARCHAR",
                        null_handling="special")
    con.create_function("rn_is_terminal", lambda s: _classify_shipment_status(s) != "none", ["VARCHAR"],
                        "BOOLEAN", null_handling="special")
    con.create_function("rn_exception", lambda s: _classify_exception(s), ["VARCHAR"], "VARCHAR",
                        null_handling="special")
    con.create_function("rn_payment", lambda s: _resolve_payment_method(s), ["VARCHAR"], "VARCHAR",
                        null_handling="special")
    con.create_function(
        "rn_eid",
        lambda brand, awb, status, sca: _event_id_shipment(brand, awb, status, sca) if (brand and sca) else None,
        ["VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR"], "VARCHAR", null_handling="special",
    )
    con.create_function("rn_event_category", event_category, ["VARCHAR"], "VARCHAR", null_handling="special")


def build(con):
    ensure_shadow(con, TARGET)
    if not source_present(con, LANE):
        print(f"[silver-shiprocket-normalize] {connect_source_table(LANE)} absent/empty — skipping "
              f"(empty lane; table auto-creates on first record, ADR-0010)", flush=True)
        return TARGET, 0
    _register_udfs(con)
    register_salts(con)
    src = connect_source_table(LANE)
    r = RECORD_KEY

    # data_source is envelope-level if present, else 'real'. Probe the source columns to stay schema-safe.
    has_data_source = con.execute(
        "SELECT count(*) FROM information_schema.columns WHERE table_name = ? AND column_name = 'data_source'",
        [f"{LANE}_connect"],
    ).fetchone()[0] > 0
    data_source_expr = "CAST(data_source AS VARCHAR)" if has_data_source else "'real'"

    df = f"""
      SELECT
        CAST(brand_id AS VARCHAR)                        AS brand_id,
        CAST(fetched_at AS VARCHAR)                      AS fetched_at,
        {data_source_expr}                               AS data_source,
        CAST("{r}".awb AS VARCHAR)                       AS awb,
        CAST("{r}".order_id AS VARCHAR)                  AS order_id,
        CAST("{r}".status AS VARCHAR)                    AS status,
        CAST("{r}".status_changed_at AS VARCHAR)         AS status_changed_at,
        CAST("{r}".payment_method AS VARCHAR)            AS payment_method,
        CAST("{r}".pincode AS VARCHAR)                   AS pincode,
        CAST("{r}".courier AS VARCHAR)                   AS courier
      FROM {src}
    """

    # Per-brand salt LEFT join for the AWB hash (bytes.fromhex(salt); a miss → NULL salt → NULL hash).
    joined = f"SELECT d.*, sl.salt_hex FROM ({df}) d LEFT JOIN _salts sl ON d.brand_id = sl.brand_id"

    # raw (untrimmed) seed components: coalesce(awb,'') / coalesce(status,'') — mirrors the repull seed.
    canon = f"""
      SELECT *,
        rn_iso(status_changed_at)                                AS occurred_at_iso,
        trim(order_id)                                           AS order_id_norm,
        trim(status)                                             AS status_norm,
        rn_classify(status)                                      AS terminal_class,
        rn_is_terminal(status)                                   AS is_terminal,
        rn_exception(status)                                     AS exception_class,
        rn_payment(payment_method)                               AS payment_method_norm,
        rn_awb_hash(trim(awb), salt_hex)                         AS awb_number_hash,
        trim(pincode)                                            AS pincode_norm,
        trim(courier)                                            AS courier_norm,
        rn_eid(brand_id, coalesce(awb, ''), coalesce(status, ''), rn_iso(status_changed_at)) AS event_id
      FROM ({joined})
    """

    # Reconstruct the canonical shiprocket.shipment_status.v1 envelope. json_object drops NULL keys.
    props = (
        "json_object("
        "'source','shiprocket',"
        "'data_source', data_source,"
        "'awb_number_hash', awb_number_hash,"
        "'order_id', order_id_norm,"
        "'status', status_norm,"
        "'terminal_class', terminal_class,"
        "'is_terminal', is_terminal,"
        "'exception_class', exception_class,"
        "'payment_method', payment_method_norm,"
        "'pincode', pincode_norm,"
        "'courier', courier_norm,"
        "'status_changed_at', occurred_at_iso,"
        "'occurred_at', occurred_at_iso)"
    )
    payload = (
        "json_object('event_name','shiprocket.shipment_status.v1','occurred_at', occurred_at_iso, "
        f"'properties', {props})"
    )

    good = f"""
      SELECT
        event_id,
        brand_id,
        CAST(occurred_at_iso AS TIMESTAMP)               AS occurred_at,
        CAST(fetched_at AS TIMESTAMP)                    AS ingested_at,
        'brain.collector.event.v1'                       AS schema_name,
        CAST(1 AS INTEGER)                               AS schema_version,
        'shiprocket.shipment_status.v1'                  AS event_type,
        rn_event_category('shiprocket.shipment_status.v1') AS event_category,
        CAST(NULL AS VARCHAR)                            AS correlation_id,
        brand_id                                         AS partition_key,
        CAST(NULL AS VARCHAR)                            AS anonymous_id,
        CAST(NULL AS VARCHAR)                            AS device_id,
        CAST(1 AS INTEGER)                               AS silver_version,
        {payload}                                        AS payload
      FROM ({canon})
      WHERE event_id IS NOT NULL AND occurred_at_iso IS NOT NULL
        AND order_id_norm IS NOT NULL AND order_id_norm <> ''
    """

    n = merge_collector_event(con, TARGET, good)
    return TARGET, n


if __name__ == "__main__":
    run_normalize_job("silver-shiprocket-normalize", build,
                      target_table="silver_collector_event_shiprocket_shadow")
