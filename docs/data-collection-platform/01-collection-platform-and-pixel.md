# 01 — Brain Data Collection Platform & First-Party Pixel

> Deliverable cluster D1 (platform definition) + D2 (first-party pixel platform).
> Skeptical-board posture: every capability is tagged **Present / Equivalent / Missing / Raw-Only / Reject** with a file ref or justification. Where build is recommended, the exact seam to extend (table / module / package / event) is named. **No new deployable, no new module, no new package, no new topic, no new envelope** is proposed — all gaps are filled by extending existing seams.

---

## D1 — The Brain Data Collection Platform

### D1.1 Purpose (why it is foundational)

Brain is an **AI-Native Commerce OS**, not a dashboard/CDP/BI/attribution tool. Every recommendation the Decision Engine emits is only as trustworthy as the first-party signal underneath it. The Collection Platform is the **bottom of the trust stack**: if collection loses an event, mislabels a tenant, or leaks raw PII, every downstream layer (identity → journey → revenue-truth → attribution → confidence → decision) inherits the defect and the confidence score is a lie. Hence the platform's prime directives are **(a) never lose an event** (Accept-Before-Validate, `I-ST02`) and **(b) Bronze is the immutable, replayable source of truth** (`I-E02`).

### D1.2 The chain (collection → … → decision-intelligence) and what each link owns today

| Link | Owner seam (exists today) | State |
|---|---|---|
| **Collection** | `apps/collector` edge → `collector_spool` (`0015`) → drainer → `dev.collector.event.v1` → `bronze_events` (`0016`) | **Present** — battle-tested per `feat-data-plane-ingest-spine` |
| **Identity** | `apps/stream-worker/src/domain/identity/IdentityResolver.ts` + `identity_graph` (`0017`), deterministic mint/link/merge | **Present** (strong identifiers only: email/phone/storefront_customer_id) |
| **Journey** | HLD-declared `silver.touchpoint` **owned by the attribution module** (`apps/core/src/modules/attribution`, currently a stub); sessionize step in stream-worker | **Missing** (gated on Silver tier landing) — out of scope for D1/D2, flagged for the journey deliverable |
| **Revenue-truth** | `realized_revenue_ledger` (`0018`/`0027`) — orders/settlements/refunds/RTO/chargebacks, deterministic recognition | **Present** |
| **Attribution** | `apps/core/src/modules/attribution` (stub) consuming Silver | **Missing** (downstream phase) |
| **Data-quality / Confidence** | `packages/contracts/src/dq` Zod stubs + DLQ runtime; `dq_grade`/`cost_confidence` per `METRICS.md` | **Equivalent/Missing** (no execution engine) |
| **Decision-Intelligence** | the Decision Engine — everything above feeds it | downstream |

**Boundary statement (enforce ruthlessly):** the Collection Platform's job ends at *durable, tenant-stamped, PII-safe Bronze rows*. It does **not** sessionize, attribute, model journeys, or take actions (no order-recovery, no campaigns — that is Decision-Engine/outbound territory, `I-ST05`). D2's pixel is a **capture-and-POST** client; all modeling happens downstream of `/collect`.

### D1.3 Ownership & boundaries

- **Edge ingest**: `apps/collector` (deployable already exists). The pixel POSTs here; no second ingest edge (**Reject** a new edge).
- **Pixel install/verify/health control-plane**: `apps/core/src/modules/connector/pixel/` (already exists; note: under `connector/`, not top-level — **Reject** a top-level `modules/pixel`).
- **The capture SDK (brain.js)**: `packages/pixel-sdk` (scaffold exists as `export {}`) — **the designated seam to extend**.
- **Wire contract**: `CollectorEventV1` (Zod, `packages/contracts`) + `collector.event.v1.avsc` (Avro) + `dev.collector.event.v1` topic — **reuse, do not fork** (**Reject** a new envelope/topic).

---

## D2 — First-Party Pixel Platform (brain.js)

