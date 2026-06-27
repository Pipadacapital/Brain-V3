"""
_gold_registry.py — the Python SoT registry of all Brain V4 Gold (and Silver-snapshot) Spark marts.

ONE entry per Gold builder in db/iceberg/spark/gold/, describing every attribute the recompute
loop, MCP tools, and lineage/parity layers need to:
  1. know WHAT to recompute + MERGE on (name, module, pk)
  2. validate money handling (money_columns: minor_col + currency_code_col pair)
  3. find the StarRocks serving MV (mv_name → brain_serving.mv_*)
  4. resolve lineage (reads_from: Silver or Gold inputs)
  5. gate disabled/predictive marts (enabled=False + NotImplementedYet marker, never faked)

INVARIANTS (V4 rules — CI-enforced):
  - brand_id is the FIRST element of every pk (tenant key, V4 rule 5).
  - money_columns entries carry a currency_code_col sibling (never blended, never float).
  - disabled specs: enabled=False, module=None, mv_name=None, not_implemented_reason starts with
    "NotImplementedYet". They fail closed (NotImplementedYetError), never return fabricated data.
  - This module is PURE DATA — NO Spark imports, NO side effects on import.
  - Features are RUNTIME — there is NO permanent feature-precompute table in this registry
    (no feature_customer_daily, no brain_feature — retired in V4).

TS MIRROR: GoldDataProduct (packages/contracts/src/api/intelligence.api.v1.ts) is the TS
  contract form of this registry. Field-for-field mapping:
    GoldMartSpec.name           <-> GoldDataProduct.name
    GoldMartSpec.layer          <-> GoldDataProduct.layer
    GoldMartSpec.pk             <-> GoldDataProduct.pk
    GoldMartSpec.money_columns  <-> GoldDataProduct.money_columns
                                    (richer here: MoneyColumn vs bare List[str])
    GoldMartSpec.reads_from     <-> GoldDataProduct.reads_from
    GoldMartSpec.mv_name        <-> GoldDataProduct.serving_mv
    GoldMartSpec.phase          <-> GoldDataProduct.phase ('identity' | 'bi')
  Python-only additions: module, grain, enabled, not_implemented_reason.

SNAP MARTS (snap_order_state / snap_attribution_credit): these jobs live in the gold/ directory
  and run in the gold refresh group but write to Iceberg brain_SILVER (the dbt config
  schema='brain_silver'). They carry layer='silver' in this registry.

DISABLED MARTS (predictive_ltv / predictive_health): registered as enabled=False. They mirror
  DisabledPredictiveModel (packages/contracts/src/api/intelligence.api.v1.ts) — present so they
  are first-class and immediately promotable when the ML platform builds the backing model.
"""
from __future__ import annotations  # Defer annotation eval — Python 3.8 Spark image compat.

from dataclasses import dataclass, field
from typing import Dict, List, Optional


# ── Phase classifier ────────────────────────────────────────────────────────────
# Every Gold mart belongs to exactly one product phase:
#   'identity' — the customer/journey identity spine (gold_customer_360, gold_journey,
#                identity-side snapshots). These products answer "who is this person".
#   'bi'       — business-intelligence marts (attribution, segments, scores, health, cac,
#                executive, recommendation, retention, revenue, logistics, settlement, funnel,
#                engagement, campaign, …). These products answer "what is happening / why".
# Mirrors GoldDataProduct.phase (packages/contracts/src/api/intelligence.api.v1.ts).
VALID_PHASES = frozenset({"identity", "bi"})


# ── Money column descriptor ────────────────────────────────────────────────────

@dataclass(frozen=True)
class MoneyColumn:
    """One bigint-minor-unit money column + its sibling ISO-4217 currency column.

    V4 money rule: every minor-unit column MUST be paired with a named currency_code column on
    the SAME row (per-currency, NEVER blended, NEVER a float). The default currency_code_col
    'currency_code' covers 100% of current marts — override if a mart names it differently.

    Mirrors GoldDataProduct.money_columns (the TS version is List[str] of minor_col names;
    this Python form is richer: it carries the sibling currency_code_col explicitly so validators
    and the parity oracle can assert the pair without re-reading the mart schema).
    """
    minor_col: str
    currency_code_col: str = "currency_code"


