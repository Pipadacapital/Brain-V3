# Remediation Plan

Ordered by criticality **and dependency** (an item that unblocks others or whose absence makes other fixes untestable comes first). Three tiers: **Before-Production (P0 blockers)**, **Near-term (P1, before scale)**, **Backlog (P2/P3, tracked)**.

---

## TIER 1 — Before Production (P0 blockers — all must close before any go-live)

These are sequenced so that enforcement and verification come *before* the things they verify.

### Phase 1A — Make it deployable & make the gate real (unblocks everything else)
1. **RISK-001 — Author the deploy substrate.** Dockerfiles for collector/core/stream-worker/web (+ HEALTHCHECK); Helm charts / Kustomize overlays for every ArgoCD app + the litellm gateway; uncomment & apply prod Terraform (network/EKS/RDS/S3); reconcile Helm-vs-Kustomize tooling and fix the image-bump sed. *(Dep: nothing — first.)*
2. **RISK-013 — Wire tests into the release path.** Gate `main.yml` (deploy) on the full test + isolation-fuzz + parity suite; wire Playwright e2e + smoke into a workflow with a `webServer`; make isolation/live tests **fail (not skip)** when datastores are absent (DEBT-D2). *(Dep: nothing — must precede any other "verify" claim.)*
3. **RISK-015 / RISK-016 / RISK-051 — Operability minimum.** Add liveness/readiness HTTP endpoints (incl. stream-worker HTTP port) with real dependency checks; HPA/PDB/resource-limits; uncaughtException/unhandledRejection handlers; make auto-rollback a real alarm→action (or remove the banner claim).

