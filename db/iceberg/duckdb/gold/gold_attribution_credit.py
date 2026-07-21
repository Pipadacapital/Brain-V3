"""
gold_attribution_credit.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_attribution_credit.py.

The load-bearing MONEY mart of the attribution group — the per-touch CREDIT LEDGER. Reproduces the
@brain/attribution-writer + @brain/metric-engine write pipeline EXACTLY as a DuckDB job: READ the Iceberg
brain_silver.silver_touchpoint (per-touch journey grain) + the recognized-revenue basis from the Iceberg
brain_gold.gold_revenue_ledger, COMPUTE the per-touch credit rows with byte/minor-unit-exact
largest-remainder apportionment, and WRITE brain_gold.gold_attribution_credit via MERGE on the PRIMARY KEY
(brand_id, credit_id).

THE ALGORITHM IS UNCHANGED (migration-plan mandate): the attribution math — every closed-form model, the
data-driven GLOBAL Markov removal-effect solve, the confidence grader, the deterministic credit_id, and the
SIGN-PRESERVING largest-remainder money apportionment — is the VENDORED pure module _attribution_math.py
(a BYTE copy of the Spark-tree _attribution_math.py, itself the 1:1 port of the TS metric-engine). This port
does NOT rewrite one line of that math: DuckDB reads the journey corpus + recognized orders, the SAME pure
Python functions do the solve in a deterministic single-threaded driver loop (identical to the Spark
driver-collect loop), and DuckDB writes the credit rows. The Markov solve is pure-Python float lists
(power iteration) confined to the weight vector, quantized to 1e8 integer units BEFORE any money is touched
— numpy is available (requirements.txt) but the vendored solve needs none; the arithmetic is Python int
(arbitrary precision) end-to-end, never a float on the money path (I-S07).

THE PIPELINE (folded from reconcile-attribution.ts, reproduced EXACTLY — same as the Spark job):
  RECOGNIZED BASIS  — orders whose revenue is recognized = event_type IN ('finalization',
                      'cod_delivery_confirmed') in the gold revenue ledger (RECOGNITION_EVENT_TYPES). One
                      basis row per (brand_id, order_id) — deterministic earliest occurred_at.
  JOURNEY RESOLVE   — order.brain_id → the stitched journey's brain_anon_id via
                      silver_touchpoint.stitched_brain_id (earliest touch_seq). No brain_id / no stitched
                      journey → the order's realized revenue is UNATTRIBUTED (no rows — honest, never
                      fabricated). DETERMINISTIC-only: stitched_brain_id is the deterministic cart-stitch
                      read-back, never a probabilistic identity link.
  PER-JOURNEY MODELS — first_touch / last_touch / linear / position_based / time_decay: per-touch weight
                      units (closed-form, Σ==1e8) apportioned SIGN-PRESERVING largest-remainder (Σ credited
                      == realized EXACTLY, zero drift).
  DATA-DRIVEN MODEL  — train the GLOBAL Markov removal-effect channel weights ONCE from the whole brand
                      journey corpus (silver_touchpoint), then apportion each recognized order's revenue
                      across its touches by those channel weights.
  CONFIDENCE         — grade each journey once (strong/partial/weak → 1.000/0.700/0.400), stamped on every
                      row. credit_id = sha256(brand‖order‖anon‖touch_seq‖model‖'credit'‖v1) → replay yields
                      identical ids → idempotent MERGE.

CLAWBACK (OMITTED, same as Spark): the clawback rows (row_kind='clawback') depend on saved credit rows
  existing first; with 0 credit rows there is nothing to claw back — a strict no-op on the current ledger,
  documented honestly rather than half-built (a follow-up once stitched journeys + credit rows exist).

HONEST-EMPTY on this corpus: the current local Silver has 0 stitched touchpoints (anon∩order=0), so the
  journey-resolve step attributes ZERO orders → 0 credit rows, EXACTLY like the empty Spark/StarRocks
  ledger. The full attribution logic is nevertheless ported so it produces correct, closed-sum credit rows
  the moment stitched journeys land. Parity target: brain_gold.gold_attribution_credit (0 rows) → 0=0 PASS.

MONEY (I-S07): credited_revenue_minor + realized_revenue_minor are SIGNED bigint MINOR units paired with
  currency_code, per-currency (NEVER blended, NEVER a float). brand_id is the tenant key, first column.
  weight_fraction is the exact DECIMAL(9,8) string. Σ credited over a (brand, order, model) group ==
  realized EXACTLY (largest-remainder closure in _attribution_math.apportion_minor).

PK / GRAIN: exactly one row per (brand_id, credit_id) — matches the Spark mart PK EXACTLY. Idempotent MERGE
  ON-CONFLICT-KEEP (WHEN MATCHED keeps the saved credit; the deterministic id makes a re-run a no-op).

RECOGNIZED-BASIS SOURCE: read from the PLAIN gold_revenue_ledger (NO MIGRATION_TABLE_SUFFIX) — the Spark
  job reads the sibling live ledger, not a suffixed target; a job's suffix applies ONLY to its OWN write
  target. Override with ATTRIBUTION_BASIS_SUFFIX if a parallel-run wants the suffixed DuckDB ledger.

CAVEATS vs the Spark job (all parity-preserving):
  - NO quarantine side-write to reproduce — this Gold mart has none (reads already-gated Silver/Gold).
  - FULL recompute over the corpus every run (the Spark gold_partition_filter incremental path is a perf
    optimisation whose end-state is byte-identical to a full recompute; the MERGE on the PK is idempotent).
  - SUPERSEDE-ON-REFOLD (AUD-IMPL-013) is reproduced: before the insert MERGE, DELETE the target's 'credit'
    rows in exactly the (brand_id, order_id, model_id) groups this run emits whose credit_id is NOT in the
    fresh set (unchanged journey → identical ids → deletes nothing → byte-identical replay), NEVER deleting
    a row a clawback references (reversed_of_credit_id). SCOPED to emitted groups only.
  - ATTRIBUTION_SOURCE=journey (B.5.4) touchpoint-input switch is a Spark-driver twin of the per-brand
    journey.engine flag; the journey_events source is a Spark-tree Gold mart not (yet) in the DuckDB tree,
    so this port supports ONLY the DEFAULT legacy source (silver_touchpoint). Setting ATTRIBUTION_SOURCE=
    journey raises (honest, not a silent fallback) — documented, byte-identical default behavior otherwise.
"""
from __future__ import annotations

