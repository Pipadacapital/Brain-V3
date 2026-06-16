# Feature Journal — feat-identity-graph

Deterministic identity graph — Bronze events → stable per-customer `brain_id`, with the India COD phone-guard. M1 data-plane (Bronze → **identity** → ledger). No new deployable (wires `packages/identity-core` + `apps/core/.../identity` + `apps/stream-worker/.../identity-bridge`). Branch `feat/identity-graph` (base master).

## 2026-06-16T18:00:00Z — Stage 1 (CTO Advisor) — ADVANCE
7 architect bindings D-1..D-7 + 8 findings (2 CRITICAL: D-1 phone-guard threshold unbound; D-2 salt cross-brand correlation / fetch-fail mode). Surfaces: multi_tenancy, pii, schema_proto, audit_integrity. Cost audit: Tier-1 deterministic, zero model calls. Artifact: 02-cto-advisor-review.md.

## 2026-06-16T22:15:00Z — Stage 2 (Architect) — ADVANCE → @data-engineer
**Paradigm:** Tier-1 deterministic, $0/mo, zero model calls. **Single-track @data-engineer** (whole graph + bridge + tests; no API seam warrants a backend track at M1).
**All bindings bound** (see 03-architecture-plan.md §0):
- D-2 salt: per-brand 32B, SaltProvider extends existing SecretsProvider, **HARD CRASH on fetch failure** (never empty/default). CI cross-brand-differs.
- D-1 phone-guard: `brand.phone_guard_threshold` DEFAULT 10 + `suppression_window_days` DEFAULT 30 (configurable), windowed; `shared_utility_identifier.suppressed_until`; re-eval = existing Argo-job type.
- C-1 stub-crypto: `stubSha256` DELETED → `node:crypto` real SHA-256.
- D-4: deterministic `merge_id` + ON CONFLICT DO NOTHING (PK + 2 UNIQUE PARTIALs); replay 3× → 1 merge.
- D-3: `contact_pii` RLS `brand_id` AND `app.role='send_service'`; dev plaintext; prod KMS = 0018 follow-up.
- D-5: deterministic-only `v1-deterministic`; merge_rule/merge_candidate/pii_vault_reference DEFERRED.
- D-6: E.164 (+91), `regionCode` param.
- D-7: bridge inside existing stream-worker; no new deployable.
- C-2: migration `0017_identity_graph.sql` (+brand cols), additive, RLS FORCE two-arg, NN-1 block, down=DROP.
- C-3: identity-bridge async writer, rebuildable from Bronze, copies CollectorEventConsumer/BronzeRepository discipline.
**Isolation:** ALL RLS tests under `SET ROLE brain_app` (superuser `brain` masks RLS — memory note). **Single-Primitive: CLEAN.**
**Slices (COMMIT PER SLICE):** 1 mig+crypto+salt → 2 resolver+idempotent writer → 3 phone-guard+contact_pii+re-eval → 4 deploy (existing ArgoCD app, no canary).
**Tests:** deterministic-merge · phone-guard false-merge-prevention (N=10 boundary) · isolation negative-control (brain_app) · no-raw-PII-in-identity_link · salt-cross-brand-differs · replay-idempotency (3×→1) · contact_pii send_service gate.
**ADR:** none new (within ADR-008/007/001/010). Artifact: 03-architecture-plan.md. **Next:** @data-engineer — Stage 3.
