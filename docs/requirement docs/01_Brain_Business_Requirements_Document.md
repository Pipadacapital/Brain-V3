# Brain — Business Requirements Document

**Product:** Brain — the AI-native commerce operating system for DTC brands in India, UAE & GCC.
**Document type:** Business Requirements Document (BRD) — the authoritative, plain-language source of truth for *what Brain is, who it serves, and how it must behave*.
**Status:** Final. **Version:** 1.0 (definitive consolidation). **Date:** 2026-06-14.
**Companion documents:** `02_Brain_Product_Functional_Specification.md` (every feature, story-ready, with positive/negative/edge behaviour) and `03_Brain_Technology_Stack_and_Technical_Decisions.md` (the technology and why each choice was made).

**How to read this document.** It is written in plain language for a founder, product manager, business analyst, designer, engineer, or AI coding agent. It first tells you *what Brain fundamentally is* (four foundational platforms, not a dashboard), then walks the product in the exact order a real user experiences it — arrive → register → onboard → connect tools → collect first-party data → resolve identity → measure honestly → decide and act → get billed — all wrapped in trust and compliance. Architecture diagrams, database schemas, API contracts, sprint plans, and deployment plans are deliberately **out of scope**; they are derived from this document and its two companions.

---

## Table of Contents

**Part A — What Brain Is**
1. Executive summary
2. The problem and the daily operating loop
3. What Brain fundamentally is — the four foundational platforms
4. Who Brain is for
5. The outcomes every feature must move
6. The end-to-end journey (the flow spine)

**Part B — The Five Core Platform Pillars**
7. Pillar 1 — The First-Party Data Collection Platform
8. Pillar 2 — The Third-Party Data Integration Platform
9. Pillar 3 — The Customer Identity Platform (Brain ID & the Identity Graph)
10. Pillar 4 — The Measurement & Attribution Platform
11. Pillar 5 — The AI Decision Intelligence Platform

**Part C — The Product Experience**
12. Getting in — access, registration, sign-in & onboarding
13. Organizations, brands, teams & roles
14. The single source of truth — the lakehouse & the numbers Brain computes
15. Using Brain day to day — surfaces over the platform
16. What Brain costs — pricing, metering & billing
17. Acting on the data — lifecycle, support & safe automation (later phases)

**Part D — Cross-Cutting Foundations**
18. Trust — privacy, consent, compliance, security & reliability
19. Cross-cutting product standards (states, accessibility, internationalization)
20. Positioning & competitive wedge

**Part E — Governance**
21. KPIs & success metrics
22. Roadmap & phasing
23. Assumptions, dependencies & open decisions
24. Glossary

---

# Part A — What Brain Is

## 1. Executive summary

DTC founders are drowning in tools and starving for truth. They open a storefront, two ad managers, a payments dashboard, a logistics panel, a WhatsApp inbox, an inventory sheet, and a finance file — all day, every day — and still cannot answer the only question that matters: *are we making high-quality money today, and what should I do about it before the day gets away from me?* Each tool shows one slice, none agree, and the most expensive decisions get made on platform ROAS while real profit bleeds out through returns, RTO, refunds, and wasted spend.

**Brain is the operating system that ends that.** It is sold not as software seats but as a **revenue/profit centre, priced as a percentage of realized (delivered) GMV under management**. Brain connects a brand's entire commerce stack, collects every source in real time into one complete **per-brand data lakehouse** (the single source of truth), computes honest profit (true contribution margin after every real cost), attributes outcomes truthfully (reconciled to the revenue that actually *realized*, not what a platform claimed), tells the operator what changed and what to do next, safely executes the low-risk actions within guardrails, and remembers every outcome so each decision sharpens the next.

Crucially, **Brain is not a dashboard, a reporting tool, a BI product, a chatbot with data access, a helpdesk wrapper, a WhatsApp sender, or a generic CRM.** It is four foundational platforms stacked into one product (§3). The dashboards, reports, briefs, and AI answers a user sees are *outputs* of those platforms — never the product itself.

## 2. The problem and the daily operating loop

DTC operators don't check tools because they love dashboards — they check because revenue is moving and the movement creates urgency. They rotate through store orders, ad accounts, payment dashboards, logistics panels, support inboxes, inventory sheets, and finance files: refresh, interpret, react, refresh again. The loop is fragile because each tool shows one slice and none agree on attribution.

The result is a catalogue of expensive failures: platform ROAS looks good while COD/RTO quality is poor, so the brand scales bad revenue; attribution is double-counted, so spend is mis-allocated; revenue rises while CM2 falls, so growth is celebrated as profit collapses; support is treated as cost, so revenue saves go uncaptured; courier and pincode failures are seen too late; decisions go unlogged, so nothing compounds.

**Brain replaces that loop with one profit-quality operating surface backed by one trusted dataset, running an eight-step loop:** Sense (collect fresh first-party + connected data) → Normalize (one model) → Resolve (events → one customer) → Measure (touch → realized revenue, honest CM2) → Detect (meaningful movement) → Decide (rank by CM2 impact, urgency, confidence, reversibility) → Act (recommend / queue / execute within guardrails) → Learn (log condition, action, outcome; sharpen the next decision).

## 3. What Brain fundamentally is — the four foundational platforms

Brain is built bottom-up as four platforms. Each is a real platform in its own right — it has **inputs**, **outputs**, a **programmatic surface** (Analytics API and read-only MCP), and **internal and external consumers**. Everything a user sees is a rendering of one or more of these platforms. If a capability cannot be tied to one of these four platforms (or to compliance, attribution accuracy, or decision memory), it does not ship.

### 3.1 Platform 1 — First-Party Data Collection Platform
**What it is:** a CDP-grade, consent-aware, server-augmented event-collection platform that observes the brand's own customers on the brand's own domain — durable, deduplicated, replayable, and quality-monitored.
**Inputs:** browser/app events from the Brain Pixel (client + server), order webhooks, click identifiers.
**Outputs:** an immutable, versioned, consent-tagged event stream (Bronze) and quality-graded behavioural data; consent-gated conversion passback to ad platforms.
**Consumers:** the Identity Platform, the Measurement Platform, the lakehouse, the brand's own tools via MCP.
**Why it is foundational:** ad-platform pixels are third-party scripts that browsers, iOS, and ad-blockers strip — and the loss is *biased*, hitting high-intent shoppers hardest. Without first-party collection, every downstream number inherits that bias. (Full detail: Pillar 1, §7.)

### 3.2 Platform 2 — Third-Party Data Integration Platform
**What it is:** a connector platform that ingests the brand's whole stack (commerce, ads, payments, logistics, messaging, support, finance) with honest status, real freshness, backfill, retry, and health monitoring.
**Inputs:** OAuth/API/webhook/settlement-file feeds from 12–14 deep native connectors at launch and a 100+ discovery catalogue.
**Outputs:** normalized, reconciled, per-source-and-combined data in the lakehouse.
**Consumers:** the Measurement Platform, the AI Platform, dashboards, billing.
**Why it is foundational:** first-party behaviour is only half the truth; spend, settlement, delivery, and returns live in third-party systems, and honest CM2 needs all of them reconciled. (Full detail: Pillar 2, §8.)

### 3.3 Platform 3 — Customer Identity Platform
**What it is:** a dedicated identity-resolution platform that mints a brand-scoped, never-global **Brain ID**, stitches scattered events into one customer, and exposes a unified Customer 360 — deterministically, reversibly, and with confidence.
**Inputs:** strong identifiers (hashed email/phone, storefront/auth IDs), first-party cookies once linked.
**Outputs:** one resolved customer per real person per brand; identity confidence and completeness; a unified profile.
**Consumers:** the Measurement Platform (attribution needs a customer), lifecycle, support, dashboards.
**Why it is foundational:** you cannot attribute revenue or remember outcomes about a person you cannot recognize. (Full detail: Pillar 3, §9.)

### 3.4 Platform 4 — Measurement & Attribution Platform
**What it is:** the platform that turns collected + integrated + resolved data into **honest, realized-revenue measurement** — true CM2, position-based attribution reconciled to the realized ledger, RTO clawback, channel contribution, and confidence on every number.
**Inputs:** the event stream, the connector data, the identity graph, the cost model.
**Outputs:** the metric registry's computed numbers — one definition, computed identically everywhere.
**Consumers:** dashboards, the AI Platform, billing, MCP.
**Why it is foundational:** measurement *is* the product's truth claim. Every other platform exists so this one can be trusted. (Full detail: Pillar 4, §10.)

### 3.5 The AI Decision Intelligence Platform (the layer on top)
**What it is:** the decision layer — Brain AI, natural-language query, the Morning Brief, ranked recommendations, the Decision Log, and (later) safe autonomous execution — that turns measured truth into the next action.
**The discipline:** numbers are always computed deterministically by the Measurement Platform; the AI **narrates and recommends, it never invents a figure.** (Full detail: Pillar 5, §11.)

### 3.6 The one architectural boundary that expresses this
`First-party + connected events → lakehouse (Iceberg, source of truth) → serving (StarRocks) → Analytics API → Brain AI / dashboards / Morning Brief / MCP`, with **Brain ID + the Identity Graph as a first-class platform service** beside it. Every surface reads only through the Analytics API, so the same question returns the same number whether it is asked by a chart, the AI, an export, or the brand's own LLM via MCP.

## 4. Who Brain is for

Brain is built for DTC and connected-commerce brands in **India (launch), UAE and GCC (sequenced)** that already have real monthly commerce volume, margin pressure, and multi-tool complexity.

The practical floor is **₹50L/month GMV** (or local-currency equivalent). **This floor is advisory, not a hard gate** (see §23 assumptions): it is the point below which the value proof and the cost-to-serve economics work cleanly. A brand below the floor can be onboarded under the minimum-fee economics, but its smaller cost base and thinner data may keep some honesty-gated features (the CM2 cap, high-confidence recommendations) inactive until its data matures.

Brain serves three tiers — operator-led brands, scaling brands, and enterprise/multi-brand groups — across four account shapes:
- **A — Single brand:** one organization, one brand; the founder is Owner. Most common at launch.
- **B — Multi-brand group:** one organization owns several fully isolated brands.
- **C — Agency:** structurally identical to B, but staff are assigned per client brand and no client ever sees another's data.
- **D — Enterprise overlay:** advanced controls (security review, custom SLA, residency, SSO, private-deployment options) layered on A/B/C, never weakening isolation.

