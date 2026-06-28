# Brain Universal First-Party Pixel — Refined Review (Spec 4.1–4.16)

Status: read-only Principal review, grounded in real files on `master` (2026-06-28).
Scope: COLLECTION (4.1–4.7), TRANSPORT/RELIABILITY/PERF (4.8–4.10), PRIVACY/SECURITY/CONFIG/OBSERVABILITY (4.11–4.16).
Guiding principle (do not violate): the pixel COLLECTS behavioural data only — never business logic / identity matching / metric calc. Preserve event fidelity, respect consent, minimise storefront impact.

---

## 1. Verdict

**~70% built, and the part that is built is genuinely strong** — the served production pixel does universal commerce + frustration capture (rage/dead/element clicks, SPA nav, cart interception, scroll depth, forms, coupon), a client-side SHA-256 email-hash identity bridge, a durable localStorage queue with storage-authoritative flush, server-trusted `brand_id` derivation from `install_token`, and per-tenant rate-limit + spool backpressure. It is richer than the brief implies. **But four structural gaps undercut the "No event loss / capture truth" mandate and the merchant-visibility goal:** (1) **two divergent pixel codebases** — the served IIFE (`pixel-asset.route.ts` `PIXEL_JS`) is the real, feature-rich pixel; the npm `@brain/pixel-sdk` is a weaker, contract-equivalent subset, so "install via NPM" ships a materially worse pixel; (2) **queue eviction has no priority + no `drop_count`** — a flood of `scroll.depth`/`rage.click` can evict a queued `order.placed`, the one true event-loss hole; (3) **no timed retry backoff** — a failed flush strands the queue until the next page event; (4) **whole areas missing**: remote config (4.13), geo/country enrichment (4.14), DNT/GPC + CMP adapters (4.11), client debug/health beacon (4.15). The single spec↔impl contract delta is **`event_id` is random UUIDv4, not deterministic UUIDv7**. Almost every gap is **buildable-now** and wireable into the existing Tracking Center UI (`apps/web/components/pixel/*`); only a handful are source/infra-blocked (real Magento/BigCommerce store, a real CMP, a `.quarantine` per-brand sink).

---

## 2. Coverage table (every 4.x requirement)

Legend: BUILT / PARTIAL / MISSING. Class: (a) buildable-now · (b) source/infra-blocked · (c) cheap-formalization.

