"""
gate_admission_guard_test.py — Brain V4 CI guard: the COLLECTOR ADMISSION GATE can never silently
starve a Silver consumer (CRIT-4 regression net).

WHY THIS EXISTS
  ADR-0010: Bronze landing is the Kafka Connect Iceberg sink (ungated, append-only), so the collector
  lane is gated EXACTLY ONCE — silver_collector_event.py's SERVER_TRUSTED / LEDGER_ONLY are the SOLE
  owner of the admission sets. (Historically the retired Spark-SS Bronze sink carried a byte-identical
  twin, and this guard cross-checked the two files; that file is deleted, so the parity checks are gone
  and the guard now protects the single remaining gate.)
  An event_type NOT in SERVER_TRUSTED (and not LEDGER_ONLY) falls to the PIXEL lane, where the R2
  install_token join SILENTLY DROPS any server-derived event that carries no install_token. That is
  exactly the CRIT-4 bug: the Shopify resource events product.upsert.v1 / customer.upsert.v1 /
  refund.recorded.v1 / fulfillment.recorded.v1 were in NEITHER lane's set → routed to the pixel lane →
  dropped → silver_refund / silver_fulfillment / silver_product_variant / silver_inventory_level starved.

WHAT THIS GUARD ASSERTS (all static — no Spark/Trino needed, runnable in CI)
  1. DISJOINT      — an event_type can never be BOTH server-trusted AND ledger-only.
  2. CRIT-4 PIN    — the four Shopify resource events are present in the gate set (regression pin).
  3. CONNECTOR ⊆ GATE — every CONNECTOR-derived canonical event a gated-keystone Silver builder consumes
                        (REQUIRED_SERVER_TRUSTED) IS admitted by the gate. Adding a new connector
                        consumer = add its event here = the assert forces it into SERVER_TRUSTED.
  4. DISCOVERY     — every event_type literal that ANY Silver builder filters on is ACCOUNTED FOR in one
                     of the documented lanes below. A brand-new, un-catalogued event_type → FAIL, so a
                     future Silver consumer cannot be added without declaring how it reaches the builder
                     (and, if connector-derived, putting it through the gate).

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions). It can be wired into CI
next to tools/lint/v4-naming-guard.sh (e.g. an extra step in the v4-naming-guard job of .github/workflows/pr.yml:
`python3 db/iceberg/spark/silver/gate_admission_guard_test.py`).
"""
from __future__ import annotations

import ast
import os
import re
from pathlib import Path

# ── Locate the gate source file (repo-root-relative, robust to cwd) ───────────────────────────────
_THIS = Path(__file__).resolve()
SILVER_DIR = _THIS.parent                # db/iceberg/spark/silver
KEYSTONE_FILE = SILVER_DIR / "silver_collector_event.py"  # ADR-0010: the SOLE gate-set owner

# The four Shopify CONNECTOR-derived RESOURCE events (CRIT-4) — server-derived brand_id, NO install_token,
# so they MUST be server-trusted or the pixel-lane R2 join drops them and starves their Silver consumers.
CRIT4_RESOURCE_EVENTS = frozenset(
    {"product.upsert.v1", "customer.upsert.v1", "refund.recorded.v1", "fulfillment.recorded.v1"}
)

# CONNECTOR-derived canonical events consumed FROM the gated keystone (silver_collector_event) by a Silver
# builder — every one MUST be admitted (in SERVER_TRUSTED). This is the anti-starvation contract: when a
# new connector consumer is added, append its event here and check 5 forces it into the gate.
REQUIRED_SERVER_TRUSTED = frozenset(
    {
        "order.live.v1",            # silver_order_state / silver_order_line
        "order.backfill.v1",        # silver_order_line (event_type LIKE 'order.%')
        "spend.live.v1",            # silver_marketing_spend / silver_ad_account / silver_campaign
        "shopflo.checkout_abandoned.v1",  # silver_checkout_signal
        "gokwik.rto_predict.v1",          # silver_checkout_signal
        "shiprocket.shipment_status.v1",  # silver_shipment_event + silver_order_state COD recognition
        "shiprocket.return_status.v1",    # silver_return
        "checkout.abandoned.v1",          # silver_checkout_signal (GoKwik webhook-first)
        "gokwik.checkout_started.v1",     # silver_checkout_signal
        "gokwik.checkout_step.v1",        # silver_checkout_signal
        "payment.attempted.v1",           # silver_payment (GoKwik)
        "payment.authorized.v1",          # silver_payment (GoKwik)
        # CRIT-4 — the four resource events now admitted:
        "product.upsert.v1",        # silver_inventory_level / silver_product_variant
        "customer.upsert.v1",       # admitted now (no consumer yet — safe: admitted-but-unconsumed != starved)
        "refund.recorded.v1",       # silver_refund
        "fulfillment.recorded.v1",  # silver_fulfillment
        # WOO-3 — the NEW canonical coupon grain (no Shopify peer), emitted server-derived by the
        # WooCommerce connector; without server-trust the pixel-lane R2 join drops it and starves silver_coupon:
        "coupon.upsert.v1",         # silver_coupon
        # AD-1 — the SHARED Meta+Google entity-metadata feed, emitted server-derived by meta-entity-sync /
        # google-entity-sync on the live collector lane; silver_campaign folds it into the authoritative dim:
        "ad.entity.updated",        # silver_campaign
        # SHOPFLO lifecycle — the NEW Shopflo checkout-funnel canonicals, emitted server-derived (webhook-first);
        # silver_checkout_signal consumes them. Without server-trust the pixel-lane R2 join would drop them:
        "shopflo.checkout_started.v1",    # silver_checkout_signal
        "shopflo.checkout_step.v1",       # silver_checkout_signal
        "shopflo.checkout_completed.v1",  # silver_checkout_signal
    }
)