## 5. The outcomes every feature must move

1. **Revenue booked** — orders, repeat purchases, recovered carts, winbacks, prepaid conversions, support-led saves.
2. **Profit protected** — CM2/CM3, RTO and COD leakage, refund leakage, wasted ad spend, overstock/stockout loss.
3. **Decision quality improved** — recommendations sharpen because every condition, action, and outcome is logged, and attribution is measured, not guessed.
4. **Operator time compressed** — the same or better decision in minutes, not by checking five to ten tools.
5. **Safe execution** — Brain can recommend, queue, execute, reverse, and audit actions within guardrails.

## 6. The end-to-end journey (the flow spine)

1. **Arrive & register** (§12) — sign up by Google or email+password; the registrant becomes the sole **Owner** of a new organization. Everyone else joins by invitation only.
2. **Onboard in four steps** (§12) — Organization → Brand → Integration selection (connect now or skip) → Done.
3. **Set up org, brands & team** (§13) — create brands (sealed worlds), invite teammates into the four roles, set the approval matrix.
4. **Connect the brand's tools** (§8) — via the Integration Marketplace; manage sync and health; marketplaces handled specially.
5. **Collect first-party data** (§7) — install the Brain Pixel; capture events with consent; monitor quality.
6. **Resolve identity** (§9) — stitch scattered events into one Customer 360 per Brain ID.
7. **Data becomes the single source of truth** (§14) — everything flows into the per-brand lakehouse, normalized, quality-graded, turned into honest numbers.
8. **Measure honestly** (§10) — realized-revenue attribution with RTO clawback, confidence, and channel contribution.
9. **Use Brain every day** (§15) — Home/Command Center, the Morning Brief and reporting rhythm, the AI assistant, MCP, the Decision Log, notifications.
10. **Get billed fairly** (§16) — a percentage of realized GMV, capped to stay affordable, on an inspectable meter.
11. **Let Brain act** (§17, later phases) — lifecycle revenue engine, AI support, safe autonomous execution.
12. **All under trust** (§18) — privacy, consent, compliance, security, isolation, and reliability wrap every step.

---

# Part B — The Five Core Platform Pillars

Each pillar below is written to a consistent shape: **Purpose · Business value · User journeys · Functional requirements · Non-functional requirements · Edge cases · Failure scenarios · Future extensibility.** The pillars are the heart of the product; the experience sections (Part C) describe how a user moves through them.

## 7. Pillar 1 — The First-Party Data Collection Platform

### 7.1 Purpose
To collect the brand's own customer behaviour — every page view, cart, and purchase — on the brand's own domain, with consent, deduplicated and stitched into one timeline, captured resiliently enough to survive cookie loss, ITP, ATT, and ad-blockers, and durable enough that a collected event is never lost. This is the raw material every other platform depends on.

### 7.2 Business value
Ad-platform pixels are third-party scripts that are increasingly stripped, and the loss is *biased* — it hits Safari/iOS and high-intent shoppers hardest, so the brands lose exactly the data they most need. A first-party collection platform makes measurement trustworthy post-iOS14 and gives the brand an owned, portable behavioural asset (which later becomes a prediction substrate, §11.8).

### 7.3 User journeys
- **Install:** a Manager/Brand Admin/Owner opens the Tracking section, copies the snippet (or enables the storefront app), pastes it; within seconds events appear in the Event Explorer and the SDK shows healthy.
- **Verify:** the operator watches the real-time Event Explorer and tracking-health dashboard confirm events, identity moments, and the client-vs-server purchase match rate.
- **Trust over time:** data-quality monitoring quietly watches for volume anomalies, schema violations, and "tracking gone dark," alerting the operator before a silent break corrupts numbers.

### 7.4 Functional requirements

**7.4.1 The Brain Pixel.** A first-party-domain script (with a server-side stream behind it) installed by snippet or storefront app. It captures the full commerce event set — page/product views, add/remove cart, checkout, purchase, search, sign-up/login/logout — **plus** marketing context: UTMs and ad click IDs (`fbclid`, `gclid`, `ttclid`, and a generic `click_ids` map for Snapchat/Reddit/Amazon Ads and future networks), persisted on the session and customer. The pixel must never slow the store (async, size-budgeted, batched, retried, offline-buffered, degrading silently).

**7.4.2 Client + server dual capture with deduplication.** Events are captured **both** client-side and server-side; the purchase is captured client-side *and* from the store's order webhook. The same purchase seen twice carries the same event ID and collapses to one — **a purchase is never double-counted.** On field disagreement, the higher-confidence server/connector value wins.

**7.4.3 Durable accept-before-validate collection.** The collector's first duty is to **durably accept and acknowledge** the raw event envelope **before** any schema validation, consent evaluation, bot detection, or enrichment. Those steps run **downstream** as stream stages, not as edge gates. A schema-invalid event lands in a Bronze quarantine (and a dead-letter path) — it is never rejected with a dropped-on-the-floor error. This is what makes "a collected event is never lost" true even when validation, the schema registry, or downstream services are degraded. (Tech rationale: `03 §5`.)

**7.4.4 In-app webview handling.** Sessions opened inside Instagram/Facebook/TikTok in-app browsers are detected and treated as a distinct surface. Because their cookies are partitioned/ephemeral, identity for these sessions relies on **server-side click-ID → order reconciliation**, not cookie persistence. A webview match-rate is surfaced as a tracking-health signal.

**7.4.5 Consent at capture.** Consent is enforced at capture across four categories — **Necessary, Analytics, Marketing, Personalization** — recorded with who/when/where, region, prompt language, and the **version of the consent text shown**. The consent snapshot rides with the event into resolution, so stitching itself is consent-gated. A separate **AI-processing flag** governs individual-profile use beyond aggregate analytics. **Capture fails closed.**

**7.4.6 Consent withdrawal propagation.** Withdrawal is retroactive within a **defined propagation window** (target: under 15 minutes). The mechanism: a consent tombstone/overlay is written (Bronze is never destructively edited); the customer is suppressed from every audience, journey, and **pending** send and pending conversion passback; and a deletion signal is sent to ad platforms for any already-passed-back conversions. (Detail: §18.3.)

**7.4.7 Sessionization.** Sessions are defined by an explicit rule: 30-minute inactivity timeout, a new session on a UTM/campaign change, and a day boundary at midnight in the brand's timezone, with a grace window for late/out-of-order events and bot sessions excluded. Session-derived metrics (first-touch channel, session count) are registered in the metric registry like any other number, so they are identical everywhere.

**7.4.8 Bot filtering.** Bot/spider traffic is detected (known-bot user-agent lists, datacenter-IP ranges, and velocity heuristics in Phase 1), flagged with a reason/method, and excluded from **both** analytics and identity-match-rate denominators — retained, never deleted.

**7.4.9 Event quality & "tracking-dark" monitoring.** A first-class monitoring contract: per-(brand, event-type) volume baselines with anomaly thresholds, a schema-violation-rate SLO, the client-vs-server purchase match-rate as a fired alarm, and a **"tracking went dark"** detector (e.g. a storefront theme update strips the snippet) wired into the notification tiers. Brain bills on collected data, so it must be able to *prove* data is flowing.

**7.4.10 Conversion passback (CAPI), output-only.** A named, consent-gated feature: Brain passes server-side conversions back to Meta CAPI / Google Enhanced Conversions / TikTok Events API to improve **the brand's own ad delivery**. It has its own status and health. **It is an output to ad platforms, never an input to Brain's attribution**, and must never inflate any Brain measurement signal. (See competitive note, §20 — this is Triple Whale "Sonar" parity.)

**7.4.11 Event replay & recovery.** Because Bronze is immutable and retained 24 months, the platform can replay any window on the *same code path* as live, so a recovered gap looks identical to data that was never missed. Late-arriving behavioural events (offline-buffered, arriving hours later) are appended; whether they re-open a closed session or attach as a new low-completeness touch is a stated rule (default: attach as a new touch; do not re-open a sealed session).

### 7.5 Non-functional requirements
- **Availability of the ingestion endpoint: 99.95%** (scoped to Brain's collector endpoint; the pixel's offline buffer + retry make brief endpoint downtime invisible to the brand — see the honesty note in §23 on what this SLO does and does not promise).
- **Latency:** tracking events 95% < 5s to availability; derived metrics within ~5 minutes.
- **Resilience:** the pixel degrades silently and never blocks checkout.
- **Isolation:** every event carries its brand_id; collection is brand-scoped end to end.

### 7.6 Edge cases
Cookieless visitor who never identifies → stays anonymous, reported honestly. CNAME/first-party domain not configured → works at reduced cookie persistence, said honestly. Multiple storefronts → per-property health. Browser closes mid-checkout → the server-side order webhook still records the purchase.

### 7.7 Failure scenarios
Collector endpoint down → client buffers and retries; nothing lost. Schema registry slow → events still accepted (validation is downstream). Pixel mis-installed → "No events / SDK not detected," never a false green. Volume drop / schema violation → a data-quality alert fires rather than silently corrupting analytics.

### 7.8 Future extensibility
Phase-2 **autocapture fallback** (DOM-level capture of commerce-relevant interactions) to reduce install-error blast radius; probabilistic device signals feeding identity (never alone); the behavioural store becoming the **prediction substrate** (§11.8). Explicitly excluded: **session replay / heatmaps** (privacy and off-mission — see §20).

## 8. Pillar 2 — The Third-Party Data Integration Platform

### 8.1 Purpose
To connect a brand's entire commerce stack and bring every authorized source into the lakehouse honestly — with truthful status, real freshness, historical backfill, retry, and health monitoring — so the combined picture is complete and reconciled.

### 8.2 Business value
First-party behaviour is only half the truth; spend lives in ad platforms, cash in payments, delivery and returns in logistics, conversations in messaging and support. Honest CM2 and honest attribution require all of them reconciled to one ledger. The principle throughout is **honesty over breadth**: a half-working connector is worse than an honest "Coming Soon."

### 8.3 User journeys
- **Discover & connect:** browse the Integration Marketplace by category; connect via OAuth or encrypted credentials; backfill runs so the brand opens with its history.
- **Operate:** Start / Pause / Resume / Retry a sync; read Last Sync, Next Sync, error reason; recover from an error without a support ticket.
- **Trust:** every source shows one of seven health states and its real freshness; a degraded source is flagged in combined views, never silently undercounted.

### 8.4 Functional requirements

