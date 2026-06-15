# HLD — Brain high-level design (Phase 1 as-built)

> Phase-1 scope only (M0–M5, single-region India `ap-south-1`, recommend-only AI). Organized by
> **bounded context**, never by technical layer. Sources: doc 04 §2–§17 (esp. §4 contexts, §5
> deployables, §6 events, §7 data, §12 isolation), doc 06 (API conventions), doc 10 (build order).
> This is the system-wide HLD; **no per-context LLD files** are written here. Money = integer minor
> units (`*_minor BIGINT`) + `currency_code CHAR(3)` ∈ {INR, AED, SAR}. Tenant key = `brand_id`.

## High-level design

### System context

Brain is **four foundational platforms delivered as one product on one open data plane**: (1) the
First-Party Data Collection Platform (Collector + Brain Pixel), (2) the Customer Identity Platform
(brand-scoped Brain ID graph), (3) the Measurement & Attribution Platform (lakehouse + metric
engine), and (4) the AI Decision Intelligence Platform (LiteLLM gateway, NLQ, Morning Brief,
recommendations, Decision Log, read-only MCP). Dashboards/reports/AI insights are **outputs** of these
platforms, rendered exclusively through the Analytics API.

**External actors / systems:**
- **DTC brand users** (Owner / Brand Admin / Manager / Analyst) — via the Next.js web app → `frontend-api` BFF.
- **The brand's own LLM / MCP clients** — read-only MCP (never invoke a Brain-side model).
- **Source systems (connectors)** — Shopify, Meta, Google Ads, Razorpay-with-settlement (Phase-1a deep); WooCommerce, Shiprocket/Delhivery, Klaviyo, GA4, HubSpot (1b/1c). 100+ catalogue ships as marketing stubs.
- **The Brain Pixel** (`brain.js`) — first-party-domain pixel + server-side first-party cookie setter on the per-tenant CNAME.
- **Model providers** — Claude / GPT / Gemini via LiteLLM (declared sub-processors, pinned region).
- **Outbound channels (Phase 1)** — email (primary alerts), PWA push, in-product; WhatsApp BSP/CAPI deferred to Phase 3 (chokepoint built now).

**The one boundary that governs everything:**
`First-party + connected events → Iceberg (SoR) → dbt → StarRocks (serving) → Analytics API → Brain AI / Dashboards / Morning Brief / MCP`, with **Brain ID + the Identity Graph as a first-class platform service beside it.** The protecting rule: `Iceberg → dbt → StarRocks → Analytics API`, **never** `StarRocks → Iceberg`; every consumer reads **only** through the Analytics API.

### Deployables (3 + web + jobs — deliberately not 8)

| Deployable | Role | Notes |
|---|---|---|
| **collector** (Fastify + durable spool → Redpanda) | Accept → durable spool (disk WAL) → **ack** → produce to Redpanda live/backfill lane. No edge validation. | Distinct 99.95% accept+ack SLA; stateless + local WAL; `apps/collector` (intake/spool/drainer/envelope/health). |
| **stream-worker** (TS/KafkaJS consumers) | validate (Apicurio) → dedup `(brand_id,event_id)` → enrich → **async identity resolution** → sessionize → bot-filter → quality-score → write Silver; feed identity writer. | Separate live vs backfill consumer groups; `apps/stream-worker`. |
| **core** (Fastify modular monolith, 13 DDD modules) | control-plane API + **Analytics API (sole DB read path)** + metric engine (in-process lib) + the 13 bounded-context modules + MCP server + NLQ orchestrator. | One team, one language, one Postgres; `apps/core/src/modules/*`. |
| **web** (Next.js) | dashboards / Home / Decision Log / NLQ / settings — via the `frontend-api` BFF only. | `apps/web`; responsive + PWA push; no native app. |
| **Argo jobs** | dbt builds, Bronze→StarRocks loads, the hourly runtime parity-convergence monitor, backfill orchestration, lakehouse compaction/snapshot-expiry, retention/erasure (crypto-shred) jobs. | Off-peak; `job-orchestration` module coordinates, owns no business logic. |

### Bounded contexts (13 Phase-1 core modules)

Each owns its data and invariants; cross-context communication is by **events (async)** or the
**Analytics API (read)** — never a direct table read into another context's store. In Phase 1 most
are modules inside the core monolith (DDD module per context, import-lint enforced) with clean
contracts for later extraction. Repo: `apps/core/src/modules/*`.

