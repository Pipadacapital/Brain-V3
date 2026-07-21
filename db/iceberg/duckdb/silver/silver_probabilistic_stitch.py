# SPEC: A.3 (WA-20) — Probabilistic stitch (QUARANTINED). AMD-12 R1: Splink is a SIBLING matcher_id
# that EXCLUSIVELY owns brain_silver.silver_probabilistic_stitch; the live rule-based Fellegi–Sunter
# matcher (MergeReview) is untouched. §1.4 quarantine is ABSOLUTE — nothing here is ever read by
# attribution/revenue (guarded by probabilistic_quarantine_guard_test.py).
"""
silver_probabilistic_stitch.py — Splink probabilistic session→customer stitch, DuckDB backend.

BACKEND-ONLY PORT of db/iceberg/spark/silver/silver_probabilistic_stitch.py: this is NOT a rewrite of
the Splink model. The Splink SETTINGS (blocking rules, comparisons, m/u training, ≥0.95 write floor)
are reproduced VERBATIM — only the compute engine changes from Spark (SparkLinker, splink 3.x) to
DuckDB (`Linker(df, settings, db_api=DuckDBAPI())`, splink 4.x). Reads/writes are the SAME Iceberg
catalog through the DuckDB _base/_catalog framework, so the table Trino reads is unchanged.

WHAT IT DOES (spec A.3)
  Over UNSTITCHED sessions (no deterministic identity), score each against the DETERMINISTICALLY-known
  customers using weak device/behavioral signals; write ONLY pairs with match probability ≥ 0.95 to the
  QUARANTINED table brain_silver.silver_probabilistic_stitch:
      {brand_id, session_id, probabilistic_brain_id, confidence, model_version, features_used, scored_at}

  session grain = brain_anon_id (the repo "session key" — silver_touchpoint sessionizes per brain_anon_id;
  session_id column carries brain_anon_id). Probabilistic NEVER crosses brand_id (tenant isolation).

TRAINING (train on deterministic labels; 20% holdout evaluated OUT-OF-BAND)
  The model is trained with Splink's supervised m-estimation from a DETERMINISTIC label column
  (`det_person`, derived from identify email-hash clusters = multi-device truth). u is estimated by
  random sampling. The holdout precision/recall + the 0.98 ship bar live in the reproducible harness
  splink_v1_golden_eval.py → knowledge-base/models/splink-v1.md (run there; do NOT re-derive here).

FLAG GATE (identity.probabilistic, per-brand, DEFAULT OFF — registry: "writes silver_probabilistic_stitch
  (quarantined; never attribution/revenue)"). The job SCORES every brand but only WRITES ≥0.95 rows for
  brands whose flag is ON. Default OFF ⇒ zero rows written ⇒ the quarantined table stays EMPTY ⇒
  golden byte-identical (§0.5) and the quarantine holds trivially. The 0.98 ship bar (harness) gates
  turning the flag ON for a real brand; the flag stays OFF on golden regardless of any score.

FEATURE AVAILABILITY (honest — see the model card):
  Available on the pixel/golden envelope: device.ua_class (desktop|mobile), device.viewport (screen
  class), hour-of-day (occurred_at) → dominant daypart + active-hour overlap, top-product overlap
  (product_handle). ABSENT (documented, honestly not used): IP /24, timezone, OS / UA-family,
  device-fingerprint. The spec's blocking keys (same IP /24 + 7-day window; device-fingerprint hash)
  are therefore UNAVAILABLE; the fallback blocking is brand_id (tenant isolation) + coarse
  device/daypart signals. This is why the model emits 0 rows ≥0.95 on this corpus — a DATA (entropy)
  limit, not a code limit.

DEPENDENCY NOTE (WA-16 not yet built): silver_session_identity / identity_current_v (the sanctioned
  deterministic identity views) are a later Wave A deliverable. Until they land, this job derives its
  deterministic label + probabilistic_brain_id from identify email-hash clusters in
  silver_collector_event. ADDITIVE, non-breaking.

QUARANTINE NOTE: this framework has NO quarantine side-table (documented invariant of the DuckDB
  port). Feature-engineering here reads only Silver marts (already cleaned) and derives coarse signals;
  there is no schema/dq/business divert to reproduce (the Spark job likewise writes no quarantine here).

FRAMEWORK: reads the sibling Silver marts DIRECTLY (like silver_customer.py) — NOT the gated
  collector-event keystone via read_gated_events_sql. Target honors MIGRATION_TABLE_SUFFIX. UTC session;
  timestamp cols are plain `timestamp` (Iceberg parity with the Spark UTC instants). PII stays hashed.

DEGRADE SAFELY: if splink is absent, or there are no deterministic labels, the quarantined table stays
  empty (identical to the flag-OFF write path) and the job exits clean — no deterministic output moves.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

try:  # driver-only gate; fail-closed (default OFF) if redis is unreachable — same as the Spark job
    from _platform_flags import FLAG_IDENTITY_PROBABILISTIC, is_flag_enabled  # noqa: E402
except Exception:  # noqa: BLE001
    FLAG_IDENTITY_PROBABILISTIC = "identity.probabilistic"

    def is_flag_enabled(_brand_id: str, _flag: str) -> bool:  # fail-closed
        return False


MODEL_VERSION = os.environ.get("SPLINK_MODEL_VERSION", "splink-v1")
OUTPUT_FLOOR = float(os.environ.get("SPLINK_OUTPUT_FLOOR", "0.95"))  # spec A.3 write floor
FEATURES_USED = "ua_class,screen_class,daypart,active_hours,top_products"  # honest: what the model saw

COLLECTOR_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"
TOUCHPOINT_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
TABLE_NAME = "silver_probabilistic_stitch"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.{TABLE_NAME}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# Spec output schema (exact) + brand_id-first tenant key. hash-only PII (session_id = anon; brain_id proxy).
_COLUMNS = """
          brand_id             string    NOT NULL,
          session_id           string    NOT NULL,
          probabilistic_brain_id string  NOT NULL,
          confidence           double,
          model_version        string,
          features_used        string,
          scored_at            timestamp NOT NULL
