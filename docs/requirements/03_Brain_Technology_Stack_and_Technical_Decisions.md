# Brain — Technology Stack & Technical Decisions

**Product:** Brain — the AI-native commerce operating system for DTC brands in India, UAE & GCC.
**Document type:** Technology Stack & Technical Decisions — the authoritative record of *what Brain is built on and why*.
**Status:** Final, frozen v1. **Date:** 2026-06-14.
**Companion documents:** `01_Brain_Business_Requirements_Document.md` (what Brain is and how it behaves) and `02_Brain_Product_Functional_Specification.md` (every feature, story-ready).

**How to read this document.** For each technology, this document states **what it does**, **why it was selected**, **the alternatives evaluated and why they were rejected**, and **how it interacts with the other components**. It also describes both the **production architecture** and the **local-development architecture**. Architecture diagrams, database schemas, API contracts, sprint plans, and deployment plans are deliberately **out of scope** — they are derived from this stack and the business requirements. Where a choice maps to a business requirement, the BRD section is cited (e.g. `BRD §7`).

---

## Table of Contents
1. The principles that drove every choice
2. The one architectural boundary
3. Cloud & platform foundation
4. Frontend
5. Authentication & identity provider
6. Backend services
7. The first-party collection path (the strict-SLA tier)
8. Streaming platform (the event backbone)
9. Stream processing
10. Operational database (the control plane)
11. The identity graph (technical decisions)
12. Cache
13. The lakehouse (the single source of truth)
14. Analytics & serving
15. The AI layer
16. Observability, security & CI/CD
17. How the components interact (end-to-end data flow)
18. Phasing — lean now, the heavy lakehouse later
19. Local development architecture
20. Open "accept-knowingly" decisions
21. Resolved technical decisions (from the v1 review)
22. One-line summary

---

## 1. The principles that drove every choice
1. **Bootstrapped & small-team lean.** Prefer managed or single-binary services; avoid fleets to operate. Spend reliability effort only where the business truly needs it.
2. **One language end-to-end (TypeScript).** A small team shares one skill set, one set of types, and code across frontend, backend, and stream processing. The one place this won't reach is heavy ML (§18).
3. **Open formats, no lock-in.** The brand's data lives in an open lakehouse (Apache Iceberg on object storage), so it is portable, exportable, and never trapped — directly serving the "the brand owns its data / no hostage data" promise (`BRD §18.5`, §20).
4. **Honest-when-degraded & isolation-first.** The stack must make brand isolation structural and must label/contain failure, not hide it (`BRD §18.1`).
5. **AWS-native, single region (ap-south-1).** India data residency by default; one cloud to operate (`BRD §18.5`).
6. **Cost-routing discipline.** Cheapest-sufficient effort everywhere (deterministic logic ≫ statistical ≫ small model ≫ frontier model). This is the structural reason a %-of-GMV price survives (`BRD §16`).

## 2. The one architectural boundary
`First-party + connected events → Iceberg (source of truth) → StarRocks (serving) → Analytics API → Brain AI / Dashboards / Morning Brief / MCP`, with **Brain ID + the Identity Graph as a first-class platform service** beside it. Keep that boundary clean and the system supports the first few hundred brands without a redesign. The rule that protects it: **`Iceberg → dbt → StarRocks → Analytics API`, never `StarRocks → Iceberg`**, and **every consumer reads only through the Analytics API** — which is what guarantees "same question, same number" (`BRD §14.6`) and keeps the serving engine swappable.

## 3. Cloud & platform foundation

