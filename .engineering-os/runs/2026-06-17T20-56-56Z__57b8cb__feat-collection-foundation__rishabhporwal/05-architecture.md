# 05 — Architecture Plan: Collection Foundation (Phase 1)

| Field | Value |
|-------|-------|
| **req_id** | `feat-collection-foundation` |
| **Stage** | 2 — Architecture (binding plan) |
| **Lane** | high_stakes (multi_tenancy / pii / schema_proto / compliance / outbound-edge) |
| **Worktree** | `/Users/rishabhporwal/Desktop/brain-spec` · branch `feat/collection-foundation` |
| **Cost paradigm** | **Deterministic logic only** (effort tier 1). No model/statistical/ML call anywhere in this phase. Token budget: 0 LLM tokens/day, $0/mo incremental inference. Justified: ingest hardening, token→brand resolution, consent routing, dedup observability, and a read-only UI are all pure deterministic control-flow + SQL. A model call here would be a paradigm-bypass VETO. |
| **Single-Primitive sweep** | **CLEAN** — every gap extends a shipped seam. No new deployable / package / topic-family / envelope / RLS-variant / OLTP journey table. Envelope extended ADDITIVELY on the ONE `CollectorEventV1`. Quarantine reuses the ONE `DlqProducer` with a `.quarantine` topic suffix (mirrors the shipped `.dlq` pattern). Tracking-health read reuses the ONE analytics BFF + metric-engine sole-read-path. install_token→brand_id resolver reuses the ONE SECURITY DEFINER enumeration seam (precedent `0026`). |

---

## 0. Grounding (live code, file:line — what is actually true)

| Claim | Ground truth |
|---|---|
| Live consumer contract is **shape (a)** | `ProcessEventUseCase.ts:66` parses `CollectorEventV1Schema.safeParse(parsed)`; fields `event_name` (`sample.collector.event.v1.ts:50`), `occurred_at` ISO-string (`:56`), `properties` record (`:81`). **No** `event_type`/`payload`/millis on this path. |
| The drainer does **NOT** translate | `kafka-producer.ts:85` produces `JSON.stringify(rawBody)` verbatim; `ProcessEventUseCase.ts:61` does `JSON.parse(rawValue)`. The body POSTed to `/collect` is the EXACT bytes Zod-parsed. The `.avsc` (shape b: `event_type`, `timestamp-millis`, `payload` — `collector.event.v1.avsc:18,54,59`) is **NOT on the live Zod path** (no Avro deserialize in the consumer). ⇒ **"emit shape (b)" is FALSE against running code — VETO confirmed (R1).** |
| Tenant key taken from untrusted input | `BronzeRepository.ts:62-65` sets GUC `app.current_brand_id` from `row.brand_id`, which is `event.brand_id` (`ProcessEventUseCase.ts:75`) — the client-stamped value. `kafka-producer.ts:75` partitions on `rawBody['brand_id'] ?? 'unknown'`. **No `pixel_installation` lookup anywhere in ingest** (grep clean). ⇒ R2 confirmed. |
| `pixel_installation` carries the token seam | `0007_pixel.sql:20` `install_token UUID NOT NULL DEFAULT gen_random_uuid()`, `:26` `UNIQUE (brand_id)`. Public id by design (`:9`). |
| `consent_flags` absent | grep empty in `packages/contracts` + `.avsc`. `ProcessOutcome` (`ProcessEventUseCase.ts:25-29`) has no `quarantined`. COMPLIANCE.md:105 mandates the field + quarantine-not-drop + CI gate. ⇒ R3 confirmed. |
| Dedup-suppression is silent | `BronzeRepository.ts:77` `ON CONFLICT (brand_id,event_id) DO NOTHING`; `ProcessEventUseCase.ts:111` returns `pk_conflict` but the consumer (`CollectorEventConsumer.ts:88`) only `console.info`s it. No metric. Redis NX `dedup_hit` (`ProcessEventUseCase.ts:79`) same. ⇒ R4 confirmed. |
| Salt lives server-side in stream-worker | `SaltProvider.ts:77 forBrand()` + `identity-core/src/index.ts:34 sha256Hex`. The canonical hasher + per-brand salt are stream-worker-resident — the browser never needs them. ⇒ ADR-2 server-side hashing is the existing, correct seam. |
| Quarantine sink is free | `DlqProducer.send(topic, key, value, reason)` (`DlqProducer.ts`) is **parametric on topic** — a `.quarantine` suffix reuses the same producer object with zero new code path. redpanda-init already declares `.dlq`; declare `.quarantine` beside it. **Not** a new topic family / deployable. |
| SECURITY DEFINER token-resolver has an exact precedent | `0026_..._security_definer_fns.sql:resolve_connector_by_shop_domain` — webhook brand resolution with no GUC known yet, owner `brain`, `SET search_path=public`, `STABLE`, dispatch-only return cols, `GRANT EXECUTE TO brain_app`, migration-time `prosecdef`/`search_path`/`EXECUTE` assertions. The install_token resolver is the **same shape**. |
| Analytics BFF pattern (UI read path) | web `analyticsApi` (`lib/api/client.ts:803`) → `/api/v1/analytics/*` → core `modules/analytics/internal/application/queries/*` → `withBrandTxn(deps.pool, brandId, …)` (`get-data-health.ts`). `getDataHealth` already reads `bronze_events` bounded + honest-empty (`state:'no_data'`). The Tracking Center read mirrors this exactly. |

