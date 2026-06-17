# Research — First-Party Pixel Benchmark vs Triple Whale / Northbeam

> Deep-research output (adversarially verified, cited). Benchmarks Brain's Phase-1
> data-collection foundation against the leading DTC measurement platforms to confirm
> we're building it correctly and surface gaps. Date: 2026-06-18.
> Companion to the authoritative spec in this folder (see `00-executive-summary.md`).

## Verdict

**Brain's Phase-1 collection foundation is architecturally validated** against how Triple
Whale and Northbeam actually work. The gaps are **NOT in the collection plumbing** — they
are in the three layers *above* it (probabilistic identity, cross-platform dedup / platform
"deterministic views" feeds, and the insights/measurement surface). The moat — and the
revenue — is the **calibrated measurement + insight UX**, not the pixel itself.

## 1. Architecture & server-side collection — VALIDATED ✅

- **Shopify Web Pixel = strict web-worker sandbox, NO DOM, `fetch`+CORS, subscribe to the
  customer-events API.** Brain's `brain.js` one-event-per-POST over `fetch` is the *only*
  compliant shape (confirms ADR-1). [shopify.dev/docs/apps/build/marketing-analytics/pixels]
- **Dual client+server collection is the validated pattern** — server-side events recover
  the ~30–40% of signal lost to ad-blockers, consent defaults, and iOS/Safari (ITP/ATT).
  Meta's own guidance is Pixel + CAPI in parallel. Brain's accept-before-validate collector
  is exactly this.
- **Meta client/server dedup = the SAME `event_id` + `event_name` across browser Pixel and
  CAPI** (~48h matching window). Brain mints+reuses `event_id` → compliant.
  [developers.facebook.com/.../conversions-api/deduplicate-pixel-and-server-events]
- **First-party endpoint: incumbents use an A-record (DNS), not a CNAME.** ⚠️ Minor
  correction to the Phase-1 plan (Track B says "per-tenant CNAME"). [docs.northbeam.io/docs/link-dns]

## 2. Identity & attribution

- Deterministic identity + click-id capture (fbclid/gclid/ttclid) + Bronze-as-truth +
  append-only ledger map directly onto TW (ID Graph / Triple Pixel) and Northbeam
  (Clicks + Deterministic Views). ✅
- **CRITICAL GAP — `event_id` dedup does NOT generalize across ad platforms.** It works on
  Meta only; TW's *Sonar* intercepts the `fbq` queue to extract Meta's `eventID` before the
  Pixel fires, then reuses it server-side. TikTok / Google / Snap / Pinterest obfuscate
  their IDs → cross-platform reconciliation needs **per-platform integrations** (ties into
  the ad-connectors work).
- **Probabilistic identity layer is missing** — needed to complement deterministic matching
  where logged-out / cookieless coverage degrades.

## 3. Insights & value (the moat — what brands pay for)

- TW **Total Impact** + **Compass** (AI insights); Northbeam **Clicks + Deterministic Views**
  (view-through attribution connecting ad *views* and clicks across platforms to real
  revenue); blended ROAS, new-vs-returning, LTV/CAC, creative/cohort analytics, real-time
  dashboards. [triplewhale.com/blog/total-impact · triplewhale.com/compass · docs.northbeam.io/docs/clicks-deterministic-views]
- **The differentiation is calibrated / view-through measurement + the insight UX**, not the
  collection layer. Pixel/touch attribution is *correlation*; incumbents calibrate toward
  incrementality.

## 4. Setup / Verification / Health UX

- 1-click Shopify app install; **live event verification with a match-rate % (~85%)** (TW
  Pixel Events Manager); Northbeam implementation + troubleshooting guides; **data-quality /
  coverage scoring**. [kb.triplewhale.com/.../pixel-events-manager · docs.northbeam.io/docs/what-to-expect-during-implementation]
- Brain's Phase-1 Tracking Center (live "first event received" + tracking health + event
  explorer) is the right direction. **The add to match them: a match-rate / coverage score**,
  not just "events flowing."

## 5. Table-stakes vs moat

- **Table-stakes:** server-side collection, Web-Pixel-compliant SDK, Meta CAPI dedup,
  click-id capture, honest health/verification UX.
- **Moat:** cross-platform view-through + calibrated/incrementality-aware measurement, the
  insight surface (AI insights, blended ROAS), and effortless install + coverage scoring.

## Gap analysis — prioritized for Brain

1. **Tracking Center: add a match-rate / coverage score** (Phase 1+ UX) — table-stakes for credibility.
2. **First-party endpoint → A-record** (not CNAME) — minor Track-B/architect correction.
3. **Per-platform conversion-feedback + cross-platform dedup** (Meta CAPI, Google Enhanced
   Conversions) — the ad-connectors phase; `event_id` dedup alone won't generalize.
4. **Probabilistic identity layer** — complement deterministic for cookieless coverage (later phase).
5. **The measurement/insight surface** (view-through, blended ROAS, incrementality,
   AI insights) — the moat; the Decision-Intelligence phases.

## Honesty check — claims the adversarial verifier REFUTED

- ❌ "Triple Pixel performs full multi-touch attribution across the entire journey" — refuted (1-2).
- ❌ "Northbeam is purely deterministic, not statistical/probabilistic" — refuted (0-3); its
  model connects ad *views* + clicks, i.e. it models, not just proves.
- Implication: **don't over-claim** in Brain's own positioning — incumbents *calibrate*, they
  don't have perfect deterministic truth.

## Key sources (primary)

- Shopify Web Pixels API + privacy: shopify.dev/docs/apps/build/marketing-analytics/pixels
- Meta CAPI dedup: developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events
- Triple Pixel / Events Manager / Sonar dedup: kb.triplewhale.com
- Northbeam data sources / Clicks + Deterministic Views / link-dns: docs.northbeam.io
- Northbeam view-through model launch: businesswire.com (2025-10-07)
- Safari ITP: stape.io/blog/safari-itp

*(Two research angles in the original run were rate-limited and recovered via a resume; the
report above is the completed 6-angle synthesis.)*
