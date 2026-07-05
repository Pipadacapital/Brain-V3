"""
parity_oracle.py — the Spark-Iceberg ⇄ StarRocks parity oracle (Brain V4 Phase 0, AREA C; repurposed 6b).

The reusable cut-over gate for EVERY phase of the V4 re-platform. Phases 1-3 built the new Spark→Iceberg
Silver/Gold layer BESIDE the live dbt→StarRocks one (dual-run, non-breaking); a reader only cut over
(Phase 4+) once this oracle proved the new table EQUALS the current one. It mirrors the proven Bronze
parity oracle (../bronze_parity_check.py) in style, connections and exit-code discipline, and lifts it
from Bronze's identity-only check to the Gold/Silver mart shape.

  - NEW side      = the Spark-built Iceberg mart (rest.brain_gold.<mart> / rest.brain_silver.<mart>),
                    read through the SAME Iceberg REST catalog wiring as the Bronze jobs.
  - BASELINE side = configurable via PARITY_BASELINE (see below).

── PARITY_BASELINE — WHICH baseline the NEW Iceberg mart is compared against ──────────────────────────
  PARITY_BASELINE=serving  (DEFAULT — Phase 6b onward):
      The StarRocks SERVING materialized view `brain_serving.mv_<mart>` (read over the MySQL wire via
      JDBC). The MV reads the SAME Iceberg table the NEW side reads, so this proves SERVING PARITY: the
      mv_* the app actually queries EQUALS its Iceberg source (no stale / lossy MV refresh). This is the
      live gate after dbt-on-StarRocks was retired in 6b. A mart with no mv_* (most provisional GAP
      marts) is absent on the baseline side → graceful SKIP (current-mart-absent).

  PARITY_BASELINE=dbt  (RETIRED — Phase 6b dropped brain_gold + brain_silver):
      The legacy dbt-built StarRocks base table `brain_gold.<mart>` / `brain_silver.<mart>` (or the PG
      table for source="pg" marts). This was the original cut-over baseline (Phases 0-4) but the
      dbt-internal brain_gold/brain_silver DBs were DROPPED in Phase 6b
      (db/starrocks/teardown/drop_dbt_internal_dbs.sql), so on a 6b+ environment every StarRocks-sourced
      mart will SKIP (current-mart-absent). Kept ONLY for (a) historical reference and (b) PG-sourced
      marts whose baseline is still Postgres. Do NOT rely on it as a live gate — it is RETIRED.

Comparison (per V4 rule 5 — "parity is exact, money is minor-unit"):
  1. ROW COUNT keyed by the mart's PRIMARY KEY — distinct PK count on each side + the symmetric-
     difference of PK identities (in-NEW-not-CURRENT / in-CURRENT-not-NEW), per brand.
  2. PER-CURRENCY MINOR-UNIT Σ of every money column — money is bigint minor units + currency_code
     (metric-engine discipline), so the oracle groups by (brand_id, currency_code) and sums each
     money column exactly (no float). A money mart passes only if every (brand, currency, column)
     sum matches to the unit.

Output is a STRUCTURED PASS/FAIL line plus the exact delta (machine-greppable: `PARITY_RESULT mart=…
status=PASS|FAIL|SKIP …`), and the process exits non-zero on FAIL so it can gate CI / a cut-over PR.

SKIP-GRACEFULLY (Phase-0 requirement): the new Iceberg mart does NOT exist yet in Phases 0-1 for most
marts. When the NEW table (or namespace) is absent, the oracle emits `status=SKIP reason=new-mart-absent`
and exits 0 — it never fails a gate merely because the dual-run hasn't built that mart yet. Likewise a
CURRENT table that is absent (a net-new V4 entity with no dbt predecessor) skips with reason
`current-mart-absent`.

Run via spark-submit inside the Spark+Iceberg image (../Dockerfile), in Redpanda's netns so the
iceberg-rest / starrocks / postgres service DNS resolves — see run-parity.sh. All wiring is
env-overridable; dev defaults target the compose service names (iceberg-rest:8181, starrocks:9030,
minio:9000). Reads the CURRENT side as the StarRocks/PG superuser (cross-brand reconciliation read,
the same RLS-bypass posture as the Bronze oracle's PG read and the StarRocks ETL reader).
"""
import json
import os
import sys
from typing import List

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.utils import AnalysisException

from mart_registry import MARTS, MartSpec, resolve_mart

