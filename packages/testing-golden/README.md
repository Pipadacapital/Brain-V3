<!-- SPEC: WA.1.10 -->
# @brain/testing-golden

Seeded deterministic golden dataset (§1.10 PLAN-OF-RECORD): ~50k events, 3 fictional
brands, full scenario matrix. Every wave gate's flags-OFF regression byte-compares
today's pipeline outputs against the snapshot this package captures.

## Brands (fixed ids — see `src/fixtures.ts`)

| key | brand_id | currency | carries |
|---|---|---|---|
| aurora | `a0a0a0a0-0001-4000-8000-000000000a01` | INR (Shopify) | anon→known mid-session, multi-device, refunds, late-identify day-7, consent-off |
| bazaar | `b0b0b0b0-0002-4000-8000-000000000b02` | INR (GoKwik+Shiprocket) | COD delivered/RTO, shared-device families, consent-off |
| cedar  | `c0c0c0c0-0003-4000-8000-000000000c03` | KWD scale-3 (GCC) | 3-decimal KWD orders, multi-device, consent-off |

## Generate

```bash
pnpm --filter @brain/testing-golden generate -- --out golden-out [--seed s] [--epoch iso]
```

Writes `collector.event.v1.jsonl` (CollectorEventV1 envelopes — pixel lane +
server-trusted connector canonicals), `shopify.orders.raw.v1.jsonl` (raw-lane
payloads), and `manifest.json` (counts, sha256 checksums, scenario→persona coverage
map). Same seed+epoch ⇒ byte-identical output (pinned by the spec test).

## Capture the snapshot baseline (needs the live local stack)

```bash
packages/testing-golden/scripts/capture-baseline.sh
```

Seeds the golden brands → produces events into Kafka → waits for the Kafka-Connect
Bronze landing + identity consumer → `ONESHOT=1 pnpm dev:v4-refresh` → exports
per-brand CSVs of silver_collector_event, silver_touchpoint (stitched cols),
gold_revenue_ledger, gold_attribution_credit, journey_events, gold_customer_360 →
writes checksums to `snapshots/baseline/`.

Flags-OFF regression at a gate:

```bash
packages/testing-golden/scripts/capture-baseline.sh --compare --skip-produce
```

Volatile columns (ingested_at/updated_at/…) are excluded; randomly-minted `brain_id`s
are replaced with a stable surrogate (min current identifier_hash) so baselines
survive stack rebuilds.
