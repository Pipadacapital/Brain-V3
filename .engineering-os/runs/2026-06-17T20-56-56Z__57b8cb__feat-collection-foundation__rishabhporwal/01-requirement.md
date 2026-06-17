# Requirement: Collection Foundation — Phase 1 of the Brain Data Collection Platform

| Field | Value |
|-------|-------|
| **req_id** | `feat-collection-foundation` |
| **Title** | Collection Foundation — harden the ingest edge (tenant-key binding, consent, quarantine) + ship the minimal first-party pixel |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-17T20:56:56Z |
| **Lane** | high_stakes (multi_tenancy / pii / schema_proto / compliance / outbound-edge) |
| **Source spec** | `docs/data-collection-platform/` (00-executive-summary, 01-collection-platform-and-pixel, 13-security-privacy-and-roadmap, 17-final-recommendations) — the authoritative design board output |

---

## Why now (the keystone)

The design board (14-agent opus review board + negative review) found that the collection foundation has a **CRITICAL isolation gap** the first-party pixel would expose. Phase 1 closes it as its keystone, then ships the smallest valuable browser-collection slice — by EXTENDING the existing accept-before-validate edge (no new deployable/topic/package/envelope).

## Critical findings this phase MUST resolve (from the spec)

- **R2 / CRITICAL (isolation):** the ingest path sets the RLS GUC from the event's **own client-stamped `brand_id`** (`BronzeRepository` / the drainer) with **no `install_token` lookup**. A browser could claim any brand → cross-brand write-injection into Bronze. **Fix: derive `brand_id` server-side from a per-tenant `install_token` at the drainer; never trust the input `brand_id`.** (Connector webhooks already resolve brand server-side and are safe.)
- **R1 / CRITICAL (wire shape):** the live consumer `ProcessEventUseCase` parses a specific Zod shape (`event_name`, ISO `occurred_at`). Any pixel emit MUST match it or every event DLQs. **ADR-1 must reconcile the pixel emit to the live consumer contract — do NOT introduce "shape (b)".**
- **R3 / CRITICAL (compliance):** `consent_flags` is absent from contracts/avsc though `COMPLIANCE.md` mandates *quarantine-not-drop* on a missing/absent consent signal. **Add `consent_flags` to the envelope + a `quarantined` consumer outcome + the CI gate.**
- **R4 / HIGH:** client-controlled `event_id` + silent `ON CONFLICT DO NOTHING` allows silent suppression of real events. **Make dedup-conflict observable (count/log), and constrain client event_id influence.**

## ADRs the architect MUST resolve before building

- **ADR-1 (wire shape):** the exact pixel→`/collect`→drainer→`ProcessEventUseCase` envelope, reconciled to the live Zod contract. No new envelope; extend `CollectorEventV1` additively if needed (`install_token`, `consent_flags`, anon/session/click-id/UTM as raw-only properties).
- **ADR-2 (PII hashing):** hashing happens **server-side at the drainer** with the per-brand salt — the secret salt NEVER reaches the browser; raw PII NEVER lands in the un-RLS'd `collector_spool`. (Veto raw-PII-over-TLS / browser-salt.)

## Deliverables (Phase 1 scope — the architect may split 1a security-hardening / 1b pixel)

1. **`install_token` → `brand_id` binding at the drainer** (fixes R2): per-tenant install token issued at pixel provisioning (the `pixel_installation` row), looked up server-side to derive the trusted `brand_id`; a mismatched/absent token → `quarantined`, never written under a claimed brand.
2. **`consent_flags` + `quarantined` outcome + CI gate** (fixes R3): additive to the envelope; the consumer routes no-consent events to quarantine (not drop, not Bronze-as-trusted), per COMPLIANCE.md.
3. **Observable dedup-conflict + malformed→DLQ** (R4): count/emit on `ON CONFLICT DO NOTHING`; malformed payloads route to the DLQ (not silent loss).
4. **Minimal `brain.js`**: anonymous id + `page.viewed` + cart events, **one event per POST** (no batched array until drainer fan-out exists), anon-id/session/click-id (fbclid/gclid/ttclid)/UTM/referrer/landing capture, **server-side** PII hashing only, on the existing `/collect` edge.
5. **`/pixel.js` asset** served on the per-tenant CNAME; **edge rate-limiting** (abuse protection).
6. **E2E proof:** a real browser-origin `page.viewed` → token-bound `brand_id` → `bronze_events` row asserted under `brain_app`, **fails-closed when offline**, with **negative controls**: mismatched-`brand_id` → quarantined; malformed → DLQ; cross-brand = 0 under `brain_app`.
7. **Tracking Center UI (MANDATORY — stakeholder-visible, not backend-only):** extend the existing Brain Pixel page (`/settings/pixel`) into a usable Tracking Center so a brand can SEE collection working:
   - **Pixel setup/installation wizard** — surface the `install_token` + the snippet/`/pixel.js` install instructions; copy-paste + "I've installed it".
   - **Live verification** — a real-time "✅ First event received" / "waiting for your first event…" state that polls and flips when a Bronze event lands for the brand (honest, never faked).
   - **Tracking Health** — events flowing (volume over time, last-event freshness), consent/quarantine counts, and an honest status (healthy / no events yet / stale).
   - **Basic Event Explorer** — the most recent collected events (type, time, anonymized identifiers) so a non-technical stakeholder can watch data arrive.
   Reuse the analytics UI patterns (shadcn/Tailwind/Recharts, KpiTile/charts, honest empty/loading states, BFF + metric-engine sole-read-path). This is what makes Phase 1 real to business stakeholders.

## Constraints (the no-drift gate — from the spec watch-list)

- **No new deployable / package / topic / envelope / RLS-variant / OLTP journey table / order-recovery action.** Extend existing seams only.
- **Veto:** "emit shape (b)"; `Set-Cookie` on `/collect` (keep the edge stateless — use a separate endpoint or client-side anon-id mint); raw-PII-over-TLS / browser-salt; batched POST before drainer fan-out; treating input `brand_id` as ground truth.
- Accept-Before-Validate preserved (receive→persist→ACK→validate later); Bronze immutable/replayable; `(brand_id,event_id)` idempotency; RLS FORCE; money/PII invariants.
- Verify isolation under `SET ROLE brain_app` (the dev superuser `brain` bypasses RLS — any isolation check not under `brain_app` is inert).

## Non-goals (later phases)

Journey/session reconstruction (Phase 4), cart-stitch, the full DQ runtime / Trust Score (Phase 7), consent *enforcement* across downstream + erasure orchestration (later), batched/fan-out delivery. The **advanced** Tracking Center (full diagnostics center, automated failure-resolution flows, connector/identity/journey health tabs) is later — but a **usable Tracking Center (setup wizard + live verification + tracking health + basic event explorer) IS in this phase** (deliverable 7), because every slice must be stakeholder-visible. This phase is the collection edge hardening + the minimal proven pixel + the Tracking Center that shows it working.

## Linked

- `docs/data-collection-platform/` (the spec) · feat-data-plane-ingest-spine (the collector/Bronze backbone) · feat-identity-graph (the hashing seam + brain_id) · the pixel module (`pixel_installation`, provision/verify/health).