**8.4.1 The Integration Marketplace.** Organized by canonical categories (storefront/commerce, marketplaces, advertising, analytics/tracking, CRM, payments, logistics, OMS/ERP/inventory, messaging, support, reviews/loyalty, finance). Every tile carries exactly one truthful status: **Connected, Syncing, Disconnected, Error, Coming Soon** (and **Disabled** where a plan does not entitle a category). No tile ever implies "live" when it is not.

**8.4.2 Connecting a source.** Two ways: **OAuth** (preferred, where supported) or **credential entry** (e.g. store URL + access token, stored encrypted, never shown back in full). On connect, the source maps to its canonical domains and ingestion begins into both the per-source and combined views.

**8.4.3 Historical backfill.** Targets **24 months where the API permits**, with **achieved depth labeled per connector**, on the *same code path* as live data so historical and live reconcile. A 60-day-cap provider is shown honestly as a 60-day connector.

**8.4.4 Connector lifecycle controls.** Every connector exposes Start / Pause / Resume / Retry Sync (Resume continues from the saved position — no gap, no duplicate), plus monitoring (Last Sync, Last Successful Sync, Next Scheduled Sync, Status, Error Reason/Logs, Sync Duration). All syncs are idempotent.

**8.4.5 The seven connection health states.** Each source carries exactly one: **Healthy, Delayed, Failed, Disconnected, Rate Limited, Token Expired, Disabled** — each with a defined entry condition, a plain explanation, and a prescribed next action. Each state also declares whether recommendations on this data are **blocked / degraded / safe**. Token Expired always links to re-auth; Rate Limited tells the operator that retrying does not help.

**8.4.6 Honest data freshness by source type.** "Real-time" is whatever each source can honestly deliver, and the achieved freshness is always visible: orders (webhook) 95% <30s / 99% <2min, hourly poll fallback; ad spend ~15min with a daily finalized correction labeled "until final"; payments/settlements <60s where webhooks exist; logistics/NDR hourly; support near-real-time; inventory hourly/daily; benchmarks daily/weekly. A breach is shown, not buried.

**8.4.7 Per-source vs combined (dual) views.** Each source alone *and* all sources in a category combined and normalized into one comparable model. A source in Error is flagged in the combined view ("Google excluded — connector failing"), never silently undercounted.

**8.4.8 Marketplaces — the special case (Amazon, Flipkart, Noon).** No pixel is possible (no journey to observe); data comes from **seller APIs + settlement reports**. **Fees are captured before revenue is counted** — referral/closing/fulfilment fees (often 15–35%) are populated from the settlement report **before** the order counts as realized. Marketplace revenue is measured as **channel contribution, not journey attribution** (§10.5). Masked marketplace PII gets a marketplace-scoped pseudo-identifier, never a weak merge.

**8.4.9 Payment-gateway settlement reconciliation.** Prepaid gateway settlement (Razorpay/Cashfree/PayU, T+2…T+7) is reconciled from the settlement file: realized prepaid revenue is **net of actual settled MDR, rolling reserve, and gateway adjustments**, not an assumed fee. This mirrors the marketplace settlement path.

**8.4.10 The tracking-plan / event-governance surface.** A customer-facing surface (built on the schema registry) where a brand defines its expected event taxonomy, sees schema-violation and missing-event reports, and governs the plan. This is the CDP table-stake that distinguishes "first-party data platform" from "a pixel." (Competitive note: Segment/RudderStack parity — §20.)

### 8.5 Non-functional requirements
- **Quality bar before breadth:** a connector counts as shipped only when its data reconciles within tolerance (orders within ~1%, spend within ~2%), appears in both views, and survives health monitoring.
- **Security:** credentials encrypted, never re-displayed; tokens revoked immediately on disconnect.
- **Scale:** sync scheduling backs off automatically under provider rate limits.

### 8.6 The launch connector set
Phase 1 ships the full 100+ **discovery** catalogue (with honest Coming Soon) **plus** a deep launch set (~12–14): Storefront **Shopify, WooCommerce**; Advertising **Meta, Google Ads**; Payments **Razorpay** + one of Stripe/PayU/Cashfree; Logistics **Shiprocket, Delhivery**; Messaging **WhatsApp Cloud API** (via a BSP) + **Klaviyo**; Analytics **GA4** + the **Brain Pixel**; CRM **HubSpot**. The GCC set (Salla, Zid, Noon, Tabby/Tamara, regional couriers) accelerates the moment the first GCC brand signs.

### 8.7 Edge cases & failure scenarios
OAuth cancelled → stays Disconnected, no half-state. Partial backfill → ingests what it can, labels real achieved depth. Settlement report delayed → the order is held **provisional** rather than counted at gross. Placed vs settled differ 20–35% → Brain trusts the settlement file. A brittle CSV/sheet source → labeled brittle, monitored hard, its lower quality caps what Brain will claim.

### 8.8 Future extensibility
The 100+ catalogue graduates connectors into the deep set by signed-customer demand; the GCC connectors activate on first GCC signing; a Phase-5 **custom-integration framework** for enterprise. Explicitly **not** a goal: the "200+ integrations" race of brittle daily CSVs.

## 9. Pillar 3 — The Customer Identity Platform (Brain ID & the Identity Graph)

### 9.1 Purpose
To resolve scattered, multi-device, multi-channel events into **one customer per real person per brand**, deterministically and reversibly, with a confidence and completeness score — so revenue can be attributed and outcomes remembered.

### 9.2 Business value
You cannot attribute revenue to, or remember outcomes about, a person you cannot recognize. Identity is the hinge between collection and measurement. In a COD market with phone-only, masked-email, guest-checkout orders, identity is also the hardest and most consequential problem — a false merge shows one customer another's orders.

### 9.3 User journeys
- **Anonymous → known:** a visitor arrives anonymous (a brand-scoped anonymous ID); on a strong identifier (login/signup/auth-checkout) a Brain ID is minted/matched and earlier anonymous sessions are stitched back.
- **Customer 360:** an operator opens one unified timeline per Brain ID — behaviour, orders, payments, marketing — and sees how confident and complete that identity is.
- **Resolve a conflict:** a shared-phone collision routes to a review queue with the evidence shown; an operator merges or keeps apart; a wrong merge is reversed.

### 9.4 Functional requirements

**9.4.1 The identity ladder.** **Anonymous on arrival → Brain ID once known → retroactive stitch.** Brain ID is **brand-scoped and never global**: the same person at two brands has two unrelated Brain IDs (a per-brand salt means even hashes cannot be correlated across brands).

**9.4.2 Deterministic matching only (Phase 1).** Strong identifiers — verified/hashed email, storefront customer ID, authenticated user ID, phone, and the first-party cookie *once linked* by a real login/signup/auth-checkout. Device/behavioural = medium (Phase 2, never alone); IP/user-agent/name/pincode = weak, **never auto-merge in any phase**.

**9.4.3 The India phone guard.** A phone match auto-merges only when no conflicting strong evidence exists. If two profiles share a phone but carry different verified emails or storefront IDs (shared COD numbers, family devices), Brain does **not** merge — it routes the pair to the **review queue** with evidence.

**9.4.4 Merge & unmerge.** Governing principle: **a false merge is worse than a missed merge.** Merges run under a **versioned merge rule** (rule ID, identifier combo, confidence, action). History is never rewritten — a read-time **alias** re-points a merged profile's events to the canonical Brain ID, so orders/sessions/journeys follow without editing events or money. **Unmerge is first-class and reversible.** A cycle guard aborts a merge that would create a loop, routing it to review.

**9.4.5 Cookie rebind (not merge).** A new login on an already-linked cookie means a *different person* on a shared device when the inbound strong identifier conflicts with the cookie's currently-bound Brain ID. The cookie **re-binds** to the new person; the two are never merged.

**9.4.6 Identity confidence & completeness.** Every merge edge carries confidence; additionally, each **profile** carries a **profile identity-confidence and completeness score** (derived from the tier, count, and recency of its links), exposed on Customer 360 and consumed by the AI and by attribution — so a one-weak-link guess and a five-strong-id profile are never treated identically.

**9.4.7 PII handling.** The graph holds **hashed** identifiers only; real email/phone live in a separate encrypted vault readable only by the send service. Links are appended, never overwritten, each recording its rule and confidence. Resolution is consent-gated.

**9.4.8 Customer 360.** The single unified profile per Brain ID — one timeline of behaviour, orders, payments, and communication. It is a **derived read model** (the lakehouse + identity graph remain authoritative), so it can always be rebuilt from source. View-only roles see it **PII-minimized** (city/pincode at most, never vault plaintext).

**9.4.9 Merge-review-queue SLA.** The review queue has a defined working SLA and a volume alarm, and a default disposition on expiry (default: keep apart / do not merge on expiry). At India COD shared-phone scale this queue is operationally significant and is owned by the Owner/Brand Admin.

### 9.5 Non-functional requirements
- **Correctness over recall:** never auto-merge on weak signals; conflicting strong evidence always goes to review.
- **Reversibility:** every merge and unmerge writes an audit-log + Decision-Log entry; an undone merge closes the alias (history preserved), never deletes it.
- **Isolation:** identity is never stitched across the brand boundary.

### 9.6 Edge cases
Cookieless visitor who never identifies → stays anonymous/unlinked, reported honestly. Two real customers sharing a phone → held apart by the guard. Same person across two devices → unified the moment a shared strong identifier appears. Just-merged/unmerged profile → re-projects to the current canonical view without destroying history.

### 9.7 Failure scenarios
A normalization mismatch (case, E.164 edge cases, unicode) would silently break the "same email is the same email" invariant with no error — so identifier normalization+hashing is centralized (or, if distributed, governed by a shared library with a CI conformance test). (Tech rationale: `03 §7`, an explicit resolved decision.) A wrong merge → unmerge restores constituent identities with full histories.

### 9.8 Future extensibility
Phase-2 probabilistic identity (device/behavioural, never alone) to lift match rate; Phase-5 online/offline (retail POS) identity. The identity confidence signal feeds the eventual `Calibrated` attribution band.

## 10. Pillar 4 — The Measurement & Attribution Platform

### 10.1 Purpose
To answer, honestly, *who actually drove the realized revenue and what is the true profit* — reconciled to money that hit the bank, never to platform claims, with confidence on every number.