> **Single highest-level framing:** brain.js is a **versioned static JS asset** that runs in the merchant storefront, captures first-party behavioural signal, hashes PII at the boundary (`D-10`/`I-S02`), and POSTs the **existing Avro/Bronze wire shape** to the **existing** `/collect` edge. It is **not** a deployable, **not** a module, **not** a new package — it is the implementation of the already-scaffolded `packages/pixel-sdk`.

### D2.0 Capability ledger (tag + seam)

| # | Capability | Tag | Seam / file ref |
|---|---|---|---|
| C1 | Accept-before-validate `/collect` edge | **Present** | `apps/collector/src/interfaces/rest/collect.route.ts` (D-1 ordering) |
| C2 | Durable spool (no-loss) | **Present** | `db/migrations/0015_collector_spool.sql`; `I-ST02` |
| C3 | Drainer + back-pressure | **Present** | `apps/collector/src/application/drain-events.usecase.ts` (F-3) |
| C4 | Bronze sink (tenant-isolated, append-only, idempotent PK) | **Present** | `db/migrations/0016_bronze_events.sql` (RLS FORCE NN-1, `(brand_id,event_id)` PK) |
| C5 | Wire envelope (Avro) | **Present** | `infra/redpanda/schemas/collector.event.v1.avsc` |
| C6 | Field-level contract (Zod SoR) | **Present** | `packages/contracts/src/events/sample.collector.event.v1.ts` |
| C7 | Pixel install/verify/health control-plane | **Present** | `apps/core/src/modules/connector/pixel/interfaces/http/pixelRoutes.ts`; `db/migrations/0007_pixel.sql` |
| C8 | Install snippet + `install_token` (public id) | **Present** | `pixelRoutes.buildDefaultSnippet` (line 129) |
| C9 | Install-wizard UI | **Present** | `apps/web/components/pixel/pixel-wizard.tsx` |
| C10 | The `/pixel.js` asset the snippet references | **Missing** | snippet at `pixelRoutes.ts:138` points to `${ingestBaseUrl}/pixel.js` — **the file does not exist anywhere** (confirmed: no `pixel.js` outside `.next` builds) |
| C11 | `@brain/pixel-sdk` implementation | **Missing** | `packages/pixel-sdk/src/index.ts` is literally `export {}` — extend THIS |
| C12 | anon-id (`brain_anon_id`) generation + persistence | **Missing** | new SDK code in `packages/pixel-sdk`; persisted via storage layer (D2.4) |
| C13 | 30-min session management | **Missing** | new SDK code; reuses the inert `hashed_session_id` envelope field (C6 line 75) |
| C14 | click-ID / UTM capture + `_fbc`/`_fbp` | **Missing** | new SDK code → carried in `payload` (additive, no envelope change) |
| C15 | Client event queue + offline retry | **Missing** | new SDK code (D2.3) |
| C16 | Client-side PII hashing at boundary | **Missing** | new SDK code; **must mirror** `packages/identity-core` hash algorithm (`sha256(salt‖normalized)`) — see D2.6 risk |
| C17 | Consent-at-capture (capture/update/withdraw/regional/absent) | **Missing** | new SDK code (D2.7) |
| C18 | Cart-attribute stitch writer | **Missing** (deferred to connector/cart-stitch deliverable) | `packages/pixel-sdk` writer + `packages/shopify-mapper` parser — out of D2 scope, named for continuity |
| C19 | Browser-origin `/collect` E2E smoke | **Missing** | only the Node fixture exists (`tools/pixel-fixture/send-event.mjs`, exits 0 in stub mode) |
| R1 | New ingest edge / deployable | **Reject** | edge + spool + Bronze complete; SDK is a static asset on the storefront CNAME |
| R2 | New `pixel-sdk` package / top-level `modules/pixel` | **Reject** | both seams already exist |
| R3 | New event envelope / topic for SDK events | **Reject** | `CollectorEventV1` + `collector.event.v1` carry arbitrary `event_type`+`payload` additively (FULL_TRANSITIVE) |
| R4 | Edge-side validation / Apicurio call in `/collect` | **Reject** | violates D-1 / `I-ST02` (risks event loss) |
| R5 | RLS on `collector_spool` | **Reject** | deliberately pre-brand-validation; isolation enforced at Bronze |
| R6 | `install_token` as a secret/auth credential | **Reject** | public tracking id by design (`0007_pixel.sql:9`) |
| RO1 | Any new SDK field at the edge | **Raw-Only** | lands opaque in `collector_spool.raw_body` → flows through to `bronze_events.payload`; **never modeled/validated at the edge** |

