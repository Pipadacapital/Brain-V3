# SPEC: A.2.2 / audit-G1 — Query-time, multi-key, bi-temporal identity resolution for the REVENUE spine.
"""
_revenue_identity.py — the ADDITIVE, FLAG-GATED (`identity.revenue_querytime`, default OFF) query-time
brain_id resolver for the revenue spine (silver_order_state / gold_revenue_ledger / gold_customer_360).

WHY THIS EXISTS (audit gap G1)
──────────────────────────────
The revenue spine resolves brain_id via a FLAT, SINGLE-KEY path: an order's hashed_customer_email →
silver_identity_alias (identifier_type='pre_hashed_email', is_active) → MIN(COALESCE(merged_into, brain_id)).
That path (a) uses ONE key only (email), so a phone-only / platform-id-only customer never resolves, and
(b) is NOT point-in-time — it reads the CURRENT alias projection, not the bi-temporal identity intervals.

Meanwhile the JOURNEY/CUSTOMER Gold jobs (gold_journey_events / gold_customer_360) already resolve brain_id
at query time against the bi-temporal, MULTI-KEY silver_identity_map using the SANCTIONED identity_current
predicate (is_current = TRUE AND system_to IS NULL) and reconcile merges. This module replicates THAT exact
canonical pattern for the revenue spine, so the two identity worlds stop diverging.

WHAT IT DOES (flag ON for a brand)
──────────────────────────────────
Given a per-order set of up-to-three HASHED identifiers already present on the order payload —
  • hashed_customer_email   → identifier space 'pre_hashed_email'
  • hashed_customer_phone   → identifier space 'pre_hashed_phone'
  • storefront_customer_id  → the spec's `platform_customer_id` (identity graph type 'storefront_customer_id')
resolve brain_id by:
  1. Joining each present identifier_hash to silver_identity_map on (brand_id, identifier_hash) ALONE.
     A hash is globally unique per (brand, value), so identifier_type is PROVENANCE ONLY — the SAME
     "join on hash alone" rule silver_session_identity uses (module docstring, A.2.2/AMD-07). We hash
     the order payload values with brand salt for the SALTED spaces (platform_customer_id) and pass the
     pre-hashed email/phone through verbatim (they are already the final 64-hex digest).
  2. Filtering to identity_current: is_current = TRUE AND system_to IS NULL (the canonical bi-temporal
     accessor — the DuckDB mirror of the Trino identity_current_v / Spark accessor).
  3. Reconciling merges: prefer the survivor via replaced_by_brain_id when a current row carries one,
     else the row's brain_id. (silver_identity_map already carries the survivor pointer.)
  4. NEVER GUESS (A.2.3): if an order's identifiers resolve to >1 DISTINCT brain_id, brain_id_v2 is NULL
     for that order (the deterministic never-guess rule; the flat legacy path stays the source of record).
     A single unambiguous brain wins (deterministic tie-break: highest confidence, then min brain_id — a
     no-op when |B|=1, only there for determinism).

CONTRACT
────────
This module NEVER computes money and NEVER touches the legacy flat brain_id. It emits ONLY the additive
brain_id_v2 value per (brand_id, order_id) for the flag-ON brands, so the flat and query-time resolutions
sit side-by-side on the same row for parallel-run parity comparison. brand_id-first throughout; hash-only
PII (every join key is a 64-hex digest); consent/gating is upstream (unchanged).

FAIL-CLOSED: when the flag is OFF for a brand (default), or silver_identity_map is absent, the alternate
resolution yields NULL brain_id_v2 for every order — the legacy flat output is untouched (parity preserved).
"""
from __future__ import annotations

import os

try:  # driver-only gate; fail-closed (default OFF) if redis is unreachable — same as the Spark jobs.
    from _platform_flags import FLAG_IDENTITY_REVENUE_QUERYTIME, is_flag_enabled
except Exception:  # noqa: BLE001
    FLAG_IDENTITY_REVENUE_QUERYTIME = "identity.revenue_querytime"

    def is_flag_enabled(_brand_id: str, _flag: str) -> bool:  # fail-closed
        return False


# The three identity graph type-names an order payload's hashed identifiers occupy. Provenance only —
# resolution joins on the hash alone (a hash is globally unique per brand). Kept for documentation + the
# best-effort type filter used to keep the join tight.
PRE_HASHED_EMAIL = "pre_hashed_email"
PRE_HASHED_PHONE = "pre_hashed_phone"
PLATFORM_CUSTOMER_ID = "storefront_customer_id"


def enabled_brands(con, brands: list[str]) -> list[str]:
    """The subset of `brands` whose `identity.revenue_querytime` flag is ON (fail-closed).

    IDENTITY_REVENUE_QUERYTIME_BRANDS='<uuid>,…' forces those brands ON (the parity-reproducibility seam,
    identical to STITCH_V2_BRANDS in silver_session_identity — the flag lives in mutable Redis, not in the
    Iceberg corpus, so an oracle produced with the flag ON needs a deterministic override for the harness).
    Unset → read the live per-brand flag exactly like production. Empty result → nothing to resolve.
    """
    forced = {b.strip() for b in os.environ.get("IDENTITY_REVENUE_QUERYTIME_BRANDS", "").split(",") if b.strip()}
    on = [b for b in brands if b and ((b in forced) or is_flag_enabled(b, FLAG_IDENTITY_REVENUE_QUERYTIME))]
    src = "IDENTITY_REVENUE_QUERYTIME_BRANDS override" if forced else "live flag"
    print(
        f'{{"module":"_revenue_identity","flag":"identity.revenue_querytime","source":"{src}",'
        f'"on":{len(on)},"total":{len(brands)}}}',
        flush=True,
    )
    return on


