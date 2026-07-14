<!-- SPEC: §1.3 (crypto-shred completeness) / §1.9 invariant 3 (new subject-linked tables registered) -->
# Shred Manifest — subject-linked tables & crypto-shred coverage

**Purpose.** §1.9 invariant 3 requires every NEW subject-linked table to register here with its subject
key, its key-envelope columns (if any), and how a subject erasure (DPDP/PDPL right-to-erasure) removes or
neutralizes its rows. This is the written mapping the foundation synthesis flagged as missing
(`00-foundation-synthesis.md:170`) — the lake tiers are hash-only *by design*, so "key destruction across
bronze/silver/gold" is satisfied **indirectly** and that indirection is documented below.

## Crypto-shred model (how erasure works here)

- **Per-brand + per-subject envelope encryption.** Raw PII lives ONLY in `contact_pii` (PG), sealed under a
  per-subject DEK wrapped by a per-brand keyring in the KMS-backed PII vault. Migrations: `0115`
  (`shred_subject_keyring`), `0100` (`erase_contact_pii_for_customer`).
- **Erasure = key destruction, not row-by-row scrubbing.** `EraseSubjectUseCase` runs the ordered 6-step
  sequence (shred the subject keyring → erase `contact_pii` → tombstone → scoped re-projection → CAPI
  delete → FORCE-RLS audit; idempotent, DLQ). Once the DEK is destroyed the raw PII is unrecoverable.
- **Lake tiers (Bronze/Silver/Gold) are HASH-ONLY.** Every identifier in Iceberg/Neo4j/Redis is a 64-hex
  hash `sha256(salt ‖ normalized)` (per-brand salt) or an interop `pre_hashed_*` sha256 — never raw PII.
  A hash is not reversible without the value; destroying the subject's `contact_pii` + keyring severs the
  hash↔person link, so the lake rows become **unlinkable** (the accepted "indirect" satisfaction). Tables
  that also need row removal (e.g. Neo4j identity nodes) are handled by the scoped re-projection step.
- **`brand_id`-first tenancy.** Every subject-linked row carries `brand_id`; erasure is always brand-scoped.

Legend — **Erasure**: `unlinkable` = hash-only, neutralized by keyring destruction (no row delete needed);
`reproject` = removed/rewritten by the scoped re-projection step; `delete` = explicitly deleted.

## Registered subject-linked tables

### Pre-Wave-A (baseline, for completeness)
| Table | Store | Subject key | Key-envelope | Erasure |
|---|---|---|---|---|
| `contact_pii` | PG | `brain_id` | per-subject DEK (the vault) | `delete` + DEK shred (SoR of raw PII) |
| `silver_identity_map` | Iceberg | `identifier_hash → brain_id` | none (hash-only) | `unlinkable` + `reproject` (Neo4j re-export) |
| Neo4j `Customer`/`Identifier` | Neo4j | `brain_id` / `identifier_hash` | none (hash-only) | `reproject` (scoped delete on erase) |
| `identity_audit` | PG | `brain_id` | none (hash-only detail) | retained (FORCE-RLS audit ledger) |

### Wave A additions (A.1–A.4) — registered by this change
| Table | Store | Subject key | Key-envelope | Erasure |
|---|---|---|---|---|
| `silver_session_identity` | Iceberg | `brand_id`, `brain_id`, `session_id`(=`brain_anon_id:session_id_raw`) | none (hash-only; `brain_anon_id` is a salted hash) | `unlinkable` + `reproject` (rederived from map on re-stitch) |
| `silver_stitch_conflicts` | Iceberg | `brand_id`, `candidate_brain_ids[]`, `identifiers[]` (all hashes) | none (hash-only) | `unlinkable` + `reproject` |
| `silver_probabilistic_stitch` | Iceberg | `brand_id`, `probabilistic_brain_id`, `session_id` | none (hash-only; QUARANTINED, never in attribution/revenue) | `unlinkable` + `reproject` |
| `silver_identity_map` (new cols `system_from`/`system_to`) | Iceberg | as above | none (bi-temporal validity only; no new PII) | inherits `silver_identity_map` |
| `ops.restitch_pending` | PG | `brand_id`, `dirty_key` (`identifier_hash` or `brain_id`) | none (hash-only dirty-set) | `delete` (transient queue; drained each run) |
| `ops.stitch_conflict_review` | PG | `brand_id`, `brain_id_a`, `brain_id_b`, `evidence`(hashes) | none (hash-only evidence, FORCE-RLS) | `reproject` (delete open reviews for the erased subject) |