### D2.1 SDK architecture, config, init, versioning, upgrade, multi-tenant, env

**Architecture (extend `packages/pixel-sdk`):** a single self-initialising IIFE that reads `window.__brain` (already emitted by the snippet: `{ install_token, brand_id }`, `pixelRoutes.ts:136`). Internal shape follows DDD-lite for a client bundle:

```
packages/pixel-sdk/src/
  index.ts                 # public bootstrap (replaces `export {}`)
  config/                  # reads window.__brain; resolves ingest base URL
  identity/                # brain_anon_id mint + persist (C12)
  session/                 # 30-min rolling session (C13)
  capture/                 # event factory: page_view, add_to_cart, checkout… → Avro wire shape (C5)
  attribution-signals/     # UTM + click-id + _fbc/_fbp extraction (C14)
  consent/                 # consent state machine (C17)
  hashing/                 # boundary PII hashing (C16) — mirrors identity-core algo
  transport/               # queue + batch + retry + offline + sendBeacon/fetch (C15)
  diagnostics/             # debug/health/telemetry (D2.5)
```

The built asset is published as **`/pixel.js`** (C10) served by the existing collector or storefront CDN over the per-tenant CNAME — **no new deployable** (a static file on an existing surface).

**Config / init.** Zero merchant-authored config beyond the snippet. `window.__brain.install_token` + `brand_id` are the only inputs. `brand_id` is stamped into every event envelope (`I-S01`) **client-side**, because the edge does not parse `brand_id` — confirmed: `drain-events.usecase.ts:33` reads only `correlation_id` from the body; `brand_id` rides in the body and is resolved at the Bronze write. **Therefore the SDK is solely responsible for stamping a correct `brand_id`; a wrong/missing `brand_id` is the only way an event becomes unroutable.** (See D2.6.)

**Versioning & upgrade.** The asset is **versioned** (`/pixel.js` = latest stable channel; `/pixel.v{N}.js` = pinned). Wire compatibility is guaranteed by the **FULL_TRANSITIVE / additive-optional** Avro contract (`C5` doc + `I-E01`): a new SDK version may only **add** optional `payload` keys, never rename/retype envelope fields. The optional Avro field `collector_version` (`avsc` line 64) is the analog for an SDK build tag — **reuse it**: stamp `collector_version = "pixel@{semver}"` so every Bronze row is traceable to the emitting SDK build. **No envelope change required.** Upgrade is "ship a new static asset"; merchants on the CNAME get it transparently; pinned merchants stay on `/pixel.v{N}.js`.

**Multi-tenant.** One asset, every brand — Single-Primitive. Per-tenant divergence is data (`window.__brain`), never code. The per-brand salt for hashing is **not** shipped in the asset (see D2.6).

**Env.** Storefront `<script defer>`; must run under Shopify's lax sandbox (D2.8) and standard `<head>`/GTM injection on Woo/custom storefronts.

### D2.2 — Event lifecycle: create → queue → batch → retry → offline → dedupe → delivery guarantees

