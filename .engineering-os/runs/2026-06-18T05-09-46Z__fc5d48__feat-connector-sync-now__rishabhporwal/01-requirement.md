# Requirement: Connector "Sync now" — manual on-demand incremental re-pull (per connector)

| Field | Value |
|-------|-------|
| **req_id** | `feat-connector-sync-now` |
| **Title** | A per-connector "Sync now" button that triggers an on-demand incremental (trailing-window) sync, overlap-locked, with live status feedback |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-18T05:09:46Z |
| **Lane** | high_stakes (connectors, multi_tenancy) |

## Why now

Sync is realtime/scheduled today (webhooks + cron polling with the trailing-window re-pull).
But a stakeholder often wants to **pull fresh data right now** — after fixing a connector,
during a demo, or to confirm the pipe works — without waiting for the next scheduled cycle.
Backfill (full history) already has a trigger button; the **incremental sync has none**.
This adds a "Sync now" affordance per connected connector.

## Current state (verified in code)

- **Backfill** has the full pattern to mirror: `apps/web/components/connectors/backfill-control.tsx`
  (BackfillControl UI: trigger button + live progress + status badge icon+text, authz-hidden
  for manager/analyst), `apps/web/lib/hooks/use-backfill.ts` (`useTriggerBackfill` +
  `useBackfillProgress`), and the backfill trigger command/job under
  `apps/core/src/modules/connector/backfill/`. **Reuse this shape.**
- **Incremental sync** is the trailing-window re-pull already shipped per source: Shopify
  (orders, 35-day), Razorpay (settlement, 30-day), Meta + Google Ads (spend, ~28-day) —
  jobs in `apps/stream-worker/src/jobs/*`, overlap-locked per (job, brand), cursor in
  `connector_cursor`/`sync_status`.
- The 7 connector health states + `sync_status` surface already exist.

## Deliverables

1. **"Sync now" trigger (backend):** an authenticated command that enqueues an **on-demand
   incremental sync** for one `connector_instance` (the same trailing-window re-pull the
   scheduler runs — NOT a full backfill). It must:
   - Be **overlap-locked** — reuse the existing per-(job, brand) overlap lock so a manual
     sync can't run concurrently with a scheduled one or a second manual click (return a
     clear "already syncing" state, not a duplicate run).
   - Be **brand-scoped + authz-gated** — connect/sync = Owner/Brand Admin/Manager (mirror the
     existing sync authz); brand from session, never the body; runs under the brand's RLS scope.
   - Emit the same sync command/event the scheduler emits (no new topic/envelope) so live and
     manual paths are identical (the "same code path" principle).
   - Be idempotent + safe to spam (debounced server-side via the lock).
2. **"Sync now" UI (MANDATORY — stakeholder-visible):** a per-connector **Sync now** button on
   the connected-connector card/row (next to / alongside the backfill control), that:
   - triggers the sync, shows **live status** (idle → syncing → synced/failed) with an
     icon+text badge (never colour-only), a **last-synced** timestamp, and an aria-live region.
   - is **hidden** (not just disabled) for manager/analyst per the authz rule, mirroring
     BackfillControl; **disabled with an "already syncing" hint** while a sync is in flight.
   - surfaces an honest error (e.g. TOKEN_EXPIRED → reconnect hint) reusing the connector
     health states.

## Constraints

- **Reuse, don't reinvent:** the backfill trigger UI/hook pattern, the existing trailing-window
  re-pull jobs, the overlap lock, the sync_status/cursor, the connector health states. **No new
  deployable/topic/envelope. No migration if avoidable** (this is a trigger over existing jobs).
- Per-brand isolation (RLS, verify under brain_app — superuser `brain` bypasses RLS so any
  non-brain_app isolation check is INERT). Brand from session, never request body.
- Dev-honesty: a manual sync of a connector whose real upstream isn't reachable in dev must
  fail honestly (status=failed + reason), never fake "synced".

## Non-goals

- Full backfill (already shipped — this is the incremental lane only).
- Per-stream granular sync selection (sync the whole connector for now).
- Changing the schedule/cron cadence.

## Build tracks (the architect will bind)

@backend-developer (the on-demand sync command + overlap-lock reuse + authz + emit the existing
sync command/event + sync_status surfacing) ∥ @frontend-web-developer (the Sync now button +
live status + last-synced + authz-hidden + error states, mirroring BackfillControl). Verify
isolation + overlap-lock under brain_app. Reuse the connector-lifecycle + backfill fixtures.