Redis (non-table, for completeness): `{brand_id}:tp:{brain_id}` touchpoint zset (A.4) — hash-only, 30d TTL,
and DELeted for the absorbed key on merge/unmerge; erasure removes the subject's key in the re-projection
step. `{brand_id}:restitch:pending` dirty-set — transient, hash-only.

<!-- SPEC: B.2 — Wave B journey re-version ledger + dirty-set (invariant 3). -->
### Wave B additions (B.1–B.5) — registered by this change
Two NEW subject-linked artifacts land with Wave B's versioned journey ledger. Both are `brain_id`-grain,
hash-only (no raw PII, no identifier hashes — `brain_id` is an opaque UUID, I-S02), and both are
flag-gated on `journey.engine` (default OFF → EMPTY on golden, so flags-OFF is byte-identical).

| Table | Store | Subject key | Key-envelope | Erasure |
|---|---|---|---|---|
| `journey_version_log` | Iceberg (Gold) | `brand_id`, `brain_id`, `to_version` (PK) | none (hash-only; `brain_id` opaque UUID, no PII, no money) | `unlinkable` + `reproject` (audit of re-version transitions, rederived from `silver_identity_map` + `journey_events` on FULL_REFRESH; severed when the subject keyring is destroyed) |
| `ops.journey_reversion_pending` | PG (`ops`) | `brand_id`, `brain_id` (PK) | none (transient dirty-set; `cause`/`trigger_event`/`source_event_id` only) | `delete` (transient queue, drained each Spark reversion run; migration `0125`) |

`journey_events` itself (the versioned event-sourced ledger, B.1) inherits the lake-tier hash-only model:
`brand_id`+`brain_id`(opaque UUID)+touchpoint hash, revenue as `revenue_minor` bigint + `currency_code`,
`attribution_signals` are `utm_*`/click-ids (marketing params, not subject PII) — `unlinkable` + `reproject`
(rebuilt from the Silver spine; superseded versions survive as `is_current=false`, neutralized by keyring
destruction). No new raw PII or un-hashed identifier is introduced (satisfies invariants 2 & 4).

<!-- SPEC: C.2 — Wave C measurement fact tables (invariant 3). -->
### Wave C additions (C.2 measurement facts) — registered by this change
The gold_measurement_* facts are ORDER-linked, HASH-ONLY-by-indirection (they carry `brand_id` + an opaque
store `order_id` — NOT a `brain_id`, a raw contact, an identifier hash, or any PII). Money is `*_minor`
bigint + `currency_code` (never blended/float). Their subject link is purely through the order→customer edge
resolved elsewhere (the lake-tier hash-only model), so — like the ancestral `silver_refund` — they are
neutralized `unlinkable` when the subject's `contact_pii` keyring is destroyed, and `reproject` (rederived
from the Silver spine on FULL_REFRESH). No new raw PII / un-hashed identifier is introduced (invariants 2, 4).

| Table | Store | Subject key | Key-envelope | Erasure |
|---|---|---|---|---|
| `gold_measurement_refunds` | Iceberg (Gold) | `brand_id`, `order_id` (opaque store ref) | none (hash-only-by-indirection; no PII/brain_id) | `unlinkable` + `reproject` (rederived from `silver_refund` + the RTO logistics lane) |
| `gold_measurement_settlements` | Iceberg (Gold) | `brand_id`, `order_id` (opaque) | none | `unlinkable` + `reproject` (rederived from `silver_settlement`) |
| `gold_measurement_fees` | Iceberg (Gold) | `brand_id`, `order_id` (opaque) | none | `unlinkable` + `reproject` (rederived from `silver_settlement`) |
| `gold_measurement_costs` | Iceberg (Gold) | `brand_id`, `order_id` (opaque) | none | `unlinkable` + `reproject` (rederived from cost config + order/line spine) |