### Phase 1B — Enforce tenant isolation in the database (the highest-RPN cluster)
4. **RISK-002 — Provision NOSUPERUSER `brain_app`** in dev compose + prod RDS; wire `SET ROLE`/least-priv DSN across core, collector (RISK-049), and stream-worker; remove superuser DSNs.
5. **RISK-003 — Fix `@brain/db` GUC**: wrap GUC + query in BEGIN/COMMIT (mirror `metric-engine/withBrandTxn`). *(Dep: must land **with** #4 — fixing #4 alone causes the 0-rows outage F2.)*
6. **Prove it:** an isolation test exercising the real `createPool` path under `brain_app` with `is_superuser=false` asserted, run in CI on the deploy path. *(Dep: #2, #4, #5.)*
7. **RISK-024 / RISK-025 — StarRocks**: fail-closed query gateway (no-sentinel = deny, not no-filter); isProduction guard on the analytics password; managed-cluster engine row policy plan.
8. **RISK-037 / RISK-009 — Unprotected stores**: add RLS + brand_id to `dev_secret` (or drop in prod) and `collector_spool`; add a spool retention/purge job.

### Phase 1C — Make the system observable (you cannot operate what you cannot see)
9. **RISK-004 — Real observability backend.** Replace the stub with OTel + a metrics exporter; serve `/metrics`; point the collector traces at a real backend (uncomment Grafana Cloud); emit RED + consumer-lag + freshness + parity metrics.
10. **Alerting:** burn-rate (multiwindow), freshness, DLQ, consumer-lag, parity alert rules **with a paging target** (RISK-043); at least the SLO + DQ dashboards.
11. **RISK-042 — Structured logs** with correlation IDs on every line and emission-time PII redaction wired in.

### Phase 1D — Stop data loss & fix the dead engines
12. **RISK-008 — Reorder ingest:** durable Bronze write **before** the dedup claim (or write-through dedup).
13. **RISK-009 — Back-pressure:** implement 503 SPOOL_FULL + Retry-After; spool depth cap + shed-on-full; drainer DLQ/skip so one poison row can't block draining.
14. **RISK-039 — Persist retry counters** (DB or Kafka header) so poison messages reach the DLQ across restarts.
15. **RISK-006 — Wire attribution write-side:** call `writeCredit` + reversal hook in the stream-worker composition root; add a "credit-ledger non-empty" DQ alert.
16. **RISK-007 — Wire identity read-time collapse:** a single tenant-scoped `resolveCanonical()` walking the alias chain, used by every brain_id read; add a minimal `valid_to` unmerge setter (GDPR reversibility).
17. **RISK-014 — Guard the clawback:** bound reversal vs saved credit; idempotency on (order, basis); clamp attributed ≥ 0.

### Phase 1E — Compliance honesty (legal exposure)
18. **RISK-010 — Reconcile `COMPLIANCE.md` to reality**: mark Erasure/DSAR/export/WORM/region-routing **DEFERRED** with tracked waivers and reflect true capability in the DPA *before onboarding any subject who can lawfully demand erasure*; prioritize the `pii_ciphertext` KMS vault + a real erasure orchestrator on the build queue.

**Exit criteria for Tier 1:** a service builds, deploys to a real cluster, is probed/monitored/alerted, enforces tenant isolation **proven under `brain_app` in CI**, does not lose events under a DB blip, populates attribution + applies merges, and the Canon no longer overclaims unbuilt controls.

---

## TIER 2 — Near-term (P1, before meaningful scale)

**Data substrate (highest-interest debt):**
- RISK-005 / DEBT-C1 — Begin the Iceberg lakehouse migration (gets harder per event ingested).
- RISK-027 / DEBT-C3 — Build the Bronze→ledger replay path for orders.
- DEBT-C2 — Avro on the wire + enforce Apicurio FULL_TRANSITIVE.
- RISK-026 / DEBT-C4 — Put dbt Silver + the parity oracle in CI.
- RISK-028 — Per-ordering-unit partition key; un-collapse finance/identity topics.

**Scale envelope (pre-1k-brand blockers):**
- RISK-011 / RISK-012 — Work-queue ingest with claim/lease/shard + leader election; shared pool/producer.
- RISK-033 / RISK-034 / RISK-036 — Partition + retention on Bronze/ledgers; PgBouncer + `max_connections` plan; `statement_timeout` + per-tenant query budget.
- RISK-035 — Split consumer groups off the shared topic.

**API contract reconciliation:**
- RISK-020/021/022/023 — Build (or amend the frozen contract for) the `/api/v1/*` + MCP surface, the `{error:{code,message,trace_id,details}}` envelope, Idempotency-Key enforcement + replay cache, correlation-id echo, and per-brand rate limiting incl. `/ask`.

**Identity & attribution correctness:**
- RISK-029 — N-way merge completeness + identifier transfer.
- RISK-030 — Phone-guard decrement on merge; unify the two threshold impls (DEBT-B4).
- RISK-031 — Cross-device stitch beyond one-anon-per-order.
- RISK-032 — Test the reconciliation metric; make the parity oracle window-independent and CI-blocking.

**Security & cost hardening:**
- RISK-041 — Rate limiter alert + degrade behavior.
- RISK-048 — OAuth state to Redis/DB.
- RISK-052 — Audit chain advisory lock; build WORM anchor + chain-walk.
- RISK-053 — DSAR + export; consent-withdrawal propagation.
- RISK-054 — Reflect role demotion before token expiry.
- RISK-044/045/046 — Restore Checkov full set; fix OIDC trust; make `eval.yml` real (NLQ/injection/narration gates).
- RISK-047 — Correct LLM tier routing via gateway; per-tenant virtual-key budget; prompt-cache the stable prefix; token budget + fallback; litellm config in repo; effort-tier CI gate.

**Reliability:**
- RISK-040 — Request timeouts (AbortController) on all connector HTTP clients.
- Circuit breakers on external calls; producer retries/backoff/idempotent (Mediums, board 09).

**Test effectiveness:**
- RISK-050 / DEBT-D1 — Mutation testing + coverage thresholds on money/RLS/compliance/auth.
- DEBT-D3/D4 — De-mock auth replay + RLS tests against real PG.

---

## TIER 3 — Backlog (P2/P3, tracked, not blocking)

- DEBT-A1/A2/A3 — Boundary lint fix; extract the read seam from metric-engine; decompose `bff.routes.ts`.
- DEBT-B1/B2/B3/B5 — Shared webhook HMAC pipeline; `sendError` helper; shared cursor util; auth repo consolidation.
- DEBT-A4/A5 — Remove or implement stub modules; collapse `web/lib/api/types.ts` onto `@brain/contracts`.
- DEBT-E2 — Centralize the salt guard; wire the prod KMS path.
- DEBT-E3 — Currency exponent generalization before GCC onboarding.
- DB-M — UNIQUE(provider, account_id) on connector tables; reconciliation grain/tolerance fix.
- RISK-017 / DEBT-E1 — Executable down-migrations; operational runbooks/playbooks + a DR drill.
- RISK-038 — Renumber the duplicate 0033 migration.
- Compliance residency region-routing + region-tag Checkov gate; breach runbook + PII catalog in CI.

---

## Sequencing note

Tier 1 is genuinely sequential at the phase level: **1A (deployable + real gate) and 1B (isolation enforced + proven) gate everything** — there is no point fixing data loss or wiring engines you cannot deploy, monitor, or trust the tests of. Within 1B, RISK-002 and RISK-003 **must ship together** or the fix to one triggers the failure mode of the other. The realistic critical path is one focused hardening phase delivering Tier 1 end-to-end, with Tier 2 data-substrate and scale work beginning in parallel where it doesn't depend on Tier 1 enforcement.
