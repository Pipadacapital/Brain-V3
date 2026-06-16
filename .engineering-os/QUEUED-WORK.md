# Queued work (Stakeholder-approved, run in order)

_(empty — all queued items completed)_

## Completed

1. ✅ **Dev email-token surfacing (LOW-DEV-TOKEN-01)** — done 2026-06-16 on branch
   `feat/dev-email-token`. Backend captures the verify/reset/invite token at send time
   (in-memory, dev-only) and exposes `GET /api/v1/dev/last-email-link?email=` — registered
   ONLY when NODE_ENV != production (double-gated: route not mounted AND store never
   populated in prod). `/verify-email` shows a one-click "Verify now (dev)" button.
   Bonus: fixed a latent PROD bug — the verify/reset/invite email links pointed at
   `/auth/verify-email`, `/auth/reset-password`, `/invites/accept` (all 404); corrected to
   `/verify-email`, `/reset-password`, `/invite/accept`. Prod-gate unit test + dev-verify
   e2e added; full e2e suite 14/14.
