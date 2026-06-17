# Developer Report — Frontend/Web (Track C)
**Req:** feat-shopify-live-connector · **Track:** C (frontend-web) · **Date:** 2026-06-17

---

## What the Live Indicator Shows

The `ConnectionStatusCard` (`apps/web/components/dashboard/connection-status-card.tsx`) now surfaces a `LiveSyncIndicator` component with four states:

| `sync_state` | `last_sync_at` | Pill label | Freshness text |
|---|---|---|---|
| `connected` | ≤ 5 min ago | **Live** (green, Radio icon, pulse) | `Live · synced just now` / `Live · synced 2 minutes ago` |
| `connected` | > 5 min ago | **Connected** (green, CheckCircle) | `Last synced 10 hours ago` |
| `syncing` | any | **Syncing…** (amber, Clock, animate-pulse) | none |
| `waiting_for_data` | null | **Waiting for data** (muted, Clock) | `No sync yet — data will appear once connected` |
| `error` | any | **Error** (red, XCircle) | none |

Live threshold: 5 minutes (`LIVE_THRESHOLD_MS = 5 * 60 * 1000`). Uses `Intl.RelativeTimeFormat` (no new dep). Client-side 30s ticker re-renders freshness text without a server round-trip.

Poll rate tightened from 60s → 30s (staleTime 30s → 15s) in `use-dashboard.ts` so the UI reflects a new `last_sync_at` from Track B's webhook `last_sync_at` touch within one cycle.

---

## Honesty — No Fake "Live"

The "Live" pill is governed by `isLive(syncState, lastSyncAt)`:

```ts
function isLive(syncState: SyncState | null, lastSyncAt: string | null): boolean {
  if (syncState !== 'connected' || !lastSyncAt) return false;
  const d = new Date(lastSyncAt);
  if (isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() <= LIVE_THRESHOLD_MS;
}
```

- Source of truth: `connector_sync_status.state` + `connector_sync_status.last_sync_at` (set by Track B webhook handler + Track A re-pull job per ADR-LV-10).
- No hardcoded "Live"; no fallback to "always Live for connected"; stale data is labeled honestly.
- Track B sets `last_sync_at=NOW(), state='connected'` on each accepted webhook → triggers "Live" within the next 30s poll cycle.

---

## A11y

- Status pill: `role="status"` + `aria-label` describing full state (e.g. `"Connector status: Live — actively syncing"`); paired icon (Radio/Clock/CheckCircle/XCircle) with `aria-hidden="true"`.
- Never colour-only: every state has icon + text label. Green "Live" = Radio icon + "Live"; amber "Syncing" = Clock + "Syncing…"; muted "Waiting" = Clock + "Waiting for data".
- Freshness text: `aria-live="polite"` so screen readers announce updates without interrupting.
- Existing card a11y patterns preserved.

---

## data-testids

| testid | Element | Value rendered |
|---|---|---|
| `connection-live-indicator` | `<span role="status">` pill | "Live" / "Connected" / "Syncing…" / "Waiting for data" / "Error" |
| `connection-freshness` | `<p>` freshness text | "Live · synced X ago" / "Last synced X ago" / "No sync yet…" |
| `connection-status-card` | outer `<Card>` | (existing, unchanged) |

---

## E2E Evidence

**Spec:** `apps/web/e2e/live-sync.spec.ts` (4 tests)

```
✓ connected connector with recent last_sync_at renders "Live" pill + freshness text
✓ connected connector with stale last_sync_at renders "Connected" (NOT "Live") + honest freshness
✓ syncing connector renders "Syncing…" animated pill
✓ waiting_for_data connector renders "Waiting for data" pill — honest no-sync state
```

All 4 REVERT-RED: removing `isLive()` threshold or the Live config causes test 1 to fail (no "Live" text) and tests 2+4 to fail (no "Connected"/"Waiting" asserted absent of "Live").

**No-regression:**
- `e2e/marketplace.spec.ts`: 6/6 GREEN (confirmed separate run after rate-limit clearing)
- `e2e/connector-lifecycle.spec.ts`: 3/3 GREEN
- `e2e/realized-revenue.spec.ts`: 4/4 GREEN (confirmed separate run)

Rate-limit note: running 17 tests in one batch exhausts the 10/hour/IP register limiter; the 7 failures in the combined run were identical `register → stayed on /register` at `onboard.ts:23` — a known pre-existing issue documented in `global-setup.ts`. Each spec runs clean independently.

---

## Commits (hash + one line)

| Hash | Slice | Description |
|---|---|---|
| `1b7556e` | C1 | Live-sync freshness indicator on connection-status card |
| `e175a67` | C2 | Tighten connection-status poll to 30s (matches Live ticker) |
| `743e7fd` | C3 | e2e live-sync freshness spec (4 tests, all green) |

---

## Typecheck

`pnpm --filter @brain/web typecheck` → **EXIT 0** (0 errors) after each commit.

---

## Missing Backend Fields / BOUNCE Notes

None. The BFF `/v1/dashboard/connection-status` already returns `syncState` + `lastSyncAt` (sourced from `connector_sync_status.state` + `last_sync_at`). Track B wires `last_sync_at=NOW()` on webhook receipt and Track A wires `state='syncing'`→`'connected'+last_sync_at=NOW()` on re-pull completion. No new BFF route needed.

**One observation for Track B:** The BFF `getConnectionStatus` maps `sync_state` only when `s.connected = true` (`s?.connected ? s.syncState : null`). If Track B sets `state='syncing'` on `connector_sync_status` while `connector_instance.status='connected'`, the BFF will correctly return `syncState='syncing'`. Verified via bff.routes.ts line 704: `connected: row.status === 'connected'` is the gate, and a connected instance with a syncing sync_status will correctly surface.
