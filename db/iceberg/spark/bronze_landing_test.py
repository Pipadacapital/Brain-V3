"""
bronze_landing_test.py — pure-python coverage for the unified landing's topic/connector wiring.

NO Spark needed (the Kafka readStream + projections + foreachBatch MERGE are the only Spark-touching
parts and are excluded here). The subscription set + topic→connector map is the contract this single
job lives or dies by — it must cover BOTH the collector/backfill lanes AND all nine raw lanes, and the
connector discriminator must be right (it drives the identity partition + every downstream WHERE filter).
Run:
    python3 db/iceberg/spark/bronze_landing_test.py
  or: python3 -m pytest db/iceberg/spark/bronze_landing_test.py -q
"""
import importlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _fresh(prefix="prod", topics_override=None):
    """Reload the module so module-level env-derived constants (TOPIC_ENV_PREFIX, TOPICS) re-evaluate."""
    os.environ["TOPIC_ENV_PREFIX"] = prefix
    if topics_override is None:
        os.environ.pop("TOPICS", None)
    else:
        os.environ["TOPICS"] = topics_override
    os.environ.pop("COLLECTOR_TOPIC", None)
    os.environ.pop("BACKFILL_TOPIC", None)
    import bronze_landing as m  # noqa: E402
    return importlib.reload(m)


def test_subscribes_collector_backfill_and_nine_raw_lanes():
    m = _fresh("prod")
    topics = m.all_topics()
    assert topics == [
        "prod.collector.event.v1",
        "prod.collector.order.backfill.v1",
        "prod.shopify.orders.raw.v1",
        "prod.woocommerce.orders.raw.v1",
        "prod.meta.spend.raw.v1",
        "prod.google.spend.raw.v1",
        "prod.ga4.rows.raw.v1",
        "prod.shiprocket.shipments.raw.v1",
        "prod.gokwik.events.raw.v1",
        "prod.shopflo.checkout.raw.v1",
        "prod.razorpay.settlement.raw.v1",
    ], topics
    assert len(topics) == 11  # 2 collector + 9 raw


def test_connector_discriminator_per_lane():
    m = _fresh("prod")
    assert m.connector_for("prod.collector.event.v1") == "collector"
    assert m.connector_for("prod.collector.order.backfill.v1") == "collector"
    assert m.connector_for("prod.shopify.orders.raw.v1") == "shopify"
    assert m.connector_for("prod.woocommerce.orders.raw.v1") == "woocommerce"
    assert m.connector_for("prod.meta.spend.raw.v1") == "meta"
    assert m.connector_for("prod.google.spend.raw.v1") == "google"
    assert m.connector_for("prod.ga4.rows.raw.v1") == "ga4"
    assert m.connector_for("prod.shiprocket.shipments.raw.v1") == "shiprocket"
    assert m.connector_for("prod.gokwik.events.raw.v1") == "gokwik"
    assert m.connector_for("prod.shopflo.checkout.raw.v1") == "shopflo"
    assert m.connector_for("prod.razorpay.settlement.raw.v1") == "razorpay"


def test_topic_to_connector_covers_every_subscribed_topic():
    m = _fresh("prod")
    tc = m.topic_to_connector()
    assert set(tc) == set(m.all_topics())
    # exactly one 'collector' plus nine distinct provider connectors
    assert sum(1 for v in tc.values() if v == "collector") == 2  # event + backfill both → collector
    providers = {v for v in tc.values() if v != "collector"}
    assert providers == {"shopify", "woocommerce", "meta", "google", "ga4", "shiprocket", "gokwik", "shopflo", "razorpay"}


def test_env_prefix_dev():
    m = _fresh("dev")
    assert m.connector_for("dev.shopify.orders.raw.v1") == "shopify"
    assert "dev.collector.event.v1" in m.all_topics()
    assert all(t.startswith("dev.") for t in m.all_topics())


def test_topics_env_override_wins():
    m = _fresh("prod", topics_override="prod.collector.event.v1, prod.shopify.orders.raw.v1")
    assert m.all_topics() == ["prod.collector.event.v1", "prod.shopify.orders.raw.v1"]


def test_unified_columns_are_the_merge_contract():
    m = _fresh("prod")
    # dedup_key + connector lead; payload + kafka coords + receipt clocks always present.
    assert m._COLUMNS[0] == "dedup_key" and m._COLUMNS[1] == "connector"
    for required in ("payload", "kafka_topic", "kafka_partition", "kafka_offset", "received_at", "written_at"):
        assert required in m._COLUMNS
    assert len(m._COLUMNS) == len(set(m._COLUMNS)), "duplicate column in the MERGE contract"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ok  {fn.__name__}")
    print(f"[bronze_landing_test] {len(fns)} passed")