NOT subject-linked (registered for completeness, no erasure obligation): `gold_product_costs` (brand×SKU cost
dimension — no subject), `gold_measurement_spend` (a VIEW alias onto `silver_marketing_spend`, day×channel —
no subject), `gold_measurement_inventory` (brand×product×variant stock movement — no subject). None carry a
`brain_id`, identifier hash, or raw PII. The extended `silver_refund` (new taxonomy/lineage columns) inherits
its existing GAP-table posture (opaque refs only; no new PII).

<!-- SPEC: C.3 — Wave C measurement engine (invariant 3). -->
### Wave C additions (C.3 economics) — registered by this change
The NEW per-order/product contribution-margin marts. `gold_order_economics` is `brain_id`-linked (a
subject key), hash-only in the sense that `brain_id` is an opaque UUID (I-S02 — no PII, no raw/hashed
identifier). `gold_product_economics` is product×day grain and carries NO subject key (rolled up away from
`brain_id`), listed here only for completeness. All money is bigint minor units + `currency_code`.

| Table | Store | Subject key | Key-envelope | Erasure |
|---|---|---|---|---|
| `gold_order_economics` | Iceberg (Gold) | `brand_id`, `order_id` (PK); `brain_id` (subject link) | none (hash-only; `brain_id` opaque UUID, money as bigint minor + `currency_code`) | `unlinkable` + `reproject` (fully rederived from `gold_revenue_ledger` + Silver facts each run; `brain_id` inherited from the ledger/`silver_order_state`, which are neutralized by subject-keyring destruction — the economics row's person link is severed transitively) |
| `gold_product_economics` | Iceberg (Gold) | `brand_id`, `product_key`, `econ_date`, `currency_code` (PK) | none (NO subject key — apportioned rollup away from `brain_id`; no PII, no identifier) | `unlinkable` + `reproject` (rederived from `gold_order_economics`; carries no person link) |

`gold_order_economics` introduces no NEW raw PII, no un-hashed identifier, and no new key-envelope
(satisfies invariants 2 & 4): it is a DERIVED mart whose only subject reference (`brain_id`) is copied
from already-registered, keyring-neutralized upstreams (`gold_revenue_ledger`, `silver_order_state`).

### Wave E additions (AI Feature Layer — CONTRACT-E, scaffold-only)
Registered now so the contract is complete; NOTHING is materialized in the scaffold (AMD-19 posture R2:
as-of over Silver/Gold, no precompute table). These become live only when Wave-E logic ships.

| Subject-linked artifact | Store | Subject key | Key-envelope | Erasure |
|---|---|---|---|---|
| `gold_ai_features` (logical PIT EAV, deferred) | Iceberg (logical) | `brand_id`, `entity_type`, `entity_id` (customer→`brain_id`) | none (hash-only entity ids; no raw PII) | `unlinkable` + `reproject` (rederived as-of from the Silver/Gold spine) |
| `{brand_id}:feat:{entity_type}:{entity_id}` online hash | Redis | `brand_id`, `entity_type`, `entity_id` | none (hash-only) | `reproject` (subject key DELeted on erase; cache, not truth) |

PII-flagged FEATURES (registry `pii: true`, `packages/ai-features/features/*.yaml`) join this manifest — a
feature that derives from / exposes subject PII is neutralized by the same subject crypto-shred:
| PII feature | Entity | Derived from | Erasure |
|---|---|---|---|
| `customer_email_domain` | customer | the customer's identifier (email) | `unlinkable` (materialized value keyed to `brain_id`; severed when the subject keyring is destroyed) |

## Notes
- No Wave A table stores raw PII, a monetary column, or an un-hashed identifier (satisfies invariants 2, 4).
- The probabilistic table is quarantined (§1.4 / invariant 5): it never reaches attribution/revenue inputs,
  so its erasure obligation is purely the hash-unlinkability above.
- Follow-up (tracked in `01-delta-plan.md:83`, out of scope for Wave A): step-4 Iceberg snapshot compaction
  is REGISTERED-DISABLED (old snapshots can resurrect shredded hashes until expiry) — a lake-wide concern,
  not specific to these tables.
