# 03 — Identity Input Design (D3) & Journey Foundation (D4)

> Cluster: `03-identity-and-journey`. Scope: the **inputs** that feed identity resolution (D3) and the
> **events → sessions → touchpoints → journeys** transform that turns raw Bronze into a deterministic
> journey foundation (D4). Deterministic-first. Journey-before-attribution. Grounded against the shipped
> identity graph (`db/migrations/0017_identity_graph.sql`) and the live collector lane
> (`dev.collector.event.v1` → `bronze_events`).
>
> **Hard-constraint posture:** no new deployable, no new topic, no new envelope, no probabilistic merge,
> no PII off the boundary. Everything below either reuses a shipped seam or adds **additive** schema on an
> existing store, with the seam named explicitly. The single non-trivial architecture decision (where the
> session/touchpoint tables live) is called out at the end with its risk.

---

## 0. Tagging legend

- **Present** — shipped, cite `file:line`.
- **Equivalent** — a shipped seam covers the intent in a reusable shape; extend it, don't rebuild.
- **Missing** — genuinely net-new; build by extending a named seam.
- **Raw-Only** — already lands raw in Bronze, not yet modeled; correct posture, model later.
- **Reject** — would drift/duplicate; do not build.

---

## D3 — Identity Input Design

### D3.1 Capture surface — where every input enters

There is exactly **one** ingress for first-party signal: the accept-before-validate `/collect` edge →
`collector_spool.raw_body` → `dev.collector.event.v1` → `bronze_events.payload` (JSON string). Every D3
input below rides the **existing** `CollectorEventV1` envelope's `event_type` + `payload` fields
(`infra/redpanda/schemas/collector.event.v1.avsc`) — additive-optional, FULL_TRANSITIVE. **No envelope or
topic change is required or permitted** for any new identity input.