# ── Gold mart descriptor ───────────────────────────────────────────────────────

@dataclass(frozen=True)
class GoldMartSpec:
    """Declarative descriptor of one V4 Gold (or Silver-snap) Spark mart.

    Mirrors GoldDataProduct (packages/contracts/src/api/intelligence.api.v1.ts) field-for-field
    — see module docstring for the complete field mapping.
    """

    # ── Identity ───────────────────────────────────────────────────────────────
    name: str
    """Iceberg table name (gold_* or snap_*) — same on the Spark mart + any dbt-era predecessor."""

    module: Optional[str]
    """The .py job filename in db/iceberg/spark/gold/ (None for disabled/not-yet-built marts)."""

    pk: List[str]
    """MERGE ON key columns; brand_id MUST be pk[0] (V4 tenant-key invariant, pk >= 1)."""

    mv_name: Optional[str]
    """brain_serving.mv_* StarRocks async materialized view name.
    None iff the mart is disabled or not yet served. Corresponds to GoldDataProduct.serving_mv.
    The app/BFF reads ONLY this MV — never the bare Iceberg Gold table directly."""

    reads_from: List[str]
    """Silver or Gold tables read at build time (lineage). Corresponds to GoldDataProduct.reads_from.
    Names are Iceberg table names (e.g. 'silver_order_state', 'gold_attribution_credit')."""

    money_columns: List[MoneyColumn]
    """Bigint-minor-unit money columns, each with its sibling currency_code column.
    [] = non-monetary mart (row-identity only). Corresponds to GoldDataProduct.money_columns."""

    enabled: bool
    """True = built + enabled (a live Spark job exists and is run in the refresh loop).
    False = registered-disabled (NotImplementedYet; the system fails closed, never fakes output)."""

    grain: str
    """Human-readable grain description (e.g. 'brand_date_currency', 'brand_credit_row')."""

    phase: str
    """Product phase classifier — one of VALID_PHASES ('identity' | 'bi'). Pure metadata that
    routes a mart to the identity spine vs the business-intelligence surface.
    Corresponds to GoldDataProduct.phase (packages/contracts/src/api/intelligence.api.v1.ts)."""

    # ── Optional / defaulted ───────────────────────────────────────────────────
    layer: str = "gold"
    """Medallion layer: 'gold' for Gold marts, 'silver' for snap_* Silver-snapshot marts.
    Corresponds to GoldDataProduct.layer."""

    not_implemented_reason: Optional[str] = None
    """For disabled specs only: must start with 'NotImplementedYet'. Documents why the mart is
    not yet built and what is required for promotion to enabled. Never faked — the system throws
    NotImplementedYetError instead of returning a fabricated result."""


# ── Registry entries ───────────────────────────────────────────────────────────
# One GoldMartSpec per Gold/snap Spark job in db/iceberg/spark/gold/.
# Organized by GROUP (matches the run-*.sh script groups). Disabled predictive marts last.