---

## 1. Resolved ADRs (binding — these gate all code)

### ADR-1 — Wire shape (resolves R1)

**Decision: the SDK emits SHAPE (a) — the live `CollectorEventV1Schema` JSON shape — verbatim. NO new envelope, NO new topic, NO shape (b).**

The POST body to `/collect` is a single JSON object matching `CollectorEventV1Schema` (`sample.collector.event.v1.ts:23`):

```jsonc
{
  "schema_version": "1",
  "event_id": "<uuidv4, generated ONCE at create-time, reused on every retry>",
  "brand_id": "<uuid — sent for PARTITIONING ONLY; server DERIVES the authoritative one (ADR-1+R2)>",
  "correlation_id": "<uuid or trace id, 1..128 chars>",
  "event_name": "page.viewed",            // dot.lowercase — "page.viewed" | "cart.item_added" | "cart.viewed"
  "occurred_at": "2026-06-18T10:00:00Z",  // ISO-8601, offset:false (UTC 'Z')
  "ingested_at": "<optional ISO — collector/consumer fills>",
  "hashed_session_id": "<optional 64-hex — activates the inert envelope field>",
  "properties": {                          // additive raw-only bag (RO1) — NO contract change
    "brain_anon_id": "<uuidv4>",
    "install_token": "<uuid — REQUIRED: the server's tenant-key derivation input (R2)>",
    "consent_flags": { "analytics": true, "marketing": false, "personalization": false, "ai_processing": false },
    "session_id": "<client session uuid>",
    "click_ids": { "fbclid": "...", "gclid": "...", "ttclid": "..." },
    "utm": { "source": "...", "medium": "...", "campaign": "...", "term": "...", "content": "..." },
    "referrer": "...", "landing_path": "...",
    "device": { "ua_class": "mobile|desktop", "viewport": "..." }
  }
}
```

**Additive contract extension (the ONLY envelope change):** `consent_flags` is promoted to a **first-class top-level optional field** on `CollectorEventV1Schema` AND mirrored in `properties` capture — because COMPLIANCE.md:105 + the CI gate inspect a known field name, not an arbitrary `properties` key. `install_token`, anon/session/click-id/UTM/referrer/landing/device ride `properties` as **raw-only** (RO1) — opaque at the edge, modeled downstream. `event_id` is generated **once at create-time and reused across all retries** (D2.2 at-least-once-on-wire / exactly-once-in-Bronze via PK).

**Why shape (a) and not (b):** the consumer Zod-parses raw JSON; there is no Avro deserialize on the live path. Emitting shape (b) ⇒ Zod fail ⇒ `outcome:'invalid'` ⇒ DLQ-without-retry for 100% of events (`ProcessEventUseCase.ts:67`, `CollectorEventConsumer.ts:66`). The `.avsc` is brought into additive alignment (add optional `consent_flags`) for registry-consistency but is **not** the wire deserializer in M1. **No second envelope is forked** (preserves Bronze `(brand_id,event_id)` idempotency, I-E01).

