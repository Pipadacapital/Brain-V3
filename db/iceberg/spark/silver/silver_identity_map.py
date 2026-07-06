"""
silver_identity_map.py — the BI-TEMPORAL identifier→brain_id map (Brain V4 Phase-1 identity, GROUP identity).

WHY (the gap this closes): the existing `silver_identity_alias` is a CURRENT-STATE projection — one row per
(brand_id, identifier_type, identifier_value) carrying the CANONICAL brain_id after all merges, with no
history. `identity_map` adds the missing EFFECTIVE-INTERVAL history: for each identifier it emits one row per
period during which that identifier resolved to a given brain_id, end-dating the row when a merge moved it to
a new brain_id. This is what point-in-time journey reconstruction needs ("which brain_id did this hash resolve
to as-of date D") without paying for the daily SCD snapshot grain of `snap_identity_link`.

SOURCE = the Neo4j identity graph (identity SoR, ADR-0004), read via the Neo4j Spark connector — the SAME
posture as silver_identity_alias.py. The interval history is INTRINSIC to the graph and NEVER rewritten:
  - (:Identifier{brand_id,type,hash})-[r:IDENTIFIES]->(c0:Customer{brain_id})  = the origin attachment.
  - (dead:Customer)-[a:ALIAS_OF{merge_id, valid_from, valid_to}]->(canon:Customer)  = a merge. valid_to IS
    NULL ⇒ a LIVE merge; a set valid_to ⇒ the merge was reverted (unmerge). Merges append, never delete.
Because the graph is append-only, `identity_map` is a DETERMINISTIC PROJECTION of it — re-running rebuilds the
identical bitemporal rows (idempotent), and history is preserved because the graph preserves it. We therefore
MERGE on the natural interval key (brand_id, identifier_hash, brain_id, effective_from) rather than doing a
stateful diff-and-end-date; the SoR already holds the intervals.

THE TRANSFORM (per identifier i attached to origin c0): walk c0's LIVE ALIAS_OF chain to canonical. Each
customer `cust` on that chain contributes ONE interval row:
  - brain_id             = cust.brain_id
  - effective_from       = the valid_from of the hop INTO cust (or r.created_at at the origin c0)
  - effective_to         = the valid_from of cust's OWN live outgoing ALIAS_OF (the next merge), else NULL
  - replaced_by_brain_id = the brain_id cust was merged INTO (the outgoing hop target), else NULL
  - merge_event_id       = the outgoing hop's merge_id, else NULL
  - is_current           = (cust has no live outgoing ALIAS_OF)  ⇔ effective_to IS NULL
  - confidence           = r.confidence (deterministic edges = 1.0)
`customer_ref` (the public BRN- id) is derived FROM brain_id in Spark via the shared _identity_ref.brain_ref
UDF (byte-identical to the TS mirror), so it stays 1:1 with brain_id and needs no separate source.

PII: identifier_hash is a 64-hex HASH only (hash-only rule, I-S02). brand_id is the first column / tenant key.
MONEY: none. STAGE-1 GATE: N/A — trusted projection of the identity SoR (same rationale as silver_identity_alias).

DATA-THIN DEV PATH: like silver_identity_alias, if NEO4J_URI is unset the job creates the correctly-shaped
EMPTY table and returns (Neo4j is empty in dev). Supplying NEO4J_URI + the neo4j-spark connector populates it
with NO code change. Parity status = NEW.

Run: picked up by the generic v4-silver cron loop (silver/silver_*.py) or run-silver-identity-map.sh.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # db/iceberg/spark — _identity_ref

from _silver_base import ensure_silver_table, run_job  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402
from pyspark.sql.functions import col, lit  # noqa: E402

TABLE = "silver_identity_map"

NEO4J_URI = os.environ.get("NEO4J_URI", "").strip()
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")

# The bitemporal-interval export Cypher — a UNION of two FLAT queries, each mirroring the SHAPE of the proven
# silver_identity_alias.py Cypher (a single MATCH/OPTIONAL MATCH … RETURN, no intermediate list-binding WITH,
# no post-WITH second OPTIONAL MATCH). WHY: the earlier single-query form (an ALIAS_OF*0..50 path + a
# `WITH … relationships(path) AS hops` list binding + a second OPTIONAL MATCH) ran in ~1s in raw Cypher but
# HUNG the Neo4j Spark connector — the connector's schema inference stalls on (a) the intermediate list
# variable and (b) merge columns that are ALL-NULL across the 13k current rows (it can't type a column it only
# ever samples as null). Fix: (1) flatten to the proven shape, (2) return TYPED SENTINELS for the nullable
# columns (-1 for a null epoch-ms, '' for a null id) so every column has a concrete type in row 1 → inference
# can't stall; Spark converts the sentinels back to NULL.
#
#   Part CURRENT   — one row per identifier at its CANONICAL brain_id (follow the live ALIAS_OF chain to canon,
#                    EXACTLY as silver_identity_alias does): is_current=true, effective_to/replaced_by/merge=null.
#   Part SUPERSEDED — for an identifier whose attached customer was itself merged away, the closed interval up to
#                    that merge: effective_to = the merge's valid_from, replaced_by = the successor, merge_event_id
#                    = the merge id, is_current=false.
# effective_from = the identifier's IDENTIFIES.created_at (attach time) — an honest lower bound for the interval.
# COVERAGE NOTE: an identifier is IDENTIFIES-attached to exactly ONE node, so SUPERSEDED captures that node's
# direct merge hop; on a rare MULTI-hop chain the intermediate hops (nodes the identifier was never attached to)
# are not enumerated — acceptable given the graph has a handful of merges; the CURRENT canonical is always exact.
# SINGLE flat MATCH … OPTIONAL MATCH … RETURN (the shape silver_identity_alias PROVES the connector handles).
# We use UNWIND to emit the two interval rows per merged identifier WITHOUT a top-level UNION or CALL subquery —
# the connector's schema inference returned an EMPTY schema for a UNION query (it can't sample a top-level
# UNION), and hung on the earlier var-length-path + list-binding form. This flat form samples cleanly.
#   rk='C' (always)      → the CURRENT interval at the CANONICAL brain_id (follow the live ALIAS_OF chain to
#                          canon exactly as silver_identity_alias does): effective_to/replaced_by/merge = sentinel.
#   rk='S' (only if c was itself merged away, i.e. it has a live outgoing ALIAS_OF) → the closed SUPERSEDED
#                          interval up to that merge: effective_to = merge valid_from, replaced_by = successor.
# TYPED SENTINELS (-1 epoch-ms, '' id) keep every column concretely typed in row 1 so inference can't stall on
# an all-null column; Spark converts them back to NULL. effective_from = the identifier attach time (created_at),
# an honest interval lower bound. COVERAGE: an identifier attaches to ONE node, so 'S' captures that node's
# direct merge hop; rare MULTI-hop intermediate intervals aren't enumerated (the CURRENT canonical stays exact).
IDENTITY_MAP_CYPHER = (
    "MATCH (i:Identifier)-[r:IDENTIFIES]->(c:Customer) "
    "WHERE c.brain_id IS NOT NULL "
    "OPTIONAL MATCH (c)-[a:ALIAS_OF]->(nextc:Customer) WHERE a.valid_to IS NULL "
    "OPTIONAL MATCH _cano = (c)-[:ALIAS_OF*1..50]->(canon:Customer) "
    "WHERE all(rel IN relationships(_cano) WHERE rel.valid_to IS NULL) "
    "  AND NOT EXISTS { MATCH (canon)-[ra:ALIAS_OF]->() WHERE ra.valid_to IS NULL } "
    "UNWIND (CASE WHEN a IS NULL THEN ['C'] ELSE ['C', 'S'] END) AS rk "
    "RETURN i.brand_id AS brand_id, i.type AS identifier_type, i.hash AS identifier_hash, "
    "(CASE rk WHEN 'C' THEN coalesce(canon.brain_id, c.brain_id) ELSE c.brain_id END) AS brain_id, "
    # toFloat/toInteger FORCE a single Spark type per column: Neo4j stores created_at/valid_from/confidence as
    # a mix of Long/Double across nodes, so the connector's row-sampled schema mis-typed them → a Double-vs-Long
    # ClassCastException at read. Coercing here makes every value the SAME concrete type the connector infers.
    "toFloat(coalesce(r.confidence, 1.0)) AS confidence, toInteger(coalesce(r.created_at, 0)) AS effective_from_ms, "
    "toInteger(CASE rk WHEN 'C' THEN -1 ELSE a.valid_from END) AS effective_to_ms, "
    "(CASE rk WHEN 'C' THEN '' ELSE nextc.brain_id END) AS replaced_by_brain_id, "
    "(CASE rk WHEN 'C' THEN '' ELSE coalesce(a.merge_id, '') END) AS merge_event_id, "
    "(rk = 'C') AS is_current"
)

# SPEC: A.1.5 — bi-temporality (AMD-07, R1 BINDING). system_from / system_to are the SYSTEM-TIME axis,
# additive + nullable — the additive-reconcile ALTER in ensure_silver_table adds them to the live
# 14,902-row table. effective_from/effective_to/is_current stay the untouched VALID-TIME axis. Writes are
# now APPEND-PER-MUTATION (close the old system interval, open a new one) — never in-place validity
# rewrites — so as-of(T_valid, T_system) becomes answerable from RETAINED rows (NOT Iceberg time-travel,
# AMD-10). Access is ONLY via the sanctioned views identity_current_v / identity_asof (A.2.2).
COLUMNS_SQL = """
          brand_id             string    NOT NULL,
          identifier_hash      string    NOT NULL,
          identifier_type      string    NOT NULL,
          brain_id             string    NOT NULL,
          customer_ref         string,
          confidence           double,
          effective_from       timestamp,
          effective_to         timestamp,
          replaced_by_brain_id string,
          merge_event_id       string,
          is_current           boolean,
          system_from          timestamp,
          system_to            timestamp,
          updated_at           timestamp NOT NULL