""".strip("\n")

_COLUMN_LIST = [
    "brand_id", "session_id", "probabilistic_brain_id", "confidence",
    "model_version", "features_used", "scored_at",
]


def _feature_frame(con):
    """Per-anon (session grain) feature frame + deterministic person label, over Silver only — the
    DuckDB analogue of the Spark _feature_frame. Returns a pandas DataFrame for the DuckDB Splink API.

    device/identify signals from silver_collector_event; product/hour from silver_touchpoint. det_person
    is a deterministic label from identify email-hash (multi-device truth) — the m-training label AND the
    probabilistic_brain_id source until WA-16's identity_current_v lands (see module docstring).

    Verbatim to the Spark aggregations:
      - ua_class / screen_class : max() over the anon's collector events (anon-consistent on golden).
      - emails                  : sorted distinct hashed_customer_email from identify events (nulls filtered).
      - active_hours            : sorted distinct hour-of-day from BOTH collector + touchpoint occurred_at.
      - top_products            : sorted distinct non-empty product_handle from touchpoint.
      - daypart                 : first (min) active hour / 6, cast int (Spark element_at(...,1)/6).
      - det_person              : identified anons only → 'DET-' + sha1(brand_id | min(email)).
    """
    dev = f"""
      SELECT brand_id, anon,
             max(ua_class)     AS ua_class,
             max(screen_class) AS screen_class,
             array_agg(DISTINCT email) FILTER (WHERE email IS NOT NULL AND is_identify) AS emails_raw,
             array_agg(DISTINCT hr)                                                     AS hrs_ev
      FROM (
        SELECT brand_id,
               json_extract_string(payload, '$.properties.brain_anon_id')       AS anon,
               json_extract_string(payload, '$.properties.device.ua_class')      AS ua_class,
               json_extract_string(payload, '$.properties.device.viewport')      AS screen_class,
               json_extract_string(payload, '$.properties.hashed_customer_email') AS email,
               (event_type = 'identify')                                          AS is_identify,
               hour(occurred_at AT TIME ZONE 'UTC')                               AS hr
        FROM {COLLECTOR_TABLE}
        WHERE json_extract_string(payload, '$.properties.brain_anon_id') IS NOT NULL
          AND json_extract_string(payload, '$.properties.brain_anon_id') <> ''
      )
      GROUP BY brand_id, anon
    """

    tp = f"""
      SELECT brand_id, anon,
             array_agg(DISTINCT product_handle)
               FILTER (WHERE product_handle IS NOT NULL AND product_handle <> '') AS top_products,
             array_agg(DISTINCT hr)                                               AS hrs_tp
      FROM (
        SELECT brand_id, brain_anon_id AS anon, product_handle,
               hour(occurred_at AT TIME ZONE 'UTC') AS hr
        FROM {TOUCHPOINT_TABLE}
      )
      GROUP BY brand_id, anon
    """

    # emails_raw / hrs_ev / hrs_tp may be NULL when the anon appears in only one side (FULL OUTER JOIN).
    # coalesce to empty arrays; active_hours = sorted distinct union of both hour sources; daypart from
    # the earliest active hour (Spark element_at(active_hours,1)/6). det_person: identified anons only.
    feats_sql = f"""
      WITH dev AS ({dev}), tp AS ({tp}),
      joined AS (
        SELECT coalesce(dev.brand_id, tp.brand_id) AS brand_id,
               coalesce(dev.anon, tp.anon)         AS anon,
               dev.ua_class, dev.screen_class,
               coalesce(dev.emails_raw, [])        AS emails_raw,
               list_sort(list_distinct(
                 list_concat(coalesce(dev.hrs_ev, []), coalesce(tp.hrs_tp, [])))) AS active_hours,
               list_sort(coalesce(tp.top_products, []))                           AS top_products
        FROM dev FULL OUTER JOIN tp ON dev.brand_id = tp.brand_id AND dev.anon = tp.anon
      ),
      labeled AS (
        SELECT brand_id, anon, ua_class, screen_class, active_hours, top_products,
               list_sort(emails_raw) AS emails,
               CASE WHEN len(active_hours) > 0
                    THEN CAST(active_hours[1] / 6 AS INTEGER) END AS daypart
        FROM joined
      )
      SELECT anon AS unique_id, brand_id, ua_class, screen_class, daypart,
             active_hours, top_products,
             CASE WHEN len(emails) > 0
                  THEN 'DET-' || sha1(brand_id || '|' || emails[1]) END AS det_person
      FROM labeled
    """
    return con.execute(f"SELECT * FROM ({feats_sql})").fetch_df()


def _splink_settings():
    """The PRODUCTION Splink settings, reproduced VERBATIM on the DuckDB backend (splink 4.x API).

    Spark job (splink 3.x, splink.spark.comparison_library):
        cl.exact_match("ua_class"/"screen_class"/"daypart")
        cl.array_intersect_at_sizes("active_hours"/"top_products", [3, 2, 1])
        blocking: brand_id + screen_class + daypart ; brand_id + ua_class
        additional_columns_to_retain = [brand_id, det_person]
    DuckDB port (splink 4.x, splink.comparison_library) — same comparisons, same thresholds, same
    tenant-first blocking. block_on(...) composes the AND-equality blocking rules; the daypart exact
    match is a CustomComparison (Null / ExactMatch / Else), the 4.x equivalent of cl.exact_match on an
    integer column (matching splink_v1_golden_eval.py's daypart_cmp)."""
    from splink import SettingsCreator, block_on
    import splink.comparison_library as cl
    from splink import comparison_level_library as cll

    daypart_cmp = cl.CustomComparison(
        output_column_name="daypart",
        comparison_levels=[cll.NullLevel("daypart"), cll.ExactMatchLevel("daypart"), cll.ElseLevel()],
        comparison_description="dominant daypart exact",
    )
    return SettingsCreator(
        link_type="dedupe_only",
        unique_id_column_name="unique_id",
        # Surface brand_id (tenant orientation) + det_person (the deterministic label / brain_id proxy)
        # onto the pairwise prediction output as *_l / *_r so _score can orient identified↔unstitched.
        additional_columns_to_retain=["brand_id", "det_person"],
        # Spec blocking keys (IP /24 + 7-day window; device-fingerprint) are ABSENT (see docstring).
        # Fallback: brand_id FIRST (probabilistic never crosses tenant) + the coarse signals we have.
        blocking_rules_to_generate_predictions=[
            block_on("brand_id", "screen_class", "daypart"),
            block_on("brand_id", "ua_class"),
        ],
        comparisons=[
            cl.ExactMatch("ua_class"),
            cl.ExactMatch("screen_class"),
            daypart_cmp,
            cl.ArrayIntersectAtSizes("active_hours", [3, 2, 1]),
            cl.ArrayIntersectAtSizes("top_products", [3, 2, 1]),
        ],
    )


def _score(con, feats):
    """Train on deterministic labels, predict pairwise, keep identified↔unstitched pairs ≥ floor —
    the DuckDB-backend equivalent of the Spark _score. Returns a pandas DataFrame in the _COLUMN_LIST
    shape (possibly empty — the golden reality: max prob ≈ 0.04) or None to degrade safely.

    Single dedupe_only linker over ALL sessions: m estimated from the det_person label (null labels are
    excluded), u by random sampling. From predictions, keep pairs where exactly ONE side is identified
    (has det_person) and the other is unstitched → (session_id = unstitched anon, probabilistic_brain_id
    = identified det_person, confidence = match probability) ≥ OUTPUT_FLOOR."""
    # §1.4 optional weak-signal matcher — DEGRADE SAFELY when splink is absent from the image.
    try:
        from splink import DuckDBAPI, Linker, block_on
    except ModuleNotFoundError:
        print("[silver_probabilistic_stitch] splink not installed — skipping probabilistic scoring "
              "(quarantined table stays empty; §1.4 optional weak-signal matcher)", flush=True)
        return None

    n_labeled = int(feats["det_person"].notna().sum())
    if n_labeled == 0:
        print("[silver_probabilistic_stitch] no deterministic labels (no identify emails) — "
              "nothing to train/score", flush=True)
        return None

    # Own DuckDB in-memory backend for Splink (separate from the Iceberg-attached `con`); Splink's own
    # engine consumes the pandas feature frame. Identical model math to SparkLinker — only the executor
    # differs.
    linker = Linker(feats, _splink_settings(), db_api=DuckDBAPI())
    # u by random sampling (Spark: estimate_u_using_random_sampling(max_pairs)).
    linker.training.estimate_u_using_random_sampling(
        max_pairs=float(os.environ.get("SPLINK_U_MAX_PAIRS", "2e6"))
    )
    # m from the deterministic label column (Spark: estimate_m_from_label_column("det_person")).
    try:
        linker.training.estimate_m_from_label_column("det_person")
    except Exception as exc:  # noqa: BLE001 — too few labeled pairs → untrained m (defaults). Safe: scores stay low.
        print(f"[silver_probabilistic_stitch] m-from-label skipped ({exc}); using default m", flush=True)

    preds = linker.inference.predict(
        threshold_match_probability=OUTPUT_FLOOR
    ).as_pandas_dataframe()
    if preds.empty:
        print("[silver_probabilistic_stitch] 0 pairs ≥ floor "
              f"({OUTPUT_FLOOR}) — nothing to write (max pair prob below floor)", flush=True)
        return preds  # empty DF → honest-empty write path

    # keep identified(one side) ↔ unstitched(other side); orient so probabilistic_brain_id = identified.
    # Then keep the single best identified match per unstitched session (highest confidence, tie-broken
    # by probabilistic_brain_id) — the exact Spark Window row_number()==1 discipline.
    import pandas as pd

    det_l, det_r = preds["det_person_l"], preds["det_person_r"]
    xor = (det_l.notna() & det_r.isna()) | (det_l.isna() & det_r.notna())
    p = preds[xor].copy()
    if p.empty:
        return p
    out = pd.DataFrame({
        "brand_id": p["brand_id_l"],
        "session_id": p["unique_id_l"].where(det_l[p.index].isna(), p["unique_id_r"]),
        "probabilistic_brain_id": det_l[p.index].where(det_l[p.index].notna(), det_r[p.index]),
        "confidence": p["match_probability"].astype("float64"),
    })
    out = out[out["confidence"] >= OUTPUT_FLOOR]
    out["model_version"] = MODEL_VERSION
    out["features_used"] = FEATURES_USED
    out = (
        out.sort_values(["confidence", "probabilistic_brain_id"], ascending=[False, True])
           .drop_duplicates(subset=["brand_id", "session_id"], keep="first")
    )
    return out


def build(con):
    ensure_table(con, TARGET, _COLUMNS)

    feats = _feature_frame(con)
    scored = _score(con, feats)
    if scored is None or len(scored) == 0:
        print(f"[silver_probabilistic_stitch] {TARGET}: no rows scored", flush=True)
        return 0

    # ── FLAG GATE (identity.probabilistic, per-brand, default OFF) — write ONLY flag-ON brands ────────
    brands = sorted(scored["brand_id"].dropna().unique().tolist())
    enabled = [b for b in brands if is_flag_enabled(b, FLAG_IDENTITY_PROBABILISTIC)]
    if not enabled:
        print(
            f"[silver_probabilistic_stitch] flag '{FLAG_IDENTITY_PROBABILISTIC}' OFF for all "
            f"{len(brands)} scored brand(s) → 0 rows written (quarantined table stays empty)", flush=True,
        )
        return 0

    to_write = scored[scored["brand_id"].isin(enabled)].copy()
    con.register("splink_stitch_new_df", to_write)
    con.execute(
        "CREATE OR REPLACE TEMP VIEW splink_stitch_new AS "
        "SELECT brand_id, session_id, probabilistic_brain_id, "
        "CAST(confidence AS DOUBLE) AS confidence, model_version, features_used, "
        "now() AT TIME ZONE 'UTC' AS scored_at FROM splink_stitch_new_df"
    )

    # AUD-IMPL-015 idempotency (verbatim to the Spark job): the logical key is ONE best match per
    # (brand_id, session_id, model_version). _score already keeps the single best-confidence row per
    # session within a run.
    #   1) DELETE stale alternates: target rows for a re-scored session whose brain_id differs from this
    #      run's best match (self-heals any pre-fix duplicates).
    #   2) MERGE on the logical key — matched rows UPDATE in place, new sessions INSERT.
    con.execute(
        f"""
        DELETE FROM {TARGET} t
        WHERE EXISTS (
            SELECT 1 FROM splink_stitch_new s
            WHERE s.brand_id = t.brand_id AND s.session_id = t.session_id
              AND s.model_version = t.model_version
              AND s.probabilistic_brain_id <> t.probabilistic_brain_id
        )
        """
    )
    non_pk = [c for c in _COLUMN_LIST if c not in ("brand_id", "session_id", "model_version")]
    set_clause = ", ".join(f"{c} = s.{c}" for c in non_pk)
    collist = ", ".join(_COLUMN_LIST)
    ins_vals = ", ".join(f"s.{c}" for c in _COLUMN_LIST)
    con.execute(
        f"""
        MERGE INTO {TARGET} t
        USING splink_stitch_new s
        ON t.brand_id = s.brand_id AND t.session_id = s.session_id
           AND t.model_version = s.model_version
        WHEN MATCHED THEN UPDATE SET {set_clause}
        WHEN NOT MATCHED THEN INSERT ({collist}) VALUES ({ins_vals})
        """
    )
    n = con.execute(f"SELECT count(*) FROM {TARGET}").fetchone()[0]
    print(f"[silver_probabilistic_stitch] MERGE complete → {TARGET} has {n} row(s) "
          f"(flag-ON brands: {len(enabled)})", flush=True)
    return len(to_write)


if __name__ == "__main__":
    run_job("silver-probabilistic-stitch", build, target_table=TABLE_NAME)