> **Wire-shape pin (load-bearing).** The SDK and all downstream consumers MUST emit the **Avro/Bronze**
> shape — `event_type` (string) + `payload` (JSON string) — used by `tools/pixel-fixture/send-event.mjs`
> and `BronzeRepository.ts`, NOT the Zod `event_name`/ISO-string shape in
> `packages/contracts/src/events/sample.collector.event.v1.ts:23`. The Zod schema stays the **field-level**
> source of truth; the wire stays Avro. Reconcile, never fork (this divergence is the #2 risk — see §D4.9).

### D3.2 Input inventory — each input, its tag, and how it feeds resolution

| # | Input | Tag | Where it lives today / seam to extend | How it feeds identity resolution |
|---|---|---|---|---|
| 1 | **Anonymous id** (`brain_anon_id`) | **Missing** (capture) / **Equivalent** (storage) | Storage seam: `customer.anonymous_id TEXT NULL` exists (`0017_identity_graph.sql:36`); capture is unbuilt (`packages/pixel-sdk/src/index.ts:25` is `export {}`). | Weak-but-stable cookie/first-party-storage id. Becomes the **anchor** that pre-purchase events hang on until a strong id (email/phone/customer_id) arrives, then backward-merges the anon profile into the known `brain_id`. Resolution reads it as the `customer.anonymous_id` seam — **not** a new identifier authority. |
| 2 | **Session id** (`hashed_session_id`) | **Equivalent (inert)** | Envelope field `hashed_session_id` exists (`sample.collector.event.v1.ts:75`) but nothing consumes it; no session table. | Today: pass-through, unconsumed. D4 makes it the session-grain key. Feeds journey, **not** merge (a session is not an identity). |
| 3 | **Customer id** (storefront) | **Present** | Extracted in `ResolveIdentityUseCase.ts:81` as `storefront_customer_id`, tier `strong_on_link`. | Strong-on-link merge key already resolving into `brain_id`. No change. |
| 4 | **Email — hashed at boundary** | **Present** | `ResolveIdentityUseCase.ts:96` → `hashIdentifier(rawEmail,'email',salt)`; `identity_link.identifier_type='email'`, tier `strong` (`0017:65`). | Strong merge key. Raw email only ever to `contact_pii` vault (`0017:223`). No change. |
| 5 | **Phone — hashed + E.164** | **Present** | `ResolveIdentityUseCase.ts:107` → `normalizePhone` (D-6) → `hashIdentifier`. Phone-guard suppression on shared utility (`SharedUtilityPolicy.ts`). | Strong merge key with shared-utility keep-apart. No change. |
| 6 | **Platform customer ids** (non-storefront, e.g. marketplace) | **Reject (as new merge key, this phase)** | `identity_link` CHECK reserves `auth_user_id` etc. (`0017:66`) but only email/phone/storefront resolve. | Promoting reserved weak types to merge keys risks over-stitching vs D-5 deterministic-strong-only. Capture **Raw-Only** in Bronze now; resolve only when a specific platform id is justified as strong. |
| 7 | **Click ids** — `fbclid`/`gclid`/`ttclid` (+ `_fbc`/`_fbp`) | **Missing (capture + model)** / **Raw-Only** if a pixel sent them | No capture (`pixel-sdk` stub); no extraction (grep of mapper/resolver = zero hits). Would sit raw in `bronze_events.payload`. | **Not identity merge keys.** They are **journey/touchpoint attributes** (channel attribution signal) + the **cart-stitch** payload that recovers `brain_anon_id` from the order server-side. They feed D4's touchpoint, and via cart-stitch close the anon→known→order loop — they do **not** mint or merge a `brain_id`. |
| 8 | **UTMs** (`utm_source/medium/campaign/term/content`) | **Missing (capture + model)** / **Raw-Only** | Same as click ids. | Touchpoint dimensions (first-touch / last-touch channel). Journey input, never a merge key. |
| 9 | **Referrer / landing page** | **Missing (model)** / **Raw-Only** | Land raw in `payload` once the SDK sends `page_view`. | Session entry attributes (entry URL, referrer host → channel classification). Journey input. |
| 10 | **Device / browser / geo** | **Missing (model)** / **Raw-Only** | Raw in `payload`. `identity_link` reserves `device_id/ip/ua/location` (`0017:67`) — schema-reserved, unused. | **Journey context + bot-filter input only.** Do **not** promote device/ip/ua to deterministic merge keys (D-5). Geo from IP must be coarse and never stored as raw IP in any modeled table (raw IP stays in Bronze only). |

**Boundary rule (non-negotiable, I-S02 / D-10).** Email and phone are hashed **client-side at capture** with
the per-brand salt before they leave the browser — the SDK never POSTs raw email/phone to `/collect`. This
is the one genuinely net-new producer-side hashing path; today only the synthetic fixture hard-codes a hash.
The salt-distribution mechanism for the **client** is an open question (server-side salt must not ship to the
browser) — see §D3.4.

### D3.3 Future expansion seam

New identity inputs are added by (a) the SDK emitting a new `event_type`/`payload` field (additive, no
envelope change) and (b) — only if the input is a *strong deterministic* identifier — adding extraction in
`ResolveIdentityUseCase.ts` + an `identifier_type` value already reserved in the `0017` CHECK. Weak signals
(device/ip/ua/geo) stay **journey-only** and never enter the merge graph this phase. This keeps the
expansion path mechanical and the merge graph deterministic-strong-only.

### D3.4 Open question — client-side salt for boundary hashing

`SaltProvider` (`apps/stream-worker/.../SaltProvider.ts`) decrypts the per-brand salt server-side and
hard-crashes on miss (D-2). The browser SDK cannot hold that salt (a per-brand salt shipped to every
storefront visitor is a cross-brand leak vector). **Decision needed:** either (a) the SDK POSTs
*normalized-but-unhashed* email/phone to `/collect` over TLS and hashing stays server-side in
`ResolveIdentityUseCase` (simplest, but raw PII transits the edge — violates I-S02 at the wire), or (b) a
per-brand *client* salt distinct from the resolution salt is served with the SDK and a server-side re-hash
bridges the two. **Recommendation: (b)** — preserve I-S02 (no raw PII on the wire) with a client-salt that
is non-reversible to the resolution salt. This is the highest-stakes D3 decision; flag to security/privacy
review before SDK build. (Out of cluster scope to resolve here; D3 only requires that the **input** design
assumes hashed-at-boundary.)

---

## D4 — Journey Foundation

### D4.1 What exists vs what is net-new

| Layer | Tag | State |
|---|---|---|
| Raw behavioral events in Bronze | **Raw-Only** | Any `event_type` (`page_view`, `add_to_cart`, `order_placed`) lands in `bronze_events.payload` accept-before-validate (`0016_bronze_events.sql`). Unmodeled beyond identity-id extraction. |
| Sessionize / bot-filter / quality-score stream steps | **Missing** | HLD pipeline names them (`HLD.md` stream-worker row) but stream-worker has only Bronze-write + identity-bridge + ledger consumers. Zero sessionize files. |
| `silver.touchpoint` / `behavior_event` | **Missing** | HLD declares them DERIVED Silver, **owned by the `attribution` module**, "never a service/deployable/store". `attribution` is an `export {}` stub. **The whole Silver tier (StarRocks/Iceberg/dbt) is not yet in the repo** — M1 Bronze = Postgres `bronze_events` (`STACK.md:46` Phase-1 seams). |
| First/last-touch, journey ordering, cross-session stitch | **Missing** | No temporal touchpoint ordering per `brain_id` anywhere. |

### D4.2 The transform — events → sessions → touchpoints → journeys

Deterministic, four-stage, all in **stream-worker** (the HLD-sanctioned home — "sessionize" is a
stream-worker step; Silver is derived, attribution-owned; **never** an OLTP table, never a new service):

```
bronze_events (raw, append-only SoR)
   │  consumer off dev.collector.event.v1 (REUSE IdentityBridgeConsumer pattern — autoCommit=false,
   │  commit-after-write, DLQ@5, brain_app/RLS) — NEW consumer group, SAME topic, NO new envelope
   ▼
[1] sessionize    — group events by (brand_id, brain_id|anon_id) within a 30-min inactivity gap → session
   ▼
[2] bot-filter    — deterministic UA/rate heuristics → is_bot flag (NOT a merge decision; a quality flag)
   ▼
[3] touchpoint    — per session, derive entry/exit, nav steps, commerce actions (view/atc/checkout),
   │                marketing interactions (click-id/UTM/referrer) → ordered touchpoints
   ▼
[4] journey       — order touchpoints per canonical brain_id (read brain_id_alias for re-pointing) →
                    first_touch / last_touch / full path; coverage + confidence stamped
```

- **Deterministic-first:** sessionization is a 30-min wall-clock gap rule; bot-filter is rule-based;
  journey ordering is `occurred_at` + per-source `sequence` (HLD H1 correctness model). **No ML, no
  probabilistic stitch** (D-5).
- **Idempotent:** every derived row keyed `(brand_id, event_id)` or a deterministic
  `session_id = f(brand_id, anchor_id, session_start)` so replay is last-writer-wins (HLD idempotency rule).
- **Identity-before-journey:** the journey stage reads the **already-resolved** `brain_id` + `brain_id_alias`
  chain (`IdentityRepository.readState`) — journey never re-resolves identity; it consumes it.

### D4.3 Stitching — three levels, all deterministic

| Stitch | Definition | Mechanism (deterministic) | Seam |
|---|---|---|---|
| **Session stitch** | events → one session | 30-min inactivity gap on `(brand_id, anchor_id)` where `anchor_id = brain_id ?? anonymous_id` | New sessionize step |
| **Cross-session stitch** | sessions of one visitor over time → one visitor timeline | `anonymous_id` stability across sessions; on strong-id arrival, **backward-merge** anon sessions into the resolved `brain_id` via `brain_id_alias` re-pointing (`0017:130`) | Reuse `brain_id_alias` read-time re-pointing |
| **Journey stitch** (anon→known→order) | pre-purchase anon journey → known customer → order | **Cart-stitch**: read `brain_anon_id` + click-ids + UTMs back out of the Shopify order `cart.attributes`/`note_attributes` server-side, deterministically (read it back, never infer) | Extend Shopify order-webhook handler + `packages/shopify-mapper` (parser) + SDK writer (`pixel-sdk`) — see cluster `connectors-commerce` notes; **no new deployable** |

Cross-session and journey stitch **reuse the shipped union-find** (`brain_id_alias` live-unique partial,
`IdentityRepository.readState` builds `aliasChain`) — no new id authority, no parallel graph.

### D4.4 Completeness / Confidence / Coverage (first-class outputs)

Confidence is a first-class Brain output (`METRICS.md`). The journey foundation stamps three deterministic
signals per journey/session — **as enum grades, not new money/floats**, consistent with the metric-engine
posture (do NOT model these as bespoke floats in OLTP):

- **Completeness** — fraction of expected touchpoints present (e.g. order exists but no pre-purchase
  session captured → low; full anon→atc→checkout→order chain → high).
- **Coverage** — share of orders with a stitched anon journey (`stitched_anon_id` non-null) vs unstitched
  (the "unattributed/dark" bucket feeding attribution's unattributed bucket honestly).
- **Confidence** — deterministic grade derived from stitch source (cart-attribute readback = high;
  identity-merge-only = medium; no-stitch = low/untrusted). Feeds the `dq_grade`/effective-confidence gate
  (`METRICS.md`) so attribution can refuse to over-claim. **Build in the metric-engine/attribution path,
  not as a touchpoint float column.**

### D4.5 Minimal additive schema — and WHERE it lives (the load-bearing decision)

HLD says Silver = StarRocks-native, dbt-on-StarRocks over Bronze-Iceberg, owned by `attribution`, **never an
OLTP table**. **But the Silver tier does not yet exist in this repo** (M1 Bronze = Postgres `bronze_events`).
So there are two honest options:

- **Option A (HLD-aligned, deferred):** define `silver.touchpoint` / `silver.session` /
  `silver.order_state` (with `stitched_anon_id`, `stitched_click_ids`, `stitched_first_touch_utms`,
  `stitch_source` per docs-08 §35) as **dbt models on StarRocks**, gated on the Silver tier landing. The
  stream-worker sessionize/touchpoint steps write to Silver. **No Postgres OLTP journey tables.**
- **Option B (bridge, this phase):** because Silver isn't here yet, a **temporary** Postgres
  `journey_session` / `journey_touchpoint` pair would unblock journey work now — but this **drifts the
  storage tiering** (behavioral derived data in OLTP) and the cluster ground-map explicitly **rejects**
  modeling touchpoints in Postgres OLTP.

**Recommendation: Option A — do NOT add Postgres journey tables.** Journey modeling is **gated on the Silver
(StarRocks/Iceberg/dbt) tier landing**; until then, behavioral events stay **Raw-Only** in `bronze_events`
(correct Bronze-as-SoR posture) and the only additive work that ships now is:

1. The **SDK capture** of `brain_anon_id` / session / click-ids / UTMs / referrer / landing (extend
   `packages/pixel-sdk`) so the inputs **exist in Bronze** to model later.
2. The **cart-stitch** additive columns (`stitched_anon_id`, `stitched_click_ids`,
   `stitched_first_touch_utms`, `stitch_source`) — these belong on `silver.order_state` per docs-08 §35
   (StarRocks), **not** a Postgres migration. The webhook **parser** (extend `shopify-mapper`) and SDK
   **writer** can ship now; the stitched columns land when Silver lands.

This keeps the constraint clean: **no new OLTP tables, no premature drift, capture-now-model-later.**

### D4.6 Reuse table — seams to extend (no new deployables)

| Net-new capability | Extend this seam | Not this |
|---|---|---|
| anon-id + 30-min session + click-id/UTM/referrer capture | `packages/pixel-sdk` (the designated stub) | new SDK package / new app |
| boundary email/phone hashing | producer-side in `pixel-sdk` + `packages/identity-core` hasher | second hashing util |
| sessionize / bot-filter / touchpoint / journey transform | **stream-worker** new consumer group on the **existing** `dev.collector.event.v1` (reuse `IdentityBridgeConsumer` shape) | new topic / new stream-worker-journey service |
| cross-session + anon→known re-pointing | `brain_id_alias` + `IdentityRepository.readState` | new session_id authority / parallel graph |
| cart-stitch parse | `shopify-mapper` + Shopify order-webhook handler | new deployable / new topic |
| touchpoint/session/order_state derived model | **dbt-on-StarRocks Silver**, owned by `attribution` module | Postgres OLTP table |
| completeness/confidence/coverage | metric-engine / `attribution` + `data-quality` `dq_grade` | bespoke OLTP floats |

### D4.7 Rejected (drift)

- **Reject** a sessions/journey microservice or deployable — HLD: Journey is derived, attribution-owned.
- **Reject** a new topic or new envelope for journey events — `event_type`+`payload` carry it additively.
- **Reject** Postgres OLTP touchpoint/session tables — drifts OLTP/OLAP tiering (ground-map reject).
- **Reject** probabilistic/ML stitch — D-5 deterministic-first; cart-stitch reads the id back.
- **Reject** promoting device/ip/ua/geo to merge keys — over-stitch risk; journey-context only.
- **Reject** a new `session_id` authority — reuse `anonymous_id` + `hashed_session_id` seams.

### D4.8 Competitor benchmark (used; passes the no-drift gate)

- **Elevar / Littledata server-side GTM + Shopify Web Pixels (Customer Events) + cart-attribute stitch:**
  the prevailing first-party pattern is exactly client-captures-`brain_anon_id`+click-ids → writes to
  `cart.attributes` → server reads them back off the order webhook → deterministic anon→order stitch. This
  validates §D4.3's cart-stitch as the journey-stitch mechanism (not an invention).
- **Triple Whale / Northbeam:** rely on first-party click-id (`_fbc`/`_fbp`/`gclid`) capture + a
  pixel-side session for the journey timeline — confirms the D3 input inventory (click-ids/UTMs as
  *journey* signals, not identity merge keys). Brain's deterministic-strong-only merge posture is
  *stricter* (and better-isolated) than Northbeam's probabilistic household stitch — we deliberately do
  **not** copy the probabilistic path (D-5).
- **Black Crow:** ML/probabilistic identity — explicitly **rejected** for this phase (D-5).

Sources: Shopify Web Pixels API / Customer Events docs; Elevar & Littledata server-side stitch patterns;
Meta CAPI `_fbc`/`_fbp` and GA4 Measurement Protocol click-id conventions (industry-standard, benchmarked).

### D4.9 Highest-risk decision (single)

**Where the journey/touchpoint/session model lives, and the Zod-vs-Avro envelope divergence that gates the
SDK.** The journey foundation is correctly **gated on the Silver (StarRocks/Iceberg/dbt) tier landing** —
recommending Postgres OLTP journey tables now would ship value faster but **permanently drift** the
OLTP/OLAP tiering the whole product depends on. Compounding it: the SDK must emit the **Avro/Bronze**
wire shape (`event_type`+`payload`), not the Zod `event_name`/ISO shape — if the SDK is built against the
wrong shape, every captured anon-id/click-id/UTM lands malformed in Bronze and the journey transform reads
garbage. **Decision: hold journey modeling for Silver; ship only capture (SDK) + cart-stitch parser now,
pinned to the Avro wire shape; reconcile the two envelope shapes before any SDK line is written.**

---

## 10-line summary

1. **D3 inputs are mostly Present or Raw-Only:** email/phone/storefront-customer-id already resolve deterministically into `brain_id` (`ResolveIdentityUseCase.ts:81-129`); strong-only merge posture is correct.
2. **Net-new (Missing) in D3:** browser **capture** of `brain_anon_id`, 30-min session, click-ids (`fbclid/gclid/ttclid`,`_fbc/_fbp`), UTMs, referrer/landing, device/geo — all by extending `packages/pixel-sdk` (no new package/deployable).
3. **Net-new (Missing) in D3:** **client-side boundary hashing** of email/phone (I-S02) — today only the fixture fakes a hash; needs a client-salt path distinct from the resolution salt.
4. **Click-ids/UTMs/referrer/device/geo are journey signals, NOT merge keys** — they never mint/merge a `brain_id` (D-5); device/ip/ua/geo stay journey-context only.
5. **Net-new (Missing) in D4:** the entire `events→sessions→touchpoints→journeys` transform — sessionize, bot-filter, touchpoint derivation, journey ordering — none exist; build in **stream-worker** on the **existing** topic (reuse `IdentityBridgeConsumer` shape), no new topic/service.
6. **Three deterministic stitches:** session (30-min gap), cross-session (`anonymous_id` + `brain_id_alias` re-pointing), journey/anon→known→order (**cart-stitch** read back off the Shopify order — deterministic, never inferred).
7. **Cross-session + journey stitch REUSE the shipped union-find** (`brain_id_alias`, `IdentityRepository.readState`) — no new id authority, no parallel graph.
8. **Completeness/coverage/confidence are first-class outputs** stamped as **enum grades** in the metric-engine/`attribution`/`dq_grade` path — NOT bespoke OLTP floats.
9. **No Postgres OLTP journey tables** (ground-map reject); journey modeling is **gated on the Silver StarRocks/Iceberg/dbt tier landing**; behavioral events stay Raw-Only in `bronze_events` until then. Only capture (SDK) + cart-stitch parser/columns (`shopify-mapper` + `silver.order_state` per docs-08 §35) ship now.
10. **Single highest-risk decision:** *where journey lives* — hold for Silver (don't drift into OLTP) **and** pin the SDK to the **Avro/Bronze** `event_type`+`payload` wire shape (not the Zod `event_name` shape) so captured inputs land well-formed; reconcile the two envelope shapes before writing any SDK code.
</content>
</invoke>
