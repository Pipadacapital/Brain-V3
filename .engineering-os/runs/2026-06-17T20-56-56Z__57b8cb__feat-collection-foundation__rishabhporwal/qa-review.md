# QA Review — feat-collection-foundation (Phase 1 Collection Foundation)

| Field | Value |
|---|---|
| req_id | feat-collection-foundation |
| Stage | 5 — QA |
| Mode | FULL |
| Lane | high_stakes (multi_tenancy / pii / schema_proto / compliance / outbound-edge) |
| Model | claude-opus-4-8[1m] |
| Verdict | **PASS** |
| Infra | real Redpanda + Redis + Postgres (localhost:9092/6379/5432), migration 0028 applied (prosecdef=t), brain_app rolsuper=f rolbypassrls=f |

## Verdict: PASS

Every claim below has captured command output from THIS session. Suites ran against real infra. Verification-validity confirmed (validity_check clean, 28 files; non-inert negative controls captured). No bypass-green, no inert probe, no tautological parity.

## Suites run (real infra, this session — all GREEN)

| Suite | Tests | Result |
|---|---|---|
| packages/contracts (incl. consent-propagation + no-pii gates) | 11 | PASS |
| packages/observability | 13 | PASS |
| packages/pixel-sdk | 12 | PASS |
| apps/collector (edge-guard 7 + pixel-asset 6 + durability 5) | 18 | PASS |
| apps/stream-worker ingest-hardening.e2e | 11 | PASS |
| apps/web tracking-status | 9 | PASS |
| **Regression (bronze/backfill/pipeline-wire/live-connector/dlq e2e)** | 57 | PASS |

Core five suites = 65 (mission claimed "66"; immaterial — more passed than claimed, 0 failures). Total independently verified this session: **74 + 57 regression = 131 tests, 0 failures.**

## Non-inert confirmations (the VETO surface)

1. **R2 guard is NON-INERT.** Un-wired the brand derivation in ProcessEventUseCase (disabled the `claimedBrandId!==derivedBrandId` quarantine branch with `if(false)` + set `brand_id=claimedBrandId`). The cross-brand test went RED: `AssertionError: expected 'written' to be 'quarantined'` at ingest-hardening.e2e.test.ts:258 — the spoofed cross-brand event wrote to Bronze under the claimed brand exactly as the breach predicts. Restored original (git diff byte-identical), test back to GREEN. The R2 keystone IS the thing the test catches.
2. **Track C read-path negative control NON-INERT.** A real BRAND_A Bronze row read under brain_app + BRAND_B GUC → 0 rows; under no GUC → 0 rows; positive control under BRAND_A GUC → 1. brain_app confirmed non-superuser/non-bypassrls via pg_roles, so the RLS isolation read is genuinely enforced (not masked by the dev superuser).
3. **Quarantine sink real (not asserted-in-memory).** The `.quarantine` message was ACTUALLY produced to and consumed back from live Redpanda — `QUARANTINE partition=0 offset=10943 reason=brand_mismatch brand=b22b...`.
4. **pixel-sdk is real (not a stub).** Full SDK (config/identity/session/capture/attribution/consent/transport); emits shape-(a), mints event_id once + reuses on retry, no PII/no salt, consent fail-safe-absent, one-event-per-POST.
5. **/pixel.js eval-parity vs the REAL Zod schema.** pixel-asset.test evals the served PIXEL_JS in a vm sandbox and parses the emitted POST body against the real `@brain/contracts CollectorEventV1Schema` — passes; no-PII scan on the real wire body passes.

## Other gates

- **tsc**: clean across contracts, observability, pixel-sdk, collector, core, web; stream-worker has the ONE pre-existing AwsSecretsManager TS2307 — confirmed NOT in this diff (untouched), unrelated.
- **validity_check**: `clean (28 files scanned)`, EXIT 0, with negative_control[] recorded in qa-review.json. Initial run flagged missing negative-control artifact (VETO) — resolved by recording the captured RED proof.
- **Production wiring**: live stream-worker main constructs `ProcessEventUseCase(dedup, bronze, auditWriter)` with enforceTenantDerivation defaulting TRUE; backfill/live-ledger lanes correctly opt out (`false`). Collector main registers edge-guard (reject-before-spool) + /pixel.js route.
- **No-PII BFF**: get-recent-events selects only type/time + anonymized ids (brain_anon_id, hashed_session_id) under withBrandTxn; never raw PII.
- **Additive-only**: migration 0028 is CREATE OR REPLACE FUNCTION (no table change, migration-time SEC guards); consent_flags additive top-level; .quarantine topic suffix reuses the shipped DlqProducer.

## Coverage / mutation

Critical-path effectiveness proven by the live R2-unwire mutation (killed) + the in-suite positive/negative RLS controls + the consent-absent / tenant-unresolved / brand-mismatch / malformed branch matrix. Cost paradigm = deterministic-only (tier 1) — no model/statistical call, correct.

## HANDOFF
PASS. Reconcile with Security Reviewer. No bounce.
