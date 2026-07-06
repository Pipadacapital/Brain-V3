<!-- SPEC: A.3 (WA-20) -->
# splink-v1 — probabilistic session→customer stitch (QUARANTINED)

**Model version:** `splink-v1` · **Owner job:** `db/iceberg/spark/silver/silver_probabilistic_stitch.py`
**Status:** BUILT · QUARANTINED (§1.4) · flag `identity.probabilistic` **OFF** everywhere · **does NOT meet the 0.98 ship bar on golden**
**Amendment:** AMD-12 R1 — Splink is a *sibling* matcher (`matcher_id` alongside the live rule-based
Fellegi–Sunter matcher); it EXCLUSIVELY owns `brain_silver.silver_probabilistic_stitch`. The
review-gated rule matcher (MergeReview) is untouched. The two scopes are disjoint — no double-counting.

## 1. What it does
Splink (Fellegi–Sunter, EM + supervised m-estimation) over **unstitched sessions** (session grain =
`brain_anon_id`, the repo session key). Trains on **deterministic labels** (identify email-hash clusters
= multi-device truth), scores each unstitched session against the deterministically-known customers, and
writes **only** pairs with match probability **≥ 0.95** to the quarantined
`silver_probabilistic_stitch {brand_id, session_id, probabilistic_brain_id, confidence, model_version,
features_used, scored_at}`. Consumers read it ONLY via `customer_sessions_extended_v` (deterministic
UNION probabilistic + `identity_basis`); attribution/revenue read **neither** (§1.4, guarded by
`probabilistic_quarantine_guard_test.py`). Writes are additionally per-brand flag-gated
(`identity.probabilistic`, default OFF) → the table is **empty on golden / a fresh stack**.

## 2. Feature availability — honest report
The spec feature set is UA family · OS · screen class · IP /24 (truncated only) · timezone ·
hour-of-day histogram distance · top-category overlap, with blocking on `brand + IP/24 + 7-day activity`
OR `brand + device-fingerprint hash`. On the golden dataset (and the current pixel/collector envelope):

| Spec feature / blocking key | Golden availability | Used? | Note |
|---|---|---|---|
| UA family / browser | **ABSENT** | no | pixel captures only a coarse `device.ua_class` ∈ {desktop, mobile}; no UA string / family |
| OS | **ABSENT** | no | never captured |
| screen class (`device.viewport`) | PRESENT but **2 values** (`1440x900`=98.4%, `390x844`=1.6%) → near-constant | yes (low weight) | anon-consistent (0 anons with >1 viewport) ⇒ ≈ `ua_class` |
| `device.ua_class` | PRESENT, **2 values**, ~98% desktop | yes (low weight) | near-constant |
| **IP /24 (truncated only)** | **ABSENT** | no | resolver has an `ip`/`device.ip` seam (`extract-identifiers.ts`) but the pixel **never populates it** — 0 rows on golden. Truncate-to-/24 rule implemented defensively but has no input. |
| timezone | **ABSENT** | no | never captured |
| hour-of-day histogram | DERIVABLE from `occurred_at` | yes | real signal — `active_hours` array + dominant `daypart` |
| top-category overlap | WEAK | yes | `collection_handle` is EMPTY on golden; `page_type` ∈ {product, home}; the usable signal is `product_handle` (**16 SKUs**) |
| **device-fingerprint hash** (blocking) | **ABSENT** | no | resolver seam exists; pixel never populates it |

**Consequence:** the spec's two high-entropy blocking keys (IP/24, fingerprint) and its high-entropy
comparisons (OS, UA-family, timezone) are all unavailable. Fallback blocking = `brand_id` (tenant
isolation — probabilistic NEVER crosses brand) + coarse device/daypart. The model's discriminating power
is limited to hour-of-day overlap + 16-SKU product overlap + two near-constant device signals.

## 3. Holdout evaluation on the golden dataset
Reproducible harness: `db/iceberg/spark/silver/splink_v1_golden_eval.py` (Splink 4 + DuckDB, dev venv;
mirrors the production job's features + comparisons — the ceiling is a DATA property, invariant to the
Splink major/backend). Labels = identify email-hash clusters; **20% of persons held out** (seed 42).

