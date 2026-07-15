# ADR-0013 — Query-time bi-temporal identity resolution for the revenue spine

Status: **Proposed** (2026-07-15)
Relates to: audit gap **G1**; ADR-0004 (identity SoR = Neo4j); the bi-temporal `silver_identity_map`
(is_current / system_to intervals); the flag-gated parallel-run precedent (`semantic.serving`,
`measurement.marts_migration`); the canonical query-time resolvers in `gold_journey_events` /
`gold_customer_360`.
Driver: audit finding **G1** — the revenue spine resolves `brain_id` on a **flat, single-key**, non-point-
in-time path, diverging from the multi-key bi-temporal resolution the journey/customer Gold already uses.

## Context

Two identity worlds coexist in the medallion:

- **Revenue spine (flat, single-key).** `silver_order_state` and `gold_revenue_ledger` resolve `brain_id`
  by joining the order's `hashed_customer_email` to `silver_identity_alias`
  (`identifier_type='pre_hashed_email'`, `is_active`), then `MIN(COALESCE(merged_into, brain_id))`. This
  path (a) uses **one key only** — a phone-only or platform-id-only customer never resolves — and (b) is
  **not point-in-time**: it reads the current alias projection, not the bi-temporal identity intervals.

- **Journey / customer Gold (query-time, multi-key, bi-temporal).** `gold_journey_events` and
  `gold_customer_360` already resolve `brain_id` at query time against `silver_identity_map` using the
  sanctioned **`identity_current`** predicate (`is_current = TRUE AND system_to IS NULL`), reconcile merges,
  and honour the deterministic never-guess rule.

The revenue spine is the money keystone, so any change to how it attributes revenue to a customer is
high-blast-radius: it must not perturb the byte-exact Spark→DuckDB parity golden, and money correctness is
non-negotiable.

## Decision

Introduce a **query-time, multi-key, bi-temporal, merge-aware** `brain_id` resolution for the revenue spine
as an **additive, flag-gated, parallel-run** change — never a replacement of the flat path.

1. **New per-brand flag `identity.revenue_querytime`, default OFF, fail-closed** (registered in
   `packages/platform-flags/src/registry.ts` and mirrored in the Python twin
   `db/iceberg/duckdb/_platform_flags.py`).

2. **Shared resolver module** `db/iceberg/duckdb/_revenue_identity.py` produces the alternate resolution SQL,
   replicating the canonical `gold_journey_events` / `gold_customer_360` pattern:
   - join the order's up-to-three **hashed** identifiers (email + phone + `platform_customer_id`) to
     `silver_identity_map` on `(brand_id, identifier_hash)` **alone** — a hash is globally unique per
     `(brand, value)`, so `identifier_type` is provenance only (the same rule `silver_session_identity` uses);
   - filter to **`identity_current`** (`is_current = TRUE AND system_to IS NULL`) — bi-temporal;
   - **merge-reconcile**: prefer `replaced_by_brain_id` (the survivor) when the current row carries one;
   - **never-guess**: an order whose keys resolve to **> 1 distinct brain** yields NULL (deterministic-first).

3. **Additive `brain_id_v2` column** on `silver_order_state` and `gold_revenue_ledger`, resolved by the
   module for flag-ON brands and **run in parallel** with the untouched flat `brain_id` on the same row — so
   the two resolutions are directly parity-comparable (the audit's parallel-run methodology). `brain_id_v2`
   is **not** part of any PK or of `ledger_event_id`, so the money key and every amount are byte-identical
   regardless of the flag.

4. When the flag is **OFF** for a brand (default) — or `silver_identity_map` is absent — the resolver
   degrades to an **empty** result; the caller LEFT-JOINs it, so `brain_id_v2` is NULL on every order and the
   legacy flat `brain_id`, all money, and all lifecycle columns are **byte-identical to pre-wave**.

`gold_customer_360` (which already resolves identity at query time) and `silver_customer` continue to read
the flat spine `brain_id` for their lifetime rollups — unchanged — so the parallel comparison is isolated to
the spine and the ledger, where the audit needs it.

## Why additive + flag-gated (not an in-place fix)

- **Parity golden is sacred.** The Spark→DuckDB cutover proved money-byte-exact parity on the flat path.
  A default-OFF flag + additive column means the shipped default output is unchanged, so the golden holds.
- **Reversible + auditable.** Operators can enable one brand, compare `brain_id` vs `brain_id_v2` on the same
  rows, and quantify the lift (phone-only / platform-only / merge / point-in-time deltas) before any cutover.
- **Follows repo precedent.** Mirrors `semantic.serving` / `measurement.marts_migration`: OFF ⇒ legacy
  byte-identical, ON ⇒ new path, parity-gated.

## Parity strategy

- **Flag OFF:** the resolver is empty ⇒ `brain_id_v2` NULL everywhere ⇒ existing money/identity/lifecycle
  output is byte-identical (proven by `test_revenue_identity_g1.py::test_flag_off_is_all_null_parity_preserved`
  and preserved by the untouched flat `_identity_link_sql`).
- **Flag ON:** `brain_id_v2` is populated for comparison; `brain_id` and all amounts remain unchanged. The
  standard `parity_check.py` harness compares `<table>_duckdb_test` against the live table on the legacy
  columns; `brain_id_v2` is an additive column the harness simply carries.
- **Reproducibility seam:** `IDENTITY_REVENUE_QUERYTIME_BRANDS='<uuid>,…'` forces brands ON for a harness run
  (identical to `STITCH_V2_BRANDS`), since the flag lives in mutable Redis, not the Iceberg corpus.

## Consequences

- Two `brain_id` columns exist transiently on the revenue spine/ledger. A future ADR may cut `brain_id` over
  to the query-time value once parity is validated per brand; until then the flat path stays the source of
  record.
- `platform_customer_id` (`storefront_customer_id`) is salt-hashed at resolution time using the same dev-salt
  derivation as `silver_session_identity` / the connector normalize jobs, so it matches the identity graph's
  stored hash. Email/phone are already pre-hashed on the payload.
- Money discipline (bigint minor units + sibling `currency_code`), `brand_id`-first isolation, and the
  upstream consent gate are untouched.

## Rollback

- **Instant, per-brand:** set `identity.revenue_querytime` OFF (fail-closed default) → `brain_id_v2` reverts
  to NULL on the next refresh; legacy output is byte-identical.
- **Code:** `git revert` the change; the additive column is dropped on the next `ensure_table` schema
  reconciliation and no legacy behaviour ever depended on it.