# ── DISCOVERY universe — every event_type literal a Silver builder may filter on, by documented lane ──
# A NEW literal NOT in this universe trips check 6, forcing the author to classify it (and, if it is
# connector-derived and consumed from the keystone, to add it to REQUIRED_SERVER_TRUSTED → the gate).

# Browser-PIXEL events: emitted by the universal collector with an install_token + consent → they ride the
# PIXEL lane (R2/R3) legitimately, so they are admitted CONDITIONALLY and are never server-starved.
PIXEL_LANE_EVENTS = frozenset(
    {
        # engagement (silver_engagement_signal)
        "rage.click", "dead.click", "scroll.depth", "element.clicked",
        # journey / touchpoint (silver_journey, silver_touchpoint, silver_sessions)
        "page.viewed", "product.viewed", "collection.viewed", "cart.viewed", "cart.item_added",
        "cart.item_removed", "cart.updated", "search.submitted", "checkout.started",
        "checkout.step_viewed", "checkout.shipping_selected", "payment.initiated", "payment.succeeded",
        "payment.failed", "order.placed", "purchase.completed", "coupon.applied", "form.submitted",
        "user.logged_in", "user.signed_up", "identify",
        # SPEC A.1.1 (WA-07): the flag-gated identify envelope — pixel-emitted with install_token +
        # consent, rides the PIXEL lane (R2/R3 + the AMD-04 denied-VALUE drop) legitimately.
        "pixel.identify.v1",
    }
)

# RAW-source-only: the ONLY Silver reader of these reads a RAW Bronze table (NOT the gated keystone), so
# the collector gate does not apply — ga4_normalize reads brain_bronze.ga4_rows_raw directly.
RAW_SOURCE_ONLY_EVENTS = frozenset({"ga4.session.v1"})

# DEFERRED keystone consumers — connector events with a DEFENSIVE / forward-compatible Silver reader that
# is NOT yet emitted on the collector lane (so there is no starvation TODAY), and which are OUT of this
# slice's scope. Do not silently "fix" by trusting them — but when a connector STARTS emitting one of these
# standalone on the live lane, it MUST be promoted to REQUIRED_SERVER_TRUSTED (+ both gate sets):
#   • message.{send,delivery,read}.v1 — silver_message_send (ESP message lifecycle).
#   • dispute.{created,under_review,won,lost} — silver_dispute Lane-2 (today payments disputes FOLD onto
#     settlement.live.v1; the standalone lane is forward-compatible only — Bronze has zero standalone today).
DEFERRED_KEYSTONE_EVENTS = frozenset(
    {
        "message.send.v1", "message.delivery.v1", "message.read.v1",
        "dispute.created", "dispute.under_review", "dispute.won", "dispute.lost",
    }
)

