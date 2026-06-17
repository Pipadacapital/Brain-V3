# Retro — feat-connector-marketplace

**Stage:** 6 (final-reviewer) · **Verdict:** PASS / APPROVE · **Bounce rounds:** 1 (fully remediated)

## What went well
- **Contract-first freeze (A0) bought clean parallelism.** Freezing the Zod contract + static catalog before either track wrote a handler let backend and frontend build against a single source of truth; the only cross-track break (envelope) surfaced and was caught by the e2e/QA gate, not in production.
- **The security spine landed correctly on the first design.** D-1 (brand_id from signed state only) was implemented by *deleting* the divergent inline callback rather than patching it — the cleanest possible fix. HMAC-first and the no-token-in-DB invariant held throughout.
- **Non-inert verification was real.** The isolation test asserts `current_user==='brain_app'` before counting (so RLS can't be superuser-masked), and the KMS negative control "goes RED when KmsKeyId is absent." The real-store Boddactive connect smoke is the strongest live evidence a connect slice can carry.
- **Scope discipline held.** Delivered set == plan; no new deployable, no health table, no plugin registry — the deferred boundary (detector/backfill/live-sync) is grep-clean.

## What bounced (and the lesson)
- **HIGH-01 (KMS binding):** the original `EncryptionContext` intent collided with a real AWS API constraint (Secrets Manager does not accept caller-supplied EncryptionContext). Resolved correctly to `KmsKeyId`-CMK with a residual (SEC-CM-RES-01) tracked to M2. *Lesson: vendor-API capability should be confirmed at design time when an invariant is pinned to a specific API parameter.*
- **Envelope 9th-mismatch regression:** a legacy `connectorsApi.list()` kept reading the old `raw.data.shopify` shape after the backend endpoint was swapped to the marketplace envelope — crashed the onboarding wizard step. Fixed by deriving `list()` from `getMarketplace()`. *Lesson: when an endpoint's response shape changes, every existing consumer of that endpoint must be re-pointed, not just the new caller — a backend contract swap is a fan-out change on the client.*

## Recurrence / auto-candidate rule — NOT written
This run's root cause (stale client method reading the old envelope shape after a backend endpoint swap) is within the envelope-`.data`-unwrap theme. That theme is **already actively guarded**: every run carries an explicit "no Nth-envelope-mismatch" binding D-item, the Architect plans the unwrap at the call site, and QA holds a VETO on flat reads. Distinct prior runs sharing this run's precise mechanism = **2** (members-team-management, analytics-api-dashboard) — below the ≥3 auto-candidate threshold — and the broad pattern is mitigated procedurally rather than un-codified. **No `rule-proposals/` entry written; nothing appended to `pending-stakeholder-attention.md`.** Adding a durable rule over an already-controlled risk would be process tax.

> Watch item (not yet a rule): if a *third* distinct run bounces on "stale consumer of a swapped endpoint shape," promote to a rule-proposal — a lightweight "endpoint-shape-change = enumerate-and-repoint-all-consumers" checklist item for the Delivery Coordinator's `/spec`.

## Carried debt into the Stakeholder gate
- SEC-CM-RES-01 (MED, M2) — single shared CMK; evaluate per-brand CMK / KMS Grants.
- KNOWN-CM-01 (LOW) — one-instance-per-provider UNIQUE limit.
- Scale-C4 (LOW) — InProcessOAuthStateStore single-instance; Redis path reserved.
- Sec-C3 (non-goal) — no provider-side OAuth revocation on disconnect.