- Population: **4,752** anons · **609** identified · **477** persons · **90** multi-device persons (≤3 devices).
- Holdout: 381 train / 96 test persons; **41** cross-device truth pairs; **blocking recall 41/41 = 1.00**
  (the harness's brand-only blocking surfaces every true pair — so the result below is a *model* ceiling,
  not a blocking miss).
- Separation is weak but non-zero: **true-pair prob** mean **0.0160** / max **0.0432**; **false-pair prob**
  mean **0.0061** / max **0.0432** (top scores overlap → no clean cut).

| threshold | predicted | tp | fp | precision | recall |
|---|---|---|---|---|---|
| **0.98 (ship bar)** | 0 | 0 | 0 | — (0/0) | 0.000 |
| **0.95 (output floor)** | 0 | 0 | 0 | — (0/0) | 0.000 |
| 0.90 | 0 | 0 | 0 | — | 0.000 |
| 0.50 | 0 | 0 | 0 | — | 0.000 |
| 0.05 | 0 | 0 | 0 | — | 0.000 |
| 0.02 | 464 | 12 | 452 | 0.026 | 0.293 |

**At the 0.95 output floor the model emits ZERO pairs; precision is undefined (no predictions) and recall
is 0.** The maximum achievable pair probability on golden is ≈ **0.043** — the model never approaches
0.95, let alone the **0.98 ship bar**. This is a genuine feature-entropy limit (blocking recall is
perfect, the model trains, and it does show a weak 2.6× true/false separation), **not** a pipeline
defect.

## 4. Ship-bar gate (real-brand enablement)
- **Ship bar (§A.3): holdout precision ≥ 0.98** — **NOT MET** on golden (0 predictions at ≥0.95).
- The **score floor (0.95)** is separate and also produces 0 rows here.
- Therefore `silver_probabilistic_stitch` is **empty on golden**, `customer_sessions_extended_v`
  degenerates to its deterministic leg (byte-identical golden, §0.5), and the quarantine holds trivially.
- **`identity.probabilistic` stays OFF regardless** of any future score. Enabling it for a real brand
  requires (a) that brand supplying higher-entropy signals (IP/24, timezone, fingerprint, richer device
  context) and (b) re-running this harness to demonstrate holdout precision ≥ 0.98.

## 5. Quarantine invariants (§1.4 / §1.9.5)
Enforced by `db/iceberg/spark/silver/probabilistic_quarantine_guard_test.py` (static + golden data test):
Q1 no attribution/revenue job references the table/view/`probabilistic` basis · Q2 single writer
(AMD-12) · Q3 read only via `customer_sessions_extended_v`, which tags `identity_basis` · Q4 flag-gated +
floor ≥ 0.95 · Q5 golden attribution/revenue outputs carry zero probabilistic-basis rows.

## 6. Reproduce
```bash
# metrics (dev venv — Splink 4 + DuckDB over the captured golden snapshot; ~seconds, no live stack):
python3 -m venv /tmp/splinkvenv && /tmp/splinkvenv/bin/pip install 'splink>=4,<5' duckdb pandas
/tmp/splinkvenv/bin/python db/iceberg/spark/silver/splink_v1_golden_eval.py --json /tmp/splink-v1-metrics.json

# production job (Spark 3.5.3 + Splink 3.9.x; writes the QUARANTINED, flag-gated table — 0 rows on golden):
db/iceberg/spark/silver/run-silver-probabilistic-stitch.sh
```

## 7. Dependency / environment notes
- Splink is the **one sanctioned added dependency** (§1.1): Dockerfile pins `splink>=3.9.10,<4` (the
  base image is Python 3.8; Splink 4 needs 3.9+). Verified in-image with two runtime shims the job sets:
  a Spark **checkpoint dir** and an **`array_length`** session UDF (Splink's Spark
  `array_intersect_at_sizes` emits `ARRAY_LENGTH`, absent in Spark 3.5.3).
- **WA-16 dependency (not yet built):** `silver_session_identity` / `identity_current_v` are a later
  Wave A deliverable. Until they land, the job derives its deterministic label + `probabilistic_brain_id`
  from identify email-hash clusters (AMD-13-style bridge; switch to the sanctioned views behind the flag
  with golden parity when WA-16 ships). Additive, non-breaking.