import os
import sys

# The pure attribution math is VENDORED into duckdb/gold/ (a byte copy of the Spark-tree _attribution_math.py
# the Spark job imports) so the DuckDB tree is self-contained and the EXECUTED money math IS the unit-tested
# one — byte-identical to Spark. numpy (requirements.txt) backs the tier; the vendored Markov solve is pure
# Python and needs none, but the pin is honored so the solve runs identically wherever the tier runs.
_HERE = os.path.dirname(os.path.abspath(__file__))
_DUCKDB_ROOT = os.path.dirname(_HERE)              # db/iceberg/duckdb
sys.path.insert(0, _DUCKDB_ROOT)
sys.path.insert(0, _HERE)                          # duckdb/gold — for the vendored pure module

from _base import ensure_table, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402
import _attribution_math as M  # noqa: E402 — vendored pure module (byte copy of the Spark-tree module)

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_attribution_credit_duckdb_test beside the
# Spark-produced live mart (parallel run → compare → cut over). Empty in production. Applies ONLY to the
# WRITE target — the recognized basis is read from the plain (live/Spark) revenue ledger unless overridden.
_SUFFIX = os.environ.get("MIGRATION_TABLE_SUFFIX", "")
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_attribution_credit{_SUFFIX}"

# Recognized-revenue basis — the SAME event types reconcile-attribution.ts credits on. Read from the sibling
# gold revenue ledger (plain name by default — the Spark job reads the live ledger, not a suffixed target).
RECOGNITION_EVENT_TYPES = ("finalization", "cod_delivery_confirmed")
_BASIS_SUFFIX = os.environ.get("ATTRIBUTION_BASIS_SUFFIX", "")
GOLD_REVENUE_LEDGER = f"{CATALOG}.{GOLD_NAMESPACE}.gold_revenue_ledger{_BASIS_SUFFIX}"
SILVER_TOUCHPOINT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"

# B.5.4 — attribution touchpoint-input source switch. DEFAULT OFF (= silver_touchpoint, byte-identical
# pre-wave). The journey_events source is a Spark-tree Gold mart not present in the DuckDB tree, so this
# port supports ONLY the legacy source; ATTRIBUTION_SOURCE=journey raises (honest, no silent fallback).
ATTRIBUTION_SOURCE_JOURNEY = "journey"


def _attribution_source_is_journey() -> bool:
    return (os.environ.get("ATTRIBUTION_SOURCE") or "").strip().lower() == ATTRIBUTION_SOURCE_JOURNEY


