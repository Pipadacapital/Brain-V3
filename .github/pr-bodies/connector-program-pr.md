TITLE: Connector depth + advertising + Shopflo + API perf + IA redesign + brand-edit + attribution/DQ fixes

## Summary
A multi-area program hardening every connector, the advertising pipeline, performance, and the UI — driven end-to-end and gated by positive/negative/edge E2E verification.

**Delivery verdict (E2E gate): SHIP WITH CAVEATS — no code-fault blockers.** Full report: `docs/architecture/e2e-delivery-report.md`.

### Connectors
- GoKwik — webhook-first reimpl; retire AWB model; canonical order/checkout/payment events.
- Shiprocket — SR-1..SR-10: resolver/secret, returns correctness (return.completed ≠ forward DELIVERED), NDR, backfill, logistics UI.
- Shopify — 4 CRIT + HIGH: webhook HMAC+registration, ingestion reaper, COD repoint, resource admission, offline OAuth, replay-gate.
- WooCommerce — full resource coverage + currency-aware money + coupon mart + 2-yr backfill.
- Advertising (Meta+Google) — full ad.insight metrics + conversion ROAS + entity sync + token/MCC + 2-yr backfill.
- Shopflo — full order source + checkout/payment lifecycle + source-neutral discriminant.

### Platform / UX / perf
- API perf — remove 500ms Trino poll-sleep + cache foundation signals (entitlements 7s→30ms, briefing 30s→1.3s).
- IA redesign — 9 user-goal tabs reusing existing endpoints; honest empty states; redirects.
- Brand-edit — name/website/timezone/region (currency/revenue excluded by design).
- Attribution + DQ — TRINO_HOST unblocks stitch; DQ Bronze checks ported to Trino dialect (D→A); honest freshness labels.

### Caveats (non-blocking)
Pre-existing memoized-config test brittleness (verified on baseline f21944b); .live suites need infra; empty-by-data legs (attribution honestly D for Bodd); one refresh degraded by a Trino OOM (env).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
