"""
_segment_rules.py — the PURE, no-Spark single source of truth for the deterministic
gold_customer_segments segmentation rules (Brain V4 Phase 2, GROUP customer).

WHY a pure module: gold_customer_segments.py imports pyspark and cannot be imported by a unit test
that has no Spark on the path. The actual rule logic — the value-tier ladder AND the named lifecycle
ladder — lives here as plain SQL CASE expression STRINGS over named columns, so the EXACT same string
the Spark job executes (spark.sql) can be replayed against an in-memory sqlite DB in the test (the same
"run the real SQL the reader uses" proof pattern as _snap_as_of / snap_identity_link_asof_test). A
parallel pure-Python reference (assign_*) cross-checks the SQL. Thresholds are module-level constants so
the numbers are single-sourced (never drift between the Spark job and the test).

DETERMINISTIC, NOT ML. Every rule is a transparent integer threshold over three base signals carried on
the silver_customer spine row:
  - recency_days       = datediff(current_date, last_seen_at::date)   (the recency / health signal)
  - lifetime_orders    = COUNT(order_id)                              (the order-count / frequency signal)
  - lifetime_value_minor = SUM(order_value_minor)  bigint MINOR units  (the monetary signal)

These three base signals reproduce, at runtime from the Silver spine (V4 rule: features are RUNTIME), the
SAME signals the sibling Gold marts publish — so the lifecycle ladder is expressed directly in base
signals but maps 1:1 onto:
  • gold_customer_scores RFM tiers   — recency_score (recency_days ≤30/60/90/180 → 5/4/3/2/1),
                                       frequency_score (lifetime_orders ≥10/5/3/2 → 5/4/3/2/1),
                                       monetary_score (lifetime_value_minor ≥1e7/5e6/1e6/2e5 → 5/4/3/2/1).
  • gold_customer_health bands       — healthy (recency_days ≤90) / at_risk (≤180) / churned (>180).
Reproducing the signals inline keeps gold_customer_segments dependent on ONLY silver_customer (no
cross-Gold build-ordering hazard — segments runs in Phase 1 before scores/health are even built).

────────────────────────────────────────────────────────────────────────────────────────────────────
LIFECYCLE SEGMENT ASSIGNMENT PRECEDENCE (first match wins — a customer holds exactly ONE primary
lifecycle segment). Ordered most-specific / highest-signal first; lapsing states (churned/at_risk)
outrank value because a churned VIP is, operationally, churned:

  1. churned         recency_days > 180                                  (health band = churned)
  2. at_risk         recency_days > 90                                   (health band = at_risk; ≤180 implied)
  3. VIP             lifetime_value_minor ≥ 10_000_000 AND lifetime_orders ≥ 5 AND recency_days ≤ 60
                     (top monetary tier + frequent + recent — RFM 5/≥4/≥4)
  4. loyal           lifetime_orders ≥ 5 AND recency_days ≤ 90          (repeat buyer, still active)
  5. high_value      lifetime_value_minor ≥ 5_000_000                    (high monetary tier, RFM M ≥ 4)
  6. first_time_buyer lifetime_orders = 1 AND lifetime_value_minor > 0   (exactly one realized order)
  7. cart_abandoner  lifetime_value_minor = 0                            (orders/checkouts placed but
                     ZERO realized revenue — the deterministic abandoned-value proxy on the purchaser
                     spine; mirrors the value-tier 'no_realized_value' bucket)
  8. window_shopper  ELSE                                                (active but low recency /
                     frequency / monetary — the residual low-engagement bucket)

NOTE on cart_abandoner / window_shopper: silver_customer is the PURCHASER spine (it is built by GROUPing
silver_order_state, so every row has lifetime_orders ≥ 1). A TRUE non-purchaser cart-abandon / browse
segmentation needs the anonymous-visitor spine (silver_cart_event / silver_page_view), which this mart
does not read. Within the purchaser population these two labels are the documented deterministic proxies
above (zero-realized-value vs the low-engagement residual). Extending to the anon spine is a future
additive change (new reads_from), tracked alongside gold_abandoned_cart / gold_funnel.

VALUE TIER (the EXISTING, unchanged ladder — kept byte-for-byte so existing value-tier readers are not
broken; emitted now under segment_type='value_tier'):
  high_value        lifetime_value_minor ≥ 100_000
  mid_value         lifetime_value_minor ≥ 50_000
  low_value         lifetime_value_minor > 0
  no_realized_value else

A customer therefore holds ONE value tier AND ONE primary lifecycle segment — two orthogonal
dimensions, disambiguated on the mart by the segment_type discriminator (note 'high_value' is a label in
BOTH ladders; segment_type is what keeps them distinct).
────────────────────────────────────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations  # Python 3.8 on the Spark image — defer annotation eval.

# ── Threshold constants (single-sourced; mirrored by the Spark job + the unit test) ──────────────

# Recency (days since last order) → gold_customer_scores recency tiers / gold_customer_health bands.
RECENCY_VIP_MAX_DAYS = 60       # recency_score ≥ 4  (≤30→5, ≤60→4)
RECENCY_ACTIVE_MAX_DAYS = 90    # recency_score ≥ 3  / health band 'healthy'
RECENCY_AT_RISK_MAX_DAYS = 180  # health band 'at_risk' upper bound; > 180 ⇒ 'churned'

# Frequency (lifetime order count) → gold_customer_scores frequency tiers.
FREQUENCY_LOYAL_MIN_ORDERS = 5  # frequency_score ≥ 4  (≥5→4, ≥10→5)
FIRST_TIME_ORDERS = 1

# Monetary (lifetime realized value, bigint MINOR units) → gold_customer_scores monetary tiers.
MONETARY_VIP_MIN_MINOR = 10_000_000   # monetary_score = 5
MONETARY_HIGH_MIN_MINOR = 5_000_000   # monetary_score ≥ 4

# Value-tier ladder (the existing, unchanged thresholds — bigint MINOR units).
VALUE_TIER_HIGH_MIN_MINOR = 100_000
VALUE_TIER_MID_MIN_MINOR = 50_000

# The two discriminator values written to the segment_type column.
SEGMENT_TYPE_VALUE_TIER = "value_tier"
SEGMENT_TYPE_LIFECYCLE = "lifecycle"

# The exhaustive label sets (used by the unit test for coverage assertions).
VALUE_TIER_LABELS = ("high_value", "mid_value", "low_value", "no_realized_value")
LIFECYCLE_LABELS = (
    "VIP",
    "high_value",
    "loyal",
    "first_time_buyer",
    "at_risk",
    "churned",
    "cart_abandoner",
    "window_shopper",
)


# ── SQL CASE builders (the EXACT expression strings the Spark job executes) ───────────────────────

def value_tier_case_sql(value_col: str = "lifetime_value_minor") -> str:
    """The deterministic value-tier CASE (unchanged ladder). Plain integer comparisons → identical in
    Spark SQL and sqlite (so the unit test replays the real string)."""
    return (
        f"CASE "
        f"WHEN {value_col} >= {VALUE_TIER_HIGH_MIN_MINOR} THEN 'high_value' "
        f"WHEN {value_col} >= {VALUE_TIER_MID_MIN_MINOR} THEN 'mid_value' "
        f"WHEN {value_col} > 0 THEN 'low_value' "
        f"ELSE 'no_realized_value' END"
    )


def lifecycle_segment_case_sql(
    recency_col: str = "recency_days",
    orders_col: str = "lifetime_orders",
    value_col: str = "lifetime_value_minor",
) -> str:
    """The deterministic named-lifecycle CASE — the precedence ladder documented in the module header,
    expressed purely in the three base signals (all integer comparisons → identical in Spark SQL and
    sqlite). First matching WHEN wins, exactly mirroring assign_lifecycle_segment below."""
    return (
        f"CASE "
        f"WHEN {recency_col} > {RECENCY_AT_RISK_MAX_DAYS} THEN 'churned' "
        f"WHEN {recency_col} > {RECENCY_ACTIVE_MAX_DAYS} THEN 'at_risk' "
        f"WHEN {value_col} >= {MONETARY_VIP_MIN_MINOR} "
        f"AND {orders_col} >= {FREQUENCY_LOYAL_MIN_ORDERS} "
        f"AND {recency_col} <= {RECENCY_VIP_MAX_DAYS} THEN 'VIP' "
        f"WHEN {orders_col} >= {FREQUENCY_LOYAL_MIN_ORDERS} "
        f"AND {recency_col} <= {RECENCY_ACTIVE_MAX_DAYS} THEN 'loyal' "
        f"WHEN {value_col} >= {MONETARY_HIGH_MIN_MINOR} THEN 'high_value' "
        f"WHEN {orders_col} = {FIRST_TIME_ORDERS} AND {value_col} > 0 THEN 'first_time_buyer' "
        f"WHEN {value_col} = 0 THEN 'cart_abandoner' "
        f"ELSE 'window_shopper' END"
    )


# ── Pure-Python reference implementations (cross-check the SQL in the unit test) ──────────────────

def assign_value_tier(lifetime_value_minor: int) -> str:
    """Pure reference for value_tier_case_sql."""
    if lifetime_value_minor >= VALUE_TIER_HIGH_MIN_MINOR:
        return "high_value"
    if lifetime_value_minor >= VALUE_TIER_MID_MIN_MINOR:
        return "mid_value"
    if lifetime_value_minor > 0:
        return "low_value"
    return "no_realized_value"


def assign_lifecycle_segment(
    recency_days: int, lifetime_orders: int, lifetime_value_minor: int
) -> str:
    """Pure reference for lifecycle_segment_case_sql — the SAME first-match precedence ladder."""
    if recency_days > RECENCY_AT_RISK_MAX_DAYS:
        return "churned"
    if recency_days > RECENCY_ACTIVE_MAX_DAYS:
        return "at_risk"
    if (
        lifetime_value_minor >= MONETARY_VIP_MIN_MINOR
        and lifetime_orders >= FREQUENCY_LOYAL_MIN_ORDERS
        and recency_days <= RECENCY_VIP_MAX_DAYS
    ):
        return "VIP"
    if lifetime_orders >= FREQUENCY_LOYAL_MIN_ORDERS and recency_days <= RECENCY_ACTIVE_MAX_DAYS:
        return "loyal"
    if lifetime_value_minor >= MONETARY_HIGH_MIN_MINOR:
        return "high_value"
    if lifetime_orders == FIRST_TIME_ORDERS and lifetime_value_minor > 0:
        return "first_time_buyer"
    if lifetime_value_minor == 0:
        return "cart_abandoner"
    return "window_shopper"


__all__ = [
    "RECENCY_VIP_MAX_DAYS",
    "RECENCY_ACTIVE_MAX_DAYS",
    "RECENCY_AT_RISK_MAX_DAYS",
    "FREQUENCY_LOYAL_MIN_ORDERS",
    "FIRST_TIME_ORDERS",
    "MONETARY_VIP_MIN_MINOR",
    "MONETARY_HIGH_MIN_MINOR",
    "VALUE_TIER_HIGH_MIN_MINOR",
    "VALUE_TIER_MID_MIN_MINOR",
    "SEGMENT_TYPE_VALUE_TIER",
    "SEGMENT_TYPE_LIFECYCLE",
    "VALUE_TIER_LABELS",
    "LIFECYCLE_LABELS",
    "value_tier_case_sql",
    "lifecycle_segment_case_sql",
    "assign_value_tier",
    "assign_lifecycle_segment",
]