# Column contract — db/starrocks/gold_attribution_credit.sql column order (the PK ledger). brand_id first.
# Timestamp cols are plain `timestamp` (framework GOLD convention). Money = signed bigint minor + currency.
COLUMNS_SQL = """
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

COLUMNS = [
    "brand_id", "credit_id", "order_id", "brain_anon_id", "touch_seq", "channel", "campaign_id",
    "model_id", "row_kind", "weight_fraction", "credited_revenue_minor", "currency_code",
    "reversed_of_credit_id", "reversal_reason", "realized_revenue_minor", "confidence_grade",
    "attribution_confidence", "model_version", "metric_snapshot_id", "occurred_at",
    "economic_effective_at", "billing_posted_period", "updated_at",
]

PK = ["brand_id", "credit_id"]


def _table_exists(con, fq: str) -> bool:
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent source → 0 recognized basis → 0 credit rows
        return False


def _billing_period(occurred_at) -> str:
    """toBillingPostedPeriod — 'YYYY-MM' (UTC) from the conversion event-time. Mirrors the Spark helper."""
    return f"{occurred_at.year:04d}-{occurred_at.month:02d}"


def _touch_dict(r):
    """Project a silver_touchpoint row into the confidence/credit touch dict (TS CreditTouch shape).

    r is a DuckDB row tuple in the SELECT order:
      (brand_id, brain_anon_id, touch_seq, channel, utm_campaign, utm_medium, fbclid, gclid, ttclid,
       stitched_brain_id)
    """
    return {
        "touch_seq": int(r[2]),
        "channel": r[3],
        "campaign_id": r[4],
        "utm_medium": r[5],
        "fbclid": r[6],
        "gclid": r[7],
        "ttclid": r[8],
        "stitched_brain_id": r[9],
    }


def _compute_brand_rows(brand_id, touches_by_anon, brain_to_anon, recognized, channel_weights):
    """Reproduce reconcile-attribution.ts for ONE brand: per-model credit rows over recognized orders.

    IDENTICAL to the Spark _compute_brand_rows — same loop, same vendored math calls, same tuple order.

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


def _read_touchpoints(con):
    """The attribution touchpoint input (DEFAULT legacy silver_touchpoint). Ordered by
    (brand_id, brain_anon_id, touch_seq ASC) so the earliest-touch resolvers pick the first row —
    the exact orderBy the Spark driver collects with. Absent table → REQUIRED → SystemExit (as Spark)."""
    if _attribution_source_is_journey():
        raise SystemExit(
            "[gold_attribution_credit] ATTRIBUTION_SOURCE=journey requires the Spark-tree "
            "brain_gold.gold_journey_events mart, which is not present in the DuckDB tree — this port supports "
            "only the DEFAULT legacy source (silver_touchpoint). Unset ATTRIBUTION_SOURCE or run the Spark "
            "job for the journey source [B.5.4]."
        )
    if not _table_exists(con, SILVER_TOUCHPOINT):
        raise SystemExit(
            f"[gold_attribution_credit] REQUIRED Iceberg table {SILVER_TOUCHPOINT} is absent — build the "
            f"Phase-1 silver_touchpoint mart first."
        )
    return con.execute(
        f"""
        SELECT brand_id, brain_anon_id, touch_seq, channel, utm_campaign, utm_medium,
               fbclid, gclid, ttclid, stitched_brain_id
        FROM {SILVER_TOUCHPOINT}
        ORDER BY brand_id, brain_anon_id, touch_seq ASC
        """
    ).fetchall()


def _read_recognized_basis(con):
    """Recognized orders (the credit basis) from the Iceberg gold revenue ledger. One row per
    (brand_id, order_id) — deterministic earliest occurred_at (then event_type ASC) — matching the TS
    per-order credit. amount_minor is the SIGNED realized basis. Absent ledger → None → 0 credit rows."""
    if not _table_exists(con, GOLD_REVENUE_LEDGER):
        print(
            f"[gold_attribution_credit] Iceberg {GOLD_REVENUE_LEDGER} unavailable; 0 recognized orders",
            flush=True,
        )
        return None
    in_list = ", ".join(f"'{t}'" for t in RECOGNITION_EVENT_TYPES)
    return con.execute(
        f"""
        WITH recognized AS (
          SELECT brand_id, order_id, brain_id,
                 CAST(amount_minor AS BIGINT) AS amount_minor, currency_code, occurred_at,
                 row_number() OVER (
                   PARTITION BY brand_id, order_id
                   ORDER BY occurred_at ASC, event_type ASC
                 ) AS _rn
          FROM {GOLD_REVENUE_LEDGER}
          WHERE event_type IN ({in_list})
        )
        -- occurred_at → plain TIMESTAMP for the driver collect: the session is UTC, so this is a lossless
        -- UTC-instant projection (matches Spark's UTC instants) that avoids pushing a timestamptz through
        -- Python (which this duckdb build routes via pytz). Written back as timestamptz by the MERGE.
        SELECT brand_id, order_id, brain_id, amount_minor, currency_code,
               CAST(occurred_at AS TIMESTAMP) AS occurred_at
        FROM recognized
        WHERE _rn = 1
        """
    ).fetchall()


