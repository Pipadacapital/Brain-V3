# Brain Engineering Excellence Audit — Executive Summary

**Audience:** CTO / Founders / Board
**Scope:** 16 specialist review boards across architecture, data, identity, attribution, security, reliability, scalability, observability, testing, CI/CD, production-readiness, compliance, plus an adversarial negative review.
**Verdict in one line:** **The truth-capture core is principal-grade engineering; the substrate it runs on cannot be deployed, observed, or operated as documented. NO-GO for production today.**

---

## Overall posture

Brain is two systems wearing one repo.

**The correctness core is genuinely excellent — and the audit confirms it is not theater.** Money is integer-minor-unit with banker's rounding and golden fixtures; the realized-revenue and attribution-credit ledgers are append-only-by-GRANT with deterministic idempotent writes; RLS is `ENABLE + FORCE` with two-arg fail-closed policies and self-verifying migration-time assertions; the metric-engine is the sole read path and NLQ narrates engine numbers rather than computing them; the consent / can_contact() suppression gate is default-closed; the highest-stakes tests run under a real `brain_app` NOSUPERUSER role with working RED proofs and a tolerance-0 parity oracle. The adversarial board explicitly tried to find inert/superuser-bypassed isolation tests and confirmed they are real. **The vision is intact: this is a Commerce OS truth system, not a dashboard/BI/CDP clone.**

**The operational substrate is pre-alpha dressed as a production pipeline.** It cannot build (zero Dockerfiles), cannot deploy (every ArgoCD app points at Helm charts / Kustomize overlays that do not exist), cannot be observed (the entire `@brain/observability` package is a stub emitting to `console.info` with no-op spans, zero OTel/Prometheus/Sentry dependency), cannot be rolled back (auto-rollback is an `echo` banner over an alarm with no actions and no metrics behind it), and — most seriously — **does not actually enforce in the database the tenant isolation it so carefully designed**: the app connects as a table-owning superuser in both dev and prod IaC, and the OLTP RLS GUC middleware issues `SET LOCAL` outside any transaction, so every FORCE-RLS policy is inert for the running application.

Net: the hard intellectual problems (truth, money, identity math, isolation *design*) are solved well; the operational and enforcement layers that turn that design into a running, monitorable, multi-tenant-safe product are largely unbuilt — and several governing requirement docs and the ratified `COMPLIANCE.md` overclaim them as live.

---

## The 7 things that matter most

1. **The product cannot deploy or run as committed.** Zero Dockerfiles; every ArgoCD Application (core/web/stream-worker/collector, plus the litellm gateway) resolves to non-existent manifests; no probes/HPA/PDB/resource-limits; prod Terraform has network/EKS/RDS/S3 commented out. Confirmed independently by the DevOps, Production-Readiness, and Negative boards. *(RISK-001)*

2. **Tenant isolation is designed but not enforced in the database.** App connects as superuser (`brain:brain` dev, `brainadmin`-only prod RDS) → FORCE RLS is bypassed unconditionally; and `@brain/db` runs `SET LOCAL` outside a transaction so even under `brain_app` the GUC never applies → reads fail-closed to 0 rows. Isolation today rests entirely on application `WHERE` clauses. One missing predicate = full cross-tenant read of revenue/PII/consent. *(RISK-002, RISK-003)*

3. **The system is blind in production.** Observability is a Sprint-0 stub; no metrics are emitted, traces are no-ops and the collector exports to `debug` only, Prometheus scrapes ports nothing serves, no dashboards exist, and not a single alert rule lives in the repo. An ingest SLO breach, freshness staleness (the heart of Brain's honest-data promise), DLQ/lag backlog, or a per-brand outage are all silently undetectable — first signal is a customer report. *(RISK-004)*

4. **The documented data substrate does not exist.** Bronze is Postgres, not the Iceberg lakehouse the canon sells as the source of truth; events are produced as JSON, not Avro (Apicurio registration is decorative); the typed-topic catalogue is collapsed to one JSON topic keyed so per-order ordering is not delivered; the order Silver mart is built from the OLTP ledger, not Bronze, with no replay path. Much is honestly self-documented as a Phase-1 fallback — but docs 03/07 still present it as shipped. *(RISK-005)*

5. **Two of Brain's headline value engines are wired to nothing.** The attribution credit write-side (`writeCredit`, the reversal hook) has zero production callers → `attribution_credit_ledger` is empty and every attribution surface returns all-unattributed; and `brain_id_alias` is write-only — no reader re-points merged identities, so merges never merge and every merged customer double-counts silently, with no unmerge path (a DPDP reversibility liability). *(RISK-006, RISK-007)*

6. **Reliability breaks precisely under the failures it's meant to absorb.** The Redis dedup slot is claimed *before* the durable Bronze write, so any transient Postgres blip permanently drops in-flight events; the contractual 503 SPOOL_FULL back-pressure path does not exist (bare 500 → pixel SDKs drop data); the collector spool is unbounded, un-RLS'd, PII-bearing, brand-id-less, and never purged — it fills shared RDS and takes down all tenant write paths first. *(RISK-008, RISK-009)*

7. **The Canon overclaims compliance controls that are not built.** `COMPLIANCE.md` (the VETO surface) asserts as ENFORCED an erasure crypto-shred pipeline, a `pii_ciphertext` KMS vault, audit WORM anchor + chain-walk, DSAR/export, and region-routing — none of which exist (PII is plaintext-at-rest; no erasure path; DSAR returns nothing). "Erasure" today is suppression-plus-deletion-request, not destruction. The platform's own doc 13 is honest that these are deferred; the Canon is not. *(RISK-010)*

---

## Headline counts

| Severity | Raw findings (16 boards) |
|---|---|
| **Critical** | **33** |
| **High** | **63** |
| **Medium** | **66** |
| **Low** | **36** |
| **Total** | **198** |

The 33 raw Criticals collapse to **~12 distinct root causes** (the deploy substrate, the RLS/superuser seam, and the observability stub each surface on 3–5 boards). See `90-master-risk-register.md` for the de-duplicated canonical risks.

**Blocking work:** ~12 canonical P0 risks and ~30 canonical P1 risks gate production. See `95-remediation-plan.md`.

---

## Bottom line

**Do not ship.** Brain is not production-grade today, but the gap is overwhelmingly in **enforcement and operations, not in design or core correctness** — which is the cheaper gap to close. The truth-capture spine, money ledgers, identity math, RLS *policies*, and the tests guarding them are assets worth protecting. What is missing is the boring, load-bearing 20%: Dockerfiles + charts, a NOSUPERUSER role wired through a transactional GUC, a real observability backend with alerts, the attribution/identity read-paths wired in, back-pressure + bounded spool, and an honest reconciliation of `COMPLIANCE.md` to reality.

A realistic path to a credible production conversation is **one focused hardening phase** that closes the ~12 canonical P0s (deploy substrate, isolation enforcement proven under `brain_app`, observability + alerting, wiring the dead engines, back-pressure) and reconciles the overclaiming docs. Until then: **NO-GO.** The single most dangerous posture is the current one — believing the careful isolation *design* means isolation is *enforced*. It is not.
