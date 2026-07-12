"""
gold_attribution_credit.py — Spark reimplementation of the attribution CREDIT LEDGER (Brain V4 Phase 2,
GROUP attribution, HIGH-RISK money math). Reproduces the @brain/attribution-writer + @brain/metric-engine
write pipeline EXACTLY as a Spark job: READ Iceberg brain_silver.silver_touchpoint (the per-touch journey
grain) + the recognized-revenue basis, COMPUTE the per-touch credit rows with byte/minor-unit-exact
largest-remainder apportionment, and WRITE Iceberg brain_gold.gold_attribution_credit via MERGE on the
PRIMARY KEY (brand_id, credit_id).

This is the load-bearing money mart of the attribution group — gold_marketing_attribution (a thin VIEW),
snap_attribution_credit (the daily snapshot) and the credit half of every downstream channel/campaign-ROAS
read derive from THIS ledger. It runs BESIDE the live TS-written StarRocks brain_gold.gold_attribution_credit
(dual-run, NON-BREAKING): repoints NO reader, changes NO dbt, touches NO app code.

NOTE: brain_gold.gold_attribution_credit has NO dbt SQL — it is written by the TypeScript reconcile job
(apps/core/.../attribution/internal/reconcile-attribution.ts driving AttributionCreditWriter). So the SoR
for the math is the TS, ported 1:1 in _attribution_math.py (verified against the metric-engine unit-test
vectors). This Spark job re-drives that SAME pipeline over the SAME Silver.

THE PIPELINE (folded from reconcile-attribution.ts, reproduced EXACTLY):
  RECOGNIZED BASIS  — orders whose revenue is recognized = event_type IN ('finalization',
                      'cod_delivery_confirmed') in the gold revenue ledger (RECOGNITION_EVENT_TYPES). One
                      row per order (the credit basis amount_minor + currency_code + brain_id + occurred_at).
  JOURNEY RESOLVE   — order.brain_id → the stitched journey's brain_anon_id via
                      silver_touchpoint.stitched_brain_id (earliest touch_seq). No brain_id / no stitched
                      journey → the order's realized revenue is UNATTRIBUTED (no rows — honest, never
                      fabricated). (Current local Silver has 0 stitched touchpoints → 0 credit rows, exactly
                      like the live empty StarRocks ledger — parity-exact dual-run.)
  PER-JOURNEY MODELS — for each of first_touch / last_touch / linear / position_based / time_decay: per-touch
                      weight units (closed-form, Σ==1e8) and apportion the order's realized revenue with the
                      SIGN-PRESERVING largest-remainder split (Σ credited == realized EXACTLY, zero drift).
  DATA-DRIVEN MODEL  — train the GLOBAL Markov removal-effect channel weights ONCE from the whole brand
                      journey corpus (silver_touchpoint), then apportion each recognized order's revenue
                      across its touches by those channel weights (computeTouchCreditsExplicit analogue).
  CONFIDENCE         — grade each journey once (strong/partial/weak → 1.000/0.700/0.400) and stamp it on
                      every row. credit_id = sha256(brand‖order‖anon‖touch_seq‖model‖'credit'‖v1) → replay
                      yields identical ids → idempotent MERGE.

CLAWBACK: the clawback rows (row_kind='clawback', signed-negative, SAVED weights) are produced by the TS
writer ON a realized reversal using the SAVED credit rows read back from the ledger. They depend on the
credit rows EXISTING first; with 0 credit rows there is nothing to claw back. The clawback fold is omitted
here (it would be a strict no-op on the current 0-credit ledger and is a follow-up once stitched journeys +
credit rows exist) — documented honestly rather than half-built.

MONEY (I-S07): credited_revenue_minor + realized_revenue_minor are SIGNED bigint MINOR units paired with
currency_code, per-currency (NEVER blended). brand_id is the tenant key, first column. weight_fraction is
the exact DECIMAL(9,8) string. Replay-safe: MERGE on (brand_id, credit_id) — ON-CONFLICT-keep semantics
(WHEN MATCHED keeps the saved credit; the deterministic id makes a re-run a no-op).

Run via run-gold-attribution.sh. The recognized basis is read DIRECTLY from the Iceberg
rest.brain_gold.gold_revenue_ledger (the SAME rest catalog this job already uses for silver_touchpoint and
writes the credit ledger into) — materialized by gold_revenue_ledger.py (run-gold-revenue.sh) which folds
the recognition chain from Iceberg Bronze. This is the Iceberg-sole-SoR read: NO StarRocks MySQL-wire JDBC,
NO brain_gold.* StarRocks reference. The revenue ledger MUST be materialized BEFORE this job runs (the
gold-tier refresh ordering guarantees gold_revenue_ledger precedes gold_attribution_credit).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402
from pyspark.sql.utils import AnalysisException  # noqa: E402

from iceberg_base import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # gold/ — for _gold_base
from _gold_base import gold_partition_filter  # noqa: E402
import _attribution_math as M  # noqa: E402

TABLE_NAME = "gold_attribution_credit"

# Recognized-revenue basis — the SAME event types reconcile-attribution.ts credits on (RECOGNITION_EVENT_TYPES).
RECOGNITION_EVENT_TYPES = ("finalization", "cod_delivery_confirmed")

# The recognized basis lives in the Iceberg gold revenue ledger (rest.brain_gold.gold_revenue_ledger),
# materialized by gold_revenue_ledger.py from Iceberg Bronze. Read it from the SAME rest catalog this job
# already uses — Iceberg-sole-SoR, no StarRocks MySQL-wire JDBC, no brain_gold.* StarRocks reference.
GOLD_REVENUE_LEDGER = f"{CATALOG}.{GOLD_NAMESPACE}.gold_revenue_ledger"

# SPEC:B — B.5.4 / AMD-13: attribution touchpoint-input SOURCE switch (DEFAULT OFF = silver_touchpoint).
# When ATTRIBUTION_SOURCE=journey the fold sources its per-touch input from the Journey-domain output
# (iceberg.brain_gold.journey_events, is_current + deterministic-only) INSTEAD of silver_touchpoint,
# projected into the EXACT silver_touchpoint column shape the fold already consumes. With the identity
# input held constant (journey.engine OFF at journey construction), journey_events.brain_id equals the
# legacy silver_touchpoint.stitched_brain_id per touch, so the projection is byte-identical and the credit
# ledger is unchanged — a refactor of the input plumbing, NOT a semantics change (AMD-13 R1). This env is
# the Spark-driver twin of the per-brand `journey.engine` flag the TS reconcile driver reads
# (apps/core/.../reconcile-attribution.ts). Anything but 'journey' → legacy silver_touchpoint (default OFF).
ATTRIBUTION_SOURCE_JOURNEY = "journey"
JOURNEY_EVENTS_TABLE = f"{CATALOG}.{GOLD_NAMESPACE}.journey_events"


def _attribution_source_is_journey() -> bool:
    """B.5.4 — read the ATTRIBUTION_SOURCE env (default OFF). Never raises → default legacy source."""
    return (os.environ.get("ATTRIBUTION_SOURCE") or "").strip().lower() == ATTRIBUTION_SOURCE_JOURNEY

# Column contract — db/starrocks/gold_attribution_credit.sql column order (the PK ledger). brand_id first.
_COLUMNS = """
          brand_id               string    NOT NULL,
          credit_id              string    NOT NULL,
          order_id               string,
          brain_anon_id          string,
          touch_seq              int,
          channel                string,
          campaign_id            string,
          model_id               string,
          row_kind               string,
          weight_fraction        string,
          credited_revenue_minor bigint,
          currency_code          string,
          reversed_of_credit_id  string,
          reversal_reason        string,
          realized_revenue_minor bigint,
          confidence_grade       string,
          attribution_confidence string,
          model_version          string,
          metric_snapshot_id     string,
          occurred_at            timestamp,
          economic_effective_at  timestamp,
          billing_posted_period  string,
          updated_at             timestamp