# ── Iceberg (NEW side) catalog wiring — identical to ../iceberg_base.build_spark (the fleet's
#    canonical REST-catalog factory; ADR-0010 removed the Spark-SS Bronze landing twin) ────────────
CATALOG = os.environ.get("ICEBERG_CATALOG", "rest")
ICEBERG_REST_URI = os.environ.get("ICEBERG_REST_URI", "http://iceberg-rest:8181")
# Each medallion layer is its own warehouse bucket (provisioned by AREA A/B): brain-silver / brain-gold.
# The oracle picks the warehouse from the mart's layer so a single catalog can address both namespaces.
SILVER_WAREHOUSE = os.environ.get("SILVER_WAREHOUSE", "s3://brain-silver/")
GOLD_WAREHOUSE = os.environ.get("GOLD_WAREHOUSE", "s3://brain-gold/")
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "http://minio:9000")

# ── BASELINE side selector (Phase 6b) ─────────────────────────────────────────────────────────────
# "serving" (default): compare the NEW Iceberg mart against the StarRocks SERVING MV brain_serving.mv_<mart>
#                      — proves the mv_* the app reads equals its Iceberg source.
# "dbt" (RETIRED):     compare against the legacy dbt brain_gold/brain_silver base table (DROPPED in 6b;
#                      PG-sourced marts still read PG). See the module docstring.
PARITY_BASELINE = os.environ.get("PARITY_BASELINE", "serving").strip().lower()
# The StarRocks DB that holds the serving materialized views (mv_<mart>) — the V4 serving layer.
SERVING_SCHEMA = os.environ.get("PARITY_SERVING_SCHEMA", "brain_serving")

