# Requirement: Deterministic identity graph (brain_id + alias + India phone-guard)

| Field | Value |
|-------|-------|
| **req_id** | `feat-identity-graph` |
| **Title** | Deterministic identity graph — resolve Bronze events to a stable brain_id, with the India COD phone-guard |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-16T17:44:41Z |
| **Tier impact** | M1 data-plane critical path (Bronze → **identity** → ledger) |
| **Region impact** | India (COD shared-phone guard) |

---

## Lane *(advisor to confirm — deterministic scan: high_stakes; surfaces: multi_tenancy, pii, schema_proto)*

---

## Raw text (from the Stakeholder)

> Build the **deterministic identity graph** — the next link after the Bronze ingest spine (`feat-data-plane-ingest-spine`, shipped). Resolve raw Bronze events into a stable per-customer `brain_id`, deterministically, with the India COD phone-guard. Wire the EXISTING scaffolds: `packages/identity-core`, `apps/core/src/modules/identity/` (stub), and `apps/stream-worker/src/identity-bridge` (the async writer from Bronze).
>
> DELIVER:
> 1. **Identifier extraction + salted hashing** — from a Bronze event extract email / phone / storefront-customer-id; store SALTED HASHES in `identity_link` (NO raw PII in the graph/analytical store). Raw contact PII lives ONLY in `contact_pii` (KMS vault in prod; dev: an isolated, access-controlled table standing in for the vault). Marts/graph reference customers by `brain_id`, never by PII value.
> 2. **Deterministic resolution + merge** — a matching identifier (same salted hash, same brand) resolves to an existing `brain_id`; otherwise mint a new one. Merges are recorded via `brain_id_alias` **read-time re-pointing** — history is NEVER rewritten; merge events are append-only with a `merge_event_id`.
> 3. **India COD phone-guard** — a shared/utility phone (e.g. a COD courier or shared family phone used across many distinct orders) MUST NOT false-merge distinct customers. Implement `shared_utility_identifier` suppression: an identifier seen across an abnormal number of distinct customers is flagged and suppressed from merge decisions.
> 4. **Per-brand isolation (the ONE invariant)** — the identity graph is brand-scoped; RLS fail-closed; cross-brand identity resolution returns nothing under `SET ROLE brain_app` (dev superuser masks RLS — verify under brain_app).
> 5. **Rebuildable from Bronze + audit** — the graph is a derived projection; the `identity-bridge` consumes Bronze (or the same event stream) as an async writer. Merge/suppression decisions are audit-logged.
> 6. **Automated tests** — deterministic merge (same email across 2 events → 1 brain_id); phone-guard (a shared phone across N distinct customers does NOT merge them); isolation negative-control (cross-brand identity = 0 under brain_app); no-raw-PII-in-`identity_link` assertion.

---

## Problem statement

The Bronze ingest spine landed events into `bronze_events`, but every event is an anonymous row — there is no customer. The realized-revenue ledger (next slice) needs to attribute revenue to a *customer*, which requires a stable identity. Deterministic identity resolution (email/phone/storefront-id → `brain_id`) with the India COD phone-guard is the M1 identity component and the prerequisite for customer-level numbers.

## Target user

Internal/platform (the identity substrate every customer-level metric reads). India DTC brand context, M1.

## Success metric

A Bronze event with a customer identifier resolves to a stable `brain_id`; two events sharing an identifier resolve to the SAME `brain_id`; a shared/utility phone across many distinct customers does NOT collapse them; no raw PII in `identity_link`; cross-brand resolution = 0 under `brain_app`; the graph is rebuildable from Bronze. All proven by automated tests.

## Constraints

- **Deterministic only** — probabilistic / fuzzy matching is Phase 2 (explicit non-goal).
- Absolute brand/tenant isolation (the ONE invariant); RLS fail-closed two-arg; verify under `SET ROLE brain_app`.
- **No raw PII in the graph / analytical store** — salted hashes in `identity_link`; raw PII only in `contact_pii` (KMS vault prod; dev isolated table). No PII in logs/audit (reference by `brain_id`).
- Read-time re-pointing via `brain_id_alias` — history never rewritten; merges append-only (`merge_event_id`).
- Hard rule: no NEW deployable — wire the existing `apps/core/modules/identity` + `packages/identity-core` + `apps/stream-worker/identity-bridge`.
- Migrations additive (I-E02). Contracts-first where a contract is added.

## Non-goals

- Probabilistic / ML identity matching (Phase 2).
- Realized-revenue ledger, attribution, Customer 360, metric engine (later slices).
- Real Shopify customer ingest (synthetic/fixture identifiers; Shopify validate-sync parked).
- Production KMS vault wiring (dev stub for `contact_pii` access control; real KMS is platform follow-up).

## Linked prior runs

- feat-data-plane-ingest-spine (Bronze + the stream-worker the identity-bridge lives in)
- chore-platform-foundations-sprint0 (RLS, contracts/codegen)

## Notes

- Scaffolds present: `packages/identity-core`, `apps/core/src/modules/identity/{index.ts, internal/}`, `apps/stream-worker/src/identity-bridge`. Data model (doc 08): `brain_id`, `brain_id_alias` (read-time re-point, `merge_event_id`), `identity_link` (salted hashes), `contact_pii` (KMS vault), `shared_utility_identifier` suppression for the phone-guard.
- Builder lesson (prior runs): tight scopes + COMMIT PER SLICE (two builders once died on infra timeouts).
- Primary builder: data-engineer (the identity graph is the data plane's). Verify isolation under `SET ROLE brain_app` (dev superuser bypasses RLS).
- The phone-guard threshold (N distinct customers before suppression) is a binding the architect must set (and make configurable); the persona/architect should pressure the false-merge vs over-suppression trade-off.
