# SPEC: A.3 (WA-20) — Splink v1 probabilistic-stitch model evaluation on the GOLDEN dataset.
"""
splink_v1_golden_eval.py — the REPRODUCIBLE holdout evaluation harness behind
knowledge-base/models/splink-v1.md.

DuckDB-tree home of the dev/CI harness. This is a BACKEND-EQUIVALENT port: the ORIGINAL Spark-tree
harness (db/iceberg/spark/silver/splink_v1_golden_eval.py) ALREADY ran the DuckDB Splink backend
(`Linker(df, settings, db_api=DuckDBAPI())`, splink 4.x) directly over the golden CSVs — it never
used Spark. Moving it into db/iceberg/duckdb/silver colocates it with the production job it mirrors;
the feature-engineering, comparison design, training, holdout, and threshold sweep are UNCHANGED.

WHAT IT DOES
  Reproduces the exact feature-engineering + Splink comparison design of the production job
  (silver_probabilistic_stitch.py) against the captured golden snapshot CSVs
  (packages/testing-golden/snapshots/baseline/*.csv), trains a Splink model on DETERMINISTIC
  labels (identify email-hash clusters = multi-device truth), holds out 20% of persons, and
  reports holdout precision/recall at the ≥0.95 output floor (and a threshold sweep) — the
  numbers cited in the model card.

WHY A SEPARATE HARNESS (not the production job)
  The production job runs the DuckDB Splink backend over the LIVE Iceberg marts (via the _base/
  _catalog framework). This harness is a DEV/CI tool that runs over the golden CSVs directly — no
  Iceberg/live stack needed, so the model card is regenerable in seconds. The FEATURES and comparison
  structure mirror the job; the reported ceiling is a property of the DATA (feature entropy), which is
  invariant to the Splink major/backend.

  Dev-only deps (NOT added to any runtime image):  pip install splink duckdb pandas

RUN
  python3 db/iceberg/duckdb/silver/splink_v1_golden_eval.py \
      [--baseline packages/testing-golden/snapshots/baseline] [--json /tmp/splink-v1-metrics.json]

  The harness needs silver_collector_event.csv + silver_touchpoint.csv in the baseline dir. When they
  are absent (a Gold-only snapshot), it exits CLEAN (0) with a structured "snapshot_absent" result
  rather than crashing — it is a regenerable dev tool, not a gate on live data.

HONEST FEATURE NOTE (see the model card §"Feature availability"): the golden pixel captures
only device.ua_class (2 values, ~98% desktop) + device.viewport (2 values) — IP/24, timezone,
OS/UA-family, and device-fingerprint (the spec's high-entropy features + blocking keys) are
ABSENT. The remaining features (ua_class, screen_class, dominant daypart, hour-of-day overlap,
top-product overlap over 16 SKUs) lack the entropy to reach the 0.95 floor: max observed pair
probability on golden ≈ 0.04. The model therefore emits ZERO ≥0.95 rows on golden and does not
meet the 0.98 ship bar — the flag `identity.probabilistic` stays OFF (spec-intended outcome).
"""
from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import json
import random
import sys
from pathlib import Path

MODEL_VERSION = "splink-v1"
SEED = 42
HOLDOUT_FRACTION = 0.20
OUTPUT_FLOOR = 0.95   # silver_probabilistic_stitch write floor (spec A.3)
SHIP_BAR_PRECISION = 0.98  # real-brand enablement bar (spec A.3)


