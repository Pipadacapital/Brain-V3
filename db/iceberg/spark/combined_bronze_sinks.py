"""
combined_bronze_sinks.py — ONE Spark driver that runs BOTH local Bronze streaming sinks together.

WHY THIS EXISTS: locally we previously ran two separate `docker run … spark-submit` containers —
`spark-bronze-sink` (the gated collector/pixel lane → brain_bronze.collector_events) and
`spark-bronze-raw-sink` (the 9-lane connector raw landing → brain_bronze.*_raw). Two JVMs means two
catalog/Kafka warm-ups and two memory budgets. This job fuses them into a SINGLE SparkSession that
constructs BOTH streaming queries and runs them concurrently via `spark.streams.awaitAnyTermination()`.

REUSE, NOT FORK: this module imports the two proven sink modules and calls their EXISTING
query-construction functions verbatim — `bronze_materialize.build_writer(spark)` for the collector lane
and `bronze_raw_landing.build_writer(spark, topics, routing)` for the raw lanes. The idempotent MERGE
logic, the R2/R3 admission gate, the offset-after-Iceberg-commit ordering, and the checkpoint-repair
self-heal all live in those modules and are NOT duplicated here. This file only:
  1. builds ONE SparkSession (the canonical Bronze factory, bronze_materialize.build_spark);
  2. ensures both lanes' tables exist + repairs the collector checkpoint;
  3. runs the two-phase cold-start startup for each lane (bounded availableNow drain → continuous);
  4. starts BOTH continuous queries and awaits any termination.

CHECKPOINT ISOLATION (critical): the two lanes MUST keep SEPARATE checkpoint paths or one would
clobber the other's committed offsets. The two modules already default to distinct paths
(`file:///tmp/bronze-spike-checkpoint` vs `file:///tmp/bronze-raw-landing-checkpoint`). We deliberately
do NOT export a single shared CHECKPOINT_LOCATION env (that would point BOTH at one path); instead we
override each module's `CHECKPOINT` global independently from COLLECTOR_CHECKPOINT_LOCATION /
RAW_CHECKPOINT_LOCATION (preserving the distinct defaults). Offset-after-commit + idempotent MERGE are
inherited unchanged, so this combined job preserves exactly-once-into-an-idempotent-sink + zero loss.

KAFKA BROKER: both lanes read the SAME broker. The launcher (tools/dev/dev-bronze-streaming.sh) joins
the broker's netns and exports KAFKA_BROKERS=localhost:9092 so both modules' import-time reads agree
(the modules' own defaults differ — redpanda:9092 vs localhost:9092 — so the launcher MUST set it).

────────────────────────────────────────────────────────────────────────────────────────────────────
⚠️  MEMORY BUDGET IS UNVERIFIED — DO NOT TRUST THE 2g TARGET WITHOUT A LIVE RUN  ⚠️
docs/ops/local-memory-budget.md sizes the two SEPARATE sinks at ~7g + ~6g mem_limit (4g driver heap
each), tuned for cold-start backlog drain. The launcher's STARTING-POINT flags here (driver 1g +
executor 1g + offHeap 256m ≈ a ~2g combined target) are an ASPIRATION, NOT a proven figure — fusing two
JVMs into one does not automatically halve the heap each lane needs, and the collector lane alone OOMed
at the default 1g during the 9,916-order Shopify backlog drain. The operator MUST live-run this and tune
the heap UP (SPARK_DRIVER_MEMORY / SPARK_EXECUTOR_MEMORY) if it OOMs (Java heap space) or lags. Treat 2g
as the floor to start measuring from, not a guarantee.
────────────────────────────────────────────────────────────────────────────────────────────────────

Run:    tools/dev/dev-bronze-streaming.sh   (host spark-submit launcher)
Verify: python3 -m py_compile db/iceberg/spark/combined_bronze_sinks.py
"""
from __future__ import annotations  # Spark image ships Python 3.8.

import os
import sys

# Sibling modules live next to this file (mounted at /opt/spike in the launcher). Put the script dir on
# sys.path on the DRIVER so `import bronze_materialize` / `import bronze_raw_landing` resolve. Their
# foreachBatch closures run inside the SAME driver process (local[*]), so no addPyFile is needed for them.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import bronze_materialize as collector  # noqa: E402 — after sys.path setup
import bronze_raw_landing as raw  # noqa: E402

# Per-lane checkpoint overrides — DEFAULT to each module's own distinct path (never collide). We override
# the module global (build_writer / repair_incomplete_checkpoint read it) so the two lanes stay isolated
# while still being independently tunable. We do NOT read a single CHECKPOINT_LOCATION here on purpose.
collector.CHECKPOINT = os.environ.get("COLLECTOR_CHECKPOINT_LOCATION", collector.CHECKPOINT)
raw.CHECKPOINT = os.environ.get("RAW_CHECKPOINT_LOCATION", raw.CHECKPOINT)