### 10.2 Business value
Add up what each ad platform *claims* and you get a number far bigger than the money that reached the bank — Meta, Google, and TikTok each take full credit for the same sale. On top of that, India-specific: a large share of orders are **COD**, ~a quarter of which **RTO**, and platforms book the "sale" at *placement* — so a campaign that looks brilliant Monday turns loss-making three weeks later when its orders bounce. Brain's premise: the only revenue worth attributing is **realized** revenue, and credit must *move* as reality moves — **the ledger wins.**

### 10.3 Revenue recognition — the one rule (resolves the cross-doc contradiction)
Revenue is recognized in **two stages**, and every part of Brain (metrics, attribution, billing) reads this one rule:
- **Provisional recognition at delivery.** When an order is delivered, revenue is recognized *provisionally* and stamped `provisional/settling`. This is an economic recognition event, not a cash event.
- **Finalization at the realization horizon / settlement.** Once the order crosses its realization horizon (delivered + horizon, or settled — whichever is later; ~25 days for COD, ~7 for prepaid by default) it is restated to the **net realized** amount and stamped `finalized`. Marketplace and prepaid-gateway orders finalize from their **settlement files** (§8.4.8–8.4.9), net of fees.

Settlement effects after delivery (RTO, refund, chargeback, fee reversal, marketplace adjustment, payment adjustment) post as **append-only ledger rows** — the original sale row is never mutated. The "as-of" rule: realized revenue on any date = the sum of ledger rows recognized up to that date, restating downward as reversals land. **Billing reads only finalized rows.**

### 10.4 The numbers Brain computes
All computed deterministically against one frozen registry of definitions; the AI narrates, never invents (full metric detail in §14.5).
- **The revenue ladder:** Placed → Paid → Shipped → Delivered (provisional recognition) → Realized (the honest number).
- **The contribution-margin waterfall:** Revenue (net of per-SKU tax) − COGS − other variable costs = **CM1**; − marketing = **CM2**; − fixed costs = **CM3**.
- **True CM2** — realized-only CM2 after subtracting only the *incremental* cost of failure (return-leg shipping + damage on RTO'd orders) plus provisions; never a double-subtraction. `CM1 ≥ CM2 ≥ True CM2` always holds.
- **Efficiency metrics:** MER, aMER, CAC, LTV:CAC — all on **realized** revenue.
- **RTO & COD economics:** RTO rate & cost (diagnostic only), COD share & realization rate, break-even COD RTO rate `r* = M ÷ (M + C)`, with the realization-rate model **pincode-, courier-, payment-method-, and seasonality-aware** (festival multipliers feed the provisioning, not just the dashboards).
- **Multi-currency / FX:** each ledger row converts at **its own recognition-date** FX rate, from a declared, dated, locked source. So a sale leg and a later clawback leg of the same order may convert at different rates (correct accounting), and the billing meter inherits this exactly. A missing rate fails closed.

### 10.5 Attribution
**10.5.1 Journey attribution** splits credit across a customer's real first-party touches using a model: first-touch, last-touch (dangerous in India), linear, and **position-based — the default** (most credit to first + last, the rest across the middle; in a COD market this spreads both credit and the eventual clawback across the touches that genuinely built the sale).

**10.5.2 Per-channel attribution windows.** Touch-eligibility windows are **per-channel and brand-configurable** (default 7-day click; 14–30 day allowed for prospecting/influencer-led consideration), frozen at conversion per order. They are not a single hardcoded value — a fixed 7-day window truncates legitimate longer-consideration journeys and under-credits upper funnel.

**10.5.3 Realized-time attribution & clawback (the India fix).** Credit is assigned to realized revenue in two passes — **Provisional** (an expected-realized estimate discounted by RTO likelihood at placement; never feeds billing or high-stakes recommendations) and **Finalized** (restated to net realized at the horizon). When an order RTOs/refunds/charges back, Brain **claws credit back from the exact campaigns and touches that got it, in the same proportions** (the original split weights are saved). The visible result — a campaign's CM2 falling weeks after the spend — is the point.

**10.5.4 Baseline / harvested-vs-created demand.** Branded search, direct, and organic leave first-party trails and would otherwise collect first/last-touch credit for demand they merely *harvested* rather than *created*. Phase 1 flags these as `harvested_demand` with a configurable haircut and a confidence penalty, and records an `organic_baseline` contribution row. (Phase-3 incrementality/MMM becomes the source of truth for incremental-vs-baseline.) **This is a deliberate honesty choice: Brain does not separate incremental from harvested demand perfectly in Phase 1, and says so.**

**10.5.5 View-through (resolves the contradiction).** **Phase 1 credits no view-through.** Brain's first-party pixel has no impression log, so view-through is not journey-credited; it lives in the unattributed bucket and is recovered by MMM in Phase 3. Every paid-social channel card carries an explicit **"view-through blind spot"** disclosure so the operator does not misread the gap as poor performance and cut incremental spend.

**10.5.6 Cross-device & app-vs-web honesty.** Deterministic-only Phase 1 means a phone-discovery → desktop-purchase journey is two journeys until a shared login appears, systematically under-crediting mobile-social discovery. Brain surfaces a `cross_device_unlinked_rate` signal (sampled from logged-in multi-device customers) that lowers journey confidence where cross-device loss is high, and documents the bias direction. In-app webview sessions rely on server-side click-ID→order reconciliation (§7.4.4).

**10.5.7 Attribution confidence.** Every attributed number carries a confidence — **Low / Medium / High** today; a top band **Calibrated** unlocks in Phase 3, only once validated against incrementality/holdout tests. Two guardrails: a **trust line at 70** (below it → labeled estimated, gap shown, high-risk recommendations blocked; the same 70 line is shared across cost-quality, data-quality, and attribution), and **`effective_confidence = min(cost-confidence, attribution-confidence)`** with the display naming which leg is the problem.

### 10.6 Channel contribution — "contribution, not credit"
The single authoritative answer to the strategic, cross-channel question — *how much did each whole channel contribute to realized revenue, including channels with no journey?* — always stated as **a range, with a method and a confidence** ("Meta contributed ₹1,000,000 ± ₹150,000 · method = MMM · confidence = Calibrated"). Everything **without a click journey lives here**: marketplaces, offline/retail, WhatsApp/lifecycle, influencer-coupon, trade shows. **The hard rule: you never add journey-credit and channel-contribution together** (two instruments measuring the same money). **One closed sum:** all channel contributions (including the always-rendered unattributed residual) equal total realized revenue for the period. Phase 1 fills the rows from rule-based + direct inputs (capped at High); Phase 3 swaps in MMM/holdout with no schema, API, dashboard, or prompt change. **MMM is not a Phase-1 dependency.**

### 10.7 Marketing-spend homing (resolves the CM2 reconciliation gap)
- **Journey-bearing spend** (Meta/Google clicks) reduces `cm2_blended` and is allocated under the model into `cm2_attributed`, with the residual in `cm2_unattributed`.
- **Non-journey spend** (influencer, affiliate, WhatsApp/lifecycle, trade shows) reduces `cm2_blended` and lands in **`cm2_unattributed` on the journey side** *and* as a `spend_minor` on the relevant **channel-contribution row** on the strategic side — **never forced onto a journey touch.** A parity check asserts that all marketing spend = journey-allocated + unattributed-spend.
- **Message cost is split** by template category: **utility** messages (order/COD confirmation) are an operational variable cost (into CM1); **marketing/promotional** messages are marketing spend (into CM2).

### 10.8 Honest about the unknown
There is always an explicit **unattributed bucket**, always shown alongside attributed numbers (never hidden, never quietly spread). It holds cookieless visitors, marketplace/offline revenue with no journey, view-through, and reversals too old to fairly blame. It doubles as a signal — a big bucket mechanically lowers every campaign's confidence. As MMM lands it shrinks but never disappears.

### 10.9 Non-functional requirements
- **One definition everywhere:** every metric has one registry definition; a continuous **parity oracle** fails the build/run on drift. "Same question, same number" is a hard launch requirement (qualified in §14.6 for the hot-vs-finalized path).
- **Reproducibility:** definitions are versioned; every attributed number is pinned to the model version + data snapshot that produced it; switching models never rewrites history.

### 10.10 Edge cases & failure scenarios
Fully-RTO'd campaign → each sale's credit exactly negated, attributed CM2 falls to zero weeks later. Partial refund → proportional clawback across the same touches/weights. Late chargeback after finalization → label stays "finalized" but the reversal still lands. NDR then re-delivery → nothing reverses, the horizon shifts. Pre-ship cancellation → no sale ever recognized.

### 10.11 Future extensibility — capture evidence now, analyze it later (FROZEN)
The decision is split deliberately into **capture** and **analyze**, because the real risk is not building incrementality late — it is *arriving at the analysis with no historical data to calibrate against.*
- **Phase 1 — reserve the contract.** The channel-contribution schema and the holdout/exposure schema are reserved and frozen (the "freeze the contract, defer the engine" pattern), so nothing downstream changes when the engine arrives.
- **Phase 2 — capture evidence.** Brain begins **collecting** the data incrementality needs: **exposure groups, holdout groups, experiment metadata, and test metadata** (deterministic geo/pincode-level assignment; lightweight, minimal UI). It does **not** yet build the MMM, incrementality, or calibration engines.
- **Phase 3 — analyze evidence.** MTA + **MMM + incrementality/holdouts** consume the Phase-2 evidence to unlock the `Calibrated` confidence band and channel contribution measured by lift.

So by the time the engines are built, the historical holdout/exposure record already exists — calibration is meaningful from day one of Phase 3 instead of needing another 3–6 months of data collection. (This is a frozen founder decision — §23.3.)

## 11. Pillar 5 — The AI Decision Intelligence Platform

### 11.1 Purpose
To turn measured truth into the next action — what changed, why, what actually drove it (in realized CM2, with honest confidence), what to do, whether Brain can safely do it, and what happened after.

### 11.2 Business value
The operator's scarcest resource is attention. The AI layer compresses ten tools and an analyst's morning into three ranked actions, each with evidence, confidence, risk, and a one-tap response — and it remembers every outcome, so the brand's decisions compound.

### 11.3 The non-negotiable discipline
**Numbers are deterministic; the model only narrates.** The AI resolves a plain-language question to a **registered metric** (`metric_id`, filters, grain, time range) and narrates the **computed** number — it never writes its own query, never does its own arithmetic, never invents a figure. This is both a correctness rule and a cost rule (deterministic ≫ statistical ≫ small model ≫ frontier model).

### 11.4 Functional requirements

**11.4.1 Brain AI / natural-language query (NLQ).** Ask in plain English → get the direct answer, the exact numbers + formula used, the filters/time period, a confidence/caveat, a suggested next action, and a link to the underlying report. The same governed tools serve NLQ and MCP, so both return identical numbers. Predictive/action questions are out of scope until their phases (descriptive/diagnostic only in early phases).

**11.4.2 The Morning Brief.** Around local morning, **at most three actions** (never a chart dump), each: problem → evidence → recommended action → expected impact → risk → confidence → buttons. Delivered on responsive web, by **email (the primary channel)**, and over **WhatsApp as a Scheduled Delivery Channel** (§15.6, §15.8) — the same channel that later carries the Daily Summary, Weekly Summary, and future digests. Responses write to the Decision Log.

**11.4.3 Ranked recommendations & the recommendation contract.** Every recommendation carries: action title, why-now, metrics used, expected revenue + CM2 impact, confidence (+reason), risk, reversibility, required approval level, execution path, fallback if rejected, and an outcome-measurement plan. **This contract is a Phase-1 cross-cutting definition** — the Home screen's Top-3 actions and the Morning Brief both render it (it is not a Phase-4-only artifact).

**11.4.4 The Decision Log & compounding memory.** Every recommendation, decision, action, and outcome is recorded — append-only, immutable in operation, retained for workspace life, referencing customers by **Brain ID, not PII**. Rejected/reversed actions are logged as fully as approved ones. **If it isn't logged, it didn't officially happen.**

**11.4.5 AI provenance.** Each AI response additionally records its own trace: model id + version, prompt-template version, the resolved metric-binding, the data snapshot/version pins, the confidence inputs, and cost/latency — so "why did Brain tell me to cut this campaign?" is reproducible months later.

**11.4.6 Explainability & confidence scoring.** Every number is explainable (formula, filters, period, freshness) and every recommendation shows confidence and risk. The AI may narrate confidence but may never invent or inflate it.

**11.4.7 MCP — the brand pulls its own data.** A brand-scoped, permission-scoped, **read-only** MCP key exposes the lakehouse through governed named tools bound to the same metric definitions Brain's screens use. MCP can never write, delete, run arbitrary SQL, reach another brand, or touch secrets; every call is audited; a key hitting a limit gets a clear machine-readable error, never a silent partial result.

**11.4.8 AI safety & prompt-injection resistance.** The primary defense is architectural — numbers are deterministic and the model cannot issue queries or change a metric, confidence, weight, or action-eligibility. Beyond that: all lakehouse-derived text (support tickets, campaign names, UTM/custom-event fields) is treated as **untrusted data, delimited and never placed in the instruction channel**; recommendation *eligibility* is computed deterministically (grade/confidence/reversibility), the model only explains; and an injection golden-set is part of the ship gate.

**11.4.9 NLQ resolution eval gate.** Because a *silent misresolution* ("revenue" → placed instead of realized) returns a correct-looking but wrong number with full confidence, a golden question→metric-binding eval suite is a **ship gate** run on every prompt/model/registry change (resolution accuracy + decline-correctly). Any model in the routing pool must pass it.

**11.4.10 AI-processing consent enforcement.** Per-customer/profile AI use checks the `ai_processing` consent flag at the Analytics-API boundary and declines (audited) when it is not granted.

### 11.5 Non-functional requirements
- **Cost routing:** the AI gateway routes the cheapest-sufficient model per task; budget exhaustion mid-conversation returns a clear limit error (never a silent degraded answer); a model failover re-runs the resolution eval.
- **Auditability:** every NLQ and MCP query is logged.

### 11.6 Edge cases & failure scenarios
A question that maps to no metric or unconnected data → says so plainly, offers the closest answerable question. Below-grade/stale source → answers with the caveat. Ambiguous question → a clarifying prompt. A poisoned campaign name attempting to steer a recommendation → treated as data, never instruction; the recommendation's eligibility is unaffected.

### 11.7 AI limitations (stated honestly)
Early phases are **descriptive/diagnostic only** — no predictive or action answers until those phases. The AI never invents delivery status or any unverifiable fact, never reveals internal margins/scores/risk labels, and always discloses it is an automated assistant with a human handoff.

### 11.8 Future extensibility — the lakehouse as a prediction substrate
The owned first-party behavioural store is the most valuable predictive asset in the category. Phase 3 adds a prediction layer (demand/sales forecast, churn/at-risk, predicted LTV, stockout, cash timing); RTO-likelihood is already a production prediction (it discounts provisional credit). **Decision (push-back-flagged):** in v1 predictions stay **internal to Brain's recommendations** — Brain is a measurement-and-decision OS, **not** a bidding/audience-optimization product sold as an audience (that is Black Crow's lane and pulls Brain off-mission). Predictive audiences/activation are a deliberate later decision, not a silent gap (§20).