def _supersede_refolded_credits(con, staged_view: str) -> int:
    """AUD-IMPL-013 — SUPERSEDE-ON-REFOLD: keep the per-(order, model) credit set CLOSED-SUM when an
    already-attributed order is re-folded with a DIFFERENT journey shape.

    This run's fold is AUTHORITATIVE for every (brand_id, order_id, model_id) group it emits — before the
    insert MERGE, DELETE the target's 'credit' rows in exactly those groups whose credit_id is NOT in the
    fresh set (deterministic ids: an unchanged journey reproduces identical ids → deletes nothing →
    byte-identical replay). SCOPED to the emitted groups only. A credit row referenced by a clawback
    (reversed_of_credit_id) is NEVER deleted. Same DELETE-with-target-derived-source pattern as the Spark
    _supersede_refolded_credits. First run (table just created / empty) → no-op."""
    try:
        stale = con.execute(
            f"""
            SELECT count(*) FROM {TARGET} t
            WHERE t.row_kind = 'credit'
              AND EXISTS (
                SELECT 1 FROM {staged_view} g
                WHERE g.brand_id = t.brand_id AND g.order_id = t.order_id AND g.model_id = t.model_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM {staged_view} s
                WHERE s.brand_id = t.brand_id AND s.credit_id = t.credit_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM {TARGET} c
                WHERE c.brand_id = t.brand_id AND c.reversed_of_credit_id = t.credit_id
              )
            """
        ).fetchone()[0]
    except Exception:  # noqa: BLE001 — table just created / empty → nothing to supersede
        return 0
    if stale and stale > 0:
        con.execute(
            f"""
            DELETE FROM {TARGET} t
            WHERE t.row_kind = 'credit'
              AND EXISTS (
                SELECT 1 FROM {staged_view} g
                WHERE g.brand_id = t.brand_id AND g.order_id = t.order_id AND g.model_id = t.model_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM {staged_view} s
                WHERE s.brand_id = t.brand_id AND s.credit_id = t.credit_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM {TARGET} c
                WHERE c.brand_id = t.brand_id AND c.reversed_of_credit_id = t.credit_id
              )
            """
        )
        print(
            f"[gold_attribution_credit] superseded {stale} stale credit row(s) from re-folded "
            f"(order, model) groups [AUD-IMPL-013]",
            flush=True,
        )
    return stale or 0