# ── feature aggregation (per-anon = the repo session grain; session_id = brain_anon_id) ───────────
def build_records(baseline: Path) -> list[dict]:
    dev: dict = {}                                              # (brand,anon) -> [Counter viewport, Counter ua]
    hours = collections.defaultdict(collections.Counter)       # (brand,anon) -> hour histogram
    prods = collections.defaultdict(collections.Counter)       # (brand,anon) -> product histogram
    emails = collections.defaultdict(set)                      # (brand,anon) -> {email_sha256}
    csv.field_size_limit(10 ** 7)

    with (baseline / "silver_collector_event.csv").open() as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            brand, etype = row[1], row[5]
            try:
                p = json.loads(row[11])
            except Exception:  # noqa: BLE001
                continue
            pr = p.get("properties", {})
            d = pr.get("device", {})
            an = pr.get("brain_anon_id")
            if not an:
                continue
            key = (brand, an)
            e = dev.setdefault(key, [collections.Counter(), collections.Counter()])
            if d.get("viewport"):
                e[0][d["viewport"]] += 1
            if d.get("ua_class"):
                e[1][d["ua_class"]] += 1
            oa = pr.get("occurred_at") or row[2]
            try:
                hours[key][int(oa[11:13])] += 1
            except Exception:  # noqa: BLE001
                pass
            if etype == "identify" and pr.get("hashed_customer_email"):
                emails[key].add(pr["hashed_customer_email"])

    with (baseline / "silver_touchpoint.csv").open() as f:
        for x in csv.DictReader(f):
            key = (x["brand_id"], x["brain_anon_id"])
            if x.get("product_handle"):
                prods[key][x["product_handle"]] += 1
            if x.get("occurred_at"):
                try:
                    hours[key][int(x["occurred_at"][11:13])] += 1
                except Exception:  # noqa: BLE001
                    pass

    # deterministic person clustering: union-find over anons sharing any email hash (multi-device truth)
    parent: dict = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    owner: dict = {}
    for key, es in emails.items():
        find(key)
        for em in es:
            if em in owner:
                union(owner[em], key)
            else:
                owner[em] = key

    def det_person(key):
        if not emails.get(key):
            return None
        root = find(key)
        return "DET-" + hashlib.sha1(f"{root[0]}|{root[1]}".encode()).hexdigest()[:16]

    recs = []
    for key in sorted(set(dev) | set(hours) | set(prods)):
        brand, an = key
        vpc, uac = dev.get(key, [collections.Counter(), collections.Counter()])
        hc = hours.get(key, collections.Counter())
        pc = prods.get(key, collections.Counter())
        recs.append({
            "unique_id": an,
            "brand_id": brand,
            "ua_class": (uac.most_common(1)[0][0] if uac else None),
            "screen_class": (vpc.most_common(1)[0][0] if vpc else None),
            "daypart": (hc.most_common(1)[0][0] // 6 if hc else None),
            "active_hours": sorted(hc.keys()),
            "top_products": sorted(pc.keys()),
            "det_person": det_person(key),
        })
    return recs


def main() -> int:
    ap = argparse.ArgumentParser()
    repo = Path(__file__).resolve().parents[4]
    ap.add_argument("--baseline", default=str(repo / "packages/testing-golden/snapshots/baseline"))
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    # The harness is a regenerable DEV/CI tool. When the Silver source CSVs are not in the snapshot
    # (e.g. a Gold-only baseline), exit CLEAN with a structured marker instead of crashing.
    baseline = Path(args.baseline)
    missing = [n for n in ("silver_collector_event.csv", "silver_touchpoint.csv")
               if not (baseline / n).exists()]
    if missing:
        result = {
            "model_version": MODEL_VERSION,
            "status": "snapshot_absent",
            "baseline": str(baseline),
            "missing_inputs": missing,
            "note": ("golden Silver source CSVs not present in this snapshot; nothing to evaluate. "
                     "This is a dev/CI regenerable harness, not a gate on live data."),
        }
        print(json.dumps(result, indent=2))
        if args.json:
            Path(args.json).write_text(json.dumps(result, indent=2))
        return 0

    import pandas as pd
    from splink import DuckDBAPI, Linker, SettingsCreator, block_on
    import splink.comparison_library as cl
    from splink import comparison_level_library as cll

    recs = build_records(baseline)
    df = pd.DataFrame.from_records(recs)
    identified = df.det_person.notna().sum()
    persons = sorted(df.det_person.dropna().unique())
    sizes = df.dropna(subset=["det_person"]).groupby("det_person").size()
    multi = int((sizes > 1).sum())

    random.seed(SEED)
    shuffled = list(persons)
    random.shuffle(shuffled)
    cut = int(len(shuffled) * (1 - HOLDOUT_FRACTION))
    train_p, test_p = set(shuffled[:cut]), set(shuffled[cut:])
    train_df = df[df.det_person.isin(train_p)].copy()
    test_df = df[df.det_person.isin(test_p)].copy()

    def daypart_cmp():
        return cl.CustomComparison(
            output_column_name="daypart",
            comparison_levels=[cll.NullLevel("daypart"), cll.ExactMatchLevel("daypart"), cll.ElseLevel()],
            comparison_description="dominant daypart exact",
        )

    settings = SettingsCreator(
        link_type="dedupe_only",
        unique_id_column_name="unique_id",
        # Spec blocking keys (IP/24 + 7-day activity; device-fingerprint hash) are ABSENT on golden.
        # Documented fallback: brand_id (tenant isolation — probabilistic NEVER crosses brand) + the
        # coarse device/daypart signals we do have. brand-only is tractable here (few-thousand anons/brand).
        blocking_rules_to_generate_predictions=[block_on("brand_id")],
        comparisons=[
            cl.ExactMatch("ua_class"),
            cl.ExactMatch("screen_class"),
            daypart_cmp(),
            cl.ArrayIntersectAtSizes("active_hours", [3, 2, 1]),
            cl.ArrayIntersectAtSizes("top_products", [3, 2, 1]),
        ],
        retain_intermediate_calculation_columns=True,
    )

    # ── train on DETERMINISTIC labels (email clusters), holding out 20% of persons ────────────────
    train = Linker(train_df, settings, db_api=DuckDBAPI())
    train.training.estimate_probability_two_random_records_match([block_on("det_person")], recall=0.9)
    train.training.estimate_u_using_random_sampling(max_pairs=3e6)
    train.training.estimate_m_from_label_column("det_person")
    model_json = train.misc.save_model_to_json()

    # ── evaluate on the held-out persons with the trained model ───────────────────────────────────
    test = Linker(test_df, model_json, db_api=DuckDBAPI())
    preds = test.inference.predict().as_pandas_dataframe()
    preds["fs"] = [frozenset((a, b)) for a, b in preds[["unique_id_l", "unique_id_r"]].values]

    truth = set()
    byp = collections.defaultdict(list)
    for uid, pp in test_df[["unique_id", "det_person"]].values.tolist():
        byp[pp].append(uid)
    for _pp, uids in byp.items():
        for i in range(len(uids)):
            for j in range(i + 1, len(uids)):
                truth.add(frozenset((uids[i], uids[j])))

    cand = set(preds["fs"])
    blocking_recall = len(truth & cand) / len(truth) if truth else float("nan")
    tp_probs = preds[preds.fs.isin(truth)].match_probability
    fp_probs = preds[~preds.fs.isin(truth)].match_probability

    sweep = {}
    for thr in [0.98, 0.95, 0.90, 0.70, 0.50, 0.10, 0.05, 0.02]:
        pset = set(preds[preds.match_probability >= thr].fs)
        tp, fp, fn = len(pset & truth), len(pset - truth), len(truth - pset)
        prec = tp / (tp + fp) if (tp + fp) else None
        rec = tp / (tp + fn) if (tp + fn) else 0.0
        sweep[str(thr)] = {"predicted": len(pset), "tp": tp, "fp": fp, "fn": fn,
                           "precision": prec, "recall": rec}

    floor = sweep[str(OUTPUT_FLOOR)]
    metrics = {
        "model_version": MODEL_VERSION,
        "seed": SEED,
        "dataset": "golden (packages/testing-golden/snapshots/baseline)",
        "total_anons": int(len(df)),
        "identified_anons": int(identified),
        "distinct_persons": int(len(persons)),
        "multi_device_persons": multi,
        "max_devices_per_person": int(sizes.max()) if len(sizes) else 0,
        "holdout": {"train_persons": len(train_p), "train_records": int(len(train_df)),
                    "test_persons": len(test_p), "test_records": int(len(test_df)),
                    "test_truth_pairs": len(truth)},
        "blocking_recall_on_holdout": blocking_recall,
        "true_pair_prob": {"max": float(tp_probs.max()) if len(tp_probs) else None,
                           "mean": float(tp_probs.mean()) if len(tp_probs) else None},
        "false_pair_prob": {"max": float(fp_probs.max()) if len(fp_probs) else None,
                            "mean": float(fp_probs.mean()) if len(fp_probs) else None},
        "threshold_sweep": sweep,
        "output_floor": OUTPUT_FLOOR,
        "ship_bar_precision": SHIP_BAR_PRECISION,
        "at_output_floor": floor,
        "meets_ship_bar": bool(floor["precision"] is not None and floor["precision"] >= SHIP_BAR_PRECISION),
        "rows_emitted_ge_floor_on_golden": floor["predicted"],
    }
    print(json.dumps(metrics, indent=2))
    if args.json:
        Path(args.json).write_text(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
