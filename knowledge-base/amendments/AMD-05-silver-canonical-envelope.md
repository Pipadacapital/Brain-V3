<!-- SPEC: 0.4 -->
# AMD-05 — "Silver canonical envelope Avro fields" (A.1.4)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** WA-09 (connector identity-field standardization)

## Conflicting spec text
> §A.1.4 "writes `email_sha256`, `phone_sha256`, `platform_customer_id` into the Silver canonical envelope (new optional Avro fields, BACKWARD)."

## Ground truth (delta-plan evidence)
`silver_collector_event` (and the Silver tier generally) is an **Iceberg table**, not an Avro envelope: `payload` is a JSON varchar column. The repo's established additive mechanism is **payload properties + promoted nullable Iceberg columns** — precedent: `anonymous_id`/`device_id` promotion with the widen-backfill MERGE (silver canonicalization gaps program). There is no Avro anywhere in the Silver tier.

## Candidate resolutions
### R1 — Amend the wording to the existing mechanism (adopted)
"Silver canonical envelope" = payload JSON properties + promoted nullable Iceberg columns (widen-backfill MERGE for history). New identity fields ride this mechanism; "optional with defaults" maps to nullable columns.
- Trade-offs: schema evolution of the Silver tier is governed by Iceberg DDL + repo convention rather than a registry-checked Avro artifact; compensated by the Kafka-side artifacts of AMD-03.

### R2 — Introduce a real Avro envelope for Silver
- Trade-offs: a re-architecture of the Silver tier's storage format; violates the additive rule (§0.5) and touches 37+ Spark jobs for zero identity value.

## RECOMMENDED resolution (BINDING)
**R1.** Purely a wording ratification of the mechanism the codebase already uses additively; R2 is non-additive by construction.
