# Requirement: D13 privacy — consent system of record + real can_contact() enforcement + consent-suppressor

| Field | Value |
|-------|-------|
| **req_id** | `feat-d13-consent-cancontact` |
| **Title** | Replace the can_contact() pass-through stub with a real consent/DND/window compliance engine, backed by consent_record + consent_tombstone + a consent-suppressor consumer, with a per-brand consent/compliance UI |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-18 |
| **Lane** | high_stakes (compliance, PII, consent, outbound chokepoint I-ST05) |
| **Roadmap** | D13 privacy completion (independent of Silver — additive migrations + stream-worker consumer; shippable any time after Phase 3). See docs/data-collection-platform/13-security-privacy-and-roadmap.md §13.4. Honor COMPLIANCE.md (the declared regime). |

## Why now
`can_contact()` is the SINGLE outbound chokepoint (I-ST05) — every send must pass it — but today it is a
pass-through stub (`return true`, notification.service.impl.ts:168-171; "Phase 3 will add real consent checks,
DND, DLT"). Marketing/messaging channels (WhatsApp/CAPI, Phase 1c/6) MUST slot in behind a real gate without
redesign. Building the enforcement chokepoint now (consent + DND + window) is the prerequisite; it is DPDP/TRAI
compliance-critical and a hard Security concern.

## Current state (verified)
- The chokepoint exists: `notification` module, `canContact(email, channel)` — currently `return true`
  (transactional_email is consent-exempt by design; marketing channels have NO real gate).
- `consent_flags` is a first-class envelope field (Phase-1 collection-foundation) — captured at the SDK,
  but NOT yet enforced and NOT persisted to a consent system of record.
- NO consent_record / consent_tombstone tables, NO consent-suppressor consumer, NO DND/window logic exist.

## Deliverables (smallest valuable slice — the enforcement chokepoint)
1. **Consent system of record (additive migrations):** `consent_record` (per brand × subject × channel/purpose:
   granted/withdrawn state, source, ts, policy version — DPDP lawful-basis record) + `consent_tombstone`
   (withdrawal/erasure marker — append-only, drives suppression). RLS FORCE; verify under brain_app.
2. **consent-suppressor consumer (stream-worker):** consumes the `consent_flags` events (+ tombstones) →
   maintains a queryable per-subject **suppression state** (suppressed for a channel/purpose when consent is
   absent/withdrawn). Reuse the existing stream-worker consumer pattern; no new deployable/topic/envelope where
   avoidable (additive topic only if the architect must). Idempotent.
3. **Real `can_contact()` enforcement (replace the stub) — the compliance engine inside the existing notification
   module (no new service):**
   - **consent**: marketing/messaging channels require an active `consent_record` (not suppressed); transactional
     stays exempt (documented).
   - **DND / quiet hours**: a **9am–9pm IST send window** — outside it, do NOT send.
   - **pending_window queue**: a send blocked only by the window is QUEUED (pending_window) and released when the
     window opens — never silently dropped, never sent out-of-window.
   - Extend the `canContact` signature to accept marketing/messaging channels (keep transactional_email exempt).
   - **DLT template-approval** + NCPR/DND-registry lookup: build the SEAM + a clearly-documented dev-honest stub
     (real TRAI DLT registration is a platform follow-up) — do NOT fake approval; default-closed where unknown.
4. **UI (MANDATORY — stakeholder-visible):** a per-brand **Consent / Compliance** view — consent coverage
   (granted/withdrawn by channel/purpose), the suppression count, the DND/send-window config (read at least), and
   the can_contact gating status. shadcn/Radix/Tailwind; honest empty; accessible.

## Constraints
- **can_contact() is the SOLE send gate (I-ST05)** — there is NO direct send path; every channel adapter passes it.
  **Default-closed**: unknown consent / unknown DLT status / unknown window → do NOT send (fail-closed), not send.
- Per-brand isolation (RLS FORCE, verify NON-INERT under brain_app — superuser bypass = INERT). PII: subject keys
  hashed (reuse identity-core per-brand salt); raw email/phone never stored in consent tables or logs. Consent state
  is auditable. Additive migrations only; reuse the notification module + stream-worker consumer pattern; no new
  deployable (I-E05).
- DPDP/TRAI: consent is lawful-basis recorded; withdrawal (tombstone) suppresses promptly; the 9–9 IST window +
  pending_window queue are enforced server-side (not UI hints).
- Dev-honesty: real DLT template registration + NCPR/DND registry are platform follow-ups — build the seam +
  default-closed stub, document the boundary; never fake compliance.

## Non-goals (follow-on D13 slices)
- Right-to-erasure: `pii_erasure_log` + crypto-shred orchestrator + `surrogate_brain_id` re-pointing (next D13 slice).
- CAPI passback (Phase 6 — slots in behind can_contact()). Real DLT/NCPR integration; full template lifecycle.
- prod `pii_ciphertext` KMS path; audit WORM anchor/chain-walk; Bronze Iceberg 24-mo TTL (gated); GCC residency (Phase 5).

## Build tracks (the architect will bind)
@backend-developer (the can_contact compliance engine in the notification module: consent + DND/9–9-IST window +
pending_window queue + DLT/NCPR seam, default-closed; consent_record/tombstone domain + write paths) ∥
@data-engineer (the consent_record/consent_tombstone migrations + the consent-suppressor stream-worker consumer +
suppression-state read seam, idempotent, RLS FORCE) ∥ @frontend-web-developer (the consent/compliance UI). Verify
can_contact is the sole gate + default-closed + the 9–9 window/pending_window + suppression on tombstone + isolation
NON-INERT under brain_app. Reuse the notification module, the stream-worker consumer pattern, identity-core hashing.