_GOLD_MARTS: List[GoldMartSpec] = [

    # ── GROUP: attribution ─────────────────────────────────────────────────────
    # Load-bearing money mart (credit ledger) + two read-projections.
    # Run order: gold_revenue_ledger -> gold_attribution_credit -> gold_attribution_paths
    #            -> gold_marketing_attribution -> snap_attribution_credit.

    GoldMartSpec(
        name="gold_attribution_credit",
        phase="bi",
        module="gold_attribution_credit.py",
        pk=["brand_id", "credit_id"],
        mv_name="brain_serving.mv_gold_attribution_credit",
        reads_from=["silver_touchpoint", "gold_revenue_ledger"],
        money_columns=[
            MoneyColumn("credited_revenue_minor"),   # signed: +credit / -clawback
            MoneyColumn("realized_revenue_minor"),   # the order's recognized basis
        ],
        enabled=True,
        grain="brand_credit_row",
    ),
    GoldMartSpec(
        name="gold_attribution_paths",
        phase="bi",
        module="gold_attribution_paths.py",
        pk=["brand_id", "brain_anon_id", "stitched_order_id"],
        mv_name="brain_serving.mv_gold_attribution_paths",
        reads_from=["silver_touchpoint"],
        money_columns=[],  # path grain is not monetary; revenue joins at read via stitched_order_id
        enabled=True,
        grain="brand_converted_journey",
    ),
    GoldMartSpec(
        name="gold_marketing_attribution",
        phase="bi",
        module="gold_marketing_attribution.py",
        pk=["brand_id", "credit_id"],
        mv_name="brain_serving.mv_gold_marketing_attribution",
        reads_from=["gold_attribution_credit"],
        money_columns=[
            MoneyColumn("credited_revenue_minor"),
            MoneyColumn("realized_revenue_minor"),
        ],
        enabled=True,
        grain="brand_credit_row",
    ),

    # ── GROUP: revenue ─────────────────────────────────────────────────────────
    # Run order: gold_revenue_ledger (recognition chain) -> gold_revenue_analytics (rollup).

    GoldMartSpec(
        name="gold_revenue_ledger",
        phase="bi",
        module="gold_revenue_ledger.py",
        pk=["brand_id", "ledger_event_id"],
        mv_name="brain_serving.mv_gold_revenue_ledger",
        reads_from=["silver_order_state"],  # folds recognition chain from Iceberg Bronze via Silver
        money_columns=[
            MoneyColumn("amount_minor"),   # signed recognition amount
            MoneyColumn("fee_minor"),      # always 0 from silver_order_recognition; reserved
        ],
        enabled=True,
        grain="brand_recognition_event",
    ),
    GoldMartSpec(
        name="gold_revenue_analytics",
        phase="bi",
        module="gold_revenue_analytics.py",
        pk=["brand_id", "period_month", "lifecycle_state", "currency_code"],
        mv_name="brain_serving.mv_gold_revenue_analytics",
        reads_from=["silver_order_state"],
        money_columns=[
            MoneyColumn("realized_value_minor"),   # signed Σ of order_value_minor
        ],
        enabled=True,
        grain="brand_month_lifecycle_currency",
    ),

    # ── GROUP: executive + cac ─────────────────────────────────────────────────

    GoldMartSpec(
        name="gold_executive_metrics",
        phase="bi",
        module="gold_executive_metrics.py",
        pk=["brand_id", "currency_code"],
        mv_name="brain_serving.mv_gold_executive_metrics",
        reads_from=["silver_order_state"],
        money_columns=[
            MoneyColumn("realized_value_minor"),
        ],
        enabled=True,
        grain="brand_currency",
    ),
    GoldMartSpec(
        name="gold_cac",
        phase="bi",
        module="gold_cac.py",
        pk=["brand_id", "acquisition_month", "currency_code"],
        mv_name="brain_serving.mv_gold_cac",
        reads_from=["silver_customer", "silver_marketing_spend"],
        money_columns=[
            MoneyColumn("acquisition_spend_minor"),
        ],
        enabled=True,
        grain="brand_month_currency",
    ),

    # ── GROUP: customer ────────────────────────────────────────────────────────

    GoldMartSpec(
        name="gold_customer_360",
        phase="identity",
        module="gold_customer_360.py",
        pk=["brand_id", "brain_id"],
        mv_name="brain_serving.mv_gold_customer_360",
        # B2 enrichment reads: silver_touchpoint (channel/acquisition/last-activity + anon→brain bridge),
        # silver_page_view (device), silver_order_line (top_category), + the OPTIONAL sibling Gold folds
        # gold_customer_health (health_band) / gold_customer_scores (churn). All optional → NULL if absent.
        reads_from=[
            "silver_customer", "silver_order_state", "silver_touchpoint", "silver_page_view",
            "silver_order_line", "gold_customer_health", "gold_customer_scores",
        ],
        money_columns=[
            # aov_minor is a DERIVED per-row ratio (exact integer division), NOT a parity-Σ money column —
            # only lifetime_value_minor is summed by the parity oracle (per (brand, currency)).
            MoneyColumn("lifetime_value_minor"),
        ],
        enabled=True,
        grain="brand_customer",
    ),
    GoldMartSpec(
        name="gold_customer_scores",
        phase="bi",
        module="gold_customer_scores.py",
        pk=["brand_id", "brain_id"],
        mv_name="brain_serving.mv_gold_customer_scores",
        reads_from=["silver_customer"],
        # Row-identity only: lifetime_value_minor is a descriptive field on the score row but the
        # parity oracle treats this mart as no-money (no currency_code on the per-customer score
        # grain; scored_on + recency/frequency/monetary_score are the grain's identity, not money).
        money_columns=[],
        enabled=True,
        grain="brand_customer",
    ),
    GoldMartSpec(
        name="gold_customer_segments",
        phase="bi",
        module="gold_customer_segments.py",
        # Two orthogonal segment dimensions on one rollup, keyed by the segment_type discriminator:
        #   'value_tier' (high/mid/low/no_realized_value) + 'lifecycle' (VIP/loyal/at_risk/churned/…).
        # segment_type is in the PK because 'high_value' is a label in BOTH ladders.
        pk=["brand_id", "segment_type", "segment"],
        mv_name="brain_serving.mv_gold_customer_segments",
        # Signals (RFM/recency/health) are FOLDED INLINE from silver_customer at runtime (V4 runtime
        # features) — NOT read from gold_customer_scores/gold_customer_health — so segments carries no
        # cross-Gold build-ordering dependency (it runs in Phase 1 before those marts are built).
        reads_from=["silver_customer"],
        # Row-identity only: segment_value_minor blends all currencies for a brand-segment bucket
        # (no currency_code on the segment grain — honest deviation documented in parity/mart_registry.py).
        # The money rule requires a sibling currency_code, which this grain lacks; verified reconciled
        # out-of-band by the MERGE log.
        money_columns=[],
        enabled=True,
        grain="brand_segment_type_segment",
    ),
    GoldMartSpec(
        name="gold_cohorts",
        phase="bi",
        module="gold_cohorts.py",
        # Spark MERGE ON (brand_id, cohort_month). The StarRocks DDL PK includes currency_code
        # (it is max(currency_code) per cohort — an aggregate, not a grouping key); the Spark job's
        # ON clause is the authoritative MERGE key used here.
        pk=["brand_id", "cohort_month"],
        mv_name="brain_serving.mv_gold_cohorts",
        reads_from=["silver_customer"],
        money_columns=[
            MoneyColumn("cohort_value_minor"),
        ],
        enabled=True,
        grain="brand_cohort_month",
    ),

    # ── GROUP: NET-NEW gap Gold products (Phase 2, parity status=NEW) ─────────
    # No dbt predecessor — these read Iceberg Silver and write Iceberg Gold only.

    GoldMartSpec(
        name="gold_contribution_margin",
        phase="bi",
        module="gold_contribution_margin.py",
        pk=["brand_id", "currency_code"],
        mv_name="brain_serving.mv_gold_contribution_margin",
        reads_from=["silver_order_state", "silver_marketing_spend"],
        money_columns=[
            MoneyColumn("net_revenue_minor"),
            MoneyColumn("cogs_minor"),
            MoneyColumn("variable_minor"),
            MoneyColumn("cm1_minor"),
            MoneyColumn("marketing_minor"),
            MoneyColumn("cm2_minor"),
        ],
        enabled=True,
        grain="brand_currency",
    ),
    GoldMartSpec(
        name="gold_logistics_performance",
        phase="bi",
        module="gold_logistics_performance.py",
        pk=["brand_id", "courier"],
        mv_name="brain_serving.mv_gold_logistics_performance",
        reads_from=["silver_shipment"],
        money_columns=[],  # delivery counts + integer-bps rates — no money
        enabled=True,
        grain="brand_courier",
    ),
    GoldMartSpec(
        name="gold_cod_rto",
        phase="bi",
        module="gold_cod_rto.py",
        pk=["brand_id", "currency_code"],
        mv_name="brain_serving.mv_gold_cod_rto",
        reads_from=["silver_cod_rto"],
        money_columns=[
            MoneyColumn("cod_amount_minor"),   # at-risk COD cash
        ],
        enabled=True,
        grain="brand_currency",
    ),
    GoldMartSpec(
        name="gold_settlement_summary",
        phase="bi",
        module="gold_settlement_summary.py",
        pk=["brand_id", "currency_code"],
        mv_name="brain_serving.mv_gold_settlement_summary",
        reads_from=["silver_settlement"],
        money_columns=[
            MoneyColumn("gross_minor"),
            MoneyColumn("fee_minor"),
            MoneyColumn("tax_minor"),
            MoneyColumn("refund_minor"),
            MoneyColumn("dispute_minor"),
            MoneyColumn("net_minor"),
        ],
        enabled=True,
        grain="brand_currency",
    ),
    GoldMartSpec(
        name="gold_funnel",
        phase="bi",
        module="gold_funnel.py",
        pk=["brand_id", "funnel_date"],
        mv_name="brain_serving.mv_gold_funnel",
        reads_from=["silver_page_view", "silver_cart_event", "silver_checkout_signal"],
        money_columns=[],  # session-reach counts — no money
        enabled=True,
        grain="brand_date",
    ),
    GoldMartSpec(
        name="gold_abandoned_cart",
        phase="bi",
        module="gold_abandoned_cart.py",
        pk=["brand_id", "cart_date", "currency_code"],
        mv_name="brain_serving.mv_gold_abandoned_cart",
        reads_from=["silver_cart_event", "silver_checkout_signal"],
        money_columns=[
            MoneyColumn("abandoned_value_minor"),
        ],
        enabled=True,
        grain="brand_date_currency",
    ),
    GoldMartSpec(
        name="gold_engagement",
        phase="bi",
        module="gold_engagement.py",
        pk=["brand_id", "engagement_date", "signal_type"],
        mv_name="brain_serving.mv_gold_engagement",
        reads_from=["silver_engagement_signal"],
        money_columns=[],  # UX-quality signal counts — no money
        enabled=True,
        grain="brand_date_signal_type",
    ),
    GoldMartSpec(
        name="gold_behavior",
        phase="bi",
        module="gold_behavior.py",
        pk=["brand_id", "behavior_date", "page_type"],
        mv_name="brain_serving.mv_gold_behavior",
        reads_from=["silver_page_view"],
        money_columns=[],  # page-view impression counts — no money
        enabled=True,
        grain="brand_date_page_type",
    ),
    GoldMartSpec(
        name="gold_conversion_feedback",
        phase="bi",
        module="gold_conversion_feedback.py",
        pk=["brand_id", "feedback_date", "form_id"],
        mv_name="brain_serving.mv_gold_conversion_feedback",
        reads_from=["silver_form_submission", "silver_payment"],
        money_columns=[],  # lead + payment-reach counts — no money (PII-safe: no field values)
        enabled=True,
        grain="brand_date_form",
    ),
    GoldMartSpec(
        name="gold_retention",
        phase="bi",
        module="gold_retention.py",
        # Spark MERGE ON (brand_id, cohort_month) — the acquisition-cohort grain reused VERBATIM from
        # gold_cohorts. currency_code is max() per cohort (an aggregate descriptor, not a grouping key).
        pk=["brand_id", "cohort_month"],
        mv_name="brain_serving.mv_gold_retention",
        reads_from=["silver_customer"],
        money_columns=[],  # behavioral counts + integer-bps rates — no money (per-currency descriptor only)
        enabled=True,
        grain="brand_cohort_month",
    ),
    GoldMartSpec(
        name="gold_campaign_performance",
        phase="bi",
        module="gold_campaign_performance.py",
        pk=["brand_id", "platform", "campaign_id", "currency_code"],
        mv_name="brain_serving.mv_gold_campaign_performance",
        reads_from=["silver_marketing_spend", "silver_campaign", "gold_attribution_credit"],
        money_columns=[
            MoneyColumn("spend_minor"),
            MoneyColumn("attributed_minor"),
        ],
        enabled=True,
        grain="brand_platform_campaign_currency",
    ),

    # ── GROUP: NET-NEW gap Gold INTELLIGENCE marts (Phase 2, parity status=NEW) ─
    # Journey rollup + deterministic customer-health + recommendation/AI feature vectors.
    # No dbt predecessor — read Iceberg Silver, write Iceberg Gold only.

    GoldMartSpec(
        name="gold_journey",
        phase="identity",
        module="gold_journey.py",
        # Spark MERGE ON (brand_id, brain_anon_id). brain_anon_id is the journey/visitor key
        # (brain_id is sparse pre-stitch), so the honest grain is the anon visitor.
        pk=["brand_id", "brain_anon_id"],
        mv_name="brain_serving.mv_gold_journey",
        reads_from=["silver_journey", "silver_touchpoint", "silver_sessions"],
        money_columns=[],  # journey entity carries no revenue — revenue truth stays in order/settlement marts
        enabled=True,
        grain="brand_anon_visitor",
    ),
    GoldMartSpec(
        name="gold_customer_health",
        phase="bi",
        module="gold_customer_health.py",
        pk=["brand_id", "brain_id"],
        mv_name="brain_serving.mv_gold_customer_health",
        reads_from=["silver_order_state", "silver_customer"],
        money_columns=[
            MoneyColumn("lifetime_value_minor"),   # carried VERBATIM from silver_customer (never blended into score)
        ],
        enabled=True,
        grain="brand_customer",
    ),
    GoldMartSpec(
        name="gold_recommendation_features",
        phase="bi",
        module="gold_recommendation_features.py",
        pk=["brand_id", "brain_id"],
        mv_name="brain_serving.mv_gold_recommendation_features",
        reads_from=[
            "silver_customer", "silver_order_state", "silver_order_line",
            "silver_touchpoint", "silver_page_view",
        ],
        money_columns=[
            MoneyColumn("monetary_minor"),        # the M of RFM (silver_customer.lifetime_value_minor)
            MoneyColumn("typical_price_minor"),   # modal purchased unit price (price affinity), per-currency
        ],
        enabled=True,
        grain="brand_customer",
    ),
    GoldMartSpec(
        name="gold_ai_features",
        phase="bi",
        module="gold_ai_features.py",
        pk=["brand_id", "brain_id"],
        mv_name="brain_serving.mv_gold_ai_features",
        reads_from=["silver_customer", "silver_order_state", "silver_touchpoint", "silver_journey"],
        money_columns=[
            MoneyColumn("lifetime_value_minor"),    # Σ recognized order value (minor + sibling currency_code)
            MoneyColumn("avg_order_value_minor"),   # lifetime_value_minor DIV order_count (per-currency, never float)
        ],
        enabled=True,
        grain="brand_customer",
    ),

    # ── GROUP: Silver-snapshot marts (layer='silver') ──────────────────────────
    # These jobs live in the gold/ directory and run in the gold refresh group but write to
    # Iceberg brain_SILVER (dbt config schema='brain_silver' for these SCD snapshot marts).
    # They are included here so the registry is complete for the recompute loop.

    GoldMartSpec(
        name="snap_order_state",
        phase="bi",
        module="snap_order_state.py",
        pk=["brand_id", "order_id", "snapshot_date"],
        mv_name="brain_serving.mv_snap_order_state",
        reads_from=["silver_order_state"],
        money_columns=[
            MoneyColumn("order_value_minor"),
        ],
        enabled=True,
        grain="brand_order_date",
        layer="silver",
    ),
    GoldMartSpec(
        name="snap_attribution_credit",
        phase="bi",
        module="snap_attribution_credit.py",
        pk=["brand_id", "credit_id", "snapshot_date"],
        mv_name="brain_serving.mv_snap_attribution_credit",
        reads_from=["gold_marketing_attribution"],
        money_columns=[
            MoneyColumn("credited_revenue_minor"),
        ],
        enabled=True,
        grain="brand_credit_date",
        layer="silver",
    ),
    GoldMartSpec(
        name="snap_identity_link",
        phase="identity",
        module="snap_identity_link.py",
        # Snapshot PK incl. snapshot_date — the AS-OF (point-in-time) identity-link history.
        pk=["brand_id", "identifier_type", "identifier_value", "snapshot_date"],
        mv_name="brain_serving.mv_snap_identity_link",
        # Pure Spark Iceberg read of the Neo4j-derived identity-link projection (sibling of the
        # StarRocks-native brain_ops.silver_identity_link). Neo4j stays the identity SoR (ADR-0004).
        reads_from=["silver_identity_alias"],
        money_columns=[],  # an identity mapping carries no money; identifier_value is a hash (no PII)
        enabled=True,
        grain="brand_identifier_date",
        layer="silver",
    ),

    # ── DEFERRED PREDICTIVE MARTS (enabled=False — registered-disabled) ────────
    # Registered so they are first-class the moment the ML platform builds the backing model.
    # Mirrors DisabledPredictiveModel in packages/contracts/src/api/intelligence.api.v1.ts.
    # Promotion path: build the Spark job + StarRocks MV + flip enabled=True.

    GoldMartSpec(
        name="predictive_ltv",
        phase="bi",
        module=None,
        pk=["brand_id", "brain_id"],
        mv_name=None,
        reads_from=["silver_customer", "gold_revenue_ledger"],
        money_columns=[
            MoneyColumn("predicted_ltv_minor"),   # when built: bigint minor + currency_code
        ],
        enabled=False,
        grain="brand_customer",
        layer="gold",
        not_implemented_reason=(
            "NotImplementedYet — customer LTV predictive mart not built (V4 deferred). "
            "Requires ML model training on the silver_customer + gold_revenue_ledger spine "
            "and a registered model version in brain_ops.model_registry before promotion."
        ),
    ),
    GoldMartSpec(
        name="predictive_health",
        phase="bi",
        module=None,
        pk=["brand_id", "brain_id"],
        mv_name=None,
        reads_from=["silver_customer", "silver_order_state"],
        money_columns=[],   # health/churn score — not monetary
        enabled=False,
        grain="brand_customer",
        layer="gold",
        not_implemented_reason=(
            "NotImplementedYet — customer health/churn predictive mart not built (V4 deferred). "
            "Requires ML training on silver_customer + silver_order_state behavioral signals "
            "and a registered model in brain_ops.model_registry before promotion."
        ),
    ),
]