| Layer | Choice | What it does |
|---|---|---|
| Cloud | **AWS** | Hosts everything; managed versions of every dependency. |
| Region | **ap-south-1 (Mumbai)** | In-region storage for DPDP residency. |
| IaC | **Terraform** | Declarative, reviewable, reproducible infrastructure. |
| Containers | **Docker** | One packaging format from laptop to production. |
| Orchestration | **Kubernetes (EKS)** | One cluster, namespaced by zone; services co-deploy now, split later. |
| GitOps | **ArgoCD** | Declarative, auditable deploys (Git is the source of truth for what runs). |
| Workflow engine | **Argo Workflows** | Scheduled data jobs (transforms, backfills, lakehouse maintenance) on the same K8s. |
| DNS / CDN / WAF | **Route53 / CloudFront / AWS WAF** | Managed edge; a shield in front of the public event collector. |
| Secrets / Encryption | **AWS Secrets Manager / KMS** | KMS-backed secrets never in code/logs; **per-brand KMS keys** make isolation cryptographic. |
| Registry | **ECR** | Container images next to the cluster. |

**Why selected:** one mature cloud with managed everything keeps a small team out of undifferentiated ops, and ap-south-1 satisfies India residency by default while keeping the GCC story additive.
**Alternatives evaluated & rejected:** **GCP/Azure** — viable, but AWS's Iceberg/Glue/EKS maturity and the team's familiarity won; multi-cloud was rejected as premature operational tax. **Self-managed Kubernetes / bare VMs** — rejected: fleet-management cost a bootstrapped team can't carry. **Multi-region at launch** — rejected: residency is satisfied single-region; multi-region is a Phase-5 trigger.
**Interactions:** KMS underpins per-brand isolation across Postgres, S3, and StarRocks; ArgoCD/Argo run on EKS; WAF fronts the collector (§7).

## 4. Frontend

| Area | Choice | What it does |
|---|---|---|
| Framework | **Next.js** | Server + client rendering for instant-feeling dashboards (`BRD §15`). |
| Language | **TypeScript** | Typed contracts shared with the backend. |
| Styling | **TailwindCSS** | Fast, consistent UI without a bespoke CSS system. |
| Components | **Shadcn UI** | Accessible, ownable primitives — speed without a heavy dependency. |
| Data fetching | **TanStack Query** | Caching, retries, loading/error states matching the "label stale, never hide it" UX (`BRD §19.1`). |
| Forms | **React Hook Form + Zod** | Robust validation for onboarding, cost setup, settings. |
| Charts | **Apache ECharts** | Rich, performant commerce charts without per-chart licensing. |
| Client auth | **Authentik OIDC** | Authenticates against the same IdP as everything else. |
| i18n / RTL | **next-intl (or equivalent)** | Locale-aware formatting + Arabic/RTL for GCC (`BRD §19.3`). |

**Why selected:** Next.js keeps one language across the stack and meets the "everyday screens must feel immediate" bar; Shadcn + Tailwind give an accessible component base (supporting the WCAG 2.2 AA + "status never colour-only" commitment, `BRD §19.2`) without owning a design system from scratch.
**Alternatives evaluated & rejected:** **Plain React SPA** — rejected: weaker first-paint and SSR story. **A charting SaaS / licensed grid** — rejected: per-seat/per-chart cost fights the no-per-seat economics. **A component library like MUI** — rejected: heavier and harder to own/restyle than Shadcn.
**Interactions:** the frontend only ever calls the Analytics API and the control-plane API; it never touches StarRocks or Iceberg directly. Mobile is **responsive web + PWA push**; **email is the primary real-time alert channel** and **WhatsApp is a Scheduled Delivery Channel** (briefs/digests, not real-time alerts — `BRD §15.8, §23.4`); no native app in v1 (`BRD §19.4`).

## 5. Authentication & identity provider

| Choice | What it does |
|---|---|
| **Authentik** | Open-source, self-hostable IdP: OAuth2 / OIDC / SAML, MFA, and enterprise SSO from one place. |

**Why selected:** covers "MFA for everyone from day one" + "SSO for enterprise" (`BRD §12.3, §18.6`) without a per-MAU SaaS bill, and keeps identity in-region.
**Alternatives evaluated & rejected:** **Keycloak** — comparable and more mature community, but heavier to operate; Authentik's single-deployment ergonomics won for a small team (revisit if a Model-D buyer mandates a specific federation). **Auth0/Cognito/Clerk (SaaS)** — rejected: per-MAU cost and out-of-region identity data conflict with residency and the cost model.
**Interactions:** the frontend (OIDC), the backend (token validation), and MCP/key issuance all federate through Authentik; it is distinct from the **customer Identity Graph** (§11), which resolves *end customers*, not Brain users.