**Create.** `capture/` builds the **Avro/Bronze wire shape** (the shape the fixture + `BronzeRepository` already use — `tools/pixel-fixture/send-event.mjs:31`), **not** the Zod-string shape. Concretely each event carries: `event_id` (UUIDv4, client-generated), `brand_id`, `occurred_at`/`ingested_at` (epoch-millis long), `schema_name`, `schema_version`, `partition_key = brand_id:event_id`, `correlation_id`, `event_type` (e.g. `page_view`, `add_to_cart`, `checkout_started`), and `payload` (JSON string: anon-id, session, UTMs, click-ids, hashed identifiers — all **no raw PII**, `I-S02`). New event types ride `event_type`+`payload` with **no contract change** (RO1).

> **Watch-item (reconcile, do not fork):** two envelope shapes coexist — Zod `event_name`/ISO-string vs Avro `event_type`/millis-long. The SDK emits shape (b) Avro/Bronze, which is what the drainer→Bronze path consumes today. The Zod schema stays the field-level SoR. **Flag to Architect:** add an optional Zod alias for `event_type`/millis OR confirm the drainer normalises — but **do not** invent a third shape.

**Queue.** In-memory ring buffer + `localStorage`-backed durable queue (survives reload/navigation). Cap size; drop-oldest with a `queue_overflow` diagnostic counter rather than blocking the page.

**Batch.** Coalesce N events / T ms into one `/collect` POST body (array) to cut request count. The edge accepts a raw body opaquely (`collect.route.ts:26`), so a batched array is a **Raw-Only** downstream concern — but note the spool stores `raw_body` as one row per POST; **prefer one event per POST OR confirm the drainer fans out an array** before batching. **Conservative default: one event per POST** (the spool's `(received_at, raw_body)` row model and the drainer's per-row produce assume single events — batching is an optimisation that must be co-designed with the drainer, flagged to Architect).

**Retry / offline.** `transport/` uses `navigator.sendBeacon` on `pagehide`/`visibilitychange` (fire-and-forget, survives unload) and `fetch(keepalive)` otherwise. On network failure or non-2xx, the event stays in the durable `localStorage` queue with exponential backoff; flush on next page load / connectivity restore. **This is the client-side analog of the server spool** — the no-loss guarantee extends to the browser edge.

**Dedupe / delivery guarantees.** Delivery is **at-least-once** from the browser (retries can resend). De-duplication is **already guaranteed downstream**: `bronze_events` PK `(brand_id, event_id)` (`0016:36`, `I-ST04`) makes replays idempotent — a resent event with the same client-generated `event_id` is a no-op insert. **Therefore the SDK MUST generate `event_id` once at create-time and reuse it across all retries of the same event** (never regenerate on retry). End-to-end guarantee: **at-least-once on the wire, exactly-once in Bronze.**

### D2.3 — Storage: cookies / local / session / server-set / cross-subdomain / ITP / Safari

| Mechanism | Use in brain.js | Tag | Notes |
|---|---|---|---|
| **First-party cookie** (`brain_anon_id`) | primary anon-id persistence | **Missing→build** | `SameSite=Lax; Secure`; **server-set via `Set-Cookie` on the `/collect` response** to dodge ITP's 7-day cap on JS-written (`document.cookie`) cookies |
| **localStorage** | durable event queue (C15) + anon-id mirror | **Missing→build** | survives navigation; not capped by ITP the way JS cookies are, but **partitioned/evicted under Safari** — must tolerate loss (anon-id regenerated, not fatal) |
| **sessionStorage** | 30-min session scratch (C13) | **Missing→build** | per-tab session window |
| **Server-set cookie** | the ITP-resilient anon-id | **Missing→build (high value)** | the collector edge response is the natural `Set-Cookie` point; **extend `collect.route.ts` reply** to set the first-party anon-id cookie when absent — additive, no D-1 violation (still ACK after spool) |
| **Cross-subdomain** | anon-id stable across `www`/`checkout`/`shop` | **Missing→build** | `Domain=.brand.com` on the cookie; served over the **per-tenant CNAME** so the cookie is first-party to the merchant domain |
| **ITP / Safari** | mitigation strategy | **Missing→build** | first-party CNAME + server-set cookie + localStorage fallback; never rely on third-party cookies or JS-written cookies for long-lived id |

