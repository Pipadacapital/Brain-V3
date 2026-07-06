"""
silver_session_identity_test.py — Brain V4 CI guard: the Stitch v2 job (silver_session_identity.py,
WA-16 / A.2.1/A.2.3/A.2.5 / AMD-13) keeps its deterministic-stitch invariants.

WHY THIS EXISTS
  Stitch v2 resolves each unstitched session's identifier set through the sanctioned identity view and
  branches on |B|. The whole guarantee — "link only when unambiguous, NEVER guess" — rests on a handful of
  SQL/logic invariants, each with a real failure mode. This guard nets them WITHOUT a SparkSession (the
  module imports pyspark, so we read its SOURCE — the composite_dedup_guard_test.py / gate_admission_guard
  pattern), so it runs in the unit lane:

    1. TENANT ISOLATION — brand_id is the FIRST column of BOTH new Iceberg tables, and every resolution
       join carries brand_id (a cross-brand hash match would leak identities across tenants).
    2. SESSION GRAIN — a session is (brand_id, brain_anon_id, session_id_raw); the MERGE key session_id is
       the brand-unique concat(brain_anon_id, ':', session_id_raw). session_key is a 32-bit hash (NOT
       injective — collides at golden volume) and must NOT key the target; the MERGE source is dedup-guarded.
    3. |B| BRANCHING — size(brain_ids)==1 → silver_session_identity (LINK); size>1 → silver_stitch_conflicts
       (NEVER guess); size 0 is written nowhere (unstitched). stitch_version is the literal 2.
    4. SHARED-DEVICE 90d RULE (A.2.3.4) — a stale anon match (older than SHARED_DEVICE_RECENCY_DAYS, default
       90) is DROPPED, and ONLY the anon lane is recency-gated (strong ids are never dropped).
    5. HASH SPACES (AMD-01) — interop email/phone hashes are used AS-IS (already plain sha256); anon /
       platform / checkout are SALTED external_id hashes = sha2(salt || '||' || trim(value), 256).
    6. SANCTIONED VIEW — resolution goes through identity_current (A.2.2), never a raw silver_identity_map read.
    7. FLAG GATE (§0.5) — the job reads the per-brand stitch.v2 flag and NO-OPS when no brand is enabled.
    8. LEGACY DUAL-WRITE — unambiguous-only (reads the stitched set) + idempotent upsert into
       ops.silver_journey_stitch (the AMD-13 legacy SoR).
    9. REVIEW BRIDGE — only conflicts with ≥2 STRONG brain_ids are enqueued (shared-device conflicts are
       NEVER merge-enqueued); enqueue is idempotent (deterministic uuid5 + ON CONFLICT DO NOTHING).
   10. HASH-ONLY / NO MONEY — no raw-PII column and no monetary column in either new table.

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions):
  python3 db/iceberg/spark/silver/silver_session_identity_test.py
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

_THIS = Path(__file__).resolve()
SILVER_DIR = _THIS.parent
JOB_FILE = SILVER_DIR / "silver_session_identity.py"
MIGRATION_FILE = SILVER_DIR.parents[2] / "migrations" / "0123_stitch_conflict_review.sql"

_SRC = JOB_FILE.read_text()


def _extract_constant(name: str):
    # Read a module-level constant (plain assignment or a triple-quoted-then-.strip() block).
    tree = ast.parse(_SRC)
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id == name:
                    v = node.value
                    if isinstance(v, ast.Constant):
                        return v.value
                    if (isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute)
                            and isinstance(v.func.value, ast.Constant)):
                        return v.func.value.value
    raise AssertionError(f"could not find constant `{name}` in {JOB_FILE}")


def _cols(schema_sql: str) -> "list[str]":
    """Ordered column names from a `name type ...,` Iceberg column block."""
    out = []
    for line in schema_sql.splitlines():
        line = line.strip().rstrip(",")
        if not line:
            continue
        out.append(line.split()[0])
    return out


# ── 1. Tenant isolation: brand_id FIRST in both tables ───────────────────────────────────────────
def test_brand_id_first_both_tables() -> None:
    for const in ("_SESSION_IDENTITY_COLUMNS", "_STITCH_CONFLICTS_COLUMNS"):
        cols = _cols(_extract_constant(const))
        assert cols[0] == "brand_id", f"{const}: brand_id must be the FIRST column, got {cols[0]}"


def test_resolution_joins_carry_brand_id() -> None:
    # Identifier→brain resolution + the session/event join must both be brand-scoped.
    assert 'join(F.broadcast(cur), ["brand_id", "identifier_hash"], "inner")' in _SRC, \
        "identity resolution join must be on (brand_id, identifier_hash) — no cross-brand hash match"
    assert 'ev["brand_id"] == sessions["brand_id"]' in _SRC, "event→session join must carry brand_id"


# ── 2. Session grain ─────────────────────────────────────────────────────────────────────────────
def test_session_id_is_brand_unique_grain() -> None:
    # session_id MUST key on the collision-free session_id_raw, NOT the 32-bit session_key hash (which
    # collides at golden volume → two source rows per session_id → MERGE_CARDINALITY_VIOLATION).
    assert 'F.concat_ws(":", F.col("brain_anon_id"), F.col("session_id_raw"))' in _SRC, \
        "session_id must be concat(brain_anon_id, ':', session_id_raw) — the injective per-session key"
    assert 'F.col("session_key").cast("string")' not in _SRC, \
        "session_id must NOT be keyed on the 32-bit session_key hash (non-injective → cardinality violation)"
    si = _cols(_extract_constant("_SESSION_IDENTITY_COLUMNS"))
    for c in ("session_id", "brain_anon_id", "session_key", "brain_id"):
        assert c in si, f"silver_session_identity must carry `{c}`"


def test_merge_source_has_no_duplicate_keys_guard() -> None:
    # BLOCKER-2 regression guard: BOTH MERGE sources must be dedup-guarded to one row per (brand_id,
    # session_id) so the Spark MERGE can never match a target row from multiple source rows.
    guards = _SRC.count('.dropDuplicates(["brand_id", "session_id"])')
    assert guards >= 2, (
        "both the stitch (_session_identity_new) and conflict (_stitch_conflicts_new) MERGE sources must "
        f"carry .dropDuplicates([\"brand_id\", \"session_id\"]); found {guards}/2"
    )


# ── 3. |B| branching + stitch_version = 2 ────────────────────────────────────────────────────────
def test_b_branching() -> None:
    # Priority-resolved (A.1.5): a WINNER (unambiguous strong id, or anon-alone) → LINK; else if ≥2 brains
    # matched → CONFLICT (never guess); else unstitched (skipped, written nowhere).
    assert 'per_session.where(F.col("winner_brain_id").isNotNull())' in _SRC, "winner → LINK branch missing"
    assert 'F.col("winner_brain_id").isNull() & (F.size("brain_ids") > 1)' in _SRC, \
        "no-winner + ≥2 brains → CONFLICT branch missing"
    assert 'F.size("brain_ids") == 0' not in _SRC, "size-0 sessions must be skipped, not written"
    assert _extract_constant("STITCH_VERSION") == 2, "stitch_version must be the literal 2"


def test_priority_strong_wins_over_ambiguous_anon() -> None:
    # A.1.5: a single strong brain wins when the anon is empty OR ambiguously contains it (multi_device);
    # a single anon brain wins only when NO strong id matched (anon-alone).
    assert "F.array_contains(F.col(\"anon_brain_ids\"), strong0)" in _SRC, \
        "strong must win over an ambiguous anon that contains it (multi_device stitch)"
    assert "(n_strong == 0) & (n_anon == 1)" in _SRC, "anon-alone link only when no strong id matched"


def test_merge_keys_are_brand_and_session() -> None:
    merges = re.findall(r"MERGE INTO[\s\S]*?ON ([^\n]+)", _SRC)
    assert merges, "expected MERGE statements for both Iceberg tables"
    for on in merges:
        assert "t.brand_id = s.brand_id" in on and "t.session_id = s.session_id" in on, \
            f"MERGE must key on (brand_id, session_id) — replay-safe; got: {on}"


# ── 4. Shared-device 90d rule ────────────────────────────────────────────────────────────────────
def test_shared_device_recency_rule() -> None:
    assert 'os.environ.get("SHARED_DEVICE_RECENCY_DAYS", "90")' in _SRC, "default recency must be 90 days"
    # Only the anon lane is recency-gated; the gate DROPS stale anon matches.
    assert 'F.col("src_type") == F.lit("anonymous_id")' in _SRC, "recency gate must target the anon lane only"
    assert "~stale_anon" in _SRC, "stale anon matches must be DROPPED (~stale_anon) before |B| is computed"
    assert "INTERVAL {SHARED_DEVICE_RECENCY_DAYS} DAYS" in _SRC, "recency window must use the configured days"


# ── 5. Hash spaces (AMD-01): interop plain vs salted external_id ─────────────────────────────────
def test_hash_spaces() -> None:
    # Interop email/phone hashes are used verbatim (already plain sha256 — the pixel/connector interop space).
    assert '"email", F.col("email_hash")' in _SRC, "email hash must be used AS-IS (interop plain space)"
    assert '"phone", F.col("phone_hash")' in _SRC, "phone hash must be used AS-IS (interop plain space)"
    # Salted external_id = sha256( salt || '||' || trim(value) ) — matches _raw_normalize.hash_identifier.
    assert 'F.sha2(F.concat(F.coalesce(F.col("salt_hex")' in _SRC and 'F.lit("||"), F.trim(' in _SRC, \
        "anon/platform must be SALTED external_id: sha2(salt || '||' || trim(value), 256)"


def test_email_phone_are_strong_anon_is_weak() -> None:
    assert '"email", F.col("email_hash"), True' in _SRC and '"phone", F.col("phone_hash"), True' in _SRC, \
        "email/phone are STRONG identifiers"
    assert '"anonymous_id", _salted(F.col("anon")), False' in _SRC, "anonymous_id is a WEAK identifier"


# ── 6. Sanctioned identity view only ─────────────────────────────────────────────────────────────
def test_uses_sanctioned_identity_view() -> None:
    assert "from _identity_views import identity_current" in _SRC
    assert "identity_current(spark)" in _SRC
    assert "spark.table" not in _SRC.split("identity_current(spark)")[0].rsplit("silver_identity_map", 1)[0] \
        or "silver_identity_map" not in _SRC, \
        "must resolve via identity_current(), never a raw silver_identity_map read"


# ── 7. Flag gate ─────────────────────────────────────────────────────────────────────────────────
def test_flag_gated_default_off() -> None:
    assert "is_flag_enabled(b, FLAG_STITCH_V2)" in _SRC, "per-brand stitch.v2 gate required"
    assert "if not brands:" in _SRC and "no-op" in _SRC, "must NO-OP when no brand has stitch.v2 ON"


# ── 8. Legacy dual-write (AMD-13) ────────────────────────────────────────────────────────────────
def test_legacy_dual_write() -> None:
    assert 'spark.table("_stitched_sessions")' in _SRC, "dual-write must read the UNAMBIGUOUS stitched set"
    assert "INSERT INTO ops.silver_journey_stitch" in _SRC, "legacy mirror target = ops.silver_journey_stitch"
    assert "ON CONFLICT (brand_id, order_id) DO UPDATE" in _SRC, "dual-write must be an idempotent upsert"
    assert "stitched_anon_id" in _SRC and "brain_id" in _SRC


# ── 9. Conflict → merge-review bridge ────────────────────────────────────────────────────────────
def test_review_bridge_strong_only_and_idempotent() -> None:
    assert 'F.size("strong_brain_ids") >= 2' in _SRC, \
        "only conflicts with >=2 STRONG brain_ids may be enqueued (shared-device conflicts are NOT merged)"
    assert "INSERT INTO ops.stitch_conflict_review" in _SRC
    assert "ON CONFLICT (brand_id, review_id) DO NOTHING" in _SRC, "enqueue must be idempotent"
    assert "uuid.uuid5(" in _SRC, "review_id must be DETERMINISTIC (uuid5) so re-runs don't duplicate"


def test_migration_table_is_brand_first_hashed_evidence() -> None:
    mig = MIGRATION_FILE.read_text()
    assert "CREATE TABLE IF NOT EXISTS ops.stitch_conflict_review" in mig
    assert "FORCE  ROW LEVEL SECURITY" in mig or "FORCE ROW LEVEL SECURITY" in mig, "review table must FORCE RLS"
    assert "HASHED identifiers only" in mig, "review evidence must be hash-only (no raw PII)"
    # brand_id first data column of the table.
    body = mig.split("CREATE TABLE IF NOT EXISTS ops.stitch_conflict_review", 1)[1]
    first_col = body.split("(", 1)[1].strip().splitlines()[0].strip()
    assert first_col.startswith("brand_id"), f"review table first column must be brand_id, got: {first_col}"


# ── 10. Hash-only / no money ─────────────────────────────────────────────────────────────────────
def test_no_raw_pii_no_money_columns() -> None:
    for const in ("_SESSION_IDENTITY_COLUMNS", "_STITCH_CONFLICTS_COLUMNS"):
        cols = _cols(_extract_constant(const))
        for c in cols:
            lc = c.lower()
            assert "email" not in lc or "hash" in lc, f"{const}: raw-email-shaped column `{c}`"
            assert not lc.endswith("phone"), f"{const}: raw-phone-shaped column `{c}`"
            assert "amount" not in lc and "minor" not in lc and "currency" not in lc and "revenue" not in lc, \
                f"{const}: money column `{c}` — stitch tables carry NO money"


def _run() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ok  {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    import sys
    sys.exit(_run())