---

# Part C — The Product Experience

## 12. Getting in — access, registration, sign-in & onboarding

The first thing a person touches in Brain must be fast, honest, and impossible to get lost in: take a brand operator from "never heard of Brain" to a working product in one short, guided sitting — without forcing a single connection, and without letting anyone slip into an organization they were never invited to. All Phase-1 scope.

Two facts govern this whole section: **the first person to register a new organization becomes its Owner, and there is exactly one Owner per organization**; and **everyone else joins by invitation only.** Where competitors lean on per-seat self-serve sign-up, Brain treats org membership as a deliberate, invite-gated act, because brand data isolation starts at the front door.

### 12.1 Landing & sign-up choice
A first screen with two equal paths — *Sign up* (create a new organization) and *Sign in*. It never silently merges a new registration into an existing org. An invited teammate who clicks *Sign up* is guided to accept their pending invitation instead of creating a second org. One human may own more than one org (an agency starting a second book), each its own isolated tenant.

### 12.2 Registration — two ways
- **Google sign-up (one tap):** a Google-verified email is treated as verified (no second email); creates the account, the org, and the Owner. No email shared → falls back to email+password.
- **Email + password:** creates the account **unverified**, sends a single-use, time-expiring verification link; the account cannot reach the product until verified. Email already registered → refuses a duplicate, reveals nothing beyond "already in use."

### 12.3 Sign-in, reset, MFA, logout & sessions
Generic "email or password is incorrect" (never disclose which), with rate-limiting/lockout. **Forgot password** uses a single-use, time-expiring magic link with a neutral "if an account exists, we've sent a link." **MFA is available to every account from day one** (not enterprise-gated). **Logout** is always accessible; "log out everywhere" ends all sessions. **Immediate revocation is non-negotiable:** removing a user, suspending them, changing their role, or revoking an integration immediately invalidates the affected sessions/tokens/keys.

### 12.4 Account states
Each membership is in exactly one state: **Invited, Active, Suspended, Removed.** All transitions are audit-logged; suspension and removal trigger immediate revocation; because decision history references customers by Brain ID, removing a teammate never destroys the record of what they did.

### 12.5 The four-step onboarding wizard
**Organization → Brand → Integration selection → Done.** Progress is saved after every step (resume if interrupted); **no single integration is ever a gate** ("Skip For Now" is a first-class choice); **pixel installation is deliberately not part of onboarding** (done later from Tracking). Brand setup hard-validates currency and timezone (they drive every monetary and day-boundary metric) and sets a default revenue definition (Realized/Delivered recommended for COD-heavy markets).

### 12.6 Landing in the product
If a source was connected, early data shows labeled by freshness, with cost-dependent numbers labeled *Estimated* (never faked). If integrations were skipped, a **guided empty state** actively drives the first connection. The **Brand Readiness Score** (defined in §15.9) acts as a to-do list, not a verdict. A clearly accessible Logout control is always present.

## 13. Organizations, brands, teams & roles

Brain is multi-tenant by design. Every brand is a sealed world, and people get exactly the access their job needs and nothing more. Every change here is written to the audit log.

### 13.1 The Organization → Brand model
A **brand** (also called a **workspace**) is the atomic unit of isolation: the tenant boundary, the billing basis, and the thing everything hangs off — its own region, currency, timezone, revenue definition, integrations, cost setup, users, goals, and Decision Log. An **organization** owns one or more brands. **Brand isolation is absolute** — one brand can never see, query, infer, or borrow another's data by any path (dashboards, Analytics API, AI, MCP, exports, or a misconfigured invite). The only legitimate cross-brand view is the Owner's organization-wide rollup, which still reads each brand within its own isolation. A cross-brand leak is a P0, never an acceptable degradation.

### 13.2 Active-brand context & switching
Because agencies and multi-brand groups are first-class, the **brand switcher** is a primary control. It is always visible; the active brand is persisted across sessions and tabs; switching while an action is unsaved prompts before discarding; deep-links are scoped to a brand_id; the Owner enters and exits the org-wide rollup explicitly; and a user with one brand sees no switcher friction.

### 13.3 The four roles
Brain implements **exactly four roles today** — **Owner, Brand Admin, Manager, Analyst** — on a permission-based engine (the atomic unit is a *permission*; roles are templates). Richer personas (Founder, Growth Lead, CFO, executive views) **map onto these four** and are *lenses*, not additional roles. A template editor to compose new roles is explicitly deferred to a later phase. Exactly one Owner per org.
- **Owner** (org-wide; one per org): the only cross-brand view; sole creator/deleter of brands and Brand Admins; the only role that can enable auto-execute and change billing / delete the org; subject to the audited transfer + break-glass flow.
- **Brand Admin** (assigned brands): full feature access; configures integrations and cost setup; approves and executes actions within policy & cap; manages Managers/Analysts.
- **Manager** (assigned brands): full read; operational write (integrations, pixel, syncs) — but no team management, settings/cost setup, financial/customer-facing actions, or billing.
- **Analyst** (assigned brands): strict view-only; can comment; sees no raw PII beyond report minimization.

### 13.4 The approval matrix, team management, Owner continuity & audit
The approval matrix (who may view, comment, send, change budget, refund, change courier, activate audiences, connect integrations, do cost setup, create/delete brands, create Brand Admins, enable auto-execute, change billing) is enforced by **permission, not role label**. Teams grow by **invitation only**; inviters can grant only brands they manage and roles at or below their authority; revocation is immediate. Because there is exactly one Owner, **Owner transfer** (planned, step-up-verified) and **break-glass recovery** (unplanned, identity-verified, support-mediated) guarantee an org never becomes permanently inaccessible or reaches zero Owners. Every org-, brand-, role-, permission-, and team-level change is recorded in a **tamper-evident, append-only audit log** with an in-product **audit-log viewer** (filterable, brand-scoped, exportable) so an enterprise buyer can verify access governance after the fact.