# DORMANT alias — present in a builder's filter IN-list but emitted by NOTHING (the canonical refund event
# is refund.recorded.v1). Accounted-for so the guard does not flap; not a gate requirement.
#   • refund.processed — dormant alias of refund.recorded.v1 (silver_refund).
#   • gokwik.order.v1 / gokwik.order_placed.v1 — AUD-IMPL-009: defensive entries in
#     silver_session_identity.ORDER_EVENT_TYPES (Stitch v2 order-grain dual-write). NO producer emits
#     them: packages/gokwik-mapper maps EVERY GoKwik order webhook (created/paid/failed/cancelled/
#     refunded/updated) to the canonical order.live.v1 (source='gokwik'), which IS in SERVER_TRUSTED —
#     so GoKwik orders already reach the stitch via order.live.v1 and nothing is starved. If a producer
#     ever starts emitting these standalone on the collector lane, PROMOTE them to
#     REQUIRED_SERVER_TRUSTED (+ the gate set) instead of leaving them here.
DORMANT_ALIAS_EVENTS = frozenset({"refund.processed", "gokwik.order.v1", "gokwik.order_placed.v1"})

# RETIRED — appear ONLY in comments/docstrings (migration 0117). Accounted-for so doc references don't trip
# the text-based discovery scan.
RETIRED_EVENTS = frozenset({"gokwik.awb_status.v1", "gokwik.webhook.v1"})


# ── AST extraction of the gate constants ──────────────────────────────────────────────────────────
def _extract_str_set(path: Path, name: str) -> set:
    """Return the set of string literals assigned to `name` (a set/list/tuple literal) in `path`."""
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id == name and isinstance(
                    node.value, (ast.Set, ast.List, ast.Tuple)
                ):
                    out = set()
                    for el in node.value.elts:
                        if isinstance(el, ast.Constant) and isinstance(el.value, str):
                            out.add(el.value)
                    return out
    raise AssertionError(f"could not find a set/list literal `{name}` in {path}")


def _gate_constants():
    return {
        "silver_server": _extract_str_set(KEYSTONE_FILE, "SERVER_TRUSTED"),
        "silver_ledger": _extract_str_set(KEYSTONE_FILE, "LEDGER_ONLY"),
    }


# ── DISCOVERY: every event_type literal a Silver builder filters on ───────────────────────────────
# Direct SQL filters: `event_type = 'X'` and `event_type IN ('X','Y')` / `event_type in ('X','Y')`.
_EQ = re.compile(r"event_type\s*=\s*'([^']+)'", re.IGNORECASE)
_IN = re.compile(r"event_type\s+in\s*\(([^)]*)\)", re.IGNORECASE)
_TOK = re.compile(r"'([^']+)'")
# Module-level event constants feeding read_bronze_events([...]) — names that clearly hold event names.
_CONST_NAMES = re.compile(
    r"(EVENT_TYPES|EVENT_TYPE|_EVENTS|PIXEL_EVENTS|CONNECTOR_EVENT|GOKWIK_PAYMENT_EVENTS|"
    r"TOUCHPOINT_EVENT_TYPES|CONVERSION_EVENTS|JOURNEY_EVENTS|ENGAGEMENT_EVENTS|FORM_EVENTS|RETURN_EVENT_TYPE)$"
)


def _looks_like_event_name(tok: str) -> bool:
    # Event names are lowercase dotted/word tokens (page.viewed, refund.recorded.v1, identify). Exclude SQL
    # wildcards (order.%), JSON paths ($.x), spaces, and uppercase identifiers.
    return bool(re.fullmatch(r"[a-z][a-z0-9_.]*", tok)) and "%" not in tok


def _builder_files() -> list:
    out = []
    for p in sorted(SILVER_DIR.glob("silver_*.py")):
        name = p.name
        if name.endswith("_test.py") or name == "silver_collector_event.py":
            continue  # skip tests and the gate itself (it DEFINES the sets, it is not a consumer)
        out.append(p)
    return out


def _strip_sql_comments(text: str) -> str:
    """Drop SQL `-- … EOL` comments so a quoted token in an explanatory comment (e.g. source='gokwik')
    inside a multi-line `event_type IN ( … )` is never mistaken for an admitted event_type."""
    return "\n".join(re.sub(r"--.*$", "", line) for line in text.splitlines())