**Decision:** the **server-set first-party cookie over the per-tenant CNAME** is the ITP/Safari-durable anon-id mechanism. This requires a small **additive** extension to the collector reply (set cookie if absent) — it does **not** touch D-1 ordering (cookie is set on the response *after* the spool INSERT). Tag: extend `apps/collector/src/interfaces/rest/collect.route.ts`.

### D2.4 — anon-id, session, attribution signals (the capture substrate)

- **anon-id (`brain_anon_id`, C12):** UUIDv4 minted on first visit, persisted via the cookie+localStorage strategy (D2.3). Carried in `payload.brain_anon_id`. Downstream it binds to the **existing `customer.anonymous_id`** seam (`identity_graph` `0017`) — **reuse, do not invent a parallel id** (the identity ground-map explicitly rejects a new session/anon authority).
- **session (C13):** 30-min rolling inactivity window; session-id hashed client-side and emitted in the **already-present-but-inert** `hashed_session_id` envelope field (`C6:75`). This activates a field that exists today but is consumed by nothing — no schema change.
- **attribution signals (C14):** capture `utm_*`, `gclid`, `fbclid`, and persist `_fbc`/`_fbp` per Meta convention. All land in `payload` (Raw-Only at the edge). These are the **first-touch signals the cart-stitch deliverable later reads back from the order** to close anon→known→order — captured here, modeled there.

### D2.5 — Diagnostics: health / debug / verify / telemetry

| Surface | Tag | Seam |
|---|---|---|
| **Install presence verify** (server-side real HTTP HEAD/GET) | **Present** | `POST /api/v1/pixel/verify` (`pixelRoutes.ts:78`) — already real, not simulated |
| **Health widget** (status: connected/syncing/waiting_for_data/error) | **Present** | `GET /api/v1/pixel/health` → `pixel_status` (`0007`) |
| **Debug mode** (`window.__brain.debug=true` → console event log, no PII) | **Missing→build** | SDK `diagnostics/` |
| **SDK self-telemetry** (queue depth, drop count, retry count, last-flush) | **Missing→build** | emit as a `pixel.diagnostic` `event_type` on the **same** `/collect` path (Single-Primitive: diagnostics are just events) — no new endpoint |
| **Browser-origin E2E smoke** | **Missing→build** | extend `tools/pixel-fixture` with a headless-browser flavour that loads the built `pixel.js` and asserts a row in `bronze_events` (closes C19; the current fixture is Node-only and exits 0 offline) |

### D2.6 — HIGHEST-RISK DECISION: where does PII hashing + the per-brand salt live?

**The contract bans raw PII (`I-S02`) and requires `hashed_user_id = sha256(per-brand-salt ‖ normalized)`** (`C6:66`). Today the *only* server-side hasher is `packages/identity-core` with a **per-brand salt that hard-crashes on miss** and is held in `brand.identity_salt_ciphertext` (KMS, server-side). **The browser cannot be given the per-brand salt** — shipping the salt in `pixel.js` would expose every brand's salt publicly and let anyone forge or correlate hashes. This is the single highest-risk decision in D2.

