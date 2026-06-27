"""
bronze_raw_landing_test.py — pure-python coverage for the raw-landing lane config + routing.

NO Spark needed (the Kafka readStream + foreachBatch MERGE are the only Spark-touching parts and are
excluded here — the lane→topic→table mapping is the contract this job lives or dies by, and it must stay
byte-identical to the retired Kafka Connect configs). Run:

    python3 db/iceberg/spark/bronze_raw_landing_test.py
  or: python3 -m pytest db/iceberg/spark/bronze_raw_landing_test.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bronze_raw_landing as m  # noqa: E402

# The lane → (topic suffix, *_raw table) map that the retired Kafka Connect sinks encoded
# (infra/kafka-connect/iceberg-bronze-*.json: `topics` minus the `prod.` prefix, and `iceberg.tables`
# minus the `brain_bronze.` namespace). This frozen expectation guards against a lane drifting.
EXPECTED = {
    "shopify_orders":       ("shopify.orders.raw.v1",       "shopify_orders_raw"),
    "woocommerce_orders":   ("woocommerce.orders.raw.v1",   "woocommerce_orders_raw"),
    "meta_spend":           ("meta.spend.raw.v1",           "meta_spend_raw"),
    "google_spend":         ("google.spend.raw.v1",         "google_spend_raw"),
    "ga4_rows":             ("ga4.rows.raw.v1",             "ga4_rows_raw"),
    "shiprocket_shipments": ("shiprocket.shipments.raw.v1", "shiprocket_shipments_raw"),
    "gokwik_events":        ("gokwik.events.raw.v1",        "gokwik_events_raw"),
    "shopflo_checkout":     ("shopflo.checkout.raw.v1",     "shopflo_checkout_raw"),
    "razorpay_settlement":  ("razorpay.settlement.raw.v1",  "razorpay_settlement_raw"),
}


def test_lane_table_is_exactly_the_nine_connector_lanes():
    assert m.LANES == EXPECTED, m.LANES
    assert len(m.LANES) == 9


def test_no_collector_pixel_lane_leaked_in():
    # The collector/pixel lane keeps its OWN gated Spark sink (bronze_materialize.py); it must NOT be
    # landed raw by this connector job.
    for suffix, table in m.LANES.values():
        assert "collector" not in suffix and "collector" not in table


def test_every_lane_is_a_raw_v1_topic_into_a_raw_table():
    for suffix, table in m.LANES.values():
        assert suffix.endswith(".raw.v1"), suffix
        assert table.endswith("_raw"), table


def test_topic_for_applies_env_prefix():
    assert m.topic_for("shopify.orders.raw.v1") == f"{m.TOPIC_ENV_PREFIX}.shopify.orders.raw.v1"


def test_fqtn_namespaces_the_table():
    assert m.fqtn("shopify_orders_raw") == f"{m.CATALOG}.{m.NAMESPACE}.shopify_orders_raw"


def test_active_lanes_defaults_to_all_nine():
    # Default (no LANE env) → every lane.
    assert m.active_lanes() == m.LANES


def test_topic_to_table_routing_is_unique_and_complete():
    routing = m.topic_to_table(m.LANES)
    assert len(routing) == 9
    # Every topic is distinct and maps to a distinct table (no two lanes collide).
    assert len(set(routing.keys())) == 9
    assert len(set(routing.values())) == 9
    # Spot-check one full mapping end to end.
    assert routing[f"{m.TOPIC_ENV_PREFIX}.shopify.orders.raw.v1"] == (
        f"{m.CATALOG}.{m.NAMESPACE}.shopify_orders_raw"
    )


def _run_all():
    fns = [g for n, g in sorted(globals().items()) if n.startswith("test_") and callable(g)]
    for fn in fns:
        fn()
        print(f"  ok  {fn.__name__}")
    print(f"\nOK — all {len(fns)} raw-landing lane-config/routing tests passed "
          f"(9 connector lanes, raw.v1→*_raw, env-prefix, fqtn, routing uniqueness).")


if __name__ == "__main__":
    _run_all()