### ADR-2 — PII hashing posture (resolves the highest-risk decision)

**Decision: the browser sends NO raw PII and NO salt. Behaviour + `brain_anon_id` + attribution signals only. ALL canonical salted hashing happens SERVER-SIDE.**

- The SDK never holds a per-brand salt (public leak = catastrophic, irreversible) and never POSTs a raw email/phone. `page.viewed` / `cart.*` events need no PII at all.
- `hashed_session_id`, if emitted, is a non-PII session hash (no salt needed; it is an opaque client session id hash, never a customer identifier).
- The canonical `sha256(per-brand-salt ‖ normalized)` for any known-user identifier is computed by the **existing server-side path**: `identity-core` (`index.ts:34`) + `SaltProvider.forBrand` (`SaltProvider.ts:77`), invoked downstream in the identity bridge — **not** in the collection edge or the SDK. Raw PII NEVER lands in the un-RLS'd `collector_spool.raw_body`.
- **VETOED:** raw-PII-over-TLS; browser-held salt; a second hasher in `pixel-sdk`. (Aligns 17-final §ADR-2, 13-security §13.2.)

**Drainer-hashing clarification (reconciling the requirement wording):** the requirement says "hashing happens server-side at the drainer." For Phase 1 the SDK emits **no PII**, so there is **no email/phone to hash in this phase** — the server-side hashing seam (`identity-core` + `SaltProvider`) is the binding location WHEN a known-user identifier later appears (Phase 2 cart-stitch / `customer.identified`), and it is invoked in **stream-worker** (where the salt already lives), never in the collector edge and never in the browser. Phase 1's obligation is the **negative guarantee** (no raw PII, no salt on the wire), enforced by the `no-pii-schema-lint` CI gate on the envelope. This is recorded as the binding posture so Phase 2 cannot drift to browser-salt.

---

## 2. The R2 keystone — install_token → brand_id binding (exact seam)

**Problem:** `BronzeRepository.ts:63` sets the RLS GUC from `event.brand_id` (client input). A browser claiming any `brand_id` writes cross-brand. The tenant key must be **derived server-side**, never trusted from input.

**Binding location: `ProcessEventUseCase.execute` (stream-worker), BEFORE building the BronzeRow.** This is the first place with DB access after the body is parsed; `BronzeRepository` then receives an already-trusted `brand_id`.

**Mechanism (mirrors `resolve_connector_by_shop_domain`, `0026`):**
1. New migration `0028` adds a SECURITY DEFINER fn `resolve_brand_by_install_token(p_install_token uuid)` — owner `brain`, `SET search_path=public`, `STABLE`, `LANGUAGE sql`, `GRANT EXECUTE TO brain_app`, dispatch-only return `(brand_id uuid)`. It looks up `pixel_installation` bypassing FORCE RLS (no GUC known yet — same justification as the connector resolver). Migration-time assertions: `prosecdef=true`, `search_path=public`, `EXECUTE` granted (verbatim from `0026`).
2. `ProcessEventUseCase.execute`: read `install_token` from `event.properties.install_token`. Call `resolve_brand_by_install_token(install_token)`:
   - **token resolves** → `derivedBrandId`. If `event.brand_id !== derivedBrandId` → **quarantine** (R3 outcome) + `audit_log` entry `pixel.brand_mismatch` (per 17-final REC-1). If equal → proceed with `derivedBrandId` as the authoritative tenant key.
   - **token absent or unresolved** → **quarantine** (`outcome:'quarantined'`, reason `tenant_unresolved`). Never written under a claimed brand.
3. `BronzeRepository.write` GUC is set from the **derived** `brand_id` (no code change to BronzeRepository — it already takes `row.brand_id`; the row is now built from the derived value). The binding is "ProcessEventUseCase passes the derived brand_id into the row it hands BronzeRepository."