**Recommended resolution (deterministic-first, no new deployable):**
1. **The SDK emits `brain_anon_id` + raw-but-minimised identifiers ONLY where unavoidable, and prefers to send NO raw PII** — anon behavioural events (page_view, add_to_cart) need no email/phone at all. Known-user identifiers (email/phone on a `customer.identified` event) are **the only** case.
2. For those, the SDK applies a **transport-only client hash with a salt the browser legitimately has** (the install context), and the **canonical per-brand-salt re-hash happens server-side in `stream-worker`** (`ResolveIdentityUseCase` already owns `SaltProvider`). I.e. the browser never holds the brand salt; identity resolution re-derives the canonical hash from a normalised value carried in a **vault-bound, never-Bronze** path — OR the SDK sends only `brain_anon_id` and lets the **existing cart-stitch / connector identity extraction** supply email/phone server-side from the order payload (which already happens for Shopify).
3. **Preferred posture:** brain.js captures **behaviour + anon-id + attribution signals**, and **defers all email/phone hashing to the server-side identity path that already has the salt.** This keeps `I-S02` true by construction (no raw PII ever leaves the browser unhashed *and* no salt ever enters the browser), and avoids a second hashing util (the ground-map **rejects** a second hasher).

**Why this is the highest risk:** it is the one place where a wrong call either (a) leaks a brand salt to the public (catastrophic, irreversible) or (b) breaks identity-join determinism (anon never resolves to known). **Flag to Architect for an explicit ADR before any hashing code is written in `packages/pixel-sdk`.** Default to "browser sends no raw PII and no salt; server hashes" unless the ADR proves a specific known-user signal must be hashed client-side.

### D2.7 — Consent: capture / update / withdraw / regional / absent-behaviour

| Aspect | Behaviour | Tag / seam |
|---|---|---|
| **Capture** | read the storefront/CMP consent signal at init; stamp `payload.consent = {analytics, marketing, personalization, ai_processing}` on every event | **Missing→build** (SDK `consent/`); aligns to the 4-category model `COMPLIANCE.md` mandates (`consent_record` is the downstream SoR, not yet built) |
| **Update** | re-read CMP on change; subsequent events carry the new state | **Missing→build** |
| **Withdraw** | stop emitting marketing/personalization events; analytics-only or full-stop per category | **Missing→build**; downstream `consent_tombstone` + `<15min` suppression is `I-S03`/`I-S04` (not in D2 scope — D2 only *captures* the signal) |
| **Regional (DPDP/IN, GCC)** | default-deny in regulated regions until consent present; region from `brand.region_code` context, not guessed | **Missing→build**; **RegionAdapter posture — never assume region** |
| **Absent / no CMP** | **fail-safe default**: capture anon behaviour (legitimate first-party analytics) but **withhold** anything consent-gated; never assume consent | **Missing→build** |

**Boundary:** the SDK **captures and transmits** the consent signal; **enforcement** (`can_contact()`, suppression, CAPI-deletion) is the downstream chokepoint (`I-ST05`), explicitly **not** a pixel concern. Do not build enforcement in the SDK.

### D2.8 — Shopify Web Pixels API / Customer Events sandbox (MANDATORY)

Shopify storefronts increasingly load custom pixels inside a **sandboxed environment**, which directly constrains brain.js:

- **Two sandbox types:** app-extension pixels run in a **strict** sandbox (Web Worker, no DOM at all); custom pixels run in a **lax** sandbox (an `<iframe sandbox="allow-scripts allow-forms">`). [Shopify Web Pixels API]
- **No top-frame / DOM access:** traditional pixels using `window.document` won't work; the iframe **cannot access the top frame**. `window.location.href` returns the **sandbox URL**, not the storefront URL. [Shopify]
- **Cookies/localStorage are polyfilled, not direct:** `document.cookie` and `window.localStorage` are **proxied asynchronously to the parent window** via the `browser` object (`browser.cookie`, `browser.localStorage`, `browser.sessionStorage`). Direct synchronous access is blocked. [Shopify; Shopify Community]
- **Events come from the `analytics.subscribe` Customer Events API**, not DOM listeners.