| Module (bounded context) | Owns | Key invariants |
|---|---|---|
| **workspace-access** | orgs, brands, users, roles, permissions, sessions, invites, **the hash-chained audit log** | exactly one Owner; absolute brand isolation; immediate revocation; append-only audit |
| **connector** | connector lifecycle, OAuth/credentials, sync cursors, backfill, health states, freshness, **settlement reconciliation**, tracking-plan surface | honest status; idempotent sync; same code path live & backfill; settlement before realization |
| **identity** | Brain ID, `brain_id_alias`, merge/unmerge, phone guard, review queue, profile confidence, PII vault | brand-scoped never global; false-merge-worse-than-missed; reversible; history never rewritten |
| **measurement** | the metric registry, the deterministic metric engine, the revenue ladder, CM waterfall, True CM2, FX, cost-confidence | one definition everywhere; all non-additive math in the engine; finalized-only for money |
| **attribution** | journey attribution, the credit ledger, two-pass + clawback, confidence, channel contribution, the unattributed bucket, `silver.touchpoint` (Journey, derived) | realized-only; clawback mirrors credit; closed-sum; never sum journey + contribution |
| **analytics** | the **Analytics API** (sole read path), dashboards/reporting rhythm, Decision Log, Brand Readiness, the recommendation contract | sole read path; same-finalized-number; recommendation eligibility deterministic |
| **billing** | the realized-GMV meter, the CM2 cap, true-ups, the inspectable bill, invoicing, dunning, plan lifecycle | billing reads **finalized rows only**; closed periods immutable; no per-seat |
| **data-quality** | the DQ grade + the metric-gating table; DQ signals | DQ grade gates serving/billing; honest-when-degraded |
| **ai** | LiteLLM gateway integration, NLQ orchestrator, prompt registry, eval/injection gates, MCP server, **AI provenance** | numbers deterministic; model narrates only; untrusted-text delimited; eligibility unwritable |
| **recommendation** | deterministic threshold detectors (CM2 falling, RTO spike, tracking-dark, connector failing) → the recommendation contract | eligibility deterministic; recommend-only (no auto-execute in Phase 1) |
| **notification** | the **single outbound send/consent chokepoint**; notification prefs, send log, suppression list | exactly one egress door; consent + DND + DLT + quiet-hours fail-closed before any channel adapter |
| **frontend-api** | the BFF — httpOnly-cookie ↔ short-token exchange, CSRF, view-model fan-out | a browser token never reaches the metric engine or the revocation denylist; aggregation tier, not a separate contract surface |
| **job-orchestration** | the Argo cron catalog, overlap-locking, backfill orchestration; coordinates + monitors | owns no business logic; commands are internal/REST, not bus facts |

> ASSUMPTION: doc 04 §4 names **nine** bounded contexts (the business-capability grouping), while the
> repo + doc 06 + doc 05 enumerate **thirteen** modules (`workspace-access, connector, identity,
> measurement, attribution, analytics, billing, data-quality, ai, recommendation, notification,
> frontend-api, job-orchestration`). I bound the HLD to the **13-module** decomposition (brownfield
> wins: `apps/core/src/modules/*` has exactly these 13), treating the doc-04 nine as the
> capability-level rollup (e.g. data-quality split out of Measurement per §4 footnote; analytics +
> recommendation + notification = the Analytics & Surfaces capability; frontend-api + job-orchestration
> are the Part F runtime additions M11/M12). Confirm the 13 is the binding count.

### Sync vs async seams

| Interaction | Mechanism | Why (ADR) |
|---|---|---|
| Web → backend | **ONLY** the `frontend-api` BFF (httpOnly cookie → short token → in-proc fan-out) | a browser must not hold a token reaching the metric engine / denylist (ADR-011) |
| Collector → Core, Stream-worker → Core, connector ingestion | **events on Redpanda** (NOT REST) | events-first; the only internal HTTP is health/readiness + the job-orchestration trigger (doc 06 finding 3) |
| Within core (module → module) | **in-process DDD module calls** (import-lint enforced) over shared domain contracts | Phase-1 modular monolith; clean contracts so a module extracts later without rewrite |
| MCP / external tools / the brand's LLM → Core | the **same** `/api/v1` APIs via token/MCP-key; **MCP never invokes a Brain-side model** | numbers stay deterministic; the caller's LLM is the only model (resolves C5) |
| Identity resolution | **async idempotent writer off Bronze** (`identity.resolution.requested`) | never a synchronous RPC on the 99.95% path (resolves C4) |
| State changes between contexts | **facts on Redpanda** (`merge.committed`, `ledger.finalized`, `consent.withdrawn`, …) | event-driven; single-producer ownership (H4); facts are immutable past-tense |
| Commands (intent) | internal/REST calls where possible (`backfill.requested`, `send.requested`); a bus command, if unavoidable, is namespaced `cmd.*` | facts vs commands (M1) |

**Correctness model (H1):** Brain does **not** rely on Redpanda/partition ordering for correctness.
Correctness = `occurred_at` (event-time) + a per-source monotonic `sequence` + **idempotent
last-writer-wins** on state tables + the **append-only ledger's as-of math** (order-tolerant by
construction). Partition keys are brand-prefixed composites per ordering unit (`hash(brand_id,
order_id)` etc.), an optimization to remove hot-spots — **never the isolation mechanism**.

### Data ownership (OLTP vs OLAP split)