**The tenant key is never trusted from input.** The browser MAY send `brand_id` (for the partition key only); the server DERIVES the authoritative one and quarantines any mismatch.

---

## 3. R3 — consent_flags + `quarantined` outcome + CI gate (exact seam)

1. **Envelope:** add `consent_flags` optional object (`{analytics, marketing, personalization, ai_processing}` booleans) to `CollectorEventV1Schema` (`sample.collector.event.v1.ts`) + mirror as an optional field in `collector.event.v1.avsc` (FULL_TRANSITIVE additive). **Capture-only** — enforcement stays at the `can_contact()` chokepoint (I-ST05, Phase 5). **VETO** building enforcement here.
2. **Outcome:** extend `ProcessOutcome` (`ProcessEventUseCase.ts:25`) with `'quarantined'`. Routing rule in `execute`: an event with **missing/absent `consent_flags`** OR an **unresolved/mismatched tenant token (R2)** → `quarantined` — **not** `dropped`, **not** Bronze-as-trusted.
3. **Quarantine sink:** in `CollectorEventConsumer.ts` add a branch `result.outcome === 'quarantined'` → `dlqProducer.send('${topic}.quarantine', key, value, reason)` then **commit offset** (mirrors the `invalid`→`.dlq` branch at `:66-80`). Reuses the shipped `DlqProducer` object — **no new producer, no new topic family**. redpanda-init declares `dev.collector.event.v1.quarantine` beside `.dlq`.
4. **CI gate:** wire `consent-propagation-test` (COMPLIANCE.md:105,149) — every customer-domain event schema in `packages/contracts`/`packages/events` MUST carry `consent_flags`; a missing field **fails the build**. Plus assert `no-pii-schema-lint` is green on the extended envelope (ADR-2 structural guard).

---

## 4. R4 — observable dedup-conflict + malformed→DLQ (exact seam)