def discover_event_type_literals() -> dict:
    """Map event_name → sorted list of builder files that reference it (filters + event-constant lists)."""
    found: dict = {}
    for p in _builder_files():
        raw = p.read_text()
        text = _strip_sql_comments(raw)  # comment-free view for the SQL-filter regexes
        toks: set = set()
        for m in _EQ.finditer(text):
            toks.add(m.group(1))
        for m in _IN.finditer(text):
            toks.update(_TOK.findall(m.group(1)))
        # Event-name constant assignments (List/Tuple/Str) feeding read_bronze_events — parse the ORIGINAL
        # source (stripping `--` could clip a triple-quote and break the parse).
        try:
            tree = ast.parse(raw)
        except SyntaxError:
            tree = None
        if tree is not None:
            for node in ast.walk(tree):
                if isinstance(node, ast.Assign):
                    targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
                    if not any(_CONST_NAMES.search(t) for t in targets):
                        continue
                    v = node.value
                    if isinstance(v, (ast.List, ast.Tuple, ast.Set)):
                        for el in v.elts:
                            if isinstance(el, ast.Constant) and isinstance(el.value, str):
                                toks.update(_TOK.findall(el.value) or [el.value])
                    elif isinstance(v, ast.Constant) and isinstance(v.value, str):
                        toks.update(_TOK.findall(v.value) or [v.value])
        for tok in toks:
            if _looks_like_event_name(tok):
                found.setdefault(tok, set()).add(p.name)
    return {k: sorted(v) for k, v in found.items()}


# ── The checks ────────────────────────────────────────────────────────────────────────────────────
def check_server_and_ledger_disjoint():
    c = _gate_constants()
    overlap = c["silver_server"] & c["silver_ledger"]
    assert not overlap, f"an event_type is BOTH server-trusted AND ledger-only (contradictory): {sorted(overlap)}"


def check_crit4_resource_events_admitted():
    c = _gate_constants()
    missing = CRIT4_RESOURCE_EVENTS - c["silver_server"]
    assert not missing, (
        "CRIT-4 REGRESSION — Shopify resource events missing from the gate set (they would fall to the "
        "PIXEL lane and be dropped, starving silver_refund/silver_fulfillment/silver_product_variant/"
        f"silver_inventory_level).\n  missing from SERVER_TRUSTED: {sorted(missing)}"
    )


def check_required_connector_events_admitted():
    c = _gate_constants()
    missing = REQUIRED_SERVER_TRUSTED - c["silver_server"]
    assert not missing, (
        "ANTI-STARVATION — a CONNECTOR-derived event consumed from the gated keystone is NOT admitted by "
        f"the gate (pixel lane would drop it for a null install_token): {sorted(missing)}.\n"
        "Add it to SERVER_TRUSTED (silver_collector_event.py — the sole gate set under ADR-0010)."
    )


def check_every_builder_event_is_accounted_for():
    accounted = (
        REQUIRED_SERVER_TRUSTED
        | _gate_constants()["silver_server"]
        | _gate_constants()["silver_ledger"]
        | PIXEL_LANE_EVENTS
        | RAW_SOURCE_ONLY_EVENTS
        | DEFERRED_KEYSTONE_EVENTS
        | DORMANT_ALIAS_EVENTS
        | RETIRED_EVENTS
    )
    discovered = discover_event_type_literals()
    unaccounted = {k: v for k, v in discovered.items() if k not in accounted}
    assert not unaccounted, (
        "UN-CATALOGUED event_type(s) read by a Silver builder — a future consumer must not be silently "
        "starved at the collector gate. For each, declare its lane in gate_admission_guard_test.py:\n"
        "  • connector-derived + read from the gated keystone → add to REQUIRED_SERVER_TRUSTED *and* both "
        "SERVER_TRUSTED gate sets;\n"
        "  • browser-pixel event → PIXEL_LANE_EVENTS;  • raw-source read → RAW_SOURCE_ONLY_EVENTS.\n"
        f"  un-catalogued: { {k: v for k, v in unaccounted.items()} }"
    )


_CHECKS = [
    ("server_and_ledger_disjoint", check_server_and_ledger_disjoint),
    ("crit4_resource_events_admitted", check_crit4_resource_events_admitted),
    ("required_connector_events_admitted", check_required_connector_events_admitted),
    ("every_builder_event_is_accounted_for", check_every_builder_event_is_accounted_for),
]


# pytest entrypoints (one test per check, for granular CI output)
def test_server_and_ledger_disjoint():
    check_server_and_ledger_disjoint()


def test_crit4_resource_events_admitted():
    check_crit4_resource_events_admitted()


def test_required_connector_events_admitted():
    check_required_connector_events_admitted()


def test_every_builder_event_is_accounted_for():
    check_every_builder_event_is_accounted_for()


def main() -> int:
    failures = []
    for name, fn in _CHECKS:
        try:
            fn()
            print(f"[gate-admission-guard] PASS  {name}")
        except AssertionError as exc:
            failures.append(name)
            print(f"[gate-admission-guard] FAIL  {name}\n{exc}\n")
    if failures:
        print(f"[gate-admission-guard] FAILED ({len(failures)}): {', '.join(failures)}")
        return 1
    print("[gate-admission-guard] OK — collector gate parity + admission coverage intact.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