## 6. Backend services

| Area | Choice | What it does |
|---|---|---|
| Language | **TypeScript** | Shared types/skills with frontend and stream processors. |
| Framework | **Fastify** | Fast, low-overhead Node API tier. |
| Validation | **Zod** | Schema validation doubling as types — enforces input validation at the edge. |
| API docs | **OpenAPI** | A typed, documented contract for every endpoint. |
| Internal RPC | **gRPC (only where required)** | Efficient typed service-to-service calls where a boundary genuinely needs them. |

**Why selected:** one language across the stack collapses context-switching for a small team; Fastify + Zod give throughput plus the four-layer input-validation discipline without ceremony.
**Alternatives evaluated & rejected:** **NestJS** — rejected: more framework ceremony than a small team needs. **Express** — rejected: slower and less type-friendly than Fastify. **Go/Java services** — rejected: would fracture the one-language principle for marginal gain at this scale (Go remains an option for the Collector hot path — §20).
**Interactions:** backend services own the control plane (Postgres, §10), expose the Analytics API over StarRocks (§14), and produce/consume events on Redpanda (§8).

## 7. The first-party collection path (the strict-SLA tier)

This is the platform's most reliability-critical surface (`BRD §7`, the 99.95% ingestion endpoint). Its decisions are called out separately from the general backend.