def build(con):
    # brand-first tenant bucketing (mirrors the Spark bucket(8, brand_id) hidden partitioning).
    ensure_table(con, TARGET, COLUMNS_SQL)

    tp_rows = _read_touchpoints(con)              # REQUIRED source (SystemExit if absent, as Spark)
    basis_rows = _read_recognized_basis(con)      # None → 0 recognized basis → 0 credit rows

    if basis_rows is None:
        print("[gold_attribution_credit] no recognized basis → 0 credit rows (no-op)", flush=True)
        total = con.execute(f"SELECT count(*) FROM {TARGET}").fetchone()[0]
        print(f"[gold_attribution_credit] table now {total} rows", flush=True)
        return 0

    # Group touches by (brand, anon), build the brain_id→anon resolver (earliest touch — rows are already
    # ordered by touch_seq ASC so setdefault keeps the first), and the Markov corpus per brand. This is the
    # driver-side collect+group the Spark job does (the journey grain is tiny).
    by_brand_touches = {}      # brand -> {anon -> [touch dict, ...]}
    by_brand_brain = {}        # brand -> {stitched_brain_id -> anon}
    corpus_seen = {}           # brand -> {anon -> {"channels": [...], "converted": bool}}
    for r in tp_rows:
        b = r[0]
        anon = r[1]
        td = _touch_dict(r)
        by_brand_touches.setdefault(b, {}).setdefault(anon, []).append(td)
        if td["stitched_brain_id"] is not None:
            by_brand_brain.setdefault(b, {}).setdefault(td["stitched_brain_id"], anon)
        ce = corpus_seen.setdefault(b, {}).setdefault(anon, {"channels": [], "converted": False})
        if td["channel"]:
            ce["channels"].append(td["channel"])
        if td["stitched_brain_id"] is not None:
            ce["converted"] = True

    by_brand_corpus = {
        b: [(e["channels"], e["converted"]) for e in anons.values()]
        for b, anons in corpus_seen.items()
    }

    by_brand_recognized = {}
    for r in basis_rows:
        by_brand_recognized.setdefault(r[0], []).append({
            "order_id": r[1],
            "brain_id": r[2],
            "amount_minor": r[3],
            "currency_code": r[4],
            "occurred_at": r[5],
        })

    all_rows = []
    for b, recognized in by_brand_recognized.items():
        touches_by_anon = by_brand_touches.get(b, {})
        brain_to_anon = by_brand_brain.get(b, {})
        # GLOBAL Markov removal-effect solve for the brand (VENDORED pure module — algorithm unchanged).
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
        print(
            "[gold_attribution_credit] 0 credit rows (no stitched journeys for recognized orders) — no-op",
            flush=True,
        )
        total = con.execute(f"SELECT count(*) FROM {TARGET}").fetchone()[0]
        print(f"[gold_attribution_credit] table now {total} rows", flush=True)
        return 0

    # Stage the computed rows (adding updated_at = now() UTC) into a temp view for the supersede + MERGE.
    con.register("attribution_credit_rows", _rows_to_arrow(all_rows))
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW attribution_credit_src AS
        SELECT
          brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, campaign_id,
          model_id, row_kind, weight_fraction, credited_revenue_minor, currency_code,
          reversed_of_credit_id, reversal_reason, realized_revenue_minor,
          confidence_grade, attribution_confidence, model_version, metric_snapshot_id,
          occurred_at, economic_effective_at, billing_posted_period,
          now() AT TIME ZONE 'UTC' AS updated_at
        FROM attribution_credit_rows
        """
    )

    # SUPERSEDE-ON-REFOLD before the insert MERGE (AUD-IMPL-013), then the idempotent ON-CONFLICT-KEEP MERGE.
    _supersede_refolded_credits(con, "attribution_credit_src")

    collist = ", ".join(COLUMNS)
    ins_vals = ", ".join(f"s.{c}" for c in COLUMNS)
    on_clause = " AND ".join(f"t.{c} = s.{c}" for c in PK)
    con.execute(
        f"""
        MERGE INTO {TARGET} t
        USING attribution_credit_src s
        ON {on_clause}
        WHEN NOT MATCHED THEN INSERT ({collist}) VALUES ({ins_vals});
        """
    )
    total = con.execute(f"SELECT count(*) FROM {TARGET}").fetchone()[0]
    print(f"[gold_attribution_credit] MERGE complete → {TARGET} has {total} rows", flush=True)
    return len(all_rows)


def _rows_to_arrow(rows):
    """Build a typed Arrow table from the computed credit-row tuples (22 cols, pre-updated_at) so DuckDB
    registers a strongly-typed relation for the MERGE (numpy backs the tier; pyarrow ships with duckdb)."""
    import pyarrow as pa

    # The 22 fields in the tuple order emitted by _compute_brand_rows (updated_at is added in SQL).
    cols = list(zip(*rows)) if rows else [[] for _ in range(22)]
    schema = pa.schema([
        ("brand_id", pa.string()),
        ("credit_id", pa.string()),
        ("order_id", pa.string()),
        ("brain_anon_id", pa.string()),
        ("touch_seq", pa.int32()),
        ("channel", pa.string()),
        ("campaign_id", pa.string()),
        ("model_id", pa.string()),
        ("row_kind", pa.string()),
        ("weight_fraction", pa.string()),
        ("credited_revenue_minor", pa.int64()),
        ("currency_code", pa.string()),
        ("reversed_of_credit_id", pa.string()),
        ("reversal_reason", pa.string()),
        ("realized_revenue_minor", pa.int64()),
        ("confidence_grade", pa.string()),
        ("attribution_confidence", pa.string()),
        ("model_version", pa.string()),
        ("metric_snapshot_id", pa.string()),
        # tz-NAIVE us timestamps: the driver collected occurred_at as a plain (UTC-session) TIMESTAMP, so
        # the Python datetimes are naive UTC instants. The staged view / MERGE write them into the Iceberg
        # timestamptz columns (the framework stores UTC instants) — no double-tz shift.
        ("occurred_at", pa.timestamp("us")),
        ("economic_effective_at", pa.timestamp("us")),
        ("billing_posted_period", pa.string()),
    ])
    return pa.table({name: cols[i] for i, name in enumerate(schema.names)}, schema=schema)


if __name__ == "__main__":
    run_job("gold-attribution-credit", build, target_table="gold_attribution_credit")