## 14. The single source of truth — the lakehouse & the numbers Brain computes

Every number Brain shows — on a dashboard, in the Morning Brief, in an export, or from the AI — comes from one place: the brand's **data lakehouse**.

### 14.1 The per-brand data lakehouse
One complete, private store of the brand's entire commerce reality, computed off ten canonical domains (Customer, Identity, Behavior, Order, Product, Payment, Marketing, Shipment, Inventory, Support). It holds **both** raw and normalized data; it is **isolated per brand**; and **every number traces to its raw origin** — if Brain can't trace it, it doesn't show it as fact.

### 14.2 Real-time ingestion & raw retention
Data flows in as events happen; Brain keeps the raw, unaltered copy for **24 months** for replay/audit. The honest truth: **the most important facts arrive several times and change** — so every restatable fact is labeled provisional / settling / finalized, and the freshest copy of a still-moving number is shown as provisional, not the truth. On recovery, backlog replays on the *same code path* as live.

### 14.3 Normalization, the dual view & data quality
Different tools' data maps into one consistent model, viewable per-source and combined. Brain grades each source and the brand overall (**A+ → D**) across completeness, freshness, accuracy, consistency, and identity-match, and the grade **changes what Brain will do** (§14.7). Two disagreeing sources reconcile to **one** figure with the discrepancy made visible (the system of record wins; a reconciliation note is raised, not a silent override).

### 14.4 Cost setup
Brain can only compute true profit if it knows real costs (COGS, payment fees, packaging, shipping, COD fees, returns/RTO). It scores cost data by **cost-confidence** — Trusted (≥95%), Estimated (70–95%), Insufficient (<70%) — and stamps every margin with its confidence. **Cost setup has a first-class input surface** (per-SKU COGS vs blended, guided import vs manual, category-benchmark defaults to bootstrap a new brand toward Trusted) — cost data is treated as an assisted onboarding feature, not just a gate, because it underpins both the CM2 promise and the billing cap.

### 14.5 The numbers Brain computes
The revenue ladder, the CM waterfall, True CM2, MER/aMER/CAC/LTV:CAC, RTO/COD economics, multi-currency FX, and goals/RAG — all as defined in Pillar 4 (§10.3–10.4). **New-vs-returning** is defined as **first *finalized* realized order, and is both merge-reactive and clawback-reactive**: a fully-RTO'd first order means *not acquired* (CAC restates on the same as-of curve as the ledger), and an identity merge restates the acquisition cohort. (This closes the "scale bad revenue" bug one layer above the ledger.) The metric registry is the one definition; the AI narrates, never invents.

### 14.6 One definition everywhere — "same question, same number"
Every metric has one registry definition; every surface computes from it; a continuous parity oracle fails loudly on drift. **Qualification (resolves the dual-store risk):** the guarantee is **same *finalized* number everywhere.** A fast, pre-deduplication serving copy may legitimately lag the authoritative store; provisional/hot reads are **labeled** and may differ until convergence, and the hot number **never** feeds a decision, billing, or attribution surface. The parity oracle continuously asserts hot-vs-authoritative convergence within a defined window and alarms on breach.

### 14.7 The data-quality gating table
A single authoritative mapping of **(data-quality grade / confidence band) → behaviour**: render label, recommendation eligibility, auto-execute eligibility, MMM-training inclusion, and billing-cap applicability. "High-risk action" is defined crisply by **reversibility + monetary threshold**. Below the 70 line / below a C grade: numbers render "estimated," high-risk recommendations are blocked, the slice is excluded from model training, and the CM2 cap does not apply.

## 15. Using Brain day to day — surfaces over the platform

Every screen here is a **rendering of a platform primitive** (a metric from the registry, a profile from the identity graph, an entry from the Decision Log), and the same data is equally available via the Analytics API and MCP. The screen is one client among several — never "the product."

### 15.1 Home / Command Center
The one screen that answers "are we making high-quality money today, and what should I do?" in seconds: a live revenue + profit strip (realized vs placed shown as two numbers, never blended; CM2/CM3 carry confidence), a revenue-quality panel (prepaid/COD mix, RTO risk, refund/support spikes), the **Top 3 Actions** (each rendering the recommendation contract — §11.4.3 — with Approve/Reject/Edit/Ask-why), the queues, Decision ROI, and integration/tracking health. Never more than three actions; nothing-to-do shows fewer, never padded.

### 15.2 Navigation & per-category analytics
The dynamic, integration-driven sidebar (only connected sources) opens per-category surfaces (Store, P&L, Acquisition/Attribution, Product, Customer/Lifecycle, Logistics/RTO, Inventory, Finance) with standard filters and **drill-to-source on every metric**. Combined views resolve cross-platform double-counting against the realized-revenue ledger.

### 15.3 Executive lenses (not roles)
CEO/CMO/COO/CFO/CTO **views** — selectable lenses within the four roles — each computed from the same trusted dataset, so the CMO's "revenue" and the CFO's "revenue" reconcile by construction.

### 15.4 Global search
A global search surface to find a customer, order, connector, metric, or past decision. Results are brand-scoped and PII-minimized per role.

### 15.5 Settings
A single Settings information architecture enumerating every configurable object and its owning role: brand profile (currency/timezone/revenue definition), cost setup, goals, attribution model, consent text, notification preferences, quiet hours, team & roles, billing & tax profile, MCP/tracking keys, and data export.

### 15.6 The reporting rhythm
- **Morning Brief** — §11.4.2 (email is the primary channel; WhatsApp is a Scheduled Delivery Channel — §15.8 — not a real-time alert channel).
- **Evening Pulse** — are we on pace; what broke; which queue before day-end.
- **Weekly Review** — revenue/CM2/CM3 vs plan; channel efficiency by attribution model; a Decision Log summary with 7-day outcome accuracy (marked "pending" until the window closes).
- **Month-End Compound Report** — "what did Brain learn about this brand this month?" — every claim tied to closed-loop 7/30-day outcomes.
- **Sale / Event Mode** — hourly revenue + CM2 pace, with the defining alert: **CM2 falling below the event threshold even while revenue rises.**

### 15.7 The AI assistant & MCP
NLQ and read-only MCP as defined in Pillar 5 (§11.4.1, §11.4.7).

