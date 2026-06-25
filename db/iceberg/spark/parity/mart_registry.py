"""
mart_registry.py — the declarative mart contract the parity oracle compares on (Brain V4 Phase 0, AREA C).

ONE place that pins, per mart: which medallion layer it lives in, its PRIMARY KEY (the identity the row
count is keyed by), where its CURRENT (dbt/StarRocks or PG) copy lives, and which columns are MONEY
(bigint minor units, summed per-(brand,currency) for the exact-Σ check). Every spec carries the tenant
key `brand_id` implicitly (the oracle always groups/scopes by it).

WHY a registry (not per-mart scripts): the parity harness is reused by every later phase (1→6). Each
phase that builds a new Spark→Iceberg mart adds/edits exactly ONE row here — the comparator code never
changes. This mirrors the metric-engine's "one definition per metric" discipline.

PK + money columns are sourced from the V4 audit reports (08-spark-ownership / 09-starrocks) and the
live StarRocks DDL (e.g. db/starrocks/gold_attribution_credit.sql → PK (brand_id, credit_id),
money = credited_revenue_minor, realized_revenue_minor). Marts whose exact Gold schema is finalized in
a later phase are listed with their best-known PK + money set and a `provisional=True` flag so the owner
of that phase confirms the columns when they build the Spark job. The oracle SKIPs any mart whose NEW
Iceberg table doesn't exist yet, so a provisional row is harmless until its phase lands.

Adding/curating a mart: append a MartSpec to MARTS. `current_schema` is the StarRocks DB (brain_gold /
brain_silver) or the PG schema for source="pg". Money columns MUST be minor-unit bigint columns paired
with a `currency_code` column on the same table (the per-currency Σ requires it).
"""
from dataclasses import dataclass, field
from typing import Dict, List


@dataclass(frozen=True)
class MartSpec:
    name: str                       # table name (same on both sides — the Spark mart mirrors the dbt model name)
    layer: str                      # "silver" | "gold" — picks the Iceberg namespace/warehouse
    pk: List[str]                   # PRIMARY KEY columns (row count keyed by distinct PK); brand_id is implicit
    money_columns: List[str] = field(default_factory=list)  # bigint minor-unit columns (need a sibling currency_code)
    source: str = "starrocks"       # CURRENT side store: "starrocks" (MySQL wire) | "pg"
    current_schema: str = "brain_gold"  # StarRocks DB or PG schema holding the CURRENT table
    provisional: bool = False       # True until the owning phase confirms PK/money against the built Spark mart


# ── Gold business-truth marts (Phase 2) — the cut-over-load-bearing set ───────────────────────────
# Money columns are minor-unit bigint; each mart that carries money also carries currency_code.
_GOLD: List[MartSpec] = [
    # VERIFIED against db/starrocks/gold_attribution_credit.sql (PK + signed minor-unit columns).
    MartSpec(
        name="gold_attribution_credit",
        layer="gold",
        pk=["brand_id", "credit_id"],
        money_columns=["credited_revenue_minor", "realized_revenue_minor"],
        current_schema="brain_gold",
    ),
    # ⚠️ HIGH-RISK money marts (report 08 §3.3) — PK/money provisional until the Phase-2 Spark job lands.
    MartSpec(
        name="gold_revenue_ledger",
        layer="gold",
        pk=["brand_id", "order_id"],
        money_columns=["realized_revenue_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    MartSpec(
        name="gold_revenue_analytics",
        layer="gold",
        pk=["brand_id", "period"],
        money_columns=["realized_revenue_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    MartSpec(
        name="gold_marketing_attribution",
        layer="gold",
        pk=["brand_id", "channel", "campaign_id", "period"],
        money_columns=["attributed_revenue_minor", "spend_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    MartSpec(
        name="gold_attribution_paths",
        layer="gold",
        pk=["brand_id", "path_id"],
        money_columns=["attributed_revenue_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    MartSpec(
        name="gold_customer_360",
        layer="gold",
        pk=["brand_id", "brain_id"],
        money_columns=["ltv_minor", "total_revenue_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    MartSpec(
        name="gold_cac",
        layer="gold",
        pk=["brand_id", "channel", "period"],
        money_columns=["cac_minor", "spend_minor"],
        current_schema="brain_gold",
        provisional=True,
    ),
    # Non-money Gold marts (PR-2.1) — row-identity parity only.
    MartSpec(name="gold_customer_scores", layer="gold", pk=["brand_id", "brain_id"], current_schema="brain_gold", provisional=True),
    MartSpec(name="gold_customer_segments", layer="gold", pk=["brand_id", "brain_id"], current_schema="brain_gold", provisional=True),
    MartSpec(name="gold_cohorts", layer="gold", pk=["brand_id", "cohort_month"], current_schema="brain_gold", provisional=True),
    MartSpec(name="gold_executive_metrics", layer="gold", pk=["brand_id", "metric_date"], current_schema="brain_gold", provisional=True),
]

# ── Silver entity marts (Phase 1) — row-identity parity keyed by (brand_id, entity_id) ────────────
# Silver is canonical entities; most carry no money column (money lands in Gold). Provisional PKs are
# the documented entity grain from report 08 §3.2; the Phase-1 owner confirms when each Spark job lands.
_SILVER: List[MartSpec] = [
    MartSpec(name="silver_customer", layer="silver", pk=["brand_id", "customer_id"], current_schema="brain_silver", provisional=True),
    MartSpec(name="silver_order_state", layer="silver", pk=["brand_id", "order_id"], current_schema="brain_silver", provisional=True),
    MartSpec(name="silver_order_line", layer="silver", pk=["brand_id", "order_id", "line_id"], current_schema="brain_silver", provisional=True),
    MartSpec(name="silver_product", layer="silver", pk=["brand_id", "product_id"], current_schema="brain_silver", provisional=True),
    MartSpec(name="silver_touchpoint", layer="silver", pk=["brand_id", "touchpoint_id"], current_schema="brain_silver", provisional=True),
    MartSpec(name="silver_sessions", layer="silver", pk=["brand_id", "session_id"], current_schema="brain_silver", provisional=True),
    MartSpec(name="silver_checkout_signal", layer="silver", pk=["brand_id", "checkout_id"], current_schema="brain_silver", provisional=True),
    MartSpec(name="silver_shipment", layer="silver", pk=["brand_id", "shipment_id"], current_schema="brain_silver", provisional=True),
    MartSpec(name="silver_shipment_event", layer="silver", pk=["brand_id", "shipment_event_id"], current_schema="brain_silver", provisional=True),
    MartSpec(
        name="silver_marketing_spend",
        layer="silver",
        pk=["brand_id", "platform", "campaign_id", "spend_date"],
        money_columns=["spend_minor"],
        current_schema="brain_silver",
        provisional=True,
    ),
]

MARTS: Dict[str, MartSpec] = {spec.name: spec for spec in (_GOLD + _SILVER)}


def resolve_mart(name: str) -> MartSpec:
    """Look up a mart spec by name; raise a clear error (with the known set) on a typo."""
    spec = MARTS.get(name)
    if spec is None:
        known = ", ".join(sorted(MARTS))
        raise SystemExit(f"[parity-oracle] unknown mart '{name}'. Known marts: {known}")
    return spec