# ── Public surface ─────────────────────────────────────────────────────────────

GOLD_MART_REGISTRY: Dict[str, GoldMartSpec] = {spec.name: spec for spec in _GOLD_MARTS}
"""The keyed registry — the single lookup table the recompute loop + MCP tools use."""


def resolve_mart(name: str) -> GoldMartSpec:
    """Look up a GoldMartSpec by name; raise a clear SystemExit on a typo.

    Mirrors parity/mart_registry.py resolve_mart — the same "fail loudly, list known names"
    convention so a mis-spelled mart name in a script is immediately diagnosable.
    """
    spec = GOLD_MART_REGISTRY.get(name)
    if spec is None:
        known = ", ".join(sorted(GOLD_MART_REGISTRY))
        raise SystemExit(f"[gold-registry] unknown mart '{name}'. Known marts: {known}")
    return spec


def enabled_marts() -> List[GoldMartSpec]:
    """Return only the enabled (built) Gold/snap marts, in registry order."""
    return [s for s in _GOLD_MARTS if s.enabled]


def disabled_marts() -> List[GoldMartSpec]:
    """Return only the disabled (not-yet-built) predictive mart stubs."""
    return [s for s in _GOLD_MARTS if not s.enabled]


__all__ = [
    "VALID_PHASES",
    "MoneyColumn",
    "GoldMartSpec",
    "_GOLD_MARTS",
    "GOLD_MART_REGISTRY",
    "resolve_mart",
    "enabled_marts",
    "disabled_marts",
]
