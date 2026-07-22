"""
gold_channel_roas.py (DuckDB) — NET-NEW pre-baked per-channel ROAS mart (ADR-0019 WS-3 D6).

NO Spark/dbt predecessor (parity status=NEW). Moves the read-time FX-blend the metric-engine does in
computeChannelRoas (attribution-channel-roas.ts) into the transform tier per the single-query-ceiling
doctrine: the endpoint (get-channel-roas.ts) reads a [from, to] window at (channel, currency) grain, so
this mart pre-bakes the two exact BIGINT operands (attributed + spend) at a DAILY grain the reader sums
over any window. The ROAS *ratio* is dimensionless and is derived at read from the two exact operands
(NEVER precomputed — a ratio is non-additive; summing daily ratios is wrong). Money stays bigint minor
+ currency_code, never blended across currencies.

THE TRANSFORM (reproduces computeChannelRoas + get-channel-roas.ts, per-day so windows are additive):
  attributed = FROM gold_marketing_attribution, per (brand, model_id, channel, currency,
               DATE(economic_effective_at)):
                 attributed_minor = Σ credited_revenue_minor   (net of clawback — the ledger already
                 signs reversals negative; Σ stays honest, mirroring channel_contribution_as_of).
  spend      = FROM silver_marketing_spend WHERE level='campaign' (GAP-C: the canonical top-of-hierarchy
               level — summing all levels ~3×-counts spend, mirrors gold_cac.py / the reader), mapped
               platform→channel (meta→paid_meta, google_ads→paid_google, tiktok→paid_tiktok, else 'paid'
               — the EXACT PLATFORM_TO_CHANNEL map in attribution-channel-roas.ts), per (brand, channel,
               currency, stat_date): spend_minor = Σ spend_minor.
  result     = attributed FULL OUTER JOIN spend ON (brand, channel, currency, day) — coalesce keys +
               each measure to 0 (a channel-day present on only one side keeps its measure, the other 0,
               exactly as the reader's Set-union over attributed∪spend keys does). model_id is carried
               from the attribution side; spend-only rows get the model_id via a CROSS-model expansion is
               NOT done — instead spend rows carry model_id = the DISTINCT models present for the brand so
               a spend-only channel-day appears once per active model (matches the reader, which reports
               spend under the requested model regardless of attribution presence). See MODEL FANOUT.

MODEL FANOUT: the reader is called with ONE model_id per request and reports every (channel, currency)
  with spend>0 OR attribution>0 UNDER THAT model. So a spend-only channel-day must exist for EACH model
  the brand uses. We enumerate the brand's DISTINCT model_ids from the attribution mart and cross-join
  the spend side onto them; a brand with no attribution rows yet has no model to report spend under
  (parity: the reader's `not_computed` state — spend exists but credit ledger empty — is handled at the
  endpoint, not here; the mart simply has no row, and the endpoint's hasSpend/hasCredit probes still fire
  against the base views). This keeps the mart a faithful pre-bake of the reader's exact output set.

GRAIN / PK: exactly one row per (brand_id, model_id, channel, currency_code, stat_date). brand_id first
  column + tenant key. MONEY: attributed_minor / spend_minor are bigint MINOR units + currency_code,
  per-currency, NEVER blended, NEVER a float (pure bigint Σ; the ratio is derived at read).

REPLAY-SAFE: full recompute from the two marts, MERGE on the PK. delete_orphans=True — a channel-day
  whose sources vanished (seed residue) is shed after the MERGE (an empty recompute never sheds — the
  merge_on_pk guard). Honors MIGRATION_TABLE_SUFFIX for the parity harness (empty in production).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_channel_roas{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
GOLD_ATTRIBUTION = f"{CATALOG}.{GOLD_NAMESPACE}.gold_marketing_attribution"
SILVER_MARKETING = f"{CATALOG}.{SILVER_NAMESPACE}.silver_marketing_spend"

# platform → JourneyChannel — MUST match PLATFORM_TO_CHANNEL in attribution-channel-roas.ts EXACTLY
# (meta→paid_meta, google_ads→paid_google, tiktok→paid_tiktok, everything else → 'paid'). A parity test
# asserts this map matches the TS literal set.
PLATFORM_TO_CHANNEL = {"meta": "paid_meta", "google_ads": "paid_google", "tiktok": "paid_tiktok"}

COLUMNS_SQL = """
  brand_id          string    NOT NULL,
  model_id          string    NOT NULL,
  channel           string    NOT NULL,
  currency_code     string    NOT NULL,
  stat_date         date      NOT NULL,
  attributed_minor  bigint    NOT NULL,
  spend_minor       bigint    NOT NULL,
  data_source       string    NOT NULL,
  updated_at        timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "model_id", "channel", "currency_code", "stat_date",
    "attributed_minor", "spend_minor", "data_source", "updated_at",
]

