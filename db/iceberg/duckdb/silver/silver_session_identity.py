# SPEC: A.2.1 / A.2.3 / A.2.3.5 / A.2.5 (WA-16, WA-18, AMD-08, AMD-13) — Deterministic Multi-Key Session Stitch (Stitch v2).
"""
silver_session_identity.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_session_identity.py.

The deterministic multi-key session stitch (A.2): one row per LINKED (brand_id, session_id) resolving a
session's full identifier set through the sanctioned identity view (identity_current) to a SINGLE canonical
brain_id. A session links to a customer sharing ANY common identifier (anon / email / phone / platform id /
checkout session id) UNAMBIGUOUSLY — and NEVER guesses: a session whose identifiers resolve to >1 brain_id
is dropped (it is written to silver_stitch_conflicts by the Spark job; see the SIDE-EFFECTS note below).

WHAT THIS PORT REPRODUCES (the parity target = brain_silver.silver_session_identity, 9049 rows):
  the Iceberg TABLE CONTENT of the deterministic |B|=1 LINK path only — every column of every stitched row.
  The Spark job additionally performs three OPERATIONAL side-effects that DO NOT change this table's content
  and are therefore SKIPPED here (documented, exactly like the quarantine skip in every other ported job):
    • silver_stitch_conflicts     — the never-guess |B|>1 AUDIT table (a SEPARATE Iceberg table; not this one).
    • the legacy PG dual-write     — ops.silver_journey_stitch mirror (an ops-schema side-write; AMD-13).
    • the conflict→review bridge   — ops.stitch_conflict_review enqueue (an ops-schema side-write).
    • the A.2.3.5 (WA-18) restitch DRAIN — folds PAST sessions dirtied by an identity-map mutation into the
      universe. Because this DuckDB port is a SINGLE FULL PASS (no watermark — see the touchpoint port's note),
      it already re-evaluates the ENTIRE session universe every run, so the drain's lift is subsumed: every
      in-window session is resolved against the CURRENT identity map regardless of any dirty set. The drain is
      an incremental-only optimization; a full pass is a strict superset of what it would fold in.

────────────────────────────────────────────────────────────────────────────────────────────────────────
SESSION GRAIN: a "session" = (brand_id, brain_anon_id, session_id_raw). The MERGE key `session_id` is the
  collision-free string concat_ws(':', brain_anon_id, session_id_raw) (session_key is a 32-bit hash and is
  NOT injective, so it is retained as an informational column ONLY — same rationale as the Spark job).
  silver_touchpoint is the session UNIVERSE + the session_id_raw → session_key map; identifiers are folded
  in from silver_collector_event payloads.

IDENTIFIER SET S (per session, from silver_collector_event payloads):
  anonymous_id         = properties.brain_anon_id          → SALTED external_id hash (internal space)
  email  (interop)     = properties.hashed_customer_email  → PLAIN sha256 already (pre_hashed_email space)
  phone  (interop)     = properties.hashed_customer_phone  → PLAIN sha256 already (pre_hashed_phone space)
  platform_customer_id = properties.storefront_customer_id → SALTED external_id hash
  checkout_session_id  = properties.checkout_session_id    → SALTED external_id hash (best-effort)
  Resolution joins identity_current on (brand_id, identifier_hash) ALONE — a hash is globally unique per
  (brand, value) so identifier_type is provenance only (drives matched_via).

RESOLUTION + BRANCHING (A.2.3 / A.1.5 priority):
  per session: strong_brains = distinct brains from strong ids ; anon_brains = distinct brains from anon.
    • winner = the single strong brain W   IF |strong|=1 AND (|anon|=0 OR W ∈ anon_brains)  → STITCH
    • winner = the single anon brain        IF |strong|=0 AND |anon|=1 (90d-fresh, weak-alone) → STITCH
    • else, if ≥2 distinct brains matched   → AMBIGUOUS, never guess                          → (conflict; skip)
    • else (0/1 brain, no winner)           → unstitched (skip)
  A strong deterministic id that resolves to ONE brain WINS over a lower-priority anon (even an ambiguous
  anon); a clean strong-vs-different-anon disagreement is a CONFLICT (no stitch). This is byte-identical to
  the Spark _write_iceberg winner rule.

SHARED-DEVICE 90d RULE (A.2.3.4): anonymous_id ALONE links only when its mapping is RECENT — within
  SHARED_DEVICE_RECENCY_DAYS (default 90) of the session (last_seen = identity_current.updated_at). A stale
  anon match is DROPPED before |B| is computed. Strong ids are never recency-gated.

IDENTITY VIEW (A.2.2 / AMD-07): identity_current = silver_identity_map filtered to is_current=true AND
  system_to IS NULL — the DuckDB mirror of the sanctioned Spark identity_current accessor / Trino
  identity_current_v. Joined on (brand_id, identifier_hash); updated_at is the shared-device recency axis.

SALTS: (brand_id, salt_hex) for the SALTED external_id space. Default = the dev-derivable salt
  sha256('brain-dev-identity-salt-v1||'||lower(brand_id)) — byte-identical to the connector / Silver
  normalize jobs (silver_shopify_order_normalize._load_salts) so the anon/platform/checkout hashes match
  the identity graph's anon_id / storefront_customer_id rows. A SALT_QUERY env override runs server-side in
  PG (mirrors the Spark _load_salts JDBC query) when a non-dev SoR is wanted.

FLAG GATE (§0.5): PER-BRAND `stitch.v2` (default OFF, fail-closed). Only flag-ON brands are processed. To
  make PARITY reproducible against an oracle produced with the flag ON (the flag lives in a mutable Redis,
  not in the Iceberg corpus), STITCH_V2_BRANDS='<uuid>,<uuid>' forces those brands ON for the run — the
  analogue of FULL_REFRESH. Default (unset) = read the live flag exactly like production.

HARD RULES: brand_id first. Hash-only PII (every identifier is a 64-hex hash). No money. Idempotent MERGE on
  (brand_id, session_id) → replay-safe. UTC session; timestamp cols plain `timestamp` (Iceberg parity).
  STAGE-1 GATE / QUARANTINE: N/A (trusted projection over cleaned Silver marts) — nothing diverts.
"""
from __future__ import annotations

