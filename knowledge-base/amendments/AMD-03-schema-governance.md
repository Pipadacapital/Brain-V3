<!-- SPEC: 0.4 -->
# AMD-03 — Schema governance posture (§1.7)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** WA-05 (Apicurio governance fixes), WA-07 (pixel.identify.v1), WA-15 (map-mutation lane), Wave I envelopes

## Conflicting spec text
> §1.7 "Every Kafka topic payload has an Apicurio-registered Avro schema, compatibility BACKWARD. New fields optional with defaults."

## Ground truth (delta-plan evidence)
- Live Apicurio holds **1 artifact** (collector.event.v1, AVRO) and **NO compatibility rule** (`/admin/rules` = `[]` despite the compose env requesting FULL_TRANSITIVE — the env var provably does not materialize a rule; registry is in-mem).
- Repo-wide doctrine is **FULL_TRANSITIVE** (packages/events + compose config).
- ~48 other topics are JSON + zod contracts only.
- `validateSchemaCompatibility` hits a nonexistent endpoint and treats 404 as "compatible" (packages/events/index.ts:130–136) — a silent no-op **bug**.
- Naming: `{env}.{domain}.{name}.v{N}` (+ the unversioned `{env}.brain.{entity}` exception).

## Candidate resolutions
### R1 — FULL_TRANSITIVE doctrine + ratified JSON+zod for non-collector lanes (adopted)
- **FULL_TRANSITIVE** is the compatibility doctrine for Apicurio-registered artifacts (matches packages/events + compose; strictly stronger than the spec's BACKWARD, so §1.7's intent is preserved and exceeded).
- **JSON + zod remains sanctioned** for the existing non-collector lanes (no wholesale migration).
- **NEW identity/action program topics** (pixel.identify.v1, the AMD-08 map-mutation lane, action.*.v1) get **registry-registered JSON Schema artifacts** under the FULL_TRANSITIVE rule, following the `{env}.{domain}.{name}.v{N}` naming convention.
- The compat-rule creation becomes an **idempotent boot step via REST** (env var is insufficient), and the `validateSchemaCompatibility` 404→pass no-op is a **Wave A fix item (WA-05 rail)** — a bug fix, not an amendment.
- Trade-offs: two serialization regimes persist; governance strength depends on the boot step actually running (hence idempotent + tested).

### R2 — Wholesale Avro + BACKWARD migration of all ~48 topics (spec verbatim)
- Trade-offs: enormous out-of-scope churn across every producer/consumer, weaker compat mode than the repo already targets, high regression risk for zero identity/measurement value.

## RECOMMENDED resolution (BINDING)
**R1.** Invariant-preserving (compat guarantee ≥ spec's BACKWARD), additive (new artifacts only; existing lanes ratified as-is), and it converts the registry from decorative to enforcing.
