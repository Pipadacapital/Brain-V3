# Brain Data Collection Platform — Design Spec Index

The authoritative design for the Brain data-collection plane: first-party collection → identity → journey → revenue truth → attribution → confidence → decision intelligence. Everything here **extends the already-shipped collector/pixel/Bronze spine** — no new deployable, package, topic, envelope, or RLS variant.

## Reading order

| # | File | What it covers |
|---|------|----------------|
| 00 | [00-executive-summary.md](./00-executive-summary.md) | **Start here.** Purpose, the foundational chain, Present vs Missing, the build sequence, the top 5 risks. |
| 01 | [01-collection-platform-and-pixel.md](./01-collection-platform-and-pixel.md) | The edge → spool → drainer → Bronze backbone and the brain.js capture SDK (anon-id, session, queue, consent-at-capture, CNAME asset). |
| 03 | [03-identity-and-journey.md](./03-identity-and-journey.md) | Identity resolution inputs and the events → sessions → touchpoints → journeys transform (Silver-gated). |
| 05 | [05-connectors-commerce-cartstitch.md](./05-connectors-commerce-cartstitch.md) | Connector platform, the realized-revenue ledger, and deterministic cart-stitch. |
| 08 | [08-dataquality-and-trackingcenter.md](./08-dataquality-and-trackingcenter.md) | DQ check-execution runtime, `dq_grade`, Trust Score, coverage metrics, the Tracking Center. |
| 10 | [10-db-events-api.md](./10-db-events-api.md) | Net-new tables/events/APIs — all additive, reusing the NN-1 RLS template and the single envelope. |
| 13 | [13-security-privacy-and-roadmap.md](./13-security-privacy-and-roadmap.md) | Consent, erasure, auditability, the security roadmap. |
| 16 | [16-db-alignment-classification.md](./16-db-alignment-classification.md) | Consolidated Present / Equivalent / Missing / Raw-Only / Reject table across all areas. |
| 17 | [17-final-recommendations.md](./17-final-recommendations.md) | Gated, prioritized recommendations + the phased roadmap (Phase 1 = Collection Foundation). |

## How to use this spec

- **Building?** Read 00, then 17 (the gate + roadmap), then the section file for your slice.
- **Reviewing for drift?** 16 is the alignment table; every recommendation in 17 carries the five-question gate.
- **The non-negotiables:** absolute per-brand isolation (RLS FORCE, verified under `brain_app`); accept-before-validate (D-1); Bronze = immutable source of truth; deterministic-first; money = integer minor units; PII hashed at the boundary with per-brand salt.

## Two blocking ADRs before any SDK/ingest code

1. **Envelope wire-shape** — the consumer parses Zod shape (a) (`event_name`/ISO `occurred_at`), not the shape (b) the section docs ruled. Reconcile in `ProcessEventUseCase`, not in prose.
2. **PII hashing posture** — browser holds no secret salt and sends no raw PII; canonical hashing is server-side.

See 17 for both.