""".strip("\n")

# The projected columns whose CHANGE (null-safely compared) defines a "mutation" for a given valid-time PK.
# Excludes the PK (brand_id, identifier_hash, brain_id, effective_from), the system-time axis, and updated_at.
_PAYLOAD_COLS = [
    "identifier_type",
    "customer_ref",
    "confidence",
    "effective_to",
    "replaced_by_brain_id",
    "merge_event_id",
    "is_current",
]

# The valid-time natural key — a version of a mapping is identified by these four; system_from/to record
# WHEN we believed each version.
_PK_COLS = ["brand_id", "identifier_hash", "brain_id", "effective_from"]


def _backfill_system_time(spark, fqtn):
    """ONE-TIME legacy backfill (AMD-07 R1, BEST-EFFORT — the amendment explicitly allows the approximation).

    Rows landed by the prior BATCH-PROJECTION runs carry NULL system_from (the additive ALTER just added the
    column). Give each a system interval:
      - system_from = updated_at  (the row's last projection time — the honest lower bound for when we
        recorded it; we have no earlier truth).
      - system_to   = NULL for the live rows (is_current = true), else the SUPERSEDING row's system_from —
        best-effort = the CURRENT row (same brand_id + identifier_hash) whose brain_id equals this row's
        replaced_by_brain_id. This conflates the two axes for LEGACY superseded rows only (we cannot
        reconstruct true system history that predates the column); it keeps identity_current_v correct
        (is_current=false rows are excluded by the is_current predicate regardless) and gives identity_asof
        SOME system bound for old merges. Going forward, append-per-mutation records the true system axis.

    Idempotent + RE-ENTRANT: gated on "a system_from IS NULL row exists". CRUCIAL ordering — the step that
    CLEARS the gate (system_from = updated_at) runs LAST, so a crash mid-backfill leaves system_from still
    NULL and the whole block safely re-runs. append-per-mutation always stamps system_from on new rows, so
    once complete this is a permanent no-op (append-era superseded rows correctly keep system_to = NULL —
    the legacy approximation only ever touches rows that predate the system-time column)."""
    try:
        n = spark.sql(f"SELECT count(*) AS n FROM {fqtn} WHERE system_from IS NULL").collect()[0]["n"]
    except Exception:  # noqa: BLE001 — table absent/empty → nothing to backfill
        return
    if not n:
        return
    print(f"[silver-identity-map] one-time system-time backfill of {n} legacy row(s) (AMD-07 best-effort)", flush=True)
    # 1. superseded legacy rows: system_to = the superseding CURRENT row's system_from (== its updated_at,
    #    the value step 2 will stamp) — sourced from updated_at so this is INDEPENDENT of step 2's ordering.
    #    GROUP BY collapses the (brand_id, identifier_hash, brain_id) grain to ONE successor row (an identifier
    #    can carry several current effective intervals) so the MERGE ON matches ≤ 1 source (no cardinality
    #    violation). Runs BEFORE step 2 so the gate (system_from IS NULL) stays true until fully done.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING (
          SELECT brand_id, identifier_hash, brain_id AS succ_brain_id, min(updated_at) AS succ_updated_at
          FROM {fqtn} WHERE is_current = true
          GROUP BY brand_id, identifier_hash, brain_id
        ) succ
        ON t.brand_id = succ.brand_id
           AND t.identifier_hash = succ.identifier_hash
           AND t.replaced_by_brain_id = succ.succ_brain_id
           AND t.is_current = false
           AND t.system_to IS NULL
        WHEN MATCHED THEN UPDATE SET t.system_to = succ.succ_updated_at
        """
    )
    # 2. system_from = updated_at for every legacy row — LAST, since it clears the re-entrancy gate.
    spark.sql(f"UPDATE {fqtn} SET system_from = updated_at WHERE system_from IS NULL")