""".strip("\n")

# Spark schema for the computed credit rows (one row per touch per model).
_ROW_SCHEMA = (
    "brand_id string, credit_id string, order_id string, brain_anon_id string, touch_seq int, "
    "channel string, campaign_id string, model_id string, row_kind string, weight_fraction string, "
    "credited_revenue_minor bigint, currency_code string, reversed_of_credit_id string, "
    "reversal_reason string, realized_revenue_minor bigint, confidence_grade string, "
    "attribution_confidence string, model_version string, metric_snapshot_id string, "
    "occurred_at timestamp, economic_effective_at timestamp, billing_posted_period string"
)


def _read_silver_touchpoint(spark: SparkSession):
    fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
    try:
        df = spark.table(fqtn)
        df.schema
        return df
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            raise SystemExit(
                f"[gold_attribution_credit] REQUIRED Iceberg table {fqtn} is absent — build the Phase-1 "
                f"silver_touchpoint Spark mart first."
            )
        raise


def _read_journey_touchpoints(spark: SparkSession):
    """SPEC:B — B.5.4: the Journey-domain touchpoint input, projected into the silver_touchpoint column
    shape the attribution fold consumes. Reads iceberg.brain_gold.journey_events WHERE is_current (exactly
    one live version per touchpoint) AND identity_basis='deterministic' (§1.4 / invariant 5 — the canonical
    ledger is deterministic-only, so ZERO probabilistic rows ever reach attribution/revenue).

    Byte-identical mapping (identity held constant → journey.engine OFF at construction):
      - brain_anon_id / touch_seq  ← recovered from source_event_ref (brand_id||brain_anon_id||touch_seq).
      - channel                    ← journey_events.channel (verbatim).
      - utm_campaign               ← journey_events.campaign (a straight passthrough of the touch utm_campaign).
      - utm_medium/fbclid/gclid/ttclid ← the attribution_signals map (empty/NULL entries were dropped by the
        build map_filter → a missing key reads NULL, which the fold's is_deterministic_channel treats the
        SAME as silver's empty string — only the boolean signal matters, these are never stored in a credit row).
      - stitched_brain_id          ← the resolved brain_id, with the 'anonymous_<anon>' placeholder mapped
        back to NULL (unstitched). With journey.engine OFF the resolved brain_id == the legacy stitched_brain_id."""
    try:
        spark.table(JOURNEY_EVENTS_TABLE).schema  # probe — raises if the table doesn't exist yet
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            raise SystemExit(
                f"[gold_attribution_credit] ATTRIBUTION_SOURCE=journey but the required Iceberg table "
                f"{JOURNEY_EVENTS_TABLE} is absent — build the Wave-B journey ledger first "
                f"(run-gold-journey-events.sh)."
            )
        raise
    return spark.sql(
        f"""
        SELECT
            brand_id,
            split(source_event_ref, '[|][|]')[1]              AS brain_anon_id,
            cast(split(source_event_ref, '[|][|]')[2] AS int) AS touch_seq,
            channel                                            AS channel,
            campaign                                           AS utm_campaign,
            attribution_signals['utm_medium']                  AS utm_medium,
            attribution_signals['fbclid']                      AS fbclid,
            attribution_signals['gclid']                       AS gclid,
            attribution_signals['ttclid']                      AS ttclid,
            CASE WHEN substr(brain_id, 1, 10) = 'anonymous_' THEN NULL ELSE brain_id END AS stitched_brain_id
        FROM {JOURNEY_EVENTS_TABLE}
        WHERE is_current = true AND identity_basis = 'deterministic'
        """
    )


def _read_touchpoints(spark: SparkSession):
    """SPEC:B — B.5.4: the attribution touchpoint input from the flag-selected source (DEFAULT OFF =
    silver_touchpoint, byte-identical pre-wave). Returns (df, source_tables); source_tables drives the
    partition-incremental watermark. Both branches expose the SAME columns the fold's tp.select() reads,
    so materialize() is unchanged downstream."""
    if _attribution_source_is_journey():
        print(
            "[gold_attribution_credit] ATTRIBUTION_SOURCE=journey → touchpoint input = journey_events "
            "(is_current, deterministic-only) [B.5.4]",
            flush=True,
        )
        return _read_journey_touchpoints(spark), ["journey_events", "gold_revenue_ledger"]
    return _read_silver_touchpoint(spark), ["silver_touchpoint", "gold_revenue_ledger"]


def _read_recognized_basis(spark: SparkSession):
    """Recognized orders (the credit basis) from the ICEBERG gold revenue ledger. One row per order_id.

    Reads rest.brain_gold.gold_revenue_ledger (the SAME rest catalog this job uses for silver_touchpoint
    and the credit ledger) — NOT the StarRocks copy. Filters to the recognition event types and collapses
    to ONE basis row per (brand_id, order_id) — deterministic earliest occurred_at — matching the TS
    per-order credit (each order is credited once). amount_minor is the signed realized basis; brain_id
    resolves the journey. If the Iceberg ledger is absent (revenue group hasn't run) → None → 0 credit rows.
    """
    in_list = ", ".join(f"'{t}'" for t in RECOGNITION_EVENT_TYPES)
    try:
        spark.table(GOLD_REVENUE_LEDGER).schema  # probe — raises if the table doesn't exist yet
    except Exception as exc:  # noqa: BLE001 — ledger absent → no recognized basis → 0 credit rows
        print(
            f"[gold_attribution_credit] Iceberg {GOLD_REVENUE_LEDGER} unavailable ({exc}); 0 recognized orders",
            flush=True,
        )
        return None
    # One basis row per order: earliest occurred_at wins (deterministic, idempotent). cast amount_minor to
    # SIGNED bigint (it already is in the Iceberg contract) and keep brand_id (tenant key) + currency_code.
    return spark.sql(
        f"""
        with recognized as (
            select brand_id, order_id, brain_id,
                   cast(amount_minor as bigint) as amount_minor, currency_code, occurred_at,
                   row_number() over (
                       partition by brand_id, order_id
                       order by occurred_at asc, event_type asc
                   ) as _rn
            from {GOLD_REVENUE_LEDGER}
            where event_type in ({in_list})
        )
        select brand_id, order_id, brain_id, amount_minor, currency_code, occurred_at
        from recognized
        where _rn = 1
        """
    )


def _billing_period(occurred_at) -> str:
    """toBillingPostedPeriod — 'YYYY-MM' (UTC) from the conversion event-time."""
    return f"{occurred_at.year:04d}-{occurred_at.month:02d}"


def _touch_dict(r):
    """Project a silver_touchpoint Row into the confidence/credit touch dict (TS CreditTouch shape)."""
    return {
        "touch_seq": int(r["touch_seq"]),
        "channel": r["channel"],
        "campaign_id": r["utm_campaign"],
        "utm_medium": r["utm_medium"],
        "fbclid": r["fbclid"],
        "gclid": r["gclid"],
        "ttclid": r["ttclid"],
        "stitched_brain_id": r["stitched_brain_id"],
    }


def _compute_brand_rows(brand_id, touches_by_anon, brain_to_anon, recognized, channel_weights):
    """Reproduce reconcile-attribution.ts for ONE brand: per-model credit rows over recognized orders.

    touches_by_anon : dict brain_anon_id -> ordered list[touch dict] (touch_seq ASC).
    brain_to_anon   : dict stitched_brain_id -> brain_anon_id (earliest touch — resolveBrainAnonId).
    recognized      : list of order dicts (order_id, brain_id, amount_minor, currency_code, occurred_at).
    channel_weights : dict channel -> 1e8 weight units (the brand's Markov global weights; {} if no corpus).
    """
    rows = []
    models = list(M.PER_JOURNEY_MODEL_IDS)
    has_dd = len(channel_weights) > 0
    for order in recognized:
        brain_id = order["brain_id"]
        if not brain_id:
            continue  # unattributed (no journey key)
        anon = brain_to_anon.get(brain_id)
        if not anon:
            continue  # no stitched journey → unattributed (honest)
        touches = touches_by_anon.get(anon)
        if not touches:
            continue
        stitched = any(t["stitched_brain_id"] is not None for t in touches)
        signals = [M.is_deterministic_channel(t) for t in touches]
        grade, confidence = M.grade_journey_confidence(stitched, signals)
        realized = int(order["amount_minor"])
        period = _billing_period(order["occurred_at"])
        n = len(touches)

        # ── the per-journey closed-form models (PER_JOURNEY_MODEL_IDS, incl. time_decay) ──
        for model in models:
            wunits = M.compute_weight_units(model, n)
            credited = M.apportion_minor(wunits, realized)
            for i, t in enumerate(touches):
                rows.append((
                    brand_id,
                    M.compute_credit_id(brand_id, order["order_id"], anon, t["touch_seq"], model),
                    order["order_id"], anon, t["touch_seq"], t["channel"], t["campaign_id"],
                    model, "credit", M.weight_fraction_string(wunits[i]),
                    credited[i], order["currency_code"], None, None, realized,
                    grade, confidence, M.ATTRIBUTION_MODEL_VERSION, None,
                    order["occurred_at"], order["occurred_at"], period,
                ))

        # ── the GLOBAL data-driven (Markov) model ──
        if has_dd:
            dd_units = M.data_driven_touch_weight_units([t["channel"] for t in touches], channel_weights)
            dd_credited = M.apportion_minor(dd_units, realized)
            for i, t in enumerate(touches):
                rows.append((
                    brand_id,
                    M.compute_credit_id(brand_id, order["order_id"], anon, t["touch_seq"], "data_driven"),
                    order["order_id"], anon, t["touch_seq"], t["channel"], t["campaign_id"],
                    "data_driven", "credit", M.weight_fraction_string(dd_units[i]),
                    dd_credited[i], order["currency_code"], None, None, realized,
                    grade, confidence, M.ATTRIBUTION_MODEL_VERSION, None,
                    order["occurred_at"], order["occurred_at"], period,
                ))
    return rows


def _supersede_refolded_credits(spark: SparkSession, fqtn: str, src) -> int:
    """AUD-IMPL-013 — SUPERSEDE-ON-REFOLD: keep the per-(order, model) credit set CLOSED-SUM when an
    already-attributed order is re-folded with a DIFFERENT journey shape.

    THE DEFECT: the credit MERGE is insert-only on the deterministic credit_id =
    sha256(brand‖order‖anon‖touch_seq‖model). If an order's journey MUTATED since it was credited (a
    stitch-v2 lift added day-1..6 touches, or an identity merge changed the earliest-touch anon), the
    re-fold emits NEW credit_ids (new touch_seqs / new anon) with weights over the NEW touch set, while
    the OLD rows keep weights over the OLD set → for that (brand, order, model)
    Σ weight_fraction ≠ 1 and Σ credited_revenue_minor ≠ realized. A changed anon even duplicates the
    entire credit set.

    THE FIX: this run's fold is AUTHORITATIVE for every (brand_id, order_id, model_id) group it emits —
    before the insert MERGE, DELETE the target's 'credit' rows in exactly those groups whose credit_id is
    NOT in the fresh set (deterministic ids: an unchanged journey reproduces identical ids → deletes
    nothing → byte-identical replay). SCOPED to the emitted groups only: an order absent from this fold
    (not re-folded, or its journey no longer resolves) keeps its saved rows — stale-but-consistent, never
    half-mutated.

    LEDGER HONESTY: a credit row referenced by a clawback (reversed_of_credit_id) is NEVER deleted —
    deleting it would orphan the economic reversal; the clawed pair already nets to zero. Same MERGE-
    DELETE-with-target-derived-source pattern as gold_journey_events_reversion (persist pins the
    pre-delete snapshot)."""
    try:
        tgt = spark.table(fqtn)
    except Exception:  # noqa: BLE001 — first run, table just created → nothing to supersede
        return 0
    staged_groups = src.select("brand_id", "order_id", "model_id").distinct()
    staged_ids = src.select("brand_id", "credit_id").distinct()
    clawed = (
        tgt.where(F.col("reversed_of_credit_id").isNotNull())
        .select("brand_id", F.col("reversed_of_credit_id").alias("credit_id"))
        .distinct()
    )
    stale = (
        tgt.where(F.col("row_kind") == F.lit("credit"))
        .join(staged_groups, ["brand_id", "order_id", "model_id"], "left_semi")
        .join(staged_ids, ["brand_id", "credit_id"], "left_anti")
        .join(clawed, ["brand_id", "credit_id"], "left_anti")
        .select("brand_id", "credit_id")
    )
    stale.persist()  # pin the pre-delete snapshot (the DELETE below must not re-evaluate this plan)
    n_stale = stale.count()
    if n_stale > 0:
        stale.createOrReplaceTempView("_superseded_credit_ids")
        spark.sql(
            f"""
            MERGE INTO {fqtn} t
            USING _superseded_credit_ids s
            ON t.brand_id = s.brand_id AND t.credit_id = s.credit_id
            WHEN MATCHED THEN DELETE
            """
        )
        print(
            f"[gold_attribution_credit] superseded {n_stale} stale credit row(s) from re-folded "
            f"(order, model) groups [AUD-IMPL-013]",
            flush=True,
        )
    stale.unpersist()
    return n_stale


def materialize(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark, GOLD_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(8, brand_id)"
    )

    tp, source_tables = _read_touchpoints(spark)  # SPEC:B — B.5.4 flag-selected touchpoint source
    tp, _commit_wm = gold_partition_filter(
        spark, tp, table_name=TABLE_NAME, source_tables=source_tables,
    )
    basis_df = _read_recognized_basis(spark)

    if basis_df is None:
        print("[gold_attribution_credit] no recognized basis → 0 credit rows (no-op MERGE)", flush=True)
        total = spark.table(fqtn).count()
        print(f"[gold_attribution_credit] table now {total} rows", flush=True)
        _commit_wm()
        return fqtn

    # Collect to the driver — the journey grain is tiny (touches + recognized orders per brand). The
    # apportionment is a deterministic single-threaded loop (matches the TS per-order writer exactly).
    tp_rows = (
        tp.select(
            "brand_id", "brain_anon_id", "touch_seq", "channel", "utm_campaign", "utm_medium",
            "fbclid", "gclid", "ttclid", "stitched_brain_id",
        )
        .orderBy("brand_id", "brain_anon_id", "touch_seq")
        .collect()
    )
    basis_rows = basis_df.collect()

    # Group touches by (brand, anon), build the brain_id→anon resolver (earliest touch), and the corpus.
    by_brand_touches = {}      # brand -> {anon -> [touch dict, ...]}
    by_brand_brain = {}        # brand -> {stitched_brain_id -> anon}
    by_brand_corpus = {}       # brand -> [(channels, converted)]
    corpus_seen = {}           # brand -> {anon -> [channels], converted}
    for r in tp_rows:
        b = r["brand_id"]
        anon = r["brain_anon_id"]
        td = _touch_dict(r)
        by_brand_touches.setdefault(b, {}).setdefault(anon, []).append(td)
        if td["stitched_brain_id"] is not None:
            # earliest touch wins (rows already ordered by touch_seq ASC) → setdefault keeps first.
            by_brand_brain.setdefault(b, {}).setdefault(td["stitched_brain_id"], anon)
        cb = corpus_seen.setdefault(b, {})
        ce = cb.setdefault(anon, {"channels": [], "converted": False})
        if r["channel"]:
            ce["channels"].append(r["channel"])
        if r["stitched_brain_id"] is not None:
            ce["converted"] = True

    for b, anons in corpus_seen.items():
        by_brand_corpus[b] = [(e["channels"], e["converted"]) for e in anons.values()]

    by_brand_recognized = {}
    for r in basis_rows:
        by_brand_recognized.setdefault(r["brand_id"], []).append({
            "order_id": r["order_id"],
            "brain_id": r["brain_id"],
            "amount_minor": r["amount_minor"],
            "currency_code": r["currency_code"],
            "occurred_at": r["occurred_at"],
        })

    all_rows = []
    for b, recognized in by_brand_recognized.items():
        touches_by_anon = by_brand_touches.get(b, {})
        brain_to_anon = by_brand_brain.get(b, {})
        channel_weights = M.compute_markov_channel_weights(by_brand_corpus.get(b, []))
        all_rows.extend(
            _compute_brand_rows(b, touches_by_anon, brain_to_anon, recognized, channel_weights)
        )

    print(
        f"[gold_attribution_credit] recognized orders={len(basis_rows)}, brands={len(by_brand_recognized)}, "
        f"stitched-brain keys={sum(len(v) for v in by_brand_brain.values())}, computed credit rows={len(all_rows)}",
        flush=True,
    )

    if not all_rows:
        print("[gold_attribution_credit] 0 credit rows (no stitched journeys for recognized orders) — no-op", flush=True)
        total = spark.table(fqtn).count()
        print(f"[gold_attribution_credit] table now {total} rows", flush=True)
        _commit_wm()
        return fqtn

    src = spark.createDataFrame(all_rows, schema=_ROW_SCHEMA)
    src.createOrReplaceTempView("attribution_credit_src")

    _supersede_refolded_credits(spark, fqtn, src)

    # Idempotent MERGE on the PK (brand_id, credit_id). ON-CONFLICT-keep: WHEN MATCHED preserves the saved
    # credit (the deterministic id makes a re-run a no-op); WHEN NOT MATCHED inserts the new credit.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING attribution_credit_src s
        ON t.brand_id = s.brand_id AND t.credit_id = s.credit_id
        WHEN NOT MATCHED THEN INSERT (
          brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, campaign_id,
          model_id, row_kind, weight_fraction, credited_revenue_minor, currency_code,
          reversed_of_credit_id, reversal_reason, realized_revenue_minor,
          confidence_grade, attribution_confidence, model_version, metric_snapshot_id,
          occurred_at, economic_effective_at, billing_posted_period, updated_at
        ) VALUES (
          s.brand_id, s.credit_id, s.order_id, s.brain_anon_id, s.touch_seq, s.channel, s.campaign_id,
          s.model_id, s.row_kind, s.weight_fraction, s.credited_revenue_minor, s.currency_code,
          s.reversed_of_credit_id, s.reversal_reason, s.realized_revenue_minor,
          s.confidence_grade, s.attribution_confidence, s.model_version, s.metric_snapshot_id,
          s.occurred_at, s.economic_effective_at, s.billing_posted_period, current_timestamp()
        )
        """
    )
    total = spark.table(fqtn).count()
    print(f"[gold_attribution_credit] MERGE complete → {fqtn} has {total} rows", flush=True)
    _commit_wm()
    return fqtn


def main() -> None:
    spark = build_spark("gold-attribution-credit")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[gold_attribution_credit] DONE — Iceberg attribution credit ledger populated (dual-run) ✓", flush=True)


if __name__ == "__main__":
    main()