### 4.1 Platforms + install methods
| Requirement | Status | File | Gap / class |
|---|---|---|---|
| Shopify ScriptTag | BUILT | `apps/core/.../ShopifyPixelInstaller` + `registerConnectors.ts:938` | — |
| Shopify Web Pixel (OS2.0 checkout) | BUILT | `extensions/brain-web-pixel/src/index.js` | — |
| Shopify Hydrogen (headless) | MISSING | — | no Hydrogen/Oxygen SDK · (a)/(b) |
| WooCommerce one-click | BUILT | `WooCommercePixelInstaller` + plugin .zip `storefront-install-cards.tsx:127` | — |
| Manual / custom HTML snippet | BUILT | `buildDefaultSnippet` `pixelRoutes.ts:308`; `pixel-wizard.tsx:201` | — |
| mobile-web | BUILT | `uaClass()` | — |
| Magento / BigCommerce / Wix / Squarespace | MISSING | only shopify+woo registered `registerConnectors.ts:937-939` | registry supports add; each = 1 installer · (b) needs a real store to validate |
| Headless React/Vue/Next SDK adapters | MISSING | `@brain/pixel-sdk` vanilla core only | · (a) |
| NPM `@brain/pixel` | PARTIAL | package exists, unpublished, feature-reduced | · (a) unify (see Gap #1) |
| Server-side SDK | PARTIAL | `/collect`,`/v1/events`,`/batch` accept server POSTs `collect.route.ts` | no published pkg · (a) |
| GTM template | MISSING | — | no dataLayer/GTM · (a) |
| Auto-detect platform | PARTIAL | `pageType()` `pixel-asset.route.ts:208` classifies Shopify+Woo | no `platform` field emitted · (c) |

### 4.2 Commerce events
`page_view` BUILT · `product_view` BUILT · `category_view` BUILT (`collection.viewed`) · `search` BUILT (`search.submitted`) · `add_to_cart` BUILT · `remove` BUILT · `view_cart` BUILT · `checkout_started` BUILT · `checkout_step` BUILT · `coupon` BUILT — all in `pixel-asset.route.ts`.
- `purchase` PARTIAL (by design): behavioural `order.placed` + Web Pixel `checkout.completed`; revenue truth stays with connectors.
- `refund`/`cancel` MISSING (by design — server/connector truth).
- `wishlist` MISSING · (a).
- Caveat: in npm SDK `capture.ts`, `search`/`coupon`/`payment.*`/`order.placed`/`wishlist` all MISSING (asset-only).

### 4.3 Behavioural
| Event | Status | File | Gap/class |
|---|---|---|---|
| scroll_depth | BUILT | `pixel-asset.route.ts:325` | — |
| button_click | BUILT | `:310` `element.clicked` | — |
| form_submission | BUILT | `:279` | — |
| navigation (SPA) | BUILT | `:244` | — |
| rage/dead click | BUILT | `:302-321` | — |
| session_start/end | MISSING | session_id exists, no discrete event | · (a) |
| form_interaction (focus/blur) | MISSING | submit-only | · (a) |
| exit_intent | MISSING | — | · (a) |
| video | MISSING | — | · (a) |
| download | MISSING | href captured, not classified | · (a) cheap |
| share | MISSING | — | · (a) |
| heatmap opt-in | PARTIAL | x/y on rage/dead, no opt-in gate/aggregation | · (a) |

### 4.4 Marketing / Attribution
`UTM` BUILT · click_ids BUILT (`fbclid/gclid/ttclid/msclkid` + `gbraid/wbraid/dclid` + `_fbc/_fbp/li_fat_id/epik` cookie) `attribution.ts` + `pixel-asset.route.ts:66-77` · `referrer` BUILT · `landing` BUILT.
- **first-touch persisted MISSING (real gap)** — UTM/click_ids re-read from current URL each event (`capture.ts:108`), never persisted to localStorage like anon_id → first-touch lost after landing page · (a).
- data-layer campaign MISSING · (a).

### 4.5 Identity
| Signal | Status | File | Gap/class |
|---|---|---|---|
| anon_id (2yr cookie) | PARTIAL | `identity.ts:9` localStorage default; 2yr cookie only behind `PIXEL_FIRST_PARTY_COOKIE` `collect.route.ts:31` | server cookie opt-in, not default · (c) |
| session_id (30min) | BUILT | `identity.ts:11` | — |
| device fingerprint | MISSING (by privacy design) | `ua_class`+viewport only | intentional · (c) document |
| hashed email bridge | BUILT | `pixel-asset.route.ts:160-179,295` SHA-256 client-side | — |
| hashed phone | MISSING | identify=email only | · (a) |
| hashed customer_id | MISSING | — | · (a) |
| `data-brain-identity` declarative | PARTIAL/MISSING | email sniffed heuristically, no named attr | · (c) formalize |
| loyalty/membership | MISSING | — | · (a) |

### 4.6 Session management
30-min rolling session_id BUILT (`identity.ts:31`), cross-tab continuity via localStorage BUILT, durable queue + pagehide/visibilitychange flush BUILT (`pixel-asset.route.ts:134-150,328`). Gap = no explicit lifecycle events (see 4.3). Otherwise sound.

### 4.7 Device / browser context
viewport BUILT (`device.viewport`), ua_class PARTIAL (mobile|desktop, raw UA withheld). MISSING, all (a)/(c), all consent-gate-recommended: **screen**, **language**, **timezone**, **DNT** (not even read), **connection**. Grep confirms zero hits for `doNotTrack|screen.|timezone|navigator.language|navigator.connection`.

### 4.8 Envelope + Transmission
| Point | Status | File | Gap/class |
|---|---|---|---|
| event_id = UUIDv7 | PARTIAL — DELTA | `pixel-asset.route.ts:49-52` `crypto.randomUUID()` = v4 | random v4 minted-once/reused-on-retry; NOT v7, NOT deterministic · (c) |
| event_name dot.lowercase | BUILT | `:111` | — |
| timestamp ISO-8601 UTC | BUILT | `:112` | — |
| tenant_id | BUILT | `brand_id` partition-only, server-derived | — |
| anon/session/user_id | PARTIAL (by design) | anon+session BUILT; user_id via identify hash | privacy-correct · (c) |
| page | PARTIAL | only `landing_path` `:106` | no page_url/title · (a) |
| referrer | BUILT | `:106` | — |
| UA | PARTIAL (privacy) | ua_class only | intentional · (c) |
| device | BUILT | `:107` | — |
| utm context | BUILT | `:77,109` | — |
| payload | BUILT | `:110` | — |
| POST to `/pixel/v1/events` + CNAME | PARTIAL — DELTA | posts `/collect` `:42`; `/v1/events` alias unused; CNAME BUILT | path-name delta · (c) |
| batching ≤10/2s | MISSING (client) — VETOED | one-per-POST `:142,152`; server `/batch` exists `collect.route.ts:123` unused | REC-5 veto vs spec · (a)+product decision |
| gzip body | MISSING | `:128` text/plain | · (a) marginal pre-batch |
| 200 + acked event_ids | PARTIAL | `/collect` returns no event_ids `collect.route.ts:91` | · (c) echo ids |

### 4.9 Reliability
| Point | Status | File | Gap/class |
|---|---|---|---|
| local queue + localStorage backup | BUILT | `:117-118,328` MAX_QUEUE=200 | — |
| exp-backoff retry 1s→30s ×5 | MISSING | flush stops on fail `:144`, waits next trigger | no timed loop · (a) |
| offline buffer 100ev/5MB | PARTIAL | 200 ev cap, no byte cap `:118` | · (a) |
| idempotency_key dedup | PARTIAL (by proxy) | event_id PK; `Idempotency-Key` CORS-allowed `:59` but unread | · (c) |
| in-session ordering | PARTIAL | FIFO head-of-line `:139-146` | no seq# / cross-tab order · (c) |
| graceful degradation: keep-critical + drop_count | MISSING | drops OLDEST, no priority `:118`; no drop metric (0 grep hits) | **highest event-loss hole** · (a) |

### 4.10 Performance
| Point | Status | File | Gap/class |
|---|---|---|---|
| async <1KB loader | BUILT | `buildDefaultSnippet` `pixelRoutes.ts:316-326` | — |
| lazy init | PARTIAL | defer + auto-fire `:332`, no rIC | · (c) |
| bundle <15KB gzip no deps | BUILT (met, unguarded) | 21.4KB raw → 7.9KB gzip; un-minified, no CI gate | · (c) minify + gate |
| batching/gzip | MISSING | see 4.8 | (a)/vetoed |
| debounced listeners | PARTIAL | rage 1.5s `:309`, scroll passive `:325` | no shared rAF throttle · (c) |
| rIC for fingerprint | MISSING (N/A by design) | no fingerprinting | moot · (c) |
| ES5+ | BUILT | hand-written ES5 IIFE | — |
| self perf metrics (load/queue/latency) | MISSING | 0 grep hits | · (a) |

### 4.11 Consent & Privacy
| Point | Status | File | Gap/class |
|---|---|---|---|
| Read CMP (TCF/Cookiebot/OneTrust) | PARTIAL | `consent()` reads `__brainConsent`+Shopify only; 0 hits tcfapi/cookiebot/onetrust | no IAB/Cookiebot/OneTrust adapter · (a) code, (b) to validate vs real CMP |
| categories necessary/analytics/marketing | PARTIAL | `types.ts:15` 4 Brain flags | no `necessary`, not IAB-mapped · (c) |
| suppress denied + emit consent_status | PARTIAL | R3 gate `ProcessEventUseCase.ts:188` blocks ABSENT only | denied-analytics still ships; no client suppression/enum · (a) |
| client-side hashing | BUILT | `pixel-asset.route.ts:160` sha256Hex | — |
| first-party cookies | BUILT (flag-gated) | `collect.route.ts:33` `PIXEL_FIRST_PARTY_COOKIE` | off by default · (c) |
| regional default (GDPR/CCPA) | MISSING | single global `PIXEL_CONSENT_DEFAULT` | no geo branch · (b) gated on geo (4.14) then (a) |
| DNT / GPC | MISSING | 0 hits doNotTrack/GPC/Sec-GPC | · (a) |

### 4.12 Security
| Point | Status | File | Gap/class |
|---|---|---|---|
| HTTPS-only | PARTIAL | snippet https `pixelRoutes.ts:315`; CORS `*` | no HSTS/enforce · (c) |
| per-tenant key / domain-validated | PARTIAL | install_token server-derives brand R2; origin allowlist global+empty `edge-guard.ts:84` | no per-tenant domain validation · (a) |
| HMAC signing | MISSING | none | stateless-edge by design · (c) decision |
| rate-limit per IP + tenant | PARTIAL | per-token window `edge-guard.ts` | no per-IP dim · (a) |
| replay/idempotency | BUILT | event_id PK + Redis NX `ProcessEventUseCase.ts:214` | v4-vs-v7 delta · (c) |
| no sensitive console | PARTIAL | only install_token warn | · (c) |
| CSP nonce | MISSING | inline bootstrap snippet | breaks strict-CSP · (a) |

### 4.13 Remote Config — MISSING (entire area)
0 hits `remote.config|sampling|feature.toggle|data.layer` across collector+sdk. Only build-time bootstrap (`install_token`,`brand_id`,`ingest_base_url`,`consent_default`) injected. Thresholds hard-coded (rage `:307`, scroll `:324`). Asset served `Cache-Control max-age=300` (static cache, not config doc). · (a) — add `GET /pixel/config?t=` + short-TTL client fetch.

### 4.14 Collector Integration
| Point | Status | File | Gap/class |
|---|---|---|---|
| Fastify validate | PARTIAL (by design) | accept-before-validate D-1; Zod downstream `ProcessEventUseCase.ts:124` | intended split · (c) document, do NOT add request-path validation |
| enrich geo/IP-country | MISSING | `stampEnvelope` adds received_at only; 0 geo hits | country-only, never raw IP · (a) |
| envelope | PARTIAL | `{rawBody,receivedAt}` | no server geo/version stamp · (c) |
| publish tenant-partitioned topic | BUILT (naming delta) | `kafka-producer.ts:84` brand-key; topic `*.collector.event.v1` not `pixel.events` | · (c) |

### 4.15 Observability
| Point | Status | File | Gap/class |
|---|---|---|---|
| `?brain_debug=1` console | MISSING | none | · (a) |
| pixel health every 5min → monitoring topic | MISSING | server has `collector_accept_total`/OTel; no client beacon | · (a) |
| admin real-time + per-tenant health | PARTIAL | merchant `TrackingHealthPanel`/`EventExplorer` exist; quarantine shown as `"—"` `tracking-health-panel.tsx:131` | no cross-tenant admin grid (a); quarantine count (b) needs `.quarantine` sink |
| alerts | MISSING | only service OTel/Sentry | · (a) |

### 4.16 Multi-tenancy & Scale
brand_id-first isolation BUILT (server-derive R2, cross-brand→quarantine+audit, Bronze brand GUC). Per-tenant rate-limit BUILT (`edge-guard.ts`). Bounded backlog/backpressure BUILT (`SpoolBackpressure` 503, reaper, MAX_QUEUE=200). Cross-tenant fairness/QoS PARTIAL — no global fairness/weighted drain · (a), not urgent.

---

## 3. Genuine buildable gaps (prioritized) — with files-touched + UI surface

Built/by-design items excluded. Every gap below is class (a) unless noted. UI surfaces are real files under `apps/web/components/pixel/`.

### P0 — Event-loss + core-truth integrity

**G1. Keep-critical queue eviction + `drop_count` / `pixel.dropped`** (4.9)
- Why: only true "No event loss" violation — a `scroll.depth`/`rage.click` flood evicts queued `order.placed`/`payment.*`/`identify`.
- Files (EXTEND): `pixel-asset.route.ts` `writeQ`/`MAX_QUEUE` `:118`; mirror in `packages/pixel-sdk/src/transport.ts`. Tag critical event families, evict non-critical first, emit a `pixel.dropped {count, reason}` beacon.
- UI: new **`pixel.dropped` row** in `event-explorer.tsx` (config falls back for unknown types) + **"Dropped events" KPI card** in `tracking-health-panel.tsx`.

**G2. Exponential-backoff retry loop 1s→30s ×5** (4.9)
- Why: failed flush strands the queue until the next page event; on a one-page session the queue is lost.
- Files (EXTEND): `pixel-asset.route.ts` `flush()` `:144`; mirror `transport.ts`. Add attempt counter + `setTimeout` schedule.
- UI: **"Delivery reliability" status** (backoff active / N buffered offline) in `tracking-center.tsx` roll-up + retry/queue-depth indicator in `tracking-health-panel.tsx`.

### P1 — Privacy/compliance correctness

**G3. DNT / GPC honor + CMP adapters (TCF `__tcfapi`, Cookiebot, OneTrust)** (4.11/4.7)
- Why: DNT/`Sec-GPC` never read (compliance smell); CMP coverage is `__brainConsent`+Shopify only.
- Files (EXTEND): `consent()` in `pixel-asset.route.ts` + `ConsentReader`/`defaultConsentReader` in `packages/pixel-sdk/src/consent.ts`. Read DNT/GPC → treat as deny; add TCF/Cookiebot/OneTrust reader adapters.
- UI: new **"Consent & Privacy" card** in `tracking-center.tsx` — detected CMP, DNT/GPC honor state, consent-capture rate by category (extend existing `consentGrantedCount` in `get-tracking-health.ts:88`).

**G4. Geo/IP-country enrichment (country only, never raw IP)** (4.14)
- Why: no geo at all; unlocks regional consent default (G3) and merchant value. Privacy-safe = country only.
- Files (EXTEND/NEW): read `cf-ipcountry`/XFF→country in the drainer enrich step (`kafka-producer.ts` / new enrich step beside `envelope.ts`); stamp `geo_country`; never persist raw IP.
- UI: **country column/flag per event** in `event-explorer.tsx` + **"Top countries" tile** in `tracking-health-panel.tsx`.

### P2 — Acquisition fidelity + observability

**G5. First-touch attribution persistence** (4.4)
- Why: UTM/click_ids/referrer/landing re-read from current URL each event; first-touch silently lost after the landing page.
- Files (EXTEND): persist `{utm, click_ids, referrer, landing}` to localStorage on first hit, attach to every event — `pixel-asset.route.ts` build()/`capture.ts:108` + `attribution.ts`.
- UI: **"First touch" line per event** in `event-explorer.tsx` + a brand acquisition-source summary tile.

**G6. `?brain_debug=1` + client health heartbeat (queue/success/latency/errors)** (4.15/4.10)
- Why: no client self-observability; merchants/ops can't see delivery health.
- Files (EXTEND/NEW): debug param in `pixel-asset.route.ts` + `browser-entry.ts`; periodic `pixel.health`/`pixel.perf` beacon to `/collect`; consume into tracking-health BFF (`get-tracking-health.ts`).
- UI: **debug toggle** in the Tracking-settings card (G9) + **p50/p95 latency, load-time, queue-depth, error tiles** in `tracking-health-panel.tsx`.

### P3 — Hardening + breadth (lower urgency, all extend)

**G7. Per-tenant origin validation + per-IP rate dimension + CSP-nonce snippet** (4.12)
- Files (EXTEND): validate `Origin` vs `pixel_installation.target_host` in `edge-guard.ts`; add per-IP bucket (XFF already trusted); nonce-able/data-attr snippet in `buildDefaultSnippet` (`pixelRoutes.ts`).
- UI: **"Allowed origins" editor + "Rejected events" count + CSP-snippet toggle** in install/security subsection of `tracking-center.tsx`.

**G8. Device context fields — screen / language / timezone / connection (consent-gated)** (4.7)
- Files (EXTEND): add to props in `pixel-asset.route.ts` + `capture.ts`; gate behind personalization consent.
- UI: enrich per-event `details` map already rendered by `event-explorer.tsx`.

**G9. Remote config endpoint + short-TTL client fetch** (4.13)
- Files (NEW + EXTEND): `GET /pixel/config?t=<install_token>` on collector (enabled events, sample rates, debug flag, consent categories, data-layer map); config row beside `pixel_installation`; boot fetch + localStorage TTL cache in both `createPixel` and `PIXEL_JS`.
- UI: **"Tracking settings" card** in `tracking-center.tsx` (manager+) — toggle event families, sampling %, debug, regional policy, data-layer key mapping. (Also the home for G3 regional policy + G6 debug toggle.)

**G10. Identity breadth — hashed phone, hashed customer_id, declarative `data-brain-identity`** (4.5)
- Files (EXTEND): `identify()` in `pixel-asset.route.ts` + `identity.ts`. Read a named `data-brain-identity` attribute → hash; add phone/customer_id hashing.
- UI: identity-match-rate stat in `tracking-health-panel.tsx` (% sessions reaching a known customer); identify rows already render in `event-explorer.tsx`.

**G11. Behavioural breadth — session lifecycle, exit_intent, download, share, video, form field-interaction, wishlist** (4.3/4.2)
- Files (EXTEND): selectors/listeners in `pixel-asset.route.ts`. All auto-render in `event-explorer.tsx` (unknown-type fallback). Heatmap/exit-intent/session-lifecycle merit a dedicated **"Behavioural signals" panel** under Overview.

**G12. UUIDv7 event_id (the one spec↔impl contract delta)** (4.8/4.12)
- Files (EXTEND): `uuid()` in `pixel-asset.route.ts:49`, `browser-entry.ts:60`, `extensions/brain-web-pixel/src/index.js:45`, `capture.ts:115`; comment at `packages/contracts/src/events/sample.collector.event.v1.ts:31`. Swap v4→time-ordered v7 (improves Iceberg Bronze clustering + `(brand_id,event_id)` dedup locality). Pure client change, no schema break.
- UI: already shown as `event_id` in `event-explorer.tsx` — no UI change needed.

**G13. Cheap-formalizations bundle** (4.8/4.10/4.14)
- Echo `event_id`(s) in `/collect` ACK; 5MB serialized-bytes queue cap; minify `PIXEL_JS` + `<15KB gzip` CI gate in `pr.yml`; add `page_url`/`page_title`; shared rAF scroll throttle; `requestIdleCallback` for non-critical hookup; document accept-before-validate split + topic-naming delta. Files: `collect.route.ts`, `pixel-asset.route.ts`, `pixelRoutes.ts`, `.github/workflows/pr.yml`.

**G14. SDK ↔ asset unification (structural debt)** (4.1)
- Why: `@brain/pixel-sdk` and the served `PIXEL_JS` are two parallel codebases; npm install ships the weaker pixel; every fix above must be written twice or they drift (parity gate only guards envelope shape, not behaviour).
- Files: make `pixel-asset.route.ts` a real build artifact of `packages/pixel-sdk` (bundle→ES5/IIFE → serve), retiring the hand-maintained string. Larger refactor; do AFTER P0–P1 land so fixes aren't doubled.
- UI: none directly; enables a documented, versioned "Install via NPM" card in `pixel-wizard.tsx`.

**G15. Installer/framework/GTM/server-SDK breadth** (4.1)
- Registry-driven (`PixelInstaller.ts`) — each new storefront = one self-registering installer, auto-renders a card via `describeForBrand`. GTM template, React/Vue adapters, published server SDK each = additive. (Magento/BigCommerce/Wix validation is source/infra-blocked — see §5.)
- UI: auto-renders in Install tab `storefront-install-cards.tsx` / `pixel-wizard.tsx`.

---

## 4. Recommended build-wave ordering (extend-not-rebuild)

**Wave 1 — Integrity (serialize, do first):** G1 (keep-critical + drop_count) → G2 (retry backoff). These close the only event-loss hole; G2 builds on G1's queue changes. Same files (`pixel-asset.route.ts` queue + `transport.ts`) → one author, sequential.

**Wave 2 — Compliance + enrichment (parallelizable):**
- Lane A: G3 (DNT/GPC + CMP) — consent files.
- Lane B: G4 (geo-country) — collector drainer; independent of A. **G4 unblocks G3's regional-default sub-feature** — do G4 first within this wave if regional policy is wanted.
- Lane C: G5 (first-touch persistence) — attribution files; fully independent.

**Wave 3 — Observability (parallelizable after Wave 1):** G6 (debug + health beacon) depends on G1/G2 telemetry existing; G13 minify/CI gate and ACK echo are independent and can run anytime.

**Wave 4 — Settings surface + hardening (parallelizable):** G9 (remote config) is the umbrella that hosts G3 regional + G6 debug toggles in one UI card → schedule after G3/G6 land so the card has real controls. G7 (security), G8 (device fields), G10 (identity), G11 (behavioural breadth), G12 (UUIDv7) are mutually independent and can fan out.

**Wave 5 — Structural:** G14 (SDK↔asset unification) LAST, so Waves 1–4 aren't written twice... unless the team commits to G14 up front — in which case do G14 FIRST and every later fix lands once. Pick one; do not interleave. G15 installer breadth is opportunistic/continuous.

**Parallelizable set:** {G4, G5} in Wave 2; {G7, G8, G10, G11, G12, G13} in Wave 4. **Strictly serial:** G1→G2; G3→(G9 regional); G6→(G9 debug); everything→G14 (or G14→everything).

---

## 5. Source/infra-blocked items (class b) — cannot be fully built/validated locally

- **Magento / BigCommerce / Wix / Squarespace installers (4.1)** — registry supports them, but each needs a real merchant store of that platform to build + validate the one-click install path. Buildable blind, but untestable without a store.
- **Shopify Hydrogen / headless (4.1)** — needs a Hydrogen/Oxygen storefront to validate.
- **CMP adapter validation (4.11, G3)** — the adapter CODE is buildable-now, but TCF `__tcfapi` / Cookiebot / OneTrust behaviour can only be verified against a real CMP install on a real store.
- **Per-brand quarantine visibility (4.15)** — `tracking-health-panel.tsx:131` shows `"—"` because quarantined events go to a Kafka `.quarantine` topic with no per-brand sink. Needs a `.quarantine` consumer landing counts per brand before the count can be real (infra, not pixel).
- **Regional consent default (4.11)** — logically blocked on G4 geo-country landing first (then class (a)).
- **Cross-tenant admin/ops dashboard (4.15)** — buildable, but a meaningful per-tenant health grid only becomes useful at multi-tenant production scale; needs real cross-tenant traffic to validate fairness/QoS (4.16).

---

## Appendix — anchor files

Served pixel: `apps/collector/src/interfaces/rest/pixel-asset.route.ts` (`PIXEL_JS`).
NPM core (divergent): `packages/pixel-sdk/src/{capture,identity,attribution,consent,transport,browser-entry}.ts`.
Ingest + ITP cookie: `apps/collector/src/interfaces/rest/collect.route.ts`; edge admission: `apps/collector/src/.../edge-guard.ts`; envelope: `.../envelope.ts`; producer: `.../kafka-producer.ts`.
Quarantine gate (R2/R3): `apps/stream-worker/src/application/ProcessEventUseCase.ts`.
Shopify checkout: `extensions/brain-web-pixel/src/index.js`. Installer registry: `apps/core/src/bootstrap/registerConnectors.ts:937`.
Contract delta: `packages/contracts/src/events/sample.collector.event.v1.ts:31`.
Merchant UI: `apps/web/components/pixel/{tracking-center,pixel-wizard,storefront-install-cards,event-explorer,tracking-health-panel}.tsx`; BFF: `apps/web/.../get-tracking-health.ts`, `get-recent-events.ts`.
