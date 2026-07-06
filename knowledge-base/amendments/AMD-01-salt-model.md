<!-- SPEC: 0.4 -->
# AMD-01 — Salt model for identifier hashing (A.1.3 / §1.3)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** WA-06 (packages/identity-normalization), WA-09 (connector rewiring), WA-10 (hash backfill), WA-16 (stitch keys)

## Conflicting spec text
> §A.1.3 "Normalization before hashing (uniform pixel + connectors) — Email: trim, lowercase, NFC-normalize, SHA-256 hex. […] Phone: […] SHA-256 hex of E.164 including `+`."
> §1.3 "Pixel hashes client-side (SHA-256, normalized per §A.1.3). Connectors hash in-process before Kafka."

The spec assumes ONE uniform plain (unsalted) SHA-256 convention across pixel and connectors.

## Ground truth (delta-plan evidence)
THREE conventions coexist:
1. **Per-brand SALTED** `sha256(salt || '||' || normalized)` in all 4 connector mappers + Spark twins (`packages/identity-core` `hashIdentifier` :219–227; `db/iceberg/spark/silver/_raw_normalize.py:146`). Cross-brand uncorrelatability is a **tested invariant**.
2. **Plain UNSALTED** sha256 client-side in the pixel (`pixel-asset.route.ts:270–295`), consumed as `pre_hashed_email` strong tier (`extract-identifiers.ts:91,199`).
3. `hash_salted_bytes` for AWB/UTR keys.

**Live bug:** the pixel's unsalted hash can never equal the connectors' salted `hashed_customer_email` — the anon→known bridge is broken in production today.

## Candidate resolutions
### R1 — Ratify the DUAL-CONVENTION + connector dual-write (adopted)
- **Plain sha256 = interop space**: pixel client-side hashes + platform-prehashed values, carried under `identifier_type` `pre_hashed_*`.
- **Per-brand salted = internal space**: connector/Spark internal stitch keys, unchanged.
- Connectors additionally **DUAL-WRITE the plain interop hash** (from raw email/phone they already hold in-process) so pixel identify hashes become joinable with connector identities — this fixes the live broken bridge.
- Resolver keeps the two spaces as distinct identifier tiers; no existing key is rewritten.
- Trade-offs: two conventions to document and test forever; interop space loses cross-brand uncorrelatability for those specific hash values (accepted — the pixel already emits them unsalted, and they never leave tenant scope).

### R2 — Migrate everything to uniform plain sha256 (spec verbatim)
- Trade-offs: orphans every existing salted stitch key (breaking, violates §0.5), destroys the tested cross-brand-uncorrelatability invariant, and salting is impossible client-side anyway — so uniform-SALTED is equally rejected by symmetry.

## RECOMMENDED resolution (BINDING)
**R1.** Invariant-preserving (no existing key or tested property is broken) and strictly additive (dual-write adds a field; nothing is rewritten). Uniform-plain and uniform-salted are both rejected on the evidence above. The interop hash lands in the unified pixel build per WA-03; WA-06/WA-09/WA-10 implement against this dual-convention.
