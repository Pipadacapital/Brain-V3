#!/usr/bin/env python3
"""seed_bronze_fixture.py — DETERMINISTIC minimal Bronze fixture for the integration live-suite (CI)
and local dev. Writes straight to the Iceberg Bronze table via DuckDB — NO Kafka, NO Kafka Connect.

WHY DIRECT-TO-ICEBERG (not Kafka → Connect → Iceberg like the old seed-bronze.mjs):
  The DuckDB transform tier reads brain_bronze.collector_events_connect (ADR-0010). On a COLD catalog
  with no events the keystone silver_collector_event has nothing to read → it never creates
  brain_silver → every downstream Silver/Gold job fails ("Namespace brain_silver does not exist").
  The old seed produced 6 events to Kafka and waited for the iceberg-sink Connect worker to commit
  them — but on a single-broker cold start the sink's commit coordination churns and completes
  "committed to 0 table(s)" (control-topic coordinator flap under many connectors), so Bronze never
  lands within the poll window and the whole live suite fails. The seed's ONLY job is to give the
  transform some Bronze rows; it does NOT need to exercise the real Connect landing path (that is
  covered by the stream-worker Kafka e2e). Writing the fixture straight to the table makes the medallion
  seed DETERMINISTIC — the same DuckDB→Iceberg write path the transform jobs already use.

WHAT: appends realistic `order.live.v1` collector envelopes (the exact payload shape the old
  seed-bronze.mjs and live-order-bronze-wiring.e2e.test.ts use) as VERBATIM `payload` JSON strings +
  the kafka coordinate columns the iceberg-sink connector would have added — so the table is
  schema-identical to a Connect-landed one and the keystone's json_extract_string(payload, …) lift
  works unchanged.

CONNECTION: reuses _catalog.connect() (DuckDB attached to the Iceberg REST catalog) via
  _maintenance_base.duckdb_connect() — same env contract as the transform/maintenance tier
  (S3_ENDPOINT / ICEBERG_REST_URI / ICEBERG_WAREHOUSE / AWS_* — see _maintenance_base.py header).

Usage (from repo root, with the DuckDB venv that carries duckdb + pyiceberg):
  S3_ENDPOINT=http://localhost:9000 ICEBERG_REST_URI=http://localhost:8181 \
  ICEBERG_WAREHOUSE=s3://brain-bronze/ AWS_ACCESS_KEY_ID=brain AWS_SECRET_ACCESS_KEY=brainbrain \
  AWS_REGION=us-east-1 /tmp/duckvenv/bin/python db/iceberg/duckdb/maintenance/seed_bronze_fixture.py
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone

# Same sys.path bootstrap as maintenance_capability_probe.py: this dir (for _maintenance_base) + the
# parent dir (for _catalog.py, the DuckDB attach seam one directory up).
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))

import _maintenance_base as mb  # noqa: E402  (after the sys.path bootstrap above)

BRONZE_NS = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
SILVER_NS = os.environ.get("SILVER_NAMESPACE", "brain_silver")
GOLD_NS = os.environ.get("GOLD_NAMESPACE", "brain_gold")
CONNECT_TABLE = os.environ.get("COLLECTOR_CONNECT_TABLE", "collector_events_connect")
COLLECTOR_TOPIC = os.environ.get("COLLECTOR_TOPIC", "prod.collector.event.v1")

# Two stable test brands (deterministic UUIDs) — mirror seed-bronze.mjs so the order spine
# (silver_order_state) + revenue ledger get real, non-trivial rows.
BRANDS = ["0a000001-0000-4000-8000-000000000001", "b9f10030-0030-4030-8030-0000000000b2"]
AMOUNTS_MINOR = [729700, 149900, 259900]  # paise; a prepaid + cod mix per brand


def _order_envelope(brand_id: str, amount_minor: int, payment_method: str) -> dict:
    """Realistic post-mapper Shopify live order — mirrors orderEnvelope() in seed-bronze.mjs."""
    order_id = str(7_600_000_000_000 + (uuid.uuid4().int % 1_000_000))
    now = datetime.now(timezone.utc).isoformat()
    return {
        "schema_version": "1",
        "event_id": str(uuid.uuid4()),  # brand+event_id is the Silver dedup key — unique per event
        "brand_id": brand_id,
        "correlation_id": f"seed:{uuid.uuid4()}",
        "event_name": "order.live.v1",
        "occurred_at": now,
        "ingested_at": now,
        "properties": {
            "source": "shopify",
            "shopify_order_id": order_id,
            "order_id": order_id,
            "amount_minor": str(amount_minor),
            "currency_code": "INR",
            "payment_method": payment_method,
            "financial_status": "pending" if payment_method == "cod" else "paid",
            "fulfillment_status": None,
            "cancelled_at": None,
            "storefront_customer_id": str(10_000_000_000_000 + (uuid.uuid4().int % 1_000_000)),
        },
    }


def main() -> int:
    # Create the medallion NAMESPACES first, via PyIceberg — a cold catalog has NO namespaces, and
    # nothing creates them: the iceberg-sink Connect worker and the DuckDB transform's ensure_table
    # both CREATE TABLE but NOT the namespace, and iceberg-catalog-init only chowns the volume. So the
    # keystone's CREATE TABLE brain_silver.* binder-errors ("Schema brain_silver does not exist") on a
    # cold catalog. Bootstrapping all three here (the cold-start entry point) lets the whole refresh
    # cascade build. Done BEFORE the first duckdb_connect() so the DuckDB attach snapshots them.
    cat = mb.pyiceberg_catalog()
    for ns in (BRONZE_NS, SILVER_NS, GOLD_NS):
        cat.create_namespace_if_not_exists(ns)

    con = mb.duckdb_connect()
    fq = mb.fqtn(BRONZE_NS, CONNECT_TABLE)

    # Schema-identical to a Connect-landed collector_events_connect: VERBATIM payload JSON + kafka
    # coords (the iceberg-sink HoistField/InsertField output). All nullable to match the connector's
    # schema-force-optional posture, so a later real Connect commit evolves cleanly onto the same table.
    con.execute(
        f"""CREATE TABLE IF NOT EXISTS {fq} (
              payload         VARCHAR,
              kafka_topic     VARCHAR,
              kafka_partition INTEGER,
              kafka_offset    BIGINT,
              kafka_timestamp TIMESTAMP
            );"""
    )

    now = datetime.now(timezone.utc)
    rows = []
    offset = 0
    for brand_id in BRANDS:
        for i, amount in enumerate(AMOUNTS_MINOR):
            env = _order_envelope(brand_id, amount, "cod" if i == 0 else "prepaid")
            rows.append((json.dumps(env), COLLECTOR_TOPIC, 0, offset, now))
            offset += 1

    con.executemany(
        f"INSERT INTO {fq} (payload, kafka_topic, kafka_partition, kafka_offset, kafka_timestamp) "
        f"VALUES (?, ?, ?, ?, ?);",
        rows,
    )

    total = con.execute(f"SELECT count(*) FROM {fq};").fetchone()[0]
    print(
        f"✓ Bronze fixture seeded: appended {len(rows)} order.live.v1 rows to "
        f"{BRONZE_NS}.{CONNECT_TABLE} ({len(BRANDS)} brands); table now has {total} row(s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