| Area | Choice | What it does |
|---|---|---|
| Collector | **Fastify service behind CloudFront + WAF** | Public ingestion endpoint for pixel + webhook events. |
| Durability contract | **accept-before-validate** → raw envelope to a durable spool / `raw_ingest` topic, then **ack** | Guarantees a collected event is never lost even when validation/registry/downstream are degraded. |
| Client SDK | **first-party-domain pixel (`brain.js`), async, batched, offline-buffered, retrying; cart-attribute stitch writer**, with a **server-side first-party cookie setter** on the per-tenant CNAME | Survives ITP/ATT/ad-block (the server-set cookie defeats ITP's JS-cookie cap) and never blocks checkout. |

**Why selected:** the business rule is "a lost event is lost forever," so the collector must **durably accept and acknowledge before any gate** (schema, consent, bot, enrich run downstream as stream stages — `BRD §7.4.3`). This inverts the naive "validate-then-accept" pattern that structurally caps durability.
**Alternatives evaluated & rejected:** **validate-at-edge then accept** — rejected: a slow registry or downstream outage would drop billable conversions. **A third-party CDP collector (Segment/RudderStack)** — rejected: it would make the most strategic asset (first-party data) a rented dependency and conflicts with the open-lakehouse and cost model; Brain is consciously *not* a generic CDP (`BRD §20`).
**Interactions:** the Collector writes raw to Redpanda (§8); consumers (§9) validate/dedupe/resolve/sessionize; consent withdrawal propagation (`BRD §7.4.6`) and the event-quality/"tracking-dark" monitor (`BRD §7.4.9`) hang off this path; CAPI passback (`BRD §7.4.10`) is a separate downstream output service.

## 8. Streaming platform (the event backbone)

| Area | Choice | What it does |
|---|---|---|
| Event streaming | **Redpanda** | Kafka-compatible, single-binary, no ZooKeeper — the durable buffer behind the 99.95% path. |
| Schema registry | **Apicurio** | Governs event schemas (backward-compatible evolution; old events stay readable forever) and **powers the tracking-plan surface** (`BRD §8.4.10`). |
| Event format | **Avro** | Compact, schema-evolvable binary — the right wire format for high-volume versioned events. |
| Client library | **KafkaJS** | The common Node/TS Kafka client (consistent with one-language). |
| Bronze writer | **Redpanda → Iceberg topic-materialization** | Redpanda writes topics directly to Iceberg, so raw events land in the lakehouse without hand-rolled TS Iceberg writers. |

**Why selected:** Redpanda gives Kafka semantics with a fraction of the operational weight (no ZooKeeper, single binary) — the right durable buffer for a small team. Apicurio makes every event validated and evolvable, and doubles as the governance substrate for the customer-facing tracking plan. Topic-materialization avoids immature Node Iceberg-write tooling.
**Alternatives evaluated & rejected:** **Apache Kafka (self-managed) / MSK** — rejected: ZooKeeper/operational weight (Kafka) or cost-and-less-control (MSK) versus Redpanda's single-binary simplicity. **AWS Kinesis** — rejected: proprietary, weaker ecosystem fit, lock-in against the open-formats principle. **Confluent Schema Registry** — viable but Apicurio is open and self-hostable in-region. **Hand-rolled TypeScript Iceberg writers** — rejected: the Node Iceberg-write ecosystem is immature; topic-materialization is more robust.
**Interactions:** the Collector and connectors produce here; stream consumers (§9) read here; Redpanda materializes Bronze into Iceberg (§13). Self-managed-vs-Cloud on the strict path is an open decision (§20).

## 9. Stream processing

| Area | Choice | What it does |
|---|---|---|
| Runtime | **EKS** | Consumer services on the same cluster. |
| Language / client | **TypeScript / KafkaJS** | Consumers do validation, dedup, enrichment, **identity resolution**, **sessionization**, bot filtering, and quality checks. |

**Why selected:** consumer services (not a heavy stream engine) keep the strict-SLA path lean and operable by the existing team; the consumers are where the durable-but-unvalidated raw stream becomes clean, resolved, sessionized data.
**Alternatives evaluated & rejected:** **Apache Spark Structured Streaming / Flink** — rejected for Phase 1: puts a non-managed, specialized-skillset engine on the 99.95% path and adds standing data-eng toil; deferred to Phase 3 only if heavy stateful/ML stream processing is genuinely needed (§18).
**Interactions:** consumers read raw from Redpanda, write resolved events onward, call the Identity Graph service (§11), and emit quality signals to the monitoring contract.

## 10. Operational database (the control plane)

| Area | Choice | What it does |
|---|---|---|
| Database | **AWS RDS PostgreSQL** (Multi-AZ, PITR) | The transactional control plane: RBAC, tenancy, consent, the **identity graph**, the Decision Log, audit, **metric definitions**, cost setup, goals, billing. |
| Isolation | **Row-Level Security + per-request tenant context + a non-owner DB role** | Isolation enforced in the database kernel — a forgotten `WHERE` returns nothing, not another brand's data. |
| Vector | **pgvector** | Semantic retrieval (Phase 3) lives in the same Postgres rather than a premature separate vector DB. |

**Why selected:** a managed, battle-tested relational store covers the entire control plane without a DBA, and RLS makes the most important guarantee (isolation) a kernel property, not an application convention.
**Alternatives evaluated & rejected:** **Aurora** — rejected for v1: RDS Postgres meets the recovery targets at lower cost/complexity (Aurora is a later scale option). **A separate vector database (Pinecone/Weaviate)** — rejected: premature; pgvector co-locates with the data it indexes. **Application-layer tenant filtering only** — rejected: one forgotten filter is a P0 cross-brand leak; isolation must be in the kernel.
**Interactions:** the control plane is the system of record for everything transactional (including the metric registry that the Measurement Platform and AI bind to); it is distinct from the lakehouse (analytical truth). RLS here is one of four isolation layers (Postgres RLS + per-brand S3 prefix + per-brand KMS + StarRocks row policies).

## 11. The identity graph (technical decisions)

The customer Identity Platform (`BRD §9`) is a **dedicated TypeScript service** over Postgres, not an emergent JOIN.

**Key technical decisions:**
- **brain_id_alias (read-time re-pointing).** A merge is a metadata write + a re-resolution event, **not** a mass UPDATE: a bitemporal `observed → canonical` alias (union-find with a cycle guard) re-points reads, so history is never rewritten and unmerge is reversible (`BRD §9.4.4`).
- **Centralized identifier hashing (resolved decision — §21).** Identifier **normalization + hashing is centralized** in the identity service (accepting transient plaintext on mTLS, with security sign-off) so the "same email is the same email" invariant cannot silently break on a producer's normalization mismatch. If ever distributed, it must use a shared normalization+hash library with a CI conformance test vector.
- **Hash-in-graph + KMS PII vault.** The graph holds hashed identifiers; real phone/email live in a KMS-encrypted vault readable only by the send service.
- **Profile identity-confidence & completeness** are computed and exposed (`BRD §9.4.6`).

**Why selected / alternatives rejected:** a dedicated service with an alias model is the only way to make merges reversible and history-preserving; the naive "UPDATE all rows to the surviving id" approach was rejected because it is destructive, un-auditable, and impossible to unmerge.
**Interactions:** stream consumers (§9) call it during resolution; Customer 360 and attribution read canonical Brain IDs from it; per-brand salts make cross-brand correlation cryptographically impossible.

## 12. Cache

| Choice | What it does |
|---|---|
| **Redis on ElastiCache** | Sub-millisecond reads for hot metrics, sessions, and rate-limit counters. |

**Why selected:** keeps dashboards/AI/MCP fast without recomputing identical queries — a performance *and* cost lever (a cached read is a serving call not paid for).
**Alternatives evaluated & rejected:** **Memcached** — rejected: fewer data structures (no sorted sets for rate limiting). **In-process caching only** — rejected: doesn't survive horizontal scaling or share across services.
**Interactions:** sits in front of the Analytics API and serving layer; holds session and rate-limit state for the collector and MCP.

## 13. The lakehouse (the single source of truth)

| Area | Choice | What it does |
|---|---|---|
| Object storage | **Amazon S3** | Cheap, durable substrate; per-brand prefixes + per-brand KMS = physical/cryptographic isolation. |
| Table format | **Apache Iceberg** | Open, ACID table format with schema/partition evolution and time-travel. ACID + row-level `MERGE` lets mutable commerce reality (placed → delivered → RTO over weeks) be represented honestly; time-travel + open format deliver reproducibility, replay, and the portable offboarding export. **The heart of the data plane.** |
| Catalog | **AWS Glue Data Catalog** | Managed metastore for the Iceberg tables — no catalog to self-operate. |
| Layers | **Bronze / Silver / Gold** | Bronze = raw events as received (replay truth, 24-month retention); Silver = normalized canonical domains; Gold = metric-ready marts (incl. the realized-revenue ledger and per-order margin facts). |

**Why selected:** an open ACID table format is what makes "the brand owns its data" literally true (portable, exportable, time-travellable) and what lets the append-only realized-revenue ledger + clawback (`BRD §10`) be modeled honestly.
**Alternatives evaluated & rejected:** **A proprietary warehouse (Snowflake/BigQuery/Redshift)** — rejected: lock-in conflicts with the no-hostage-data promise and the per-brand-isolation/residency model; cost scales poorly against %-GMV. **Delta Lake / Hudi** — viable open formats, but Iceberg's AWS/Glue maturity and engine-agnosticism won. **ClickHouse/DuckDB-on-S3 as the system of record** (an earlier design) — rejected: replaced by Iceberg-as-SoR + StarRocks-as-serving so the SoR is open and the serving engine is swappable.
**Interactions:** Bronze is written by Redpanda materialization (§8); dbt transforms Bronze → Silver/Gold (§14); StarRocks serves it. The `Iceberg → dbt → StarRocks` direction is one-way by rule.

## 14. Analytics & serving

| Area | Choice | What it does |
|---|---|---|
| Serving / query engine | **StarRocks** | Serves the sub-second dashboards/NLQ/MCP path; **native primary-key tables** (real upserts — the mutable order lifecycle works in Phase 1) **and** can read Iceberg via an external catalog (so it evolves to read Iceberg Silver/Gold at Phase 3 with no consumer change). |
| Transformations | **dbt Core** | The governed transform layer (staging → marts) with tests and lineage; runs on StarRocks today, on Iceberg later — same models. |
| The deterministic metric engine | **TypeScript metric engine over the registry** | All non-additive math (per-SKU tax, realization-date FX, banker's rounding, largest-remainder allocation, ratios) lives in **one** engine; dbt/SQL only does additive input marts. |

**Why selected:** one engine that does both real upserts *and* Iceberg-external-catalog reads shrinks the "two-store consistency" risk and avoids a Phase-3 serving rewrite. Confining all non-additive math to one TypeScript engine is what makes dual-store parity ("same finalized number everywhere", `BRD §14.6`) actually hold — SQL dialects can't disagree on math they never do.
**Alternatives evaluated & rejected:** **ClickHouse** — strong serving engine, but weaker primary-key/upsert ergonomics for the mutable order lifecycle and no equivalent Iceberg-SoR evolution path; StarRocks won on both. **Athena/Trino as the Phase-1 serving path** — rejected: not sub-second for interactive dashboards; added at Phase 3 for ad-hoc/BI. **Doing metric math in SQL across stores** — rejected: tri-dialect drift would break parity; hence the single TS metric engine.
**Interactions:** dbt builds marts StarRocks serves; the TS metric engine + registry are the only thing that emits a number; the **parity oracle** (CI golden-fixture vs an independent reference + continuous StarRocks-vs-Bronze reconciliation + the hot-vs-finalized convergence check) enforces correctness; everything is read through the Analytics API.

## 15. The AI layer

| Area | Choice | What it does |
|---|---|---|
| AI gateway | **LiteLLM** | A single entry point in front of every model — model pinning, prompt caching, per-brand budgets, fallback, cost routing. **No service calls a model directly.** |
| Models | **Claude / GPT / Gemini** | Multi-provider via the gateway; routed cheapest-sufficient per task. |
| The discipline | numbers are deterministic; the model only narrates | The model resolves a question to a **registered metric** and narrates the **computed** number — never invents figures, never writes its own query (`BRD §11.3`). |
| Eval gate | **NLQ resolution eval suite** | A golden question→metric-binding set is a ship gate on every prompt/model/registry change (`BRD §11.4.9`). |
| Safety | **prompt-injection defense** | Lakehouse-derived text is untrusted/delimited; the model can never change a number, weight, or action-eligibility (`BRD §11.4.8`). |

**Why selected:** a gateway makes cost routing, budgets, failover, and model-pinning a platform property rather than scattered per-service code, and enforces the "no direct model calls" rule that keeps numbers deterministic. This architecture *is* the primary prompt-injection defense.
**Alternatives evaluated & rejected:** **Direct provider SDK calls per service** — rejected: no central cost control, no failover, no enforcement of the deterministic-numbers rule. **A single-provider lock-in** — rejected: multi-provider routing is both a cost and a resilience lever. **Text-to-SQL** — rejected outright: it lets the model invent queries/numbers, the exact failure mode the product forbids; binding to `metric_id` is mandatory.
**Interactions:** every AI/NLQ/MCP request flows through LiteLLM and binds to the metric registry via the Analytics API; AI provenance (`BRD §11.4.5`) is written to the Decision Log; budget exhaustion returns a clear limit error; a failover model must pass the resolution eval before serving.

## 16. Observability, security & CI/CD

| Area | Choice | What it does |
|---|---|---|
| Metrics / Logs / Traces | **Grafana Mimir / Loki / Tempo + OpenTelemetry** | One open, self-hostable, vendor-neutral observability stack; monitors API latency, Redpanda lag, connector health, data quality, LLM cost/latency, and feeds the public status surface. |
| Security / tenancy | **KMS · Secrets Manager · TLS · WAF · RBAC · Postgres RLS + per-brand S3 prefixes + per-brand KMS + StarRocks row policies / Analytics-API-sole-path** | Isolation enforced at every layer; **AWS Lake Formation** adds row/column governance when Iceberg Silver/Gold arrive at Phase 3. |
| CI/CD | **GitHub + GitHub Actions → ECR → Helm → ArgoCD → EKS** | Gated pipeline. |
| Environments | **dev / staging / production on separate AWS accounts** | Hard blast-radius separation. |

**CI gates (enforced, not aspirational):** lint, unit, integration, security scan, schema validation, **tenant-isolation tests at every layer including StarRocks and the MCP path** (`BRD §18.1`), the **metric-parity oracle** (so "same finalized number everywhere" is enforced and a cross-brand regression fails the build), the **NLQ resolution eval** and **prompt-injection golden-set**, and the **WCAG 2.2 AA / "status never colour-only" accessibility checks** (`BRD §19.2`).
**Why selected / alternatives rejected:** the LGTM stack is open and in-region (vs Datadog/New Relic SaaS — rejected on cost and data-egress); GitHub Actions + ArgoCD keeps deploys auditable and Git-sourced. *(Trade-off: self-hosting LGTM is real ops; Grafana Cloud is a leaner early option if the team prefers.)*
**Interactions:** OTel spans (incl. `gen_ai.*` for the AI layer) flow to Tempo; the status surface reads measured availability; CI gates protect the boundary in §2.

## 17. How the components interact (end-to-end data flow)
1. **Collect** — the Brain Pixel (client + server) and connectors send events to the **Collector**, which durably accepts-and-acks before validation (§7) and produces to **Redpanda** (§8).
2. **Process** — **TypeScript consumers** (§9) validate, dedupe, enrich, **resolve identity** (§11), sessionize, and quality-check.
3. **Land** — **Redpanda materializes Bronze** into **Iceberg/S3** (§13); raw is immutable and retained 24 months.
4. **Transform** — **dbt** (§14) builds Silver/Gold; the **TypeScript metric engine** owns all non-additive math against the **registry** in Postgres (§10).
5. **Serve** — **StarRocks** (§14) serves sub-second reads; **Redis** (§12) caches hot results.
6. **Expose** — the **Analytics API** is the sole read path; **dashboards** (§4), **Brain AI/NLQ**, the **Morning Brief**, and **MCP** all read through it via **LiteLLM** (§15) for anything model-touched.
7. **Govern** — the **parity oracle**, **isolation tests**, **eval/injection gates**, and **accessibility checks** run in **CI** (§16); **Grafana/OTel** observe everything; the **control plane** (§10) holds the Decision Log, audit, consent, billing, and the metric registry.

## 18. Phasing — lean now, the heavy lakehouse later
The data plane is deliberately **phased** so a bootstrapped team isn't operating a heavy lakehouse before it's needed:
- **Phase 1 (lean):** Bronze = Iceberg/Glue (raw, replayable, open); **Silver/Gold = StarRocks-native** (built by dbt-on-StarRocks over Bronze). No Spark, no Athena. StarRocks' primary-key tables handle the mutable order lifecycle. This is the full data plane the BRD needs, at the smallest operational footprint. The **channel-contribution schema is reserved and rule-based/direct-populated** now, and the **holdout/exposure schema is reserved** now (the contract is frozen) — but per the frozen founder decision (`BRD §10.11, §23.4`), holdout/exposure **evidence capture starts in Phase 2** and the **MMM/incrementality/calibration engines that analyze it land in Phase 3** ("capture evidence in Phase 2, analyze it in Phase 3").
- **Phase 3 (when ML / data-driven attribution / MMM / scale trigger):** migrate Silver/Gold to **Iceberg** as the system of record; add **Athena/Trino** (ad-hoc/BI over Iceberg) and **Apache Spark** (batch + heavy transforms + Iceberg maintenance); add **AWS Lake Formation** governance; add a **Python ML service** (Feast, prediction models, MMM) — because Phase-3 ML is a Python ecosystem the TypeScript stack deliberately doesn't cover. StarRocks flips to reading Iceberg via its external catalog, so dashboards, APIs, and AI prompts don't change.
**Rule:** nothing in a later phase becomes a dependency of an earlier one — **including MMM.**

## 19. Local development architecture
The whole stack runs on a laptop via **Docker Compose** (k3d/kind later for local Kubernetes), so a feature is proven locally before it touches shared infrastructure:
- **Real containers** (no emulation for the heavyweight stateful services): **PostgreSQL, Redis, Authentik, Redpanda, Apicurio, MinIO** (S3 stand-in), a local **Iceberg REST catalog** (lakekeeper/Nessie, the Glue stand-in), **StarRocks, LiteLLM, Grafana, Loki**.
- **LocalStack** emulates **S3 / Secrets Manager / KMS / EventBridge** for the AWS-API surface.
- **Profile-based startup** brings up only the zones a developer needs (the full stack is memory-heavy), so "one command up" means the relevant profile, not every service at once.
**Why this shape:** the strict-SLA and parity-critical services (Redpanda, Postgres, StarRocks, Authentik) behave too differently under emulation, so they run as real containers; only the thin AWS-API surface is emulated. This keeps local behaviour faithful to production for the parts where fidelity matters.

## 20. Open "accept-knowingly" decisions (not blockers; founder's call)
1. **Self-hosted Redpanda on the 99.95% event path vs Redpanda Cloud.** Self-hosting means the team operates its strictest-SLA dependency; a managed option de-risks it at a cost.
2. **KafkaJS vs a librdkafka-based client (or a Go collector) on the high-volume Collector path.** KafkaJS is pure-JS and consistent with one-language; a librdkafka/Go client is faster under sale-day spikes — worth reconsidering specifically for the Collector.
3. **A Python ML service at Phase 3.** Confirmed direction: the TypeScript stack covers Phases 1–2; Phase-3 ML (Feast/predictions/MMM) lands as a Python service.

## 21. Resolved technical decisions (from the v1 review)
These were genuinely open and are now resolved, recorded here so they are not re-litigated:
- **dbt has no compute engine in v1** → Phase-1 dbt runs **on StarRocks** building StarRocks-native Silver/Gold over Bronze-Iceberg; Athena/Trino + Spark added only at Phase 3.
- **The Bronze writer** is **Redpanda → Iceberg topic-materialization**, not hand-rolled TS Iceberg writers (immature tooling).
- **Identifier hashing is centralized** in the identity service (§11) to protect the identity invariant — the single highest-leverage correctness decision in the identity core.
- **Dual-store parity** is the top technical risk and is contained by: the single TS metric engine, the 3-layer parity oracle, and the hot-vs-finalized convergence rule (the hot pre-dedup read is labeled and never feeds a decision/billing/attribution surface — `BRD §14.6`).
- **The collector is accept-before-validate** (§7) — the durability decision that makes the 99.95% endpoint SLO achievable.

## 22. One-line summary
TypeScript everywhere, Authentik for identity, RDS Postgres for the control plane, an accept-before-validate Redpanda event backbone, an open S3 + Iceberg + Glue lakehouse served fast by StarRocks (with dbt for transforms and one deterministic metric engine), LiteLLM in front of Claude/GPT/Gemini with eval + injection gates, the Grafana/OTel stack for observability, and ArgoCD/EKS/Terraform on AWS ap-south-1 — chosen to be lean for a small team now, open and portable for the brand always, isolation-enforced at every layer, and able to grow into the full lakehouse + ML at Phase 3 without a redesign.

---

*End of Technology Stack & Technical Decisions. Companion documents: `01_Brain_Business_Requirements_Document.md`, `02_Brain_Product_Functional_Specification.md`.*