import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

try:  # driver-only gate; fail-closed (default OFF) if redis is unreachable — same as the Spark job
    from _platform_flags import FLAG_STITCH_V2, is_flag_enabled  # noqa: E402
except Exception:  # noqa: BLE001
    FLAG_STITCH_V2 = "stitch.v2"

    def is_flag_enabled(_brand_id: str, _flag: str) -> bool:  # fail-closed
        return False


TABLE = "silver_session_identity"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

COLLECTOR_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"
TOUCHPOINT_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
IDENTITY_MAP_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_identity_map"

STITCH_VERSION = 2
SHARED_DEVICE_RECENCY_DAYS = int(os.environ.get("SHARED_DEVICE_RECENCY_DAYS", "90"))

# Dev salt SoR (byte-identical to _raw_normalize / the connector). A SALT_QUERY override runs in PG.
DEV_SALT_PREFIX = os.environ.get("DEV_IDENTITY_SALT_PREFIX", "brain-dev-identity-salt-v1")
PG_HOST = os.environ.get("SILVER_PG_HOST", "localhost")
PG_PORT = os.environ.get("SILVER_PG_PORT", "5432")
PG_DB = os.environ.get("SILVER_PG_DB", "brain")
PG_USER = os.environ.get("SILVER_PG_USER", "brain")
PG_PASSWORD = os.environ.get("SILVER_PG_PASSWORD", "brain")