### 15.8 Notifications & preferences
Three tiers — **Critical (act now)**, **Important (act today)**, **Informational (be aware)** — routed by role/brand. A **notification-preference center** manages per-channel toggles, per-tier overrides, immediate-vs-digest, and quiet hours (critical may override quiet hours; nothing below it may).
**Real-time alert channels (Phase 1):** in-product, **email (the primary alert channel)**, and mobile-web/push.
**WhatsApp is a Scheduled Delivery Channel, not a real-time alert channel (Phase 1).** It carries scheduled, batched deliveries — the Morning Brief, a Daily Summary, a Weekly Summary, and future digests (e.g. an AI Insight Digest or Executive Summary) — but never real-time alerts, because of BSP dependencies, template approval, delivery unpredictability, and operational burden. (This keeps the alert path off any messaging-vendor dependency and lets WhatsApp's delivery scope grow over time without re-writing the requirement.)
Noise control groups related issues and, when alerting too often on a theme, proposes a rule instead of continuing to interrupt.

### 15.9 The Brand Readiness Score
A defined, sub-scored checklist (sources connected, pixel installed and healthy, cost data toward Trusted, identity match rate, consent configured) with weights, where each sub-score links to the action that raises it and gates which honesty-dependent features are active. It is a to-do list, not a verdict.

### 15.10 Self-serve data export
Three distinct export paths: **report export** (a single report/view, with async handling for large exports, format and PII rules per role), **full-brand export** (raw + normalized + Decision Log in open formats — also the offboarding export), and **DSAR export** (a data-subject access/portability export for compliance). Who can trigger each, where it lands, and rate limits are stated per path.

## 16. What Brain costs — pricing, metering & billing

Brain is sold as a revenue/profit centre, not a software seat. This flows in the order a finance owner experiences it.

### 16.1 The pricing principle
A percentage of **realized GMV under management**, by tier — **Launch ~1.0% / Growth ~0.75% / Scale ~0.5% / Enterprise** custom — with two guardrails: a **minimum monthly fee** (cost-to-serve floor) and a **CM2 affordability cap** (the fee never eats a disproportionate share of contribution margin). **No per-seat pricing.**

### 16.2 The activation period
A time-boxed window aligned with Day 0–14 onboarding **before** the first GMV-based invoice, so cost setup and data quality reach the accuracy bar first. **Day 14 is a minimum gate, not a calendar default** — it extends per contract when data-quality grade or backfill depth has not cleared the bar (e.g. a 24-month backfill across rate-limited APIs, or a COD brand whose first cohort has not yet realized). Realized GMV during activation is not retroactively billed.

### 16.3 The meter, the cap & the cost-confidence gate
The billable base is **realized/delivered GMV** (finalized rows only — §10.3), converted at the **realization-date FX** (frozen once the period closes). Later refunds/RTO/chargebacks post as **adjustments in the period they happen** — a closed/invoiced period is never edited. Fee = **max(min(tier% × realized GMV, cap% × CM2), minimum fee)**, where the cap applies **only when cost data is Trusted** — otherwise Brain bills the full tier%×GMV and records a **flagged true-up** to reconcile once costs reach Trusted (so a brand can't shrink its bill by withholding cost data, and Brain never bills against a margin it can't stand behind). A heavy-refund month where net realized GMV is ~zero still pays the minimum fee.

### 16.4 The inspectable bill, invoicing, collection & disputes
Before any invoice issues, the brand inspects the full computation, drilling into the **same** numbers their dashboards show (GMV → realized-revenue ledger, FX basis, tier math, cap with a cost-confidence badge, floor, adjustments). Invoicing is region-compliant (India GST, UAE VAT, KSA ZATCA Arabic+English). On non-payment the subscription **degrades to read-only** but keeps full read + export — **Brain never deletes a delinquent brand's data as a collection tactic**. A billing dispute is a **data dispute** resolved against the immutable snapshot + ledger; a confirmed data-quality failure means the bill is **corrected, not defended** (via a credit note, never an in-place edit). **Billing actions are Owner-only**; a delinquent-and-Owner-gone brand recovers via the support-mediated break-glass path.

### 16.5 Value proof
Every paying brand continuously sees the return next to the charge: attributed placed and realized revenue, recovered/protected revenue and CM2, the fee, and the recovered-revenue/fee and CM2-recovered/fee ratios. **Early-life honesty:** months 1–2 ratios are contextualized as "still compounding" (the ratio is below target by design while recovered CM2 accrues) so a finance owner does not churn on a month-1 number.

## 17. Acting on the data — lifecycle, support & safe automation (later phases)

Everything here is **later-phase**, specified now so requirements are stable and the data foundation is built to support it. **Lifecycle & AI support = Phase 3; autonomous execution = Phase 4.** One rule above all: **recommend-only is the default forever** — autonomy is something the Owner deliberately turns on, narrowly, with caps.

### 17.1 Lifecycle as a revenue engine (Phase 3)
**One audience + decision layer** above all channels: a segment is defined once (channel-agnostic) and every channel consumes it; Brain recommends a channel mix ranked by expected realized CM2. **Margin-gating is a hard rule:** never recommend a discount or paid send where expected CM2 is negative after message + offer + expected RTO/refund cost; the offer ladder starts no-discount-first. WhatsApp sends are consent-aware (no template to a non-consented number), template-approved, frequency-capped, with utility-vs-marketing cost tracking. **WhatsApp commerce** (catalog → cart → pay-in-chat orders) is treated as a distinct order source flowing to the realized ledger and a lifecycle contribution row.

### 17.2 AI ticket management as revenue protection (Phase 3)
Support tickets are commerce events (a delivery-delay ticket is an RTO about to happen; a refund request is margin about to leak). Classify → enrich (order history, RFM, LTV, shipment status, policy eligibility, suggested resolution with its CM2 impact) → auto-resolve if low-risk and high-confidence, draft if medium, escalate if high-risk → log. A refund above cap is never auto-resolved even at high confidence; a human request stops automation immediately.

### 17.3 Agents & safe autonomous execution (Phase 4)
Agents recommend unless an action is inside an Owner-enabled auto-execute class. **Guardrails are conjunctive** (confidence ≥ class threshold; caps not exceeded; freshness, consent, and policy checks pass; reversible-or-explicitly-approved; permission granted) — fail any one → fall back to recommend-only. **Auto-revert** pulls a class back to recommend-only if its reversal/error rate crosses threshold. **The 60-second kill switch** stops all autonomy (org-wide for the Owner, brand-level for a Brand Admin); pausing never stops analytics or recommendations. **The platform default is, and remains, recommend-only — forever.**

---

# Part D — Cross-Cutting Foundations

## 18. Trust — privacy, consent, compliance, security & reliability

Brain runs a brand's most sensitive asset — its customers, money, and decisions — so trust is the product. The headline: **a brand's data is its own, and one brand can never see, reach, or affect another's.**

### 18.1 Brand owns its data; isolation is absolute
Every brand gets its own isolated lakehouse and workspace; isolation is **structural, not a setting** — enforced in the database kernel (row-level security + a tenant context on every read/write), at a network boundary around the lakehouse, with per-brand object-storage prefixes and per-brand encryption keys; the tenant key travels on every row, event, cache key, and log line. This **agency-safety guarantee** is what makes Brain usable for agencies. A cross-brand leak is always a **P0** → breach workflow. Isolation negative-tests run in CI **at every layer including the serving engine and MCP path** (a forgotten filter returns nothing, not another brand's data).

### 18.2 Compliance posture
Brain acts as a **processor** for the brand (the brand is the controller). Built around **India DPDP 2023 + Rules 2025** (Consent-Manager compatible ~Nov 2026), **India TCCCPR/DLT** (registered senders/templates, NCPR/DND scrubbing, 9am–9pm window), **UAE PDPL**, and **KSA PDPL**. Where a brand configures something that would breach a rule, Brain blocks/flags rather than quietly complying against the law; Brain ships a DPA and a current sub-processor list.

### 18.3 Consent
**Collection consent at capture** (four categories) and **communication consent at send** (each channel its own opt-in), plus the **AI-processing flag** respected by every AI surface. **Withdrawal is retroactive within the propagation window** (§7.4.6): the customer is suppressed from all outreach and pending sends immediately and kept suppressed, a deletion signal is sent for already-passed-back conversions, and every suppression is logged with its consent state. Outreach to a non-consented/withdrawn customer must be impossible by construction.

### 18.4 What Brain stores / must never store
**Stores** (PII-minimized, identifiers hashed by default): orders, products & costs, ad metrics, first-party events, logistics (pincode/city-level), payment metadata, support tickets. **Must never store:** card numbers, CVVs, raw bank details, full UPI secrets, national IDs, special-category data, plaintext passwords, full addresses by default, **PII in logs ever.** Lawful plain contact PII lives in an **encrypted vault only the send service can read.**

### 18.5 Residency, audit, offboarding & retention
**Indian customer data stored in-region by default** (every brand); GCC per local rules; every cross-border path is on the sub-processor registry under the DPA. An **append-only, tamper-evident audit log** records every sensitive action (incl. AI/MCP queries, auto-execute toggles, exports, deletions). **No hostage data:** offboarding exports raw + normalized + Decision Log in open formats, then deletes after a default 90-day window (certified, logged). Retention is stated per data class; a **DPDP/PDPL erasure request overrides retention** for that person via Brain-ID pseudonymization (the person is forgotten; the math still reconciles).

### 18.6 Security, reliability & honest behaviour under bad data
MFA from day one; SSO for enterprise; immediate revocation; KMS-backed secrets never in logs; internal staff access is PII-minimized, consent-gated, time-boxed, and audited (never silent impersonation). Availability targets (Phase 1): **ingestion endpoint 99.95%** (scoped — §7.5), **product surfaces 99.9%**; RPO ≤15 min, RTO ≤4h → ≤1h with maturity; **no committed brand data is ever permanently lost**; maintenance avoids peak commerce windows; a measured public status surface with proactive incident comms. The three defaults under bad data: **show the data you trust, label the data you don't, never let automation run on a foundation Brain doesn't believe in.**

## 19. Cross-cutting product standards (states, accessibility, internationalization)

These standards are inherited by **every** feature and story, so they are stated once here rather than repeated.

### 19.1 Standard states
Every surface defines its **loading** (skeleton, never a frozen blank), **empty** (guided, drives the next action), **error** (network/500/timeout, with a retry path), **permission-denied** (clear, not a dead end), and **offline/stale** (last-known-good, labeled) states. The data-honesty states (Estimated, provisional/settling/finalized, "collecting your data") layer on top of these.

### 19.2 Accessibility
**WCAG 2.2 AA** is a commitment and a CI gate. A specific load-bearing rule: **status is never colour-only** — RAG goals, the seven connector health states, and confidence bands must each carry a non-colour indicator (icon/label/text), because colour-blind operators take financial actions on these.

### 19.3 Internationalization & localization
The data layer is already locale-aware (currency, timezone, per-SKU tax, FX, GST/VAT invoicing, 9am–9pm windows). The **UI layer** commits to locale-aware number/date/currency formatting and, for GCC, **Arabic language support and RTL layout** (KSA invoices are already Arabic+English). If Arabic UI is phased, the phase is stated explicitly rather than left as a silent gap.

### 19.4 Mobile-web
Native iOS/Android apps are out of scope; **mobile-responsive web is a primary surface.** The Home/brief/approve-reject flow is mobile-first; heavy analytical surfaces may be desktop-first, stated per surface; push/PWA delivers time-sensitive alerts.

### 19.5 Bulk actions & undo
Queues support multi-select/bulk triage (bulk-invite, bulk-approve/reject) where stated; domain-specific undo (identity unmerge, action reversal) is first-class; a generic undo applies where stated. Silent truncation is never acceptable — if a list/queue is capped, it says so.

## 20. Positioning & competitive wedge

Brain's wedge versus the field is real but must be stated unmistakably, because the docs otherwise read as feature parity. No competitor combines all five of these:
1. **Realized-revenue CM2 as the headline number** (not ROAS, not placed revenue) — *"we bill on money that hit the bank, and so do our numbers."*
2. **Realized-time attribution with proportional clawback** keyed to India's COD/RTO reality — credit moves as reality moves (Triple Whale's "Total Impact" credits at conversion with **no** clawback).
3. **Honest-when-degraded confidence** — the 70 line, `min(cost, attribution)`, and the always-visible unattributed bucket (more honest than Northbeam's calibration framing or any tool's silent precision).
4. **Brand-owned open lakehouse** — Iceberg, no lock-in, with a self-serve data-out path (vs Triple Whale's closed ecosystem).
5. **%-of-realized-GMV pricing with a CM2 cap** that aligns Brain's incentive with the brand's actual profit.

**Conscious scope lines (stated, not silent):**
- **Not a generic CDP** — Brain collects first-party data for honest measurement and decisions; it does **not** do reverse-ETL to arbitrary destinations (vs Segment/RudderStack). It must, however, match the CDP table-stakes it claims: durable collection, identity resolution, consent governance, and a **tracking-plan/event-governance surface** (§8.4.10).
- **No product/UX surveys, session replay, heatmaps, or feature flags** (PostHog's lane) — off-mission and, for session replay, in conflict with the consent-first posture. **Exception, in scope: the post-purchase attribution survey** ("how did you hear about us") is first-class **zero-party attribution data** — a self-reported touchpoint and a triangulation input (platform-reported vs Brain-attributed vs self-reported; doc 08 §35), distinct from product surveys. **Autocapture** is borrowed as a Phase-2 install-hardening fallback (§7.8); **experiments/holdouts** are borrowed for incrementality (§10.11).
- **Predictions stay internal to recommendations in v1** — the lakehouse is a prediction substrate (RTO-likelihood is model #1), but Brain is not an audience-optimization product (Black Crow's lane) yet (§11.8).
- **Creative analytics** (Triple Whale's Creative Cockpit) is a named Phase-2 surface, not a silent gap.
- **CAPI passback** (Triple Whale Sonar) is a named, consent-gated, output-only feature (§7.4.10), and Brain provides a **"why Brain's number is lower than Meta's (and why it's the honest one)"** reconciliation view.

---

# Part E — Governance

## 21. KPIs & success metrics

**Platform health (lead with these — they prove the platforms, not the screens):** events captured & ingestion-endpoint availability; identity match rate; attribution reconciliation rate (attributed vs realized); % of decisions logged (target 100% of Brain actions); recovered-CM2 / fee ratio.
**Customer value:** realized revenue recovered (up MoM); recovered/protected CM2 (up MoM); recovered-revenue/fee ratio (>3× by month 3, >5× by month 6 for mature customers); RTO-cost reduction; COD→prepaid lift; wasted-ad-spend reduction; refund-save rate.
**Product engagement (secondary):** Morning Brief open rate >80%; recommendation approval 40–70%; outcome-measurement coverage >90% of eligible recommendations; auto-execute reversal rate <8% (alert at 15%); healthy connectors >99%.
**Business:** GMV under management, net revenue, gross margin, churn (low among activated brands), expansion, support cost per brand. Brain dogfoods its own pixel and pipeline to measure these.

## 22. Roadmap & phasing

One conviction: **build the platforms and the lakehouse first, show honest analysis on them, and only then layer prediction and autonomy.**
- **Phase 1 — Foundation & Lakehouse (largest):** access/onboarding/roles; the Integration Marketplace + launch connectors + the tracking-plan surface; the first-party collection platform (durable collector, consent, sessionization, bot filtering, event-quality monitoring, CAPI passback); deterministic identity + Customer 360 + identity confidence; real-time ingestion → normalization → the per-brand lakehouse; the metric registry + Analytics API + parity oracle; basic analytics + basic CM2 + rule-based attribution; NLQ (descriptive/diagnostic) with the resolution eval gate; a read-only MCP server; billing/metering; the governance machinery (freshness SLOs, seven health states, DQ grades + the gating table, cost-confidence, FX, attribution governance, the Decision Log schema, the Brand Readiness Score, the recommendation contract); the channel-contribution contract reserved & rule-based-populated (no MMM engine); the **holdout/exposure schema reserved** (capture begins in Phase 2, not here).
- **Phase 2 — Honest profit & attribution intelligence:** the full CM waterfall + True CM2 with complete cost setup; the acquisition module; executive lenses; RTO/COD/pincode intelligence; RFM; probabilistic identity; autocapture fallback; creative analytics; **holdout/exposure evidence capture** (exposure groups, holdout groups, experiment & test metadata — capture only, no engine); the full Decision Log experience (briefs, Weekly Review, Month-End Compound Report).
- **Phase 3 — Predictions & lifecycle/support engines + data-driven attribution:** MTA + MMM + incrementality/holdouts **analyzing the Phase-2 evidence** (unlocks `Calibrated`); the first prediction layer; the Shared Audience Builder; WhatsApp lifecycle; AI ticket management.
- **Phase 4 — Agentic execution:** Owner-configured auto-execute; low-risk classes; the 60-second kill switch; reversal workflows; auto-revert.
- **Phase 5 — Scale, Enterprise & Retail:** portfolio rollups; enterprise data controls + residency options; the custom-integration framework; privacy-thresholded cross-brand benchmarking; mature GCC coverage; retail-aware extensions.

**Fixed sacrifice order under scope pressure:** defer NLQ first, narrow dashboards second; **never trade the lakehouse, the collection platform, the semantic layer, or isolation. Nothing in a later phase may become a dependency of an earlier one — explicitly including MMM.**

## 23. Assumptions, dependencies & open decisions

### 23.1 Assumptions (hedged where load-bearing)
- The brand runs real monthly volume; the **₹50L floor is advisory** (the value-proof and cost-to-serve economics work above it), not a hard gate — below it, honesty-gated features may stay inactive until data matures.
- The brand will share cost data; if it cannot reach Trusted, margins render Estimated, recommendations degrade gracefully, and the cap does not apply (an adversarial dynamic mitigated by the cost-data assistance path, §14.4).
- **Phase-1 deterministic-only identity may cap match rate** in a COD/phone-only market, which can hold attribution confidence below the 70 line for some brands — recommendations degrade gracefully rather than fail. Launch brands should target a stated minimum match rate.
- The **99.95% ingestion SLO is scoped to Brain's collector endpoint**, not end-to-end capture (which depends on the brand's storefront/CDN/customer browser; the pixel buffer mitigates but cannot guarantee it).
- **Cold-start realization horizons** use a category-benchmark P80 until the brand's own Fingerprint matures; billing only *finalizes* at the horizon, so an early guess self-corrects.
- The customer accepts that **realized** revenue is the fairest basis for both decisions and billing; a human stays accountable for decisions; consent is collected at capture.

### 23.2 Dependencies (each monitored; failure made visible)
Provider APIs (commerce/ads/payments/logistics/support/CRM); messaging-channel approval (WhatsApp/Meta BSP & template approval — with **email as the primary delivery and alert channel** so launch is never gated on WhatsApp); accuracy of brand-supplied cost data; regional regulatory regimes; and the brand's own operational follow-through (Brain tracks ignored recommendations and the cost of inaction).

### 23.3 Open decisions (need sign-off; none block requirements)
- **Commercial:** exact GMV % + minimum fee + CM2 cap % per tier/region; whether an expired cost-confidence true-up still credits (default: no); zero/negative-GMV-month treatment (default: min fee stands); min fee during a pause; the global FX default source/cadence.
- **Legal/tax:** the India SAC code for Brain's fee + e-invoicing/IRN threshold; KSA ZATCA Phase-2 scope; confirmation that aggregate reproducibility suffices after a data-subject erasure; date-effective GST slab versioning and ITC treatment of return-leg freight (§10.4 implies both).
- **Attribution/product:** the realization-horizon defaults (≈25d COD / 7d prepaid; Fingerprint-derived); the post-finalization clawback age limit; confirming "Calibrated" as the top-band name; MMM timing (lightweight marketplace-only MMM at Phase 1.5 vs full MMM Phase 3 — never a Phase-1 dependency).

### 23.4 Frozen founder decisions (2026-06-14, from the expert-review-board challenge)
Three decisions raised by the challenge board were resolved by the founder and are now frozen and reflected throughout this document:
1. **Holdout/incrementality — capture in Phase 2, analyze in Phase 3 (APPROVED).** The schema is reserved in Phase 1; **evidence capture** (exposure groups, holdout groups, experiment & test metadata) moves to **Phase 2** (capture only — no MMM/incrementality/calibration engine); the engines that **analyze** that evidence stay in **Phase 3**. Rationale: the risk is not building incrementality early, it is arriving at Phase 3 with no historical holdout data — capturing in Phase 2 means calibration is meaningful from the start of Phase 3 (§10.11, §22).
2. **View-through excluded from attribution in Phase 1 (STRONGLY APPROVED).** View-through is **not** credited; it lives in the **unattributed bucket** with an explicit disclosure ("Potential view-through impact: ₹X — not included in attribution"). This is the deliberate choice of *observed* over *claimed* attribution, central to Brain's positioning; it may be incorporated properly once MMM/holdouts/calibration exist (§10.5.5, §10.8).
3. **WhatsApp is a Scheduled Delivery Channel, not a real-time alert channel, in Phase 1 (APPROVED, wording modified).** WhatsApp is positioned as a **Scheduled Delivery Channel** — it supports scheduled, batched deliveries (Morning Brief, Daily Summary, Weekly Summary, and future digests), **not** real-time alerts (BSP dependencies, template approval, delivery unpredictability, operational burden). **Email is the primary alert channel in Phase 1.** (Deliberately *not* worded "WhatsApp = Morning Brief only," so the delivery scope can grow without re-writing the requirement — §15.8.)

## 24. Glossary

**Four Foundational Platforms** — first-party data collection (the Pixel) **+ third-party integrations (Connectors)**, customer identity, measurement & attribution, AI decision intelligence; together with the **Data Lakehouse** these are the **Brand-Owned Data Foundation** — Brain's primary asset. Value chain: **Pixel + Integrations + Identity → Lakehouse → Customer 360 · Journey · Attribution · Measurement → Decision Engine → Recommendations → Outcomes → Learning**; the dashboards/reports/briefs are *outputs*, not the product. **Data Lakehouse** — the complete, isolated per-brand store of raw + normalized data every surface and MCP read from. **Realized / Delivered GMV** — order value surviving cancellation, payment failure, RTO, and refund; the billing base (finalized rows only). **Provisional / Settling / Finalized** — the three recognition labels; provisional at delivery, finalized at the realization horizon/settlement. **CM1 / CM2 / CM3** — contribution margin after non-marketing variable costs / after marketing / after allocated fixed costs. **True CM2** — realized-only CM2 after the incremental RTO penalty + provisions (no double-count). **Attribution clawback** — reversal of attribution credit when RTO/refund reverses the realized-revenue ledger, across the same touches and weights. **Channel Contribution** — methodology-agnostic per-channel *contribution* (not credit), as a range + method + confidence; the single source of truth for channel impact; never summed with journey credit. **Harvested vs created demand** — branded-search/direct/organic that captured existing intent vs demand a channel generated; Phase-1 haircut + confidence penalty. **Calibrated** — the top attribution-confidence band (Phase 3+), earned only by validation against incrementality/MMM. **CAPI Passback** — output-only conversion send to ad platforms to improve the brand's own delivery; never an attribution input. **Brain ID** — the persistent, brand-scoped, never-global customer identifier. **Identity confidence/completeness** — per-profile scores derived from link tier/count/recency. **MER / aMER** — net revenue / total marketing spend; new-customer revenue / acquisition spend. **New customer** — first *finalized* realized order; merge- and clawback-reactive. **RTO / NDR** — Return to Origin / Non-Delivery Report. **COD** — Cash on Delivery. **Decision Log** — the immutable record of recommendations, actions, approvals, reversals, and outcomes — the compounding memory. **Brand Fingerprint** — the brand's learned operating patterns. **Cost-confidence** — Trusted/Estimated/Insufficient score on cost data. **Data-quality grade** — A+→D across completeness/freshness/accuracy/consistency/identity-match; gates behaviour via the gating table. **Tracking plan** — the brand's governed expected-event taxonomy. **Parity oracle** — the continuous check that every surface computes the identical finalized number. **DPDP / TCCCPR / DLT / PDPL** — India's data-protection act / commercial-communications rules / A2P SMS-voice registration ledger / UAE & KSA data-protection laws. **MCP** — the read-only, tool-based interface exposing a brand's lakehouse to external LLMs and Brain's own AI.

---

*End of Business Requirements Document. Companion documents: `02_Brain_Product_Functional_Specification.md`, `03_Brain_Technology_Stack_and_Technical_Decisions.md`.*
