# Go / No-Go Recommendation

## Verdict: **NO-GO** for production.

Conditional path to GO: a single focused hardening phase closing the ~12 canonical P0 risks (`95-remediation-plan.md` Tier 1) and reconciling the overclaiming Canon. This is **CONDITIONAL-GO after Tier 1**, not a request for a rewrite — the core is sound; the operational and enforcement layers are not built.

The decision is unanimous across boards that assessed shippability: Database, Security, Reliability, Observability, Testing, DevOps, Production-Readiness, Compliance, and the adversarial Negative review all returned FAIL/BOUNCE. No board found a reason to ship.

---

## The hard questions, answered honestly

**Is Brain production-grade?**
**No.** It cannot build (zero Dockerfiles), deploy (ArgoCD → non-existent manifests), be observed (stub observability, zero alerts), or be rolled back (echo-banner auto-rollback). These are pre-alpha operational gaps, not polish items.

**Is it architecturally correct?**
**Largely yes — the design.** The modular monolith is substantially compliant with its own canon: truth-capture spine, app isolation, metric-engine sole-read-path, no-dashboard/BI/CDP drift. The *enforcement* of those boundaries is partly inert (lint rules can't match the imports used; the engine absorbed a DB seam it was never to own), and the documented data substrate (Iceberg, Avro, typed topics) does not exist. Correct on paper and in the correctness kernel; divergent at the substrate and enforcement layers.

**Is it scalable to 10k brands?**
**No — not on the current footprint.** The single-instance sequential ingest scheduler breaches its 45s SLA in the low hundreds of connectors and "never completes" at 10k; OLTP-as-Bronze is the cost wall by ~500 brands; consumer fanout and connection limits cap ~1k. Reaching 5k–10k requires the deferred work-queue + lakehouse + pooler + managed-OLAP re-architecture. Realistic ceiling today: **~100 brands.**

**Is it secure for enterprise commerce data?**
**No — today.** The auth/token/webhook/secrets/consent spine is genuinely excellent and scanned clean. But tenant isolation is **designed, not enforced**: the app runs as a superuser so FORCE RLS is a no-op, and the GUC middleware never applies the tenant context. The primary isolation control has never been validated under the production role. One missing app-WHERE = cross-tenant breach. This is the single most important fix.

**Is it resilient?**
**Partially.** The structural primitives are right (accept-before-validate spool, offset-after-write, idempotent append-only ledgers). But it fails precisely under the dependencies it should absorb: dedup-before-durable-write drops events on a DB blip, no 503 back-pressure, unbounded spool, in-memory poison-pill counters, no probes/HPA/PDB. The happy path is durable; the failure paths are not.

**Is it maintainable?**
**Mostly yes, with targeted debt.** Healthy DDD structure and strong tests on the money/RLS core, but a 2,538-line BFF god-file, ~1,256 LOC of duplicated webhook HMAC, 250+ hand-rolled error envelopes, and a hand-mirrored contract types file. Maintainable now; the duplication compounds.

**Is it cost-efficient at scale?**
**No.** The lone LLM call defaults to Opus (Tier-4) while labelled Tier-3, with no prompt-cache markers, no per-tenant spend cap, and no gateway config — 1–2 orders of magnitude over budget, unbounded per tenant. DB-side, GUC round-trips double statement load and ~6× consumer-deserialization waste is baked in. The cost-routing "measure from day one" phase-gate is unmet.

**Is it privacy-compliant?**
**No — and the Canon overclaims it.** The consent/suppression half is production-grade. The erasure/access/portability half is unbuilt: PII is plaintext at rest, there is no erasure pipeline, no DSAR, and `COMPLIANCE.md` asserts these as ENFORCED. "Erasure" today is suppression-plus-deletion-request. This is both a build gap and a documentation-integrity (and legal-exposure) gap.

**Is it ready for the next phase?**
**Not yet.** The next phase should be the Tier-1 hardening phase, not new features. The foundations are strong enough that this is a closable gap in one focused phase, not a restart.

---

## What MUST be fixed before production (gating)

1. Deploy substrate: Dockerfiles + charts + prod infra + real rollback (RISK-001/015).
2. Tenant isolation **enforced and proven** under `brain_app`: NOSUPERUSER role + transactional GUC + collector SET ROLE, with a CI isolation test on the real path (RISK-002/003/049).
3. Tests on the release path; isolation/live tests fail-not-skip without datastores (RISK-013).
4. Real observability + alerting with a paging target (RISK-004/043).
5. Probes/HPA/PDB + crash handlers; stream-worker HTTP port (RISK-016/051).
6. Stop event loss: durable-write-before-dedup, 503 back-pressure, bounded/purged spool, persistent poison-pill counters (RISK-008/009/039).
7. Wire the dead engines: attribution write-side + identity read-time collapse + clawback guard (RISK-006/007/014).
8. StarRocks fail-closed gateway + credential guard; RLS on dev_secret/collector_spool (RISK-024/025/037).
9. Reconcile `COMPLIANCE.md` to reality with tracked waivers before onboarding any erasure-capable subject (RISK-010).

## What is deferred-but-tracked (acceptable for a gated launch, must not be silently dropped)

- Iceberg lakehouse, Avro wire, typed-topic catalogue, Bronze→ledger replay (data substrate — Tier 2; begin now, the longer deferred the harder).
- Work-queue ingest, lakehouse, pooler, managed-OLAP row policies (scale — required before ~1k brands).
- `/api/v1/*` + MCP surface, contract envelope/idempotency/rate-limit reconciliation.
- DSAR/export, `pii_ciphertext` vault, audit WORM (compliance build-out, with waivers tracked).
- Mutation testing + coverage thresholds; cost-routing telemetry + per-tenant LLM cap.
- The maintainability debt (BFF decomposition, webhook/error-envelope dedup).

---

## Bottom line

Brain has a rare and valuable asset: a **correctness kernel** (truth capture, money ledgers, identity math, RLS design, and non-tautological tests guarding them) that is genuinely principal-grade. What it lacks is the operational and enforcement scaffolding to run that kernel safely in production — and a Canon that honestly reflects what is and isn't built. Both gaps are closable in one focused hardening phase. **Ship nothing until Tier 1 closes; then re-gate.** The most dangerous thing the team could do is mistake the quality of the *design* for the existence of *enforcement* — because in the database, where it matters most, the enforcement is not there yet.