def _brand_in_list(brands: list[str]) -> str:
    """A SQL IN-list of quoted brand_ids, or a never-matching literal when empty (fail-closed)."""
    if not brands:
        return "('__no_brand__')"
    return "(" + ", ".join("'" + b.replace("'", "''") + "'" for b in brands) + ")"


def resolve_brain_id_v2_sql(
    identity_map_fq: str,
    orders_cte: str,
    on_brands: list[str],
    *,
    order_id_col: str = "order_id",
    email_hash_col: str = "hashed_customer_email",
    phone_hash_col: str = "hashed_customer_phone",
    platform_hash_col: str = "platform_customer_id_hash",
) -> str:
    """Return a SELECT (brand_id, <order_id_col>, brain_id_v2) resolving brain_id at query time from the
    bi-temporal multi-key silver_identity_map, for the flag-ON brands ONLY.

    `orders_cte` is a SQL SELECT exposing at minimum: brand_id, <order_id_col>, and the (nullable) hash
    columns <email_hash_col> / <phone_hash_col> / <platform_hash_col>. The platform hash is expected
    already salted+hashed by the caller (the callers that have the salt); email/phone are pre-hashed on the
    payload. Any hash column the caller cannot supply may be projected as NULL — it simply contributes no
    candidate, and resolution degrades gracefully to the keys that ARE present.

    The result is EMPTY (no rows) when `on_brands` is empty — the caller LEFT JOINs it, so every order then
    gets brain_id_v2 = NULL (fail-closed parity). Never emits a row for an ambiguous order (never-guess).
    """
    in_list = _brand_in_list(on_brands)

    # identity_current: the sanctioned bi-temporal accessor (is_current AND system_to IS NULL). Merge-aware:
    # the survivor is replaced_by_brain_id when the current row carries one, else the row's own brain_id.
    # (silver_identity_map rows already point a superseded id at its survivor via replaced_by_brain_id.)
    identity_current = f"""
      SELECT
        brand_id,
        identifier_hash,
        identifier_type,
        CASE
          WHEN replaced_by_brain_id IS NOT NULL AND replaced_by_brain_id <> ''
            THEN replaced_by_brain_id
          ELSE brain_id
        END AS resolved_brain_id,
        confidence
      FROM {identity_map_fq}
      WHERE is_current = TRUE
        AND system_to IS NULL
        AND brain_id IS NOT NULL
        AND identifier_hash IS NOT NULL
        AND brand_id IN {in_list}
    """

    # Unpivot the order's up-to-three hashes to one candidate row per present (order, hash, space). The
    # space is provenance only — the join is on (brand_id, identifier_hash) ALONE (hash globally unique).
    order_keys = f"""
      SELECT brand_id, {order_id_col} AS _oid, {email_hash_col} AS h, '{PRE_HASHED_EMAIL}' AS space
      FROM ({orders_cte})
      WHERE brand_id IN {in_list} AND {email_hash_col} IS NOT NULL AND {email_hash_col} <> ''
      UNION ALL
      SELECT brand_id, {order_id_col} AS _oid, {phone_hash_col} AS h, '{PRE_HASHED_PHONE}' AS space
      FROM ({orders_cte})
      WHERE brand_id IN {in_list} AND {phone_hash_col} IS NOT NULL AND {phone_hash_col} <> ''
      UNION ALL
      SELECT brand_id, {order_id_col} AS _oid, {platform_hash_col} AS h, '{PLATFORM_CUSTOMER_ID}' AS space
      FROM ({orders_cte})
      WHERE brand_id IN {in_list} AND {platform_hash_col} IS NOT NULL AND {platform_hash_col} <> ''
    """

    # Distinct (brand, order) → set of resolved brains + a deterministic confidence per brain. Never-guess:
    # keep the order ONLY when exactly one distinct brain_id resolved; the winner tie-break (confidence DESC,
    # brain_id ASC) is a no-op at |B|=1 and exists purely for total ordering.
    return f"""
      WITH _idc AS ({identity_current}),
      _cand AS (
        SELECT k.brand_id, k._oid,
               c.resolved_brain_id AS brain_id,
               max(c.confidence)   AS confidence
        FROM ({order_keys}) k
        JOIN _idc c
          ON c.brand_id = k.brand_id AND c.identifier_hash = k.h
        GROUP BY k.brand_id, k._oid, c.resolved_brain_id
      ),
      _counts AS (
        SELECT brand_id, _oid, count(*) AS n_brains
        FROM _cand GROUP BY brand_id, _oid
      ),
      _winner AS (
        SELECT brand_id, _oid, brain_id,
               row_number() OVER (
                 PARTITION BY brand_id, _oid
                 ORDER BY confidence DESC NULLS LAST, brain_id ASC
               ) AS _rn
        FROM _cand
      )
      SELECT w.brand_id, w._oid AS {order_id_col}, w.brain_id AS brain_id_v2
      FROM _winner w
      JOIN _counts n ON n.brand_id = w.brand_id AND n._oid = w._oid
      WHERE w._rn = 1 AND n.n_brains = 1
    """
