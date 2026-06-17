# Requirement: Connector module + Integration Marketplace UI (honest status, generic connect)

| Field | Value |
|-------|-------|
| **req_id** | `feat-connector-marketplace` |
| **Title** | Connector module + Integration Marketplace — category-organized, truthful per-tile status, generic OAuth/credential connect, 7-state health |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-17T03:57:15Z |
| **Tier impact** | Connector-ingestion epic §1 (Connect) + §8 (honest health) — the entry layer every later connector slice hangs off |
| **Region impact** | India (M1); GCC set is Phase-5 (out of scope) |

---

## Lane *(advisor to confirm — deterministic scan: high_stakes; surfaces: multi_tenancy, connectors, oauth/secrets, pii)*

---

## Raw text (from the Stakeholder)

> Build the **Connector module + Integration Marketplace UI** — the first slice of the connector-ingestion epic (§1 Connect + §8 honest health). This is the entry point every later connector slice (Shopify deep, Razorpay settlement, Meta/Google Ads) hangs off. Wire/generalize the EXISTING scaffolds: `apps/core/src/modules/connector` (catalog/connection/sources/* dirs + the concrete `sources/storefront/shopify` impl that already does OAuth/HMAC/secrets/connector_instance), the web `apps/web/app/(dashboard)/settings/connectors` + `apps/web/components/connectors`, and the `connectorsApi` client. Migration `0006_connector.sql` already has `connector_instance` / `connector_sync_status` / `connector_cursor`.
>
> DELIVER:
> 1. **Connector catalog (the definition registry):** a catalog of connector *definitions* organized by category — storefront, ads, payments, logistics, messaging, CRM, analytics. Each definition declares: id, category, display name, connect method (oauth | credential | coming_soon), and M1 availability. Phase-1a deep set (Shopify, Meta, Google Ads, Razorpay) + the long tail ship as honest **"Coming Soon"** stubs — NO half-built connectors, NO tile ever fakes "live." The catalog is the single source of truth for what the marketplace renders.
> 2. **Integration Marketplace UI:** a category-organized marketplace page (replacing/extending the current flat connectors list) where every tile shows **truthful status** — Not Connected / Connect (oauth or credential) / Coming Soon / or the live health state if connected. **"Skip For Now" is first-class** — a brand can finish onboarding with zero connections; no source is ever a gate. data-testids for e2e.
> 3. **Generic connect flow (Shopify becomes one instance):** generalize the connect contract so it isn't Shopify-special-cased. `POST /api/v1/connectors` (with a connector type) returns an `oauth_url` for OAuth connectors (or accepts credentials for credential connectors); the OAuth callback (`/api/v1/oauth/callback/{type}`) is **CSRF state-signed, brand_id derived from the signed state — NEVER from the request body**. Disconnect (`DELETE`) revokes immediately. The existing Shopify OAuth impl is refactored to register under this generic seam (not rewritten — its HMAC/nonce/state security stays).
> 4. **Token storage (the security spine):** `connector_instance.oauth_token_ciphertext` — tokens encrypted under a **per-brand KMS data key**, decryptable only by the Connector module's role, scoped by `kms:EncryptionContext:brand_id` (prod). Dev: the existing `LocalSecretsManager`/`ISecretsManager` seam stands in for KMS (do NOT regress it). Tokens **refreshed server-side, NEVER returned in full to the client, revoked immediately on disconnect**. No token/secret in logs.
> 5. **7-state health model (§8):** each connector instance declares one of **Healthy / Delayed / Failed / Disconnected / Rate Limited / Token Expired / Disabled**, and each state maps to a **recommendation safety** of `safe | degraded | blocked`. A connector in an error state is **flagged in the combined view** ("Google excluded — connector failing"), never silently undercounted. (The detector/eventing that *drives* state transitions from live data is a later slice — this slice establishes the state model, persistence, the safety mapping, and the honest UI surface; M1 instances can be set to Healthy on connect / Disconnected on disconnect.)
> 6. **Authz (§1):** connect / sync / disconnect = **Owner / Brand Admin / Manager**; backfill = **Owner / Brand Admin only** (backfill execution is a later slice, but the role gate is established here so the marketplace honors it). Enforced server-side, not just UI-hidden.
> 7. **Per-brand isolation (the ONE invariant + §9):** connector_instance + health are brand-scoped (RLS FORCE fail-closed); `brand_id` from the session / signed OAuth state, **asserted, never inferred from the body**; cross-brand = 0 rows under `SET ROLE brain_app`; no token ciphertext or PII returned to the client; no secret in logs.
> 8. **Automated tests:** catalog renders all categories with truthful status (no faked-live); a Coming-Soon tile cannot be "connected"; generic connect returns an oauth_url and the callback derives brand_id from signed state (not body) — a forged-body brand_id is rejected; disconnect revokes + flips state to Disconnected; the 7-state → safety mapping is correct; authz negative-control (a Manager can connect but cannot backfill; an Analyst cannot connect); isolation negative-control under `SET ROLE brain_app` (brand A never sees brand B's connector instance); a Playwright e2e — marketplace renders categories + truthful tiles, "Skip For Now" works, an OAuth tile initiates connect.

---

## Problem statement

The M1 data-plane spine can compute and display the reconciling number from *seeded* data, but there is no honest way for a brand to *connect a real source*. Today only Shopify exists, as a one-off flat list item with a Shopify-special-cased flow and a 3-state status (connected/disconnected/error). The epic (§1, §8, §9) calls for a category-organized Integration Marketplace where every tile tells the truth (no faked "live"), a *generic* connect contract (so Shopify is one instance and the next four connectors plug in without re-architecting), KMS-scoped per-brand token storage, and the 7-state health model with a recommendation-safety mapping. This slice is the entry layer every later connector slice (Shopify deep, Razorpay settlement, Meta/Google Ads) builds on.

## Target user

Owner / Brand Admin / Manager connecting a data source from Settings → Connectors (the Integration Marketplace). India DTC brand, M1.

## Success metric

A brand sees a category-organized marketplace where every tile shows truthful status (Coming-Soon tiles can't be connected; no tile fakes live); connecting an OAuth connector returns a real `oauth_url` and the callback derives `brand_id` from the signed state (a forged body is rejected); tokens are stored as per-brand-encrypted ciphertext, never returned, revoked on disconnect; each instance carries one of the 7 health states mapped to `safe|degraded|blocked`; authz holds server-side (Manager connects, only Owner/Admin backfills, Analyst can't connect); cross-brand connector reads = 0 under `brain_app`. All proven by automated tests incl. a Playwright e2e.

## Constraints

- **Honesty (epic §1/§8):** no tile ever fakes "live"; Coming-Soon is explicit and un-connectable; an errored connector is flagged in the combined view, never silently undercounted. No half-built connector ships.
- **Generic seam, not a rewrite:** Shopify's existing OAuth/HMAC/nonce/state-signing security is preserved — it is *registered* under the generic connect seam, not reimplemented. Do not weaken its CSRF/HMAC posture.
- **Token security:** ciphertext only at rest (per-brand KMS data key in prod; the existing `ISecretsManager` dev seam stands in); never returned in full; revoked on disconnect; never logged. `brand_id` from signed state / session, never the body.
- Absolute brand/tenant isolation (the ONE invariant); RLS FORCE fail-closed two-arg; verify under `SET ROLE brain_app` (dev superuser masks RLS). No PII / no token to the client.
- **Envelope discipline:** the BFF `{request_id, data}` envelope — the web client unwraps `.data` (we've fixed ~8 envelope-mismatch bugs; do NOT add a 9th). `connectorsApi` already has a `RawConnectorListEnvelope` pattern — keep it consistent.
- Migrations additive (I-E02): expanding the `connector_instance.status` model to the 7-state health (+ safety mapping) is an additive migration (new column/table + CHECK), not a destructive rewrite of 0006.
- Hard rule: no NEW deployable — the existing core `connector` module + the existing web app. No new service.

## Non-goals

- **The deep Shopify connector** (live order ingestion, webhooks, the 35-day re-pull window) — a separate epic slice. This slice generalizes the *connect/disconnect/health/marketplace shell*, not the data pull.
- **Backfill execution** (the 24-month paged pull, two-lane `prod.backfill.*` topics, progress UX) — a later slice. This slice only establishes the backfill *authz gate* (Owner/Admin-only).
- **Live sync** (webhooks, polling+cursor, settlement files, the freshness targets) — later slices.
- **The health *detector*** (volume-anomaly + schema-violation + client-vs-server match-rate that *drives* state transitions, `connector.health.changed` eventing, tracking-dark, DQ A+→D gating) — a later slice. This slice establishes the state model + persistence + safety mapping + honest surface; transitions are connect→Healthy / disconnect→Disconnected for M1.
- Razorpay settlement / Meta / Google Ads deep connectors (later slices — they ship here only as catalog Coming-Soon/connect tiles).
- Real KMS wiring in dev (the `ISecretsManager` dev seam stands in; real per-brand KMS is a platform follow-up, as with `contact_pii`).
- GCC connectors (Salla/Zid/Noon/Tabby/Tamara) — Phase 5.

## Linked prior runs

- feat-m1-app-foundation (the Shopify OAuth/HMAC/secrets/connector_instance impl this generalizes; the pixel module)
- feat-access-onboarding-flow + feat-members-team-management (the role model the authz gate reads: owner/brand_admin/manager/analyst)
- feat-analytics-api-dashboard (the dashboard the connected sources will eventually feed)

## Notes

- Existing schema (0006_connector.sql): `connector_instance` (status CHECK connected/disconnected/error — to be extended to the 7-state health + safety), `connector_sync_status` (state connected/syncing/waiting_for_data/error), `connector_cursor`. All RLS FORCE, brain_app GRANTed SELECT/INSERT/UPDATE.
- Existing code: `sources/storefront/shopify/{InitiateOAuthCommand, HandleOAuthCallbackCommand (state-nonce + HMAC), DisconnectCommand, GetConnectorStatusQuery}`, `infrastructure/secrets/{ISecretsManager, LocalSecretsManager, AwsSecretsManager}`, `infrastructure/state/{IOAuthStateStore, InProcessOAuthStateStore}`, `PgConnectorInstanceRepository`. The empty category dirs (`sources/{payment,marketplace,advertising,messaging,logistics}`, `catalog`, `connection`) are the scaffolds to populate. Web: `app/(dashboard)/settings/connectors/page.tsx` (the marketplace page to build), `components/connectors/connectors-list.tsx`, `connectorsApi` in `lib/api/client.ts` (install/status/disconnect already there).
- **Architect must bind:** the connector-definition catalog shape + where it lives (a static registry in the connector module — the single source of truth) and how a category/method drives the tile; the generic connect contract (`POST /api/v1/connectors {type}` → oauth_url | credential intake) and how the existing Shopify command registers under it without losing HMAC/CSRF; the additive migration for the 7-state health + the `safe|degraded|blocked` safety mapping (column vs lookup table); the authz enforcement point (server-side role check for connect/sync/disconnect vs backfill); the envelope shape the marketplace consumes; the dev KMS seam (`ISecretsManager`) boundary for prod KMS-EncryptionContext.
- Builder lesson (carried): tight scopes + **COMMIT PER SLICE** (prior builders died on infra socket timeouts ~61 min — only committed work survived). Tracks: **@backend-developer** (catalog registry + generic connect seam + 7-state health migration + authz + token-storage refactor) ∥ **@frontend-web-developer** (marketplace UI + truthful tiles + Skip-For-Now + client + e2e). Verify isolation under `SET ROLE brain_app`.
- This is the epic's entry layer: after it, Shopify-deep / Razorpay-settlement / Meta+Google plug into the generic seam + catalog without re-architecting the connect path.