**Design implications for brain.js (must address):**
1. **Storage abstraction is mandatory.** The SDK's `storage/` layer must have a **Shopify-sandbox driver** that uses the async `browser.cookie` / `browser.localStorage` API, and a **standard driver** (direct `document.cookie`/`localStorage`) for Woo/custom storefronts. Same SDK, two storage drivers selected at init — Single-Primitive preserved.
2. **anon-id persistence becomes async** in the sandbox — the queue/transport layer must not assume synchronous reads.
3. **Server-set cookie (D2.3) is even more important** under Shopify: since the pixel can't reliably write a durable top-frame cookie, the **`Set-Cookie` on `/collect` over the per-tenant CNAME** is the robust anon-id mechanism.
4. **Event source = `analytics.subscribe`** for Shopify (`page_viewed`, `product_added_to_cart`, `checkout_started`, `checkout_completed`), mapped into our `event_type`+`payload` wire shape. **URL/referrer must come from the event payload Shopify provides**, not `window.location` (which is the sandbox URL).
5. **`window.__brain` injection** — under a custom pixel the snippet can't rely on top-frame globals; `install_token`/`brand_id` must be passed via the pixel's own settings/config, mapped to the same `window.__brain` contract internally.

**This is a non-trivial fork risk:** the temptation is a "Shopify-only pixel." **Reject** — it must be **one SDK with a pluggable storage+source driver**, not a per-channel SDK (Single-Primitive, `I-E05`).

---

## Net-new (Missing) capabilities — build list, by seam (no new deployable)

1. **brain.js capture SDK** → extend `packages/pixel-sdk/src/index.ts` (replace `export {}`).
2. **The served `/pixel.js` static asset** (+ versioned `/pixel.v{N}.js`) over the per-tenant CNAME.
3. **anon-id + 30-min session** → SDK; reuse `customer.anonymous_id` + the inert `hashed_session_id` envelope field.
4. **UTM/click-id/`_fbc`/`_fbp` capture** → SDK `payload` (additive, no contract change).
5. **Client queue + offline retry + sendBeacon transport** → SDK; client-side analog of the server spool.
6. **Storage layer w/ Shopify-sandbox + standard drivers** → SDK; async `browser.*` API for Shopify.
7. **Server-set first-party anon-id cookie** → additive extension to `apps/collector/.../collect.route.ts` reply (ITP/Safari durability).
8. **Consent-at-capture state machine** → SDK; stamps `payload.consent` (4-category), region-aware, fail-safe-absent.
9. **Client PII-hashing posture** → resolve via ADR (D2.6); default = browser sends no salt/no raw PII, server-side `identity-core` hashes.
10. **Diagnostics (debug/telemetry-as-events) + browser-origin E2E smoke** → SDK `diagnostics/` + extend `tools/pixel-fixture`.

**Single highest-risk decision:** **where PII hashing and the per-brand salt live (D2.6).** The browser must never hold a brand salt (public leak = catastrophic, irreversible) yet the contract demands salted hashes — recommended default is *browser sends no raw PII/no salt; the existing server-side `identity-core` + `SaltProvider` does all canonical hashing*. **Requires an Architect ADR before any SDK hashing code is written.**

---

### Competitor benchmark
Shopify sandbox constraints (lax iframe, polyfilled async `browser.cookie`/`localStorage`, no top-frame access, `analytics.subscribe` event source) are drawn from Shopify's official Web Pixels API docs and corroborate the Elevar/Littledata/Fullstory server-side-GTM pattern of *server-set first-party cookies over a merchant CNAME* — which is exactly the ITP-resilience seam D2.3 recommends, achievable here by extending the existing `/collect` reply rather than adding infrastructure.

**Sources:**
- [Shopify Web Pixels API](https://shopify.dev/docs/api/web-pixels-api)
- [Shopify — About web pixels](https://shopify.dev/docs/apps/build/marketing-analytics/pixels)
- [Shopify Community — Using document.cookie in Custom Web Pixel](https://community.shopify.com/t/using-document-cookie-in-custom-web-pixel-environment/284305)
- [Working with Shopify Privacy Consent Data in Custom Web Pixels (Kahunam)](https://kahunam.com/articles/web-analytics/working-with-shopify-privacy-consent-data-in-custom-web-pixels/)
</content>
</invoke>