PK = ["brand_id", "model_id", "channel", "currency_code", "stat_date"]


def _platform_to_channel_sql(col: str) -> str:
    """SQL CASE reproducing PLATFORM_TO_CHANNEL — else 'paid' (the TS `?? 'paid'` default)."""
    whens = " ".join(f"WHEN {col} = '{p}' THEN '{c}'" for p, c in PLATFORM_TO_CHANNEL.items())
    return f"CASE {whens} ELSE 'paid' END"


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    chan = _platform_to_channel_sql("platform")

    # ── attributed: Σ credited_revenue_minor per (brand, model, channel, currency, day) ──
    attributed = f"""
      SELECT
        brand_id,
        model_id,
        channel,
        currency_code,
        CAST(economic_effective_at AS DATE)                AS stat_date,
        CAST(COALESCE(SUM(credited_revenue_minor), 0) AS BIGINT) AS attributed_minor
      FROM {GOLD_ATTRIBUTION}
      WHERE brand_id IS NOT NULL AND channel IS NOT NULL AND currency_code IS NOT NULL
        AND model_id IS NOT NULL AND economic_effective_at IS NOT NULL
      GROUP BY brand_id, model_id, channel, currency_code, CAST(economic_effective_at AS DATE)
    """

    # ── spend: Σ spend_minor per (brand, channel, currency, day), platform mapped to channel ──
    # level='campaign' (GAP-C — canonical top-of-hierarchy; summing all levels ~3×-counts spend).
    spend = f"""
      SELECT
        brand_id,
        {chan}                                             AS channel,
        currency_code,
        CAST(stat_date AS DATE)                            AS stat_date,
        CAST(COALESCE(SUM(spend_minor), 0) AS BIGINT)      AS spend_minor
      FROM {SILVER_MARKETING}
      WHERE brand_id IS NOT NULL AND currency_code IS NOT NULL AND stat_date IS NOT NULL
        AND level = 'campaign'
      GROUP BY brand_id, {chan}, currency_code, CAST(stat_date AS DATE)
    """

    # ── MODEL FANOUT: the brand's DISTINCT model_ids from the attribution mart (the reader reports spend
    #    under whichever model was requested; a spend-only channel-day must exist for each active model). ──
    brand_models = f"""
      SELECT DISTINCT brand_id, model_id
      FROM {GOLD_ATTRIBUTION}
      WHERE brand_id IS NOT NULL AND model_id IS NOT NULL
    """

    # Spend rows expanded to (brand, model) so a spend-only channel-day appears once per active model.
    spend_by_model = f"""
      SELECT bm.model_id, s.brand_id, s.channel, s.currency_code, s.stat_date, s.spend_minor
      FROM ({spend}) s
      JOIN ({brand_models}) bm ON bm.brand_id = s.brand_id
    """

    # ── FULL OUTER JOIN on the full grain — coalesce keys + each measure to 0 (the reader's Set-union). ──
    staged = f"""
      SELECT
        COALESCE(a.brand_id, s.brand_id)                   AS brand_id,
        COALESCE(a.model_id, s.model_id)                   AS model_id,
        COALESCE(a.channel, s.channel)                     AS channel,
        COALESCE(a.currency_code, s.currency_code)         AS currency_code,
        COALESCE(a.stat_date, s.stat_date)                 AS stat_date,
        COALESCE(a.attributed_minor, 0)                    AS attributed_minor,
        COALESCE(s.spend_minor, 0)                         AS spend_minor,
        CAST('live' AS VARCHAR)                            AS data_source,
        now() AT TIME ZONE 'UTC'                           AS updated_at
      FROM ({attributed}) a
      FULL OUTER JOIN ({spend_by_model}) s
        ON  a.brand_id      = s.brand_id
        AND a.model_id      = s.model_id
        AND a.channel       = s.channel
        AND a.currency_code = s.currency_code
        AND a.stat_date     = s.stat_date
    """

    # Idempotent MERGE on the full PK; the joins already yield one row per PK (order_by is a nominal
    # tie-break). delete_orphans=True: full recompute, so a channel-day whose sources vanished is shed.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK,
                       order_by_desc=["updated_at", "attributed_minor"],
                       delete_orphans=True)


if __name__ == "__main__":
    run_job("gold-channel-roas", build, target_table="gold_channel_roas")