# ── CURRENT/BASELINE side (StarRocks serving MV, retired dbt base table, or PG) JDBC wiring ────────
# StarRocks speaks the MySQL wire protocol on :9030, so the MySQL Connector/J driver reads its tables
# directly. In serving mode this targets brain_serving.mv_<mart>; in (retired) dbt mode the dbt base
# table. PG-sourced marts (source="pg") always read Postgres regardless of mode.
SR_JDBC_URL = os.environ.get("PARITY_SR_JDBC_URL", "jdbc:mysql://starrocks:9030")
SR_USER = os.environ.get("PARITY_SR_USER", "root")
SR_PASSWORD = os.environ.get("PARITY_SR_PASSWORD", "")
# A few marts' current SoR is still Postgres (e.g. operational ledgers not yet on StarRocks). Those
# specs set source="pg" and are read with the same superuser RLS-bypass posture as the Bronze oracle.
PG_JDBC_URL = os.environ.get("PARITY_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
PG_USER = os.environ.get("PARITY_PG_USER", "brain")
PG_PASSWORD = os.environ.get("PARITY_PG_PASSWORD", "brain")

# Allowed transient row-identity delta (one side mid-batch during dual-run). Money Σ tolerance is
# SEPARATE and defaults to ZERO — money must be exact (V4 rule 5). A persistent row drift above the
# row tolerance, or ANY money delta above the money tolerance, fails the gate.
ROW_TOLERANCE = int(os.environ.get("PARITY_ROW_TOLERANCE", "0"))
MONEY_TOLERANCE = int(os.environ.get("PARITY_MONEY_TOLERANCE", "0"))

# Optional single-brand scoping — restrict BOTH sides to one tenant (faster local checks / per-brand gate).
BRAND_ID = os.environ.get("PARITY_BRAND_ID", "").strip() or None


def build_spark() -> SparkSession:
    """Spark session with the Iceberg REST catalog + MinIO S3 wiring.

    Mirrors ../iceberg_base.build_spark's catalog wiring. The warehouse here is set per-layer at table-read
    time via `spark.read` is NOT enough for a REST catalog (the warehouse is a catalog-level property),
    so we register the catalog with the GOLD warehouse by default and rely on the REST catalog resolving
    each namespace's own metadata location (the REST catalog is the source of truth for table locations;
    the warehouse is only the default root for NEW tables — reads resolve from catalog metadata). Both
    brain_silver and brain_gold live under the same REST catalog and are addressable as rest.<ns>.<tbl>.
    """
    return (
        SparkSession.builder.appName("parity-oracle")
        .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
        .config(f"spark.sql.catalog.{CATALOG}", "org.apache.iceberg.spark.SparkCatalog")
        .config(f"spark.sql.catalog.{CATALOG}.type", "rest")
        .config(f"spark.sql.catalog.{CATALOG}.uri", ICEBERG_REST_URI)
        .config(f"spark.sql.catalog.{CATALOG}.warehouse", os.environ.get("PARITY_WAREHOUSE", GOLD_WAREHOUSE))
        .config(f"spark.sql.catalog.{CATALOG}.io-impl", "org.apache.iceberg.aws.s3.S3FileIO")
        .config(f"spark.sql.catalog.{CATALOG}.s3.endpoint", S3_ENDPOINT)
        .config(f"spark.sql.catalog.{CATALOG}.s3.path-style-access", "true")
        .config(f"spark.sql.catalog.{CATALOG}.s3.access-key-id", os.environ.get("AWS_ACCESS_KEY_ID", "brain"))
        .config(f"spark.sql.catalog.{CATALOG}.s3.secret-access-key", os.environ.get("AWS_SECRET_ACCESS_KEY", "brainbrain"))
        .getOrCreate()
    )


def _emit(payload: dict) -> None:
    """One machine-greppable structured line: `PARITY_RESULT <k=v …> json=<...>`.

    A stable prefix + flat k=v pairs for grep/CI, plus the full structured payload as JSON for tooling.
    """
    flat = " ".join(
        f"{k}={payload[k]}" for k in ("mart", "status", "row_delta", "money_delta", "reason") if k in payload and payload[k] is not None
    )
    print(f"\nPARITY_RESULT {flat} json={json.dumps(payload, default=str)}", flush=True)


def _iceberg_namespace(spec: MartSpec) -> str:
    return os.environ.get("SILVER_NAMESPACE", "brain_silver") if spec.layer == "silver" else os.environ.get("GOLD_NAMESPACE", "brain_gold")


def _read_new(spark: SparkSession, spec: MartSpec):
    """Read the NEW Iceberg mart. Returns None if the table/namespace doesn't exist yet (graceful skip)."""
    ns = _iceberg_namespace(spec)
    fqtn = f"{CATALOG}.{ns}.{spec.name}"
    try:
        df = spark.table(fqtn)
        df.schema  # force metadata resolution NOW so an absent table/namespace raises here, not later
    except (AnalysisException, Exception) as exc:  # noqa: BLE001 — REST catalog raises NoSuchNamespace as a
        # generic Py4J error (not AnalysisException), so we match on the message for the absent-mart cases
        # and re-raise anything else (a real connectivity/schema error must NOT masquerade as a graceful skip).
        msg = str(exc).lower()
        if any(s in msg for s in (
            "not found", "table_or_view_not_found", "cannot be found", "does not exist",
            "no such", "cannot find", "nosuchtable", "nosuchnamespace", "namespace does not exist",
        )):
            return None
        raise
    if BRAND_ID:
        df = df.where(F.col("brand_id") == BRAND_ID)
    return df


def _baseline_target(spec: MartSpec) -> tuple:
    """Resolve the BASELINE side (store + schema.table) for this mart, honouring PARITY_BASELINE.

    Returns (is_starrocks, db_qualified). PG-sourced marts (source="pg") always read Postgres. In
    serving mode the StarRocks baseline is brain_serving.mv_<mart>; in retired dbt mode it is the dbt
    base table spec.current_schema.<mart>.
    """
    if spec.source == "pg":
        # An operational ledger whose baseline is still Postgres — unaffected by the dbt→serving switch.
        return False, f"{spec.current_schema}.{spec.name}"
    if PARITY_BASELINE == "serving":
        # Serving parity: the mv_* the app reads must equal its Iceberg source (mart names carry their
        # silver_/gold_/snap_ prefix, so the MV is exactly mv_<spec.name>).
        return True, f"{SERVING_SCHEMA}.mv_{spec.name}"
    # RETIRED dbt baseline (brain_gold/brain_silver dropped in 6b → will SKIP as current-mart-absent).
    return True, f"{spec.current_schema}.{spec.name}"


def _read_current(spark: SparkSession, spec: MartSpec):
    """Read the BASELINE mart (serving MV / retired dbt base table / PG) over JDBC. None if absent (skip)."""
    is_sr, db_qualified = _baseline_target(spec)
    if is_sr:  # StarRocks (MySQL wire) — serving MV or dbt base table
        url, user, pw, driver = SR_JDBC_URL, SR_USER, SR_PASSWORD, "com.mysql.cj.jdbc.Driver"
    else:  # Postgres
        url, user, pw, driver = PG_JDBC_URL, PG_USER, PG_PASSWORD, "org.postgresql.Driver"

    is_sr = spec.source != "pg"

    def _text(c: str) -> str:
        return f"CAST({c} AS CHAR) AS {c}" if is_sr else f"{c}::text AS {c}"

    def _money(c: str) -> str:
        return f"CAST({c} AS SIGNED) AS {c}" if is_sr else f"{c}::bigint AS {c}"

    # SELECT only the columns the oracle needs (PK + brand + currency + money), de-duplicated and in a
    # stable order (brand_id is always in the PK, so never select it twice). Cast keys to text + money to
    # signed bigint so the two engines' native types compare cleanly for the same logical column.
    text_cols: List[str] = []  # de-duped set of identity/dimension columns to cast as text
    for c in (["brand_id"] + list(spec.pk) + (["currency_code"] if spec.money_columns else [])):
        if c not in text_cols:
            text_cols.append(c)
    cols = [_text(c) for c in text_cols] + [_money(m) for m in spec.money_columns]
    where = f" WHERE brand_id = '{BRAND_ID}'" if BRAND_ID else ""
    query = f"SELECT {', '.join(cols)} FROM {db_qualified}{where}"
    try:
        return (
            spark.read.format("jdbc")
            .option("url", url)
            .option("user", user)
            .option("password", pw)
            .option("driver", driver)
            .option("query", query)
            .load()
        )
    except Exception as exc:  # noqa: BLE001 — JDBC raises a generic Py4J error for an unknown table
        msg = str(exc).lower()
        if "doesn't exist" in msg or "does not exist" in msg or "unknown table" in msg or "not found" in msg or "undefined table" in msg:
            return None
        raise


def _row_parity(new_df, cur_df, spec: MartSpec):
    """Distinct-PK identity comparison, per brand. Returns (new_n, cur_n, miss_in_new, miss_in_cur, by_brand_df)."""
    keys = spec.pk
    new_k = new_df.select(*keys).dropDuplicates()
    cur_k = cur_df.select(*keys).dropDuplicates()
    new_n = new_k.count()
    cur_n = cur_k.count()
    miss_in_new = cur_k.subtract(new_k)   # in CURRENT, not yet in NEW
    miss_in_cur = new_k.subtract(cur_k)   # in NEW, not in CURRENT
    by_brand = (
        cur_df.groupBy("brand_id").agg(F.countDistinct(*keys).alias("current"))
        .join(new_df.groupBy("brand_id").agg(F.countDistinct(*keys).alias("new")), "brand_id", "outer")
        .fillna(0)
        .withColumn("delta", F.col("current") - F.col("new"))
    )
    return new_n, cur_n, miss_in_new.count(), miss_in_cur.count(), by_brand


def _money_parity(new_df, cur_df, spec: MartSpec):
    """Per-(brand,currency) minor-unit Σ of every money column on each side. Returns the joined deltas df
    and the worst absolute delta across all (brand,currency,column) cells."""
    if not spec.money_columns:
        return None, 0
    grp = ["brand_id", "currency_code"]
    agg_new = new_df.groupBy(*grp).agg(*[F.sum(F.col(m)).alias(f"new_{m}") for m in spec.money_columns])
    agg_cur = cur_df.groupBy(*grp).agg(*[F.sum(F.col(m)).alias(f"cur_{m}") for m in spec.money_columns])
    joined = agg_new.join(agg_cur, grp, "outer").fillna(0)
    worst = 0
    for m in spec.money_columns:
        joined = joined.withColumn(f"delta_{m}", F.col(f"cur_{m}") - F.col(f"new_{m}"))
        row = joined.select(F.max(F.abs(F.col(f"delta_{m}"))).alias("w")).first()
        worst = max(worst, int(row["w"] or 0))
    return joined, worst


def check_mart(spark: SparkSession, spec: MartSpec) -> bool:
    """Run the full parity check for one mart. Returns True if PASS or SKIP (gate stays open), False on FAIL."""
    _, baseline_tbl = _baseline_target(spec)
    header = f"================ PARITY ORACLE: {spec.name} ({spec.layer}, baseline={PARITY_BASELINE}:{baseline_tbl}) ================"
    print(f"\n{header}", flush=True)
    if BRAND_ID:
        print(f"  scoped to brand_id={BRAND_ID}", flush=True)

    new_df = _read_new(spark, spec)
    if new_df is None:
        _emit({"mart": spec.name, "status": "SKIP", "reason": "new-mart-absent"})
        return True  # the dual-run hasn't built this mart yet — never fail the gate for that

    cur_df = _read_current(spark, spec)
    if cur_df is None:
        _emit({"mart": spec.name, "status": "SKIP", "reason": "current-mart-absent"})
        return True  # net-new V4 entity with no dbt/StarRocks predecessor — nothing to compare against

    new_n, cur_n, miss_in_new, miss_in_cur, by_brand = _row_parity(new_df, cur_df, spec)
    row_delta = miss_in_new + miss_in_cur
    print(f"  PK={spec.pk}", flush=True)
    print(f"  current distinct-PK rows: {cur_n}", flush=True)
    print(f"  new     distinct-PK rows: {new_n}", flush=True)
    print(f"  in CURRENT but MISSING in NEW: {miss_in_new}", flush=True)
    print(f"  in NEW but MISSING in CURRENT: {miss_in_cur}", flush=True)
    print("\n  per-brand distinct-PK counts (current vs new):", flush=True)
    by_brand.orderBy(F.abs(F.col("delta")).desc()).show(20, truncate=False)

    money_join, money_delta = _money_parity(new_df, cur_df, spec)
    if spec.money_columns:
        print(f"  money columns: {spec.money_columns} — per-(brand,currency) minor-unit Σ deltas:", flush=True)
        money_join.orderBy(*[F.abs(F.col(f"delta_{m}")).desc() for m in spec.money_columns]).show(20, truncate=False)

    row_ok = row_delta <= ROW_TOLERANCE
    money_ok = money_delta <= MONEY_TOLERANCE
    status = "PASS" if (row_ok and money_ok) else "FAIL"
    payload = {
        "mart": spec.name,
        "layer": spec.layer,
        "status": status,
        "row_delta": row_delta,
        "row_tolerance": ROW_TOLERANCE,
        "money_delta": money_delta,
        "money_tolerance": MONEY_TOLERANCE,
        "current_rows": cur_n,
        "new_rows": new_n,
        "missing_in_new": miss_in_new,
        "missing_in_current": miss_in_cur,
        "brand_id": BRAND_ID,
    }
    _emit(payload)
    if status == "FAIL":
        print(
            f"  RESULT: ✗ PARITY FAIL — row_delta={row_delta} (tol {ROW_TOLERANCE}), "
            f"money_delta={money_delta} (tol {MONEY_TOLERANCE}) — gate CLOSED",
            flush=True,
        )
        return False
    print(
        f"  RESULT: ✓ PARITY OK — row_delta={row_delta} ≤ {ROW_TOLERANCE}, "
        f"money_delta={money_delta} ≤ {MONEY_TOLERANCE} — gate OPEN",
        flush=True,
    )
    return True


def main() -> None:
    spark = build_spark()
    spark.sparkContext.setLogLevel("ERROR")

    requested = os.environ.get("PARITY_MART", "").strip()
    if requested and requested.lower() != "all":
        specs = [resolve_mart(requested)]
    else:
        specs = list(MARTS.values())

    if PARITY_BASELINE == "dbt":
        print(
            "\n[parity-oracle] ⚠ PARITY_BASELINE=dbt is RETIRED — the dbt-internal brain_gold/brain_silver "
            "DBs were DROPPED in Phase 6b. StarRocks-sourced marts will SKIP (current-mart-absent). "
            "Use PARITY_BASELINE=serving (default) for the live Iceberg⇄brain_serving.mv_* gate.",
            flush=True,
        )
    print(
        f"\n[parity-oracle] baseline={PARITY_BASELINE} "
        f"({'Iceberg ⇄ brain_serving.mv_*' if PARITY_BASELINE == 'serving' else 'Iceberg ⇄ retired dbt base table'})",
        flush=True,
    )
    print(f"[parity-oracle] checking {len(specs)} mart(s): {[s.name for s in specs]}", flush=True)
    all_pass = True
    for spec in specs:
        try:
            ok = check_mart(spark, spec)
        except Exception as exc:  # noqa: BLE001 — surface the mart that exploded, then fail the gate honestly
            _emit({"mart": spec.name, "status": "FAIL", "reason": f"error:{type(exc).__name__}: {exc}"})
            ok = False
        all_pass = all_pass and ok

    if not all_pass:
        print("\n[parity-oracle] OVERALL: ✗ at least one mart FAILED — gate CLOSED", flush=True)
        sys.exit(1)
    print("\n[parity-oracle] OVERALL: ✓ all checked marts PASS or SKIP — gate OPEN", flush=True)


if __name__ == "__main__":
    main()
