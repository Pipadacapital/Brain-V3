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

## Notes
- No Wave A table stores raw PII, a monetary column, or an un-hashed identifier (satisfies invariants 2, 4).
- The probabilistic table is quarantined (§1.4 / invariant 5): it never reaches attribution/revenue inputs,
  so its erasure obligation is purely the hash-unlinkability above.
- Follow-up (tracked in `01-delta-plan.md:83`, out of scope for Wave A): step-4 Iceberg snapshot compaction
  is REGISTERED-DISABLED (old snapshots can resurrect shredded hashes until expiry) — a lake-wide concern,
  not specific to these tables.