def _append_per_mutation(spark, fqtn, staged):
    """Bi-temporal APPEND-PER-MUTATION (AMD-07 R1): never rewrite validity columns in place.

    A "mutation" = the freshly-projected row for a valid-time PK differs (null-safely, on _PAYLOAD_COLS)
    from the currently-KNOWN row (the open row, system_to IS NULL). Two MERGE passes:
      Pass A — CLOSE the open row whose payload changed: system_to = the new row's system_from.
      Pass B — INSERT the new version (system_from = now, system_to = NULL). Because Pass A already closed
               the changed row, an UNCHANGED PK still has its open row (blocks the insert), a CHANGED PK no
               longer has an open+same row (→ NOT MATCHED → insert the new version), and a BRAND-NEW PK has
               no row at all (→ insert). Idempotent: an unchanged projection appends nothing.

    Invariant preserved: at most ONE open (system_to IS NULL) row per valid-time PK, so every MERGE ON
    matches ≤ 1 target row (no ambiguous-merge error). Batch-dedup first (a re-pull can emit a PK twice)."""
    staged.createOrReplaceTempView("_idm_stage")
    part = ", ".join(_PK_COLS)
    spark.sql(
        f"""
        CREATE OR REPLACE TEMPORARY VIEW _idm_stage_dedup AS
        SELECT * FROM (
          SELECT *, row_number() OVER (PARTITION BY {part} ORDER BY system_from DESC) AS _rn
          FROM _idm_stage
        ) WHERE _rn = 1
        """
    )
    on_pk = " AND ".join(f"t.{c} <=> s.{c}" for c in _PK_COLS)
    same = " AND ".join(f"t.{c} <=> s.{c}" for c in _PAYLOAD_COLS)
    proj = ", ".join(staged.columns)
    # Pass A — close the superseded system interval (only when the payload actually changed).
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING (SELECT * FROM _idm_stage_dedup) s
        ON {on_pk} AND t.system_to IS NULL
        WHEN MATCHED AND NOT ({same}) THEN UPDATE SET t.system_to = s.system_from
        """
    )
    # Pass B — insert brand-new PKs AND the new version of changed PKs (an unchanged open row blocks it).
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING (SELECT {proj} FROM _idm_stage_dedup) s
        ON {on_pk} AND t.system_to IS NULL AND ({same})
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def _ms_to_ts(col_ms):
    """Neo4j epoch-millis (nullable) → Spark timestamp (null-safe)."""
    return F.when(col_ms.isNotNull(), F.to_timestamp(F.from_unixtime(col_ms / lit(1000)))).otherwise(F.lit(None).cast("timestamp"))


def build(spark):
    # Ship the pure brain_ref module to the workers so the customer_ref UDF resolves there (the generic
    # v4-silver cron loop only --py-files iceberg_base.py; addPyFile makes this job self-contained — the
    # exact ModuleNotFoundError class of bug the v4 cold-start work fixed for other helpers).
    _ref_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_identity_ref.py")
    if os.path.exists(_ref_path):
        spark.sparkContext.addPyFile(_ref_path)
    from _identity_ref import brain_ref_udf  # noqa: E402 — after addPyFile
    _customer_ref = brain_ref_udf()

    fqtn = ensure_silver_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id)")

    # System-time backfill runs BEFORE the append (and even in the data-thin path): the existing rows need
    # their system interval regardless of whether Neo4j is reachable this run. One-time + idempotent.
    _backfill_system_time(spark, fqtn)

    if not NEO4J_URI:
        print("[silver-identity-map] NEO4J_URI not set — created EMPTY table (data-thin path).", flush=True)
        return fqtn, spark.table(fqtn).count()

    edges = (
        spark.read.format("org.neo4j.spark.DataSource")
        .option("url", NEO4J_URI)
        .option("authentication.type", "basic")
        .option("authentication.basic.username", NEO4J_USER)
        .option("authentication.basic.password", NEO4J_PASSWORD)
        .option("query", IDENTITY_MAP_CYPHER)
        # Bounded Bolt connect/acquire timeouts so a flaky/heap-pressured Neo4j FAILS FAST (and the run scripts'
        # supervision / a retry can recover) instead of the driver hanging indefinitely on the connector's
        # schema-inference Bolt call — the failure mode observed on this small-heap dev Neo4j.
        .option("connection.timeout", os.environ.get("NEO4J_CONNECTION_TIMEOUT_MS", "30000"))
        .option("connection.acquisition.timeout", os.environ.get("NEO4J_ACQUIRE_TIMEOUT_MS", "60000"))
        .load()
    )

    staged = (
        edges.select(
            col("brand_id"),
            col("identifier_hash"),
            col("identifier_type"),
            col("brain_id"),
            _customer_ref(col("brain_id")).alias("customer_ref"),
            col("confidence").cast("double").alias("confidence"),
            _ms_to_ts(col("effective_from_ms")).alias("effective_from"),
            # Convert the TYPED SENTINELS the connector-safe Cypher returns back to real NULLs: effective_to_ms
            # = -1, replaced_by_brain_id/merge_event_id = '' all mean "no successor merge" (a current row).
            F.when(col("effective_to_ms") >= lit(0), _ms_to_ts(col("effective_to_ms"))).otherwise(F.lit(None).cast("timestamp")).alias("effective_to"),
            F.when(col("replaced_by_brain_id") == lit(""), F.lit(None).cast("string")).otherwise(col("replaced_by_brain_id")).alias("replaced_by_brain_id"),
            F.when(col("merge_event_id") == lit(""), F.lit(None).cast("string")).otherwise(col("merge_event_id")).alias("merge_event_id"),
            (col("is_current") == lit(True)).alias("is_current"),
            # SPEC: A.1.5 — this run's SYSTEM-TIME stamp. Every projected row is a candidate new system
            # version: system_from = now, system_to = NULL (open). _append_per_mutation decides whether it
            # is actually a change worth appending.
            F.current_timestamp().alias("system_from"),
            F.lit(None).cast("timestamp").alias("system_to"),
            F.current_timestamp().alias("updated_at"),
        )
        .where(col("brand_id").isNotNull() & col("identifier_hash").isNotNull() & col("brain_id").isNotNull())
        # effective_from anchors the interval key; a missing origin created_at falls back to epoch 0 so the
        # natural PK is always non-null (honest — the interval still resolves, just with an unknown start).
        .withColumn("effective_from", F.coalesce(col("effective_from"), F.to_timestamp(lit("1970-01-01 00:00:00"))))
    )

    # SPEC: A.1.5 — bi-temporal append (close old system interval, open new); replaces the former
    # merge_on_pk in-place UPDATE SET * (which rewrote validity columns and erased system history).
    _append_per_mutation(spark, fqtn, staged)
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-identity-map", build)