# ── column contract — byte-for-byte the Spark/StarRocks silver_session_identity DDL. brand_id first. ──
COLUMNS_SQL = """
  brand_id        string    NOT NULL,
  session_id      string    NOT NULL,
  brain_anon_id   string,
  session_key     int,
  brain_id        string    NOT NULL,
  matched_via     string[],
  stitch_version  int       NOT NULL,
  session_start   timestamp,
  event_date      date,
  stitched_at     timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "session_id", "brain_anon_id", "session_key", "brain_id",
    "matched_via", "stitch_version", "session_start", "event_date", "stitched_at",
]


def _dev_salt(brand_id: str) -> str:
    """The dev-derivable salt for a brand — sha256('<prefix>||'||lower(brand_id)) — matching the
    connector / Silver normalize salt SoR (so anon/platform/checkout hashes match the identity graph)."""
    return hashlib.sha256(f"{DEV_SALT_PREFIX}||{brand_id.lower()}".encode("utf-8")).hexdigest()


def _load_salts(con, brands: list[str]) -> dict:
    """(brand_id → salt_hex). SALT_QUERY (server-side PG, mirrors the Spark _load_salts JDBC query) when
    set; otherwise the dev derivation for exactly the flag-ON brands. Never reads raw PII."""
    salt_query = os.environ.get("SALT_QUERY", "").strip()
    if salt_query:
        try:
            con.execute("INSTALL postgres; LOAD postgres;")
            con.execute(
                f"ATTACH 'host={PG_HOST} port={PG_PORT} dbname={PG_DB} user={PG_USER} "
                f"password={PG_PASSWORD}' AS _pgsalt (TYPE postgres, READ_ONLY);"
            )
            rows = con.execute(f"SELECT brand_id, salt_hex FROM postgres_query('_pgsalt', $q${salt_query}$q$)").fetchall()
            got = {str(b): str(s) for b, s in rows if b is not None}
            if got:
                return {b: got.get(b, _dev_salt(b)) for b in brands}
        except Exception as exc:  # noqa: BLE001 — SALT_QUERY unreachable → dev derivation (safe fallback)
            print(f"[silver-session-identity] SALT_QUERY unavailable ({str(exc)[:120]}); dev salt derivation", flush=True)
    return {b: _dev_salt(b) for b in brands}


def _enabled_brands(con) -> list[str]:
    """The DISTINCT brands present in the session universe whose stitch.v2 flag is ON (fail-closed).
    STITCH_V2_BRANDS='<uuid>,…' forces those brands ON (parity reproducibility — see the module docstring)."""
    try:
        brands = [
            r[0] for r in con.execute(f"SELECT DISTINCT brand_id FROM {TOUCHPOINT_TABLE} WHERE brand_id IS NOT NULL").fetchall()
        ]
    except Exception as exc:  # noqa: BLE001 — touchpoint absent (cold start) → nothing to stitch
        print(f"[silver-session-identity] silver_touchpoint unavailable ({exc}); no sessions to stitch", flush=True)
        return []
    forced = {b.strip() for b in os.environ.get("STITCH_V2_BRANDS", "").split(",") if b.strip()}
    on = [b for b in brands if (b in forced) or is_flag_enabled(b, FLAG_STITCH_V2)]
    src = "STITCH_V2_BRANDS override" if forced else "live flag"
    print(f"[silver-session-identity] flag gate ({src}): {len(on)}/{len(brands)} brand(s) have stitch.v2 ON", flush=True)
    return on


def _register_salts(con, salts: dict) -> None:
    con.execute("DROP TABLE IF EXISTS _ssi_salts;")
    con.execute("CREATE TEMP TABLE _ssi_salts (brand_id VARCHAR, salt_hex VARCHAR);")
    if salts:
        con.executemany("INSERT INTO _ssi_salts VALUES (?,?)", list(salts.items()))


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    brands = _enabled_brands(con)
    if not brands:
        # Clean no-op: the table EXISTS (empty) so downstream views resolve. Pre-wave byte-identical.
        print("[silver-session-identity] no brand has stitch.v2 ON — no-op (pre-wave, refresh unaffected)", flush=True)
        return con.execute(f"SELECT count(*) FROM {TARGET}").fetchone()[0]

    in_list = ", ".join(f"'{b}'" for b in brands)
    _register_salts(con, _load_salts(con, brands))

    # ── session universe (from silver_touchpoint): distinct (brand, anon, session_id_raw) → session_key +
    # per-session session_start (min occurred_at) + event_date + the collision-free session_id MERGE key.
    # Rows with no session_id_raw cannot be matched to an event payload → excluded (honest skip). FULL PASS:
    # no watermark (see the touchpoint port) — the whole universe is re-resolved every run (subsumes the
    # A.2.3.5 restitch drain). ──
    sessions = f"""
      SELECT brand_id, brain_anon_id, session_id_raw, session_key,
             min(occurred_at)                    AS session_start,
             CAST(min(occurred_at) AS DATE)      AS event_date,
             concat_ws(':', brain_anon_id, session_id_raw) AS session_id
      FROM {TOUCHPOINT_TABLE}
      WHERE brand_id IN ({in_list})
        AND session_id_raw IS NOT NULL AND session_id_raw <> ''
      GROUP BY brand_id, brain_anon_id, session_id_raw, session_key
    """

    # ── each session's identifier set S, in the correct hash space, from collector event payloads. Attach
    # each event to its session via (brand_id, anon, session_id_raw) + the brand salt. ──
    events = f"""
      SELECT brand_id,
             json_extract_string(payload, '$.properties.brain_anon_id')          AS anon,
             json_extract_string(payload, '$.properties.session_id')             AS sid,
             json_extract_string(payload, '$.properties.hashed_customer_email')  AS email_hash,
             json_extract_string(payload, '$.properties.hashed_customer_phone')  AS phone_hash,
             json_extract_string(payload, '$.properties.storefront_customer_id') AS platform_id,
             json_extract_string(payload, '$.properties.checkout_session_id')    AS checkout_sid
      FROM {COLLECTOR_TABLE}
      WHERE brand_id IN ({in_list})
        AND json_extract_string(payload, '$.properties.brain_anon_id') IS NOT NULL
        AND json_extract_string(payload, '$.properties.brain_anon_id') <> ''
        AND json_extract_string(payload, '$.properties.session_id') IS NOT NULL
    """

    # external_id space: sha256( salt_hex || '||' || trim(value) ) — _raw_normalize.hash_identifier.
    def salted(col):
        return f"sha256(concat(coalesce(z.salt_hex, ''), '||', trim({col})))"

    ev_join = f"""
      WITH sess AS ({sessions}), ev AS ({events}),
      attached AS (
        SELECT ev.brand_id, s.session_id, s.brain_anon_id, s.session_key, s.session_start, s.event_date,
               ev.anon, ev.email_hash, ev.phone_hash, ev.platform_id, ev.checkout_sid, z.salt_hex
        FROM ev
        JOIN sess s ON ev.brand_id = s.brand_id AND ev.anon = s.brain_anon_id AND ev.sid = s.session_id_raw
        LEFT JOIN _ssi_salts z ON ev.brand_id = z.brand_id
      ),
      base_cols AS (SELECT * FROM attached),
      lanes AS (
        SELECT brand_id, session_id, brain_anon_id, session_key, session_start, event_date,
               'anonymous_id' AS src_type, {salted('anon')} AS identifier_hash, false AS is_strong
        FROM base_cols z WHERE anon IS NOT NULL
        UNION ALL
        SELECT brand_id, session_id, brain_anon_id, session_key, session_start, event_date,
               'email', email_hash, true
        FROM base_cols z WHERE email_hash IS NOT NULL AND email_hash <> ''
        UNION ALL
        SELECT brand_id, session_id, brain_anon_id, session_key, session_start, event_date,
               'phone', phone_hash, true
        FROM base_cols z WHERE phone_hash IS NOT NULL AND phone_hash <> ''
        UNION ALL
        SELECT brand_id, session_id, brain_anon_id, session_key, session_start, event_date,
               'platform_customer_id', {salted('platform_id')}, true
        FROM base_cols z WHERE platform_id IS NOT NULL AND platform_id <> ''
        UNION ALL
        SELECT brand_id, session_id, brain_anon_id, session_key, session_start, event_date,
               'checkout_session_id', {salted('checkout_sid')}, false
        FROM base_cols z WHERE checkout_sid IS NOT NULL AND checkout_sid <> ''
      ),
      idents AS (SELECT DISTINCT * FROM lanes),
      cur AS (
        SELECT brand_id, identifier_hash, brain_id, updated_at AS mapping_last_seen
        FROM {IDENTITY_MAP_TABLE}
        WHERE is_current = true AND system_to IS NULL AND brand_id IN ({in_list})
      ),
      matched AS (
        SELECT i.brand_id, i.session_id, i.brain_anon_id, i.session_key, i.session_start, i.event_date,
               i.src_type, i.is_strong, c.brain_id, c.mapping_last_seen
        FROM idents i
        JOIN cur c ON i.brand_id = c.brand_id AND i.identifier_hash = c.identifier_hash
      ),
      -- A.2.3.4 shared-device 90d rule: DROP a stale anon match (only the anon lane is recency-gated).
      matched_fresh AS (
        SELECT * FROM matched
        WHERE NOT (
          src_type = 'anonymous_id'
          AND mapping_last_seen IS NOT NULL
          AND mapping_last_seen < session_start - INTERVAL {SHARED_DEVICE_RECENCY_DAYS} DAY
        )
      )
      SELECT * FROM matched_fresh
    """

    # ── aggregate per session → priority winner (A.1.5) → keep |winner|=1 LINKs. ──
    staged = f"""
      WITH m AS ({ev_join}),
      per_session AS (
        SELECT brand_id, session_id, brain_anon_id, session_key, session_start, event_date,
               list_distinct(list(brain_id))                                          AS brain_ids,
               list_sort(list_distinct(list(src_type)))                               AS matched_via,
               -- FILTER over an empty match returns NULL (not []) in DuckDB → coalesce so len()=0 works.
               coalesce(list_distinct(list(brain_id) FILTER (WHERE is_strong)),
                        CAST([] AS VARCHAR[]))                                         AS strong_brain_ids,
               coalesce(list_distinct(list(brain_id) FILTER (WHERE src_type = 'anonymous_id')),
                        CAST([] AS VARCHAR[]))                                         AS anon_brain_ids
        FROM m
        GROUP BY brand_id, session_id, brain_anon_id, session_key, session_start, event_date
      ),
      resolved AS (
        SELECT *,
          CASE
            WHEN len(strong_brain_ids) = 1
                 AND (len(anon_brain_ids) = 0 OR list_contains(anon_brain_ids, strong_brain_ids[1]))
              THEN strong_brain_ids[1]
            WHEN len(strong_brain_ids) = 0 AND len(anon_brain_ids) = 1
              THEN anon_brain_ids[1]
            ELSE NULL
          END AS winner_brain_id
        FROM per_session
      )
      SELECT
        brand_id, session_id, brain_anon_id, CAST(session_key AS INTEGER) AS session_key,
        winner_brain_id AS brain_id,
        matched_via,
        {STITCH_VERSION} AS stitch_version,
        session_start, event_date,
        now() AT TIME ZONE 'UTC' AS stitched_at
      FROM resolved
      WHERE winner_brain_id IS NOT NULL
    """

    from _base import merge_on_pk  # local import: same discipline as the other duckdb jobs
    return merge_on_pk(
        con, TARGET, staged, COLUMNS,
        ["brand_id", "session_id"],
        order_by_desc=["session_start"],
    )


if __name__ == "__main__":
    run_job("silver-session-identity", build, target_table=TABLE)
