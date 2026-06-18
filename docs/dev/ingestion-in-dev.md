# How ingestion works in dev (near-real-time, honestly)

> Scope: the local/dev continuous ingestion pipeline shipped by
> `feat-realtime-ingestion-pipeline`. Production uses provider webhooks + an Argo
> scheduler (an explicit non-goal here).

## TL;DR

In dev the dashboard updates **near-real-time** via a **continuous polling
scheduler**, NOT via provider push. New orders/spend appear within one poll
interval (default **45s**). True sub-30s webhook push requires a public URL the
provider can POST to — impossible on `localhost` without a tunnel. We never claim
push without a tunnel running.

## The two real-time paths

| Path | Latency | Works on localhost? | How |
|---|---|---|---|
| **Polling scheduler (default)** | one interval (~45s) | ✅ yes, zero setup | `apps/stream-worker` interval loop re-pulls every connected connector across every brand via the provider API |
| **Webhook push (true real-time)** | sub-30s | ❌ not without a tunnel | Shopify/Meta/etc. POST to a PUBLIC collector URL; `localhost` is unreachable from the provider |

## The default: continuous polling scheduler

The running `apps/stream-worker` hosts `startIngestScheduler`
(`src/jobs/ingest-scheduler/run.ts`) — an interval loop **inside the existing
worker** (no new deployable/topic/envelope), mirroring `startSyncRequestClaimer`
and `startDqChecks`. Every `SYNC_SCHEDULER_INTERVAL_MS` (default `45000`, hard
floor `15000`) it:

1. enumerates **every connected connector across every brand** via the existing
   SECURITY-DEFINER enumerate fns (no brand GUC at this step — discovery only,
   fail-closed under `brain_app`);
2. dispatches each connector's existing repull `run()` **sequentially**
   (rate-limit-safe), **per-connector fail-isolated** (one bad connector never
   blocks others), **overlap-safe** (each `run()`'s own `FOR UPDATE SKIP LOCKED`
   prevents a double-run with a manual "Sync now" or a previous tick).

Per-brand isolation is preserved: the scheduler holds **no brand context**; every
brand-scoped read/write happens inside `run()` under that run's own
GUC-after-enumerate, connecting as `brain_app` (RLS enforced — never the dev
superuser `brain`).

Tune the cadence:

```bash
SYNC_SCHEDULER_INTERVAL_MS=30000 pnpm --filter @brain/stream-worker dev   # 30s
# values below 15000 are clamped to the 15s floor (anti-stampede)
```

The dashboard auto-refetches on a ~20–30s react-query `refetchInterval` and the
header shows a **"Live · updated Ns ago"** indicator driven by the real
`dataUpdatedAt` of the primary query — so liveness is honest and visible (it shows
"Updating…" while fetching, "Reconnecting…" on error; never a faked "Live").

## True webhook push (optional — needs a tunnel)

To get sub-30s provider push in dev you must expose the collector
(`apps/collector`, default port `3001`) on a public URL and register it with the
provider:

```bash
pnpm dev:tunnel    # cloudflared quick tunnel over the local collector (best-effort)
```

Then register the printed `https://…` URL as the provider webhook endpoint
(Shopify/Meta app settings). Until a tunnel is running and registered, **push is
not active** — the polling scheduler remains the only live path. `dev:tunnel`
requires `cloudflared` on your PATH and is strictly optional; the scheduler ships
and works without it.

## What is guaranteed (and what isn't)

- ✅ Continuous near-real-time polling for **all brands × all connected
  connectors**, zero manual seeding (deterministic per-brand dev salt).
- ✅ Idempotent re-pull (deterministic `event_id` + ledger dedup → no double-count).
- ✅ Money stays BIGINT minor + currency.
- ❌ NOT sub-30s in dev without a tunnel. We do not fake push.
