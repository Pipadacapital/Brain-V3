# 13 — Deploy Report: fix-dev-token-reach

| Field | Value |
|-------|-------|
| **req_id** | `fix-dev-token-reach` |
| **Stage** | 8 (deploy) · **Status: shipped** |
| **Deployed by** | orchestrator (inline dev-grade bake) |
| **Target** | dev environment (web :3000, core :3001, stream-worker); docker infra untouched |
| **Stakeholder** | approved (Stage 7); merging on GitHub |
| **ts** | 2026-06-17T12:12:00Z |

## Deploy bake — all gates GREEN

| Gate | Result |
|------|--------|
| Migration 0024 `dev_secret` | ✅ present |
| Migration 0025 `connector_sync_status_brand_connector_unique` | ✅ present |
| @brain/core typecheck | ✅ EXIT 0 |
| @brain/web typecheck | ✅ EXIT 0 |
| Analytics suite (the QA-bounced gate) | ✅ **21/21** |
| core /health | ✅ 200 |
| OAuth callback redirect | ✅ 302 → /settings/connectors |
| Live proof | 19,476 INR ledger rows, connector_sync_status=connected |

## Carried tech-debt (Stakeholder-accepted, tracked)

| ID | Sev | Title | Target |
|----|-----|-------|--------|
| SEC-DTR-M1 | MED | dev_secret plaintext token — add shared-dev-DB warning to 0024 header | follow-up |
| SEC-DTR-L1 | LOW | NIL-uuid no-GUC negative-control test | follow-up |
| (lifecycle) | LOW | connect→disconnect→reconnect + real-pagination regression e2e | follow-up requirement (recommended) |
| (jsdoc) | trivial | stale revenue-snapshot.ts JSDoc | follow-up |
| (worker-prod) | LOW | WorkerLocalSecretsManager constructor prod-throw for symmetry | follow-up |

## Note
- branch→master merge is the Stakeholder's GitHub action (gh unauthenticated; hook blocks direct master push).
- Recommended follow-up: a **connector lifecycle + real-data regression suite** (subsumes SEC-DTR-L1 + the lifecycle/pagination debt).