- **OLTP — Postgres (control plane, the system of record for transactional state):** workspace/access, RBAC, sessions, the **identity graph** (`brain_id_alias` + PII-vault references), the **metric registry**, the **Decision Log**, the **hash-chained audit ledger**, connector cursors/credentials, consent, goals/cost-setup, billing (`gmv_meter_snapshot` write-once, invoices, true-ups). A context's tables are written only by that context.
- **OLAP — the lakehouse, one-way `Iceberg → dbt → StarRocks → Analytics API`:**
  - **Bronze** (Iceberg on S3 + Glue): raw envelopes exactly as received (+ `bronze_quarantine`), **append-only, no MERGE**, partitioned `(brand_id, event_date)`, per-brand prefix + per-brand data key, **24-month retention, the replay SoR**.
  - **Silver** (StarRocks-native PK tables, dbt-on-StarRocks over Bronze-Iceberg): canonical domains (`customer`, `identity`, `behavior_event` deduped on `(brand_id,event_id)`, `order_state` mutable lifecycle, `product`, `payment`, `marketing_spend`, `shipment`, `inventory`, `support`, `touchpoint`). PK upsert + server-wins.
  - **Gold** (StarRocks marts + append-only ledgers): **`realized_revenue_ledger`** (recognition/reversal event grain; the **dual-date rule** — `economic_effective_at` for as-of math, `billing_posted_period` for the open period a late adjustment posts to), **`attribution_credit_ledger`** (order×touch×channel×model_version×pass; clawback = an append-only reversal mirroring the original split), `order_margin_fact` (CM1→CM2→CM3, True CM2), `channel_contribution` (reserved-nullable MMM-seam columns + `Calibrated` enum), `attribution_confidence_mart`, `gmv_meter_snapshot`.
- **Direction is one-way by rule.** `StarRocks → Iceberg` is forbidden. The Analytics API is the **only** component that reads StarRocks/Iceberg; the **in-process TS metric engine is the only place a number is computed** (`packages/metric-engine`). Journey (`silver.touchpoint`) is a **derived** layer owned by the `attribution` module — never a service, deployable, or store.

> ASSUMPTION: realized-revenue horizon default (**~25d COD / 7d prepaid**) + reconciliation tolerance
> are **TODO-with-owner = Data Engineer** (ratified). These bound the `realized_revenue_ledger`
> finalization horizon, the `restatement_window`, and the parity oracle's termination — not yet
> numerically frozen in this HLD.

### Cross-cutting concerns

- **Tenant isolation — 4 layers on the stores + the real work on the seams.** Stores: **Postgres RLS** (+ per-request tenant context + non-owner DB role) · **per-brand S3 prefix** · **per-brand KMS data keys** · **StarRocks row policies**. The hard part — where leaks actually happen — is the seams (doc 04 §12 names the four highest-risk surfaces): (1) the **identity service** (transient cross-brand plaintext + per-brand salts — a hardened, separately-audited trust zone; cross-brand comparison structurally refused), (2) **stream consumers** (assert `brand_id` on the envelope **before processing** — that is the isolation control, not the partition key), (3) the **AI gateway/cache** (tenant-scoped keys via `tenant-context.brandKey()`, outside RLS), (4) the **Owner rollup** (N isolated brand reads stitched at the presentation layer, never a cross-brand query). `X-Brand-Id` non-null is asserted before any query (a missing tenant context is a hard error, never default-to-all). Isolation tests at every layer incl. StarRocks + MCP are a **P0 CI gate that must pass before any launch**.
- **Idempotency.** Key = **`(brand_id, event_id)`** at every layer (Bronze, Silver, consumers); client `event_id` is untrusted for global uniqueness so dedup is brand-scoped; derived events use deterministic IDs (`ledger_event_id`, `credit_id`). At-least-once + idempotent processing = effectively-once (no Kafka EOS). Every mutating API requires `Idempotency-Key` (cached 24h, replayed). Connector writes are idempotent on the cursor.
- **Traceability.** `X-Correlation-Id` accepted-or-generated, propagated through Redpanda envelopes → OTel spans → logs, echoed in responses; every span/log carries `brand_id` (PII-redacted). The **hash-chained, WORM-anchored Postgres audit ledger is the system of record** (the `audit.action.logged` event is fan-out/observability only). **AI provenance** (model+version, prompt-hash, metric-binding, snapshot pins, PII-redacted) is written to the Decision Log under the same immutability. **No raw PII** in any event payload / Redpanda topic / Bronze table / log stream / replay source (C2 — CI schema-lint + edge redaction + no-PII-in-logs lint).
- **Parity ("same finalized number everywhere").** One in-process TS metric engine; the 3-layer parity oracle (CI golden-fixture test, hourly runtime convergence monitor, decision-path purity assertion); hot/provisional/un-deduped rows are **structurally barred** from billing/decision/attribution endpoints (a typed, column-level policy → `409 NON_FINALIZED_ON_GUARDED_ENDPOINT`, not a query convention); closed-sum assertions with the residual as a computed plug.

> Per-context LLD files are intentionally **not** written here. The contracts that bind each context
> live in `packages/contracts` (Zod-as-source-of-truth → OpenAPI/types, doc 06 §10), the event
> registry (doc 07), and the metric registry (Postgres). This HLD stays high-level by design.