1. **Observable suppression:** on `outcome:'pk_conflict'` (`BronzeRepository` `ON CONFLICT DO NOTHING`, `:77`) AND `outcome:'dedup_hit'` (Redis NX), emit a counter metric `collector_dedup_conflict_total{brand_id,layer=pg|redis,event_name}` from `CollectorEventConsumer` (replace the bare `console.info` at `:88`). A forged/colliding `event_id` is now observable, not silent. (DQ Freshness/Completeness alarm on conflict-rate is Phase 4 — out of scope; the metric emission is the Phase-1 obligation.)
2. **Constrain client event_id influence:** the SDK derives `event_id = uuidv4()` once per logical event (D2.2) and reuses on retry; documented + asserted in the SDK unit test (a retried event keeps its id; a new event gets a fresh id). The server treats `event_id` as opaque — the R2 token-binding is what prevents cross-brand id forgery from mattering (a forged id under brand A can never collide into brand B's keyspace because `brand_id` is server-derived).
3. **Malformed → DLQ (REC-6):** already correct on the live path (`CollectorEventConsumer.ts:66` routes `outcome:'invalid'` to `.dlq`). Add an explicit negative-control test: a missing/garbage `brand_id` or unparseable body → `.dlq` (never the `unknown:unknown` partition silently). No code change beyond the test if the path holds; if the test reveals `kafka-producer.ts:75`'s `?? 'unknown'` produces a routable message, add a guard that quarantines a token-less body (it will quarantine downstream via R2 anyway — the test pins the behaviour).

---

## 5. Alternatives considered + rejected

| Alternative | Rejected because |
|---|---|
| Bind brand_id at the **collector edge / drainer** (collector app) | The collector app has no `pixel_installation` access and is deliberately pre-validation (spool has NO RLS, `0015`). Binding there would either add validation to the edge (VETO, breaks D-1) or add a cross-app DB read. ProcessEventUseCase (stream-worker) is the first GUC-aware, DB-connected point — correct seam. |
| Emit shape (b) Avro and add Avro deserialize to the consumer | Fork + rewrite of the live Zod path; would DLQ every in-flight event during cutover; contradicts the additive-only mandate. Shape (a) is what runs. |
| New `*.quarantine` topic family / new quarantine table | DlqProducer is parametric on topic; a `.quarantine` suffix on the existing topic family + the shipped producer is zero-new-infra. A table would be a new OLTP store (drift). |
| Treat `install_token` as a secret/auth credential | R6 (16-db §A): it is a public tracking id by design (`0007:9`). Auth is the **server-side derivation** (token→brand lookup + mismatch-quarantine), not token secrecy. |
| Browser-side hashing with a public pepper | Adds a second hasher (drift) + a client-resolvable identifier surface. Phase 1 sends NO PII, so no client hashing is needed at all — strictly simpler + safer (ADR-2). |

---

## 6. Reversibility / migrations (all additive)

- **`0028_resolve_brand_by_install_token.sql`** — `CREATE OR REPLACE FUNCTION` only (no table change). Rollback: `DROP FUNCTION IF EXISTS resolve_brand_by_install_token(uuid);`. Clean.
- **Envelope `consent_flags`** — additive-optional Zod + Avro field (FULL_TRANSITIVE). Rollback: remove the optional field; historical Bronze rows unaffected (it rode `payload`/optional).
- **No DROP/ALTER on any shipped table.** `pixel_installation`, `bronze_events`, `collector_spool` untouched structurally. I-E02 destructive-migration ban honoured.
- **Topic `.quarantine`** — declared in redpanda-init alongside `.dlq`; removable without data loss (forensic sink).

---

## 7. Test strategy (real-network smoke + tenant isolation under brain_app)

**ALL isolation assertions run under `SET ROLE brain_app`** (MEMORY: dev superuser `brain` bypasses RLS — any check not under `brain_app` is inert). Required across tracks:

- **Browser→Bronze E2E (happy path):** a real browser-origin `page.viewed` (loads built `pixel.js`) → `/collect` → drainer → stream-worker → asserts a `bronze_events` row under `brain_app` with the **token-derived** `brand_id`. **Fails-closed when the collector is unreachable** (closes the inert-probe gap; the current Node fixture exits 0 offline — that is rejected).
- **Negative control — cross-brand:** an event whose body `brand_id` ≠ the token-resolved brand → `outcome:'quarantined'`, **0 rows** in `bronze_events` for the claimed brand under `brain_app`, `audit_log` `pixel.brand_mismatch` written. The quarantine branch must be **non-inert** (assert the `.quarantine` message was produced).
- **Negative control — tenant-less / malformed:** missing/garbage `install_token` → `quarantined`; unparseable body → `.dlq`. Neither silently lands.
- **Consent gate:** an event with absent `consent_flags` → `quarantined` (not dropped, not Bronze). CI `consent-propagation-test` red on a contract missing the field.
- **Dedup observability:** a replayed `event_id` increments `collector_dedup_conflict_total` (assert metric emitted, not just `console.info`).
- **Isolation-fuzz:** a synthetic cross-brand `bronze_events` SELECT under `brain_app` returns nothing.

---

## 8. 1a / 1b split — RECOMMENDED

**Split into 1a (ship the critical fix fast) and 1b (the SDK + richer UI).** Each is independently shippable and each ships a stakeholder-visible UI surface.

- **Phase 1a — Security hardening + Live Verification UI.** R2 (token→brand derivation + SECURITY DEFINER fn), R3 (`consent_flags` + `quarantined` outcome + CI gate), R4 (observable dedup + malformed→DLQ). UI: the **Live Verification** panel ("waiting… / ✅ first event received") on `/settings/pixel`, fed by a thin tracking-health BFF read. **De-risks by landing the isolation VETO + compliance gate independently of the SDK.** Provable with a hand-crafted shape-(a) POST + the negative controls — does not need `brain.js` to exist.
- **Phase 1b — brain.js SDK + /pixel.js + full Tracking Center.** Minimal `pixel-sdk` (anon-id, page/cart, one-event-per-POST, attribution capture, consent capture), served `/pixel.js`, edge rate-limiting, + the full Tracking Center (setup wizard, Tracking Health, Event Explorer). Depends on 1a's envelope + quarantine being live.

**Recommendation: split.** 1a closes the CRITICAL isolation + compliance gaps on the fastest path with a real (if minimal) UI; 1b layers the capture client + richer surfaces on a hardened, contract-stable edge.

---

## 9. Build tracks

> Each track is COMMIT-PER-SLICE with its own tests. **Every slice ships a stakeholder-visible UI surface** (hard rule). Tasks are 2–5 min, file:line-anchored. Persona/synthesis must-fix items are folded into each acceptance contract as REQUIRED pass-1.

### Track A — Ingest hardening — `@data-engineer` / `@backend-developer` (Phase 1a)

**Scope:** the R2/R3/R4 server-side fixes + the additive envelope/migration.

**Files / seams:**
- `db/migrations/0028_resolve_brand_by_install_token.sql` (NEW, additive — SECURITY DEFINER fn, mirror `0026`).
- `packages/contracts/src/events/sample.collector.event.v1.ts:81` — add optional `consent_flags` field (top-level + documented `properties.install_token` raw-only).
- `infra/redpanda/schemas/collector.event.v1.avsc:68` — add optional `consent_flags` (FULL_TRANSITIVE).
- `apps/stream-worker/src/application/ProcessEventUseCase.ts:25` (extend `ProcessOutcome` + `'quarantined'`), `:75` (derive brand_id via the new fn; quarantine on mismatch/absent token/absent consent), `:88` (build row from derived brand_id).
- `apps/stream-worker/src/infrastructure/pg/` — a thin repository method `resolveBrandByInstallToken(token)` calling the SECURITY DEFINER fn under `brain_app`.
- `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts:66` (add `quarantined`→`.quarantine` branch + commit), `:88` (emit `collector_dedup_conflict_total` on `pk_conflict`/`dedup_hit`).
- `audit_log` write on `pixel.brand_mismatch` via the shipped `packages/audit` writer.
- redpanda-init topic declaration: `dev.collector.event.v1.quarantine`.
- CI: `consent-propagation-test` + `no-pii-schema-lint` wiring.

**Bindings owned:** ADR-1 wire shape enforced in the consumer; ADR-2 negative guarantee (no PII/no salt on wire); R2 tenant-key derivation; R3 consent + quarantine; R4 observability.

**Required tests (pass-1):** browser→Bronze-shape E2E with token-derived brand_id under `brain_app`; cross-brand→quarantined (0 rows, non-inert `.quarantine` assert, audit row); tenant-less→quarantined; malformed→DLQ; absent-consent→quarantined; replayed event_id→metric incremented; isolation-fuzz under `brain_app`; `consent-propagation-test` green.

**UI surface (with this track, 1a):** Track C ships the **Live Verification** panel against this track's quarantine/health signals — Track A exposes the read via Track C's BFF query (no UI logic in A).

### Track B — Minimal brain.js + /pixel.js — `@backend-developer` (Phase 1b)

**Scope:** the capture SDK + served asset + edge rate-limiting.

**Files / seams:**
- `packages/pixel-sdk/src/index.ts` (replace `export {}`) + `config/ identity/ session/ capture/ attribution-signals/ consent/ transport/` per D2.1. Reads `window.__brain` (`pixelRoutes.ts:136`).
- `capture/` emits **shape (a)** (ADR-1) — `event_name` in {`page.viewed`,`cart.item_added`,`cart.viewed`}, ISO `occurred_at`, `properties` bag with `install_token`/`brain_anon_id`/`consent_flags`/click-ids/UTM/referrer/landing/device. **ONE event per POST** (VETO batched array until drainer fan-out exists, REC-5).
- `transport/` — `sendBeacon` on `pagehide`/`visibilitychange` + `fetch(keepalive)`; durable localStorage queue; `event_id` minted once, reused on retry (R4).
- `consent/` — read CMP, stamp `consent_flags`, fail-safe-absent (capture anon behaviour, withhold consent-gated). **No** enforcement (I-ST05).
- The built **`/pixel.js`** asset served on the existing collector/storefront CNAME (`pixelRoutes.ts:138` already references it). Versioned `/pixel.v{N}.js`; stamp `collector_version="pixel@{semver}"`.
- Edge rate-limiting: Fastify plugin at `apps/collector` — per-`install_token` rate-limit + origin allowlist, **reject-before-spool** (NOT a D-1 violation, REC-9). **VETO Set-Cookie on /collect** (REC-4 — keep edge stateless; anon-id minted client-side).

**Bindings owned:** ADR-1 emit shape; one-event-per-POST; client-side anon-id (no Set-Cookie); edge abuse protection.

**Required tests (pass-1):** SDK unit — shape-(a) envelope conformance (Zod parse passes); `event_id` reuse-on-retry / fresh-on-new-event; consent fail-safe-absent; one-event-per-POST. Edge — rate-limit rejects over-cap before spool; origin allowlist. Browser-origin E2E loading the real built `pixel.js` → Bronze (extends `tools/pixel-fixture` with a headless flavour, fails-closed offline).

**UI surface:** the **Setup/Installation Wizard** (Track C) surfaces this SDK's `install_token` + `/pixel.js` snippet.

### Track C — Tracking Center UI — `@frontend-web-developer` (1a: Live Verification; 1b: full) — MANDATORY

**Scope:** extend `/settings/pixel` into a Tracking Center. Reuse shadcn/Tailwind/Recharts + `KpiTile`/`TrendChart`/`data-health-*` components; honest empty/loading; BFF + metric-engine sole-read-path.

**Files / seams:**
- BFF (NEW, mirrors `get-data-health.ts`): `apps/core/src/modules/analytics/internal/application/queries/get-tracking-health.ts` — bounded, RLS-scoped via `withBrandTxn(deps.pool, brandId, …)`: recent `bronze_events` (type/time/anonymized ids — anon_id/session hash from `payload`, NEVER raw PII), last-event freshness, per-day volume, consent/quarantine counts. Route `GET /api/v1/analytics/tracking-health` + `GET /api/v1/analytics/recent-events` registered like the analytics queries; web `analyticsApi` + a `use-tracking-health.ts` hook (mirror `use-analytics.ts` with `refetchInterval` for the live poll).
- `apps/web/app/(dashboard)/settings/pixel/page.tsx` + `apps/web/components/pixel/pixel-wizard.tsx` (extend, do not fork) into:
  - **(1a) Live Verification** — polls tracking-health; flips "waiting for your first event…" → "✅ First event received" **only when a real Bronze event lands for the brand** (honest, never faked).
  - **(1b) Setup/Installation Wizard** — surfaces `install_token` + the `/pixel.js` snippet (reuse `buildDefaultSnippet`, `pixelRoutes.ts:129`); copy-paste + "I've installed it".
  - **(1b) Tracking Health** — events-flowing volume chart (reuse `data-health-volume-chart.tsx`), last-event freshness (reuse `data-health-relative-time.ts`), consent/quarantine counts as `KpiTile`s, honest status (healthy / no events yet / stale).
  - **(1b) Event Explorer** — recent collected events (type, time, anonymized ids) so a non-technical stakeholder can watch data arrive (reuse `recent-activity.tsx` shape).

**Bindings owned:** the stakeholder-visible proof surface; metric-engine/`withBrandTxn` sole-read-path; honest states (no faked verification).

**Required tests (pass-1):** BFF query under `brain_app` returns only the brand's rows (RLS), honest-empty `no_data`, NO raw PII in the response (assert anonymized ids only). Web — Live Verification shows "waiting" with zero events and flips to "received" when a Bronze row exists (poll); empty/loading/error states render; a11y status is icon+text not colour-only.

---

## 10. Over-engineering self-check — PASS

- Zero new deployables/packages/topic-families/envelopes/RLS-variants/OLTP-tables. One additive migration (a function), one additive envelope field, one topic suffix on the existing family.
- Cost paradigm = deterministic only (tier 1); no model/statistical call anywhere — correct for ingest/control-flow.
- Plan length matches the high_stakes calibration band (multi-tenancy + PII + compliance + schema + outbound-edge all touched) — detail is load-bearing, not padding.
- Single-Primitive sweep clean; every gap extends a named, file:line'd shipped seam.

---

## HANDOFF
See journal + the HANDOFF block returned to the orchestrator.