# TRIGGER_MODE governs the COMBINED job (the modules' own import-time TRIGGER_MODE is unused — we drive
# the triggers here). "continuous" (default) = two-phase startup then both long-lived streams together;
# "availableNow" = drain both lanes once and exit (CI / one-shot).
TRIGGER_MODE = os.environ.get("TRIGGER_MODE", "continuous")


def _setup(spark) -> "tuple[list, dict]":
    """Ensure both lanes' Iceberg tables exist + repair the collector checkpoint. Returns the raw lanes'
    (topics, routing) so the same routing map feeds the drain and the continuous query."""
    # Collector / pixel lane.
    collector.repair_incomplete_checkpoint(spark)
    collector.ensure_table(spark)
    # Connector raw lanes (all of LANES, or a single LANE if set).
    lanes = raw.active_lanes()
    routing = raw.topic_to_table(lanes)
    raw_topics = list(routing.keys())
    for target in routing.values():
        raw.ensure_table(spark, target)
    print(
        f"[combined-bronze] collector lane → {collector.TABLE}; "
        f"raw lanes ({len(raw_topics)}) → {list(routing.values())}",
        flush=True,
    )
    return raw_topics, routing


def _drain_collector(spark) -> None:
    """Phase 1 (collector): bounded availableNow drain of the backlog, then terminate. MANDATORY — the
    collector lane always has a backlog, and draining it in chunks avoids the cold-start giant-batch
    deadlock before the continuous query takes over on the SAME checkpoint."""
    print("[combined-bronze] phase 1 — draining collector backlog (availableNow, chunked)…", flush=True)
    drain = collector.build_writer(spark).trigger(availableNow=True).start()
    drain.awaitTermination()
    print("[combined-bronze] phase 1 — collector drain complete", flush=True)


def _drain_raw(spark, raw_topics: list, routing: dict) -> None:
    """Phase 1 (raw lanes): BEST-EFFORT drain. The connector lanes are routinely empty / partially
    populated on a cold start, which trips a known Trigger.AvailableNow partition-mismatch bug — so on
    ANY failure we fall through to phase 2. SAFE: phase 2 shares the SAME checkpoint and offsets commit
    only after the durable Iceberg append, so a skipped/partial drain loses nothing (mirrors raw.main)."""
    print("[combined-bronze] phase 1 — draining raw backlog (availableNow, chunked, best-effort)…", flush=True)
    try:
        rdrain = raw.build_writer(spark, raw_topics, routing).trigger(availableNow=True).start()
        rdrain.awaitTermination()
        print("[combined-bronze] phase 1 — raw drain complete", flush=True)
    except Exception as e:  # noqa: BLE001 — degrade to continuous; phase 2 drains via the shared checkpoint
        print(
            f"[combined-bronze] phase 1 — raw drain skipped ({type(e).__name__}: {e}); "
            "the continuous stream will drain the backlog in bounded batches",
            flush=True,
        )


def main() -> None:
    # ONE SparkSession for BOTH lanes — the canonical Bronze factory (catalog + Kafka offset-fetch config).
    spark = collector.build_spark()
    spark.sparkContext.setLogLevel("WARN")
    raw_topics, routing = _setup(spark)

    if TRIGGER_MODE == "continuous":
        # Two-phase startup per lane (the cold-start fix), then run BOTH continuous queries together.
        _drain_collector(spark)
        _drain_raw(spark, raw_topics, routing)

        print(
            f"[combined-bronze] phase 2 — starting BOTH continuous streams "
            f"(collector every {collector.PROCESSING_TIME}, raw every {raw.PROCESSING_TIME})…",
            flush=True,
        )
        collector.build_writer(spark).trigger(processingTime=collector.PROCESSING_TIME).start()
        raw.build_writer(spark, raw_topics, routing).trigger(processingTime=raw.PROCESSING_TIME).start()
        # Block on EITHER query terminating — a failure in one surfaces immediately (non-zero exit) so the
        # supervisor/operator restarts the combined sink rather than silently losing one lane.
        spark.streams.awaitAnyTermination()
    else:
        # One-shot: drain both lanes once and exit (CI / backfill catch-up). Collector drain is mandatory;
        # raw drain best-effort. Run them as two availableNow queries and await both.
        print("[combined-bronze] availableNow — draining both lanes once then exiting", flush=True)
        cq = collector.build_writer(spark).trigger(availableNow=True).start()
        try:
            rq = raw.build_writer(spark, raw_topics, routing).trigger(availableNow=True).start()
        except Exception as e:  # noqa: BLE001 — empty/partial raw lanes; collector still drains
            print(f"[combined-bronze] raw availableNow skipped ({type(e).__name__}: {e})", flush=True)
            rq = None
        cq.awaitTermination()
        if rq is not None:
            rq.awaitTermination()
        print(
            f"[combined-bronze] DONE — {collector.TABLE} has {spark.table(collector.TABLE).count()} rows",
            flush=True,
        )
        for target in routing.values():
            print(f"[combined-bronze] DONE — {target} has {spark.table(target).count()} rows", flush=True)


if __name__ == "__main__":
    main()
