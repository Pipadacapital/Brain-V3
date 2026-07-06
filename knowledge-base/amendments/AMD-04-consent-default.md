<!-- SPEC: 0.4 -->
# AMD-04 — Consent default for identity capture (A.1.2 / §1.3)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** WA-08 (per-brand consent config)

## Conflicting spec text
> §A.1.2 "Per-brand config: `{identity_capture: 'off'|'explicit_only'|'autodetect', consent_source: 'cmp_signal'|'assume_granted'}`. Default `off`."
> §1.3 "Consent gating: pixel identity capture only when the brand's consent config permits (§A.1.2). Default OFF per brand."

## Ground truth (delta-plan evidence)
- The shipped posture is `PIXEL_CONSENT_DEFAULT=granted` — a collector-wide env default (pixel-asset.route.ts:142–164, :552), deliberately load-bearing for CMP-less stores (see pixel-iceberg-pipeline-live memory: R3 quarantined ALL pixel traffic until this default was set).
- Consent enforcement in Silver is presence-quarantine only (ABSENT consent_flags → silver_consent_rejected; silver_collector_event.py:224–243) — a denied VALUE (`analytics:false`) currently passes.
- Per-brand consent columns do not exist on tenancy.brand.

## Candidate resolutions
### R1 — Per-brand config with migration seeding current behavior (adopted)
- Add the per-brand config columns; the migration **SEEDS every EXISTING brand to its current effective behavior** (identity capture on, `consent_source='assume_granted'`) so no live install goes dark.
- **NEW brands default `off`** per spec.
- Add the Silver denied-VALUE drop for identifies (+ test) alongside the existing presence-quarantine.
- Trade-offs: existing brands are grandfathered into a posture the spec calls non-default; requires an explicit, auditable seed migration.

### R2 — Flip the default OFF globally (spec verbatim)
- Trade-offs: zeroes pixel identity data for every live install the moment the flag ships; a silent, non-reversible data-loss regression for CMP-less stores; violates "no event loss".

## RECOMMENDED resolution (BINDING)
**R1.** Additive (new columns + seed; no live behavior changes at migration time) and invariant-preserving (spec's default-off applies to all NEW brands; consent enforcement gets strictly stronger via denied-value drop).
