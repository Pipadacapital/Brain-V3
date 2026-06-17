# 13 — Deploy Report: feat-connector-marketplace

| Field | Value |
|-------|-------|
| **req_id** | `feat-connector-marketplace` |
| **Stage** | 8 (deploy) |
| **Status** | **shipped** |
| **Deployed by** | platform-devops (agent died on infra socket timeout ~22min mid-bake; deploy bake completed inline by the orchestrator — same commands, no shortcut) |
| **Target** | dev environment — running servers web :3000, core :3001; docker infra untouched |
| **Stakeholder** | approved + merged (PR #29, origin/master=e351e7e) |
| **ts** | 2026-06-17T11:20:00Z |

## Deploy bake — all gates GREEN

| Gate | Result | Evidence |
|------|--------|----------|
| Migration 0021 present | ✅ | `information_schema.columns`: `connector_instance.health_state` + `safety_rating` both present (applied during build; not re-applied) |
| NN-2 / token secrecy | ✅ | Only `secret_ref` column on `connector_instance` — NO `*_token` / `*_ciphertext` column |
| Live real-store smoke | ✅ | `connector_instance` (Boddactive): `provider=shopify, status=connected, health_state=Healthy, safety_rating=safe, has_secret=t` |
| core /health | ✅ | HTTP 200 |
| web /settings/connectors | ✅ | HTTP 200 (marketplace serves) |
| @brain/core typecheck | ✅ | `tsc --noEmit` — 0 errors |
| @brain/web typecheck | ✅ | `tsc --noEmit` — 0 errors |
| Marketplace e2e (deploy smoke) | ✅ | **6/6 pass (38.5s)**: 7 categories render · shopify connect input · coming-soon un-connectable · zero-connection brand + Skip-For-Now · OAuth POST type=shopify · envelope {request_id,data:{tiles}} no token leak |

## Notes

- **branch→master merge is already done** by the Stakeholder (PR #29). The git hook blocks direct push to master; no master push attempted.
- The strongest smoke is the **real Boddactive OAuth connect** captured during this run — a live third-party store is connected, Healthy, token stored as an encrypted secret ref (never in any response), audit-logged.
- The connect path is live; **order/data ingestion is the next epic slice (backfill)** — `connector_sync_status=waiting_for_data` is the honest current state, by design.

## Carried tech-debt (Stakeholder-accepted, tracked)

| ID | Sev | Title | Target |
|----|-----|-------|--------|
| SEC-CM-RES-01 | MED | Single shared CMK across brands — per-brand KMS Grant / per-brand CMK not yet implemented | M2 |
| KNOWN-CM-01 | LOW | `UNIQUE(brand_id, provider)` — one instance per provider per brand (multi-account later) | later |
| Scale-C4 | LOW | `InProcessOAuthStateStore` single-instance (Redis path reserved) | scale-out |
| F-SEC-02 | P2 | old GetRealizedGmvAsOf GUC-reset path | before Phase-2 |
| QA-3 | MED | audit_log.correlation_id | M2 |
