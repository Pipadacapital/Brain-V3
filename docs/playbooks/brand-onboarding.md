# Playbook — Brand onboarding (prod, <30 min target)

Audit trail: **AUD-OPS-023**. Onboarding a brand is the GO-LIVE acceptance gate
(`GO-LIVE.md` step 13.5–6) with a **<30 minute** target from registration to a healthy,
trust-building dashboard. This is the timed checklist over the product sequence
(Registration → Verification → Organization → Brand → Region → Team → Shopify → Pixel →
Verification → Initial Sync → Health), with every known trap embedded so the first prod
onboarding doesn't rediscover them.

**Prerequisites (operator, BEFORE the merchant is on the call):**
- Platform smoke green (`GO-LIVE.md` step 13.1–4): health endpoints 200, a test event lands in
  Bronze, `mv_*` views serve.
- `v4-silver`/`v4-gold` CronWorkflows enabled and passing (`argo -n argo list`).
- A Trino port-forward open for the verification queries below
  (`kubectl -n trino port-forward svc/<trino-coordinator> 8090:8080`).
- Known-trap ground rules:
  - **Connector OAuth tokens CANNOT be pre-seeded** — they are minted only by the merchant
    clicking Connect/Reconnect in the UI (GO-LIVE manual-items table #12). Do not burn time
    trying to seed them.
  - **Dashboards are HONEST-EMPTY until the first refresh cycle** after data lands
    (`v4-silver` :05 / `v4-gold` :25). An empty state with a freshness stamp is a PASS, a 500
    is a FAIL — "no empty charts as a success state" cuts both ways.

## Timed checklist

| ⏱ | Step (product sequence) | Action | Verify before moving on |
|---|---|---|---|
| 0–3 min | **Registration + Verification** | Merchant signs up, verifies email | Login lands on onboarding; no console/network errors |
| 3–6 min | **Organization → Brand → Region** | Create org, brand, pick region | Brand exists; note the **`brand_id`** (needed for every query below); region matches residency expectation |
| 6–8 min | **Team** | Invite teammates (RBAC roles) | Invite email received OR skip (not gating) |
| 8–13 min | **Shopify connect** | Settings → Connectors → Shopify → Connect; merchant authorizes | Connector row **Connected + health green**. Token lives in Secrets Manager now. If the row shows connected but later 500s "can't find secret", that's a secret-ref problem — reconnect once. |
| 13–16 min | **Pixel** | Install the Brain Pixel (ScriptTag auto-install on connect / Settings → Brain Pixel) | Open the storefront, click around, then Bronze check ① below returns rows within ~1 min (collector accepts → Connect sink commits every 30s) |
| 13–16 min | *(trap)* **Checkout events** | ScriptTag runs ONLY on the online-store origin — `checkout_started/completed` need the **Web Pixel** on **checkout-extensibility** (Shopify Plus or upgraded checkout). Follow `docs/runbooks/enable-shopify-checkout-pixel.md` (Path A app pixel / Path B custom pixel). | Not gating for onboarding; without it the funnel checkout stage is honestly 0 — say so to the merchant rather than promising it |
| 16–22 min | **Initial Sync (backfill)** | Trigger the Shopify initial sync/backfill in the UI. *(trap)* The backfill queue exists ONLY for providers in `BACKFILL_QUEUE_PROVIDERS = ['shopify']` (`packages/connector-core/src/domain/backfill-providers.ts`) — the UI gates the button; other connectors fill from webhooks/pulls forward-only. | Backfill job visibly progressing; Bronze check ② rows climbing |
| 22–28 min | **Refresh + Health** | Wait for (or submit — `rerun-medallion.md` §1) one `v4-silver` + `v4-gold` cycle | Checks ③/④ below; connector health green; Data Trust/health surface shows fresh, non-zero counts |
| 28–30 min | **Dashboard walkthrough** | Open every dashboard tab with the merchant | All render 200; populated where data exists, honest-empty (with freshness) where it doesn't; order counts match Shopify admin (revenue truth over platform truth) |

## Verification queries (brand-scoped, via the Trino port-forward)

```bash
B=<BRAND_UUID>
T() { trino --server http://127.0.0.1:8090 --execute "$1"; }
# ① Pixel events landing in Bronze (source of truth first):
T "SELECT count(*) FROM iceberg.brain_bronze.collector_events_connect_lifted WHERE brand_id='$B'"
# ② Backfilled orders landed (raw lane; auto-created on first record — absent table = nothing landed yet, not an error):
T "SELECT count(*) FROM iceberg.brain_bronze.shopify_orders_raw_connect WHERE brand_id='$B'"
# ③ Silver folded them (must match the Shopify admin order count for the synced window):
T "SELECT count(*) FROM iceberg.brain_serving.mv_silver_order_state WHERE brand_id='$B'"
# ④ Gold/serving populated (what the dashboards actually read):
T "SELECT count(*) FROM iceberg.brain_serving.mv_gold_revenue_ledger WHERE brand_id='$B'"
```

Escalation map: ① zero → pixel/collector/Connect landing (`adr-0010-kafka-connect-bronze.md`,
incl. the `[]`-connectors recovery); ② zero → connector/backfill (health badge, webhook
registration); ③ ≪ ② → the FULL_REFRESH watermark trap (`rerun-medallion.md` §2); ④ zero
while ③ populated → gold cron logs (`argo -n argo list`).

**Acceptance (the gate):** all four queries non-zero-and-consistent, every dashboard 200, and
total elapsed ≤30 min. Record the actual time — the target is a measured product promise, not
an aspiration.
