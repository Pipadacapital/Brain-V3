# Phase 5 — Final Audit Report: Brain Platform (Synthesis)

**Date:** 2026-07-11
**Inputs:** `00-discovery.md` (Phase 0), `01-architecture-gaps.md` (Phase 1), `02-implementation-findings.md` (Phase 2), `03-infra-findings.md` (Phase 3), `04-operational-gaps.md` (Phase 4), plus the Wave-1 remediation completion results (2026-07-11 ~18:40–18:55 UTC: 5 ArgoCD syncs, Trino views apply, Bronze e2e verification, GH build status).
**Scope of this document (audit protocol §8):** executive summary + health score, full findings register with statuses, prioritized remediation backlog in waves, implementation plan with milestones/effort/rollback. **No remediation was performed in this phase.**
**Honesty note:** every finding carries its original MEASURED/HYPOTHESIS tag. HYPOTHESIS items are listed explicitly in §5 — they are inferred from code/config and have NOT been proven live; several require a staged replay or a drill to confirm.

---

## 1. Executive summary

### 1.1 Overall health score: **52 / 100** — "Serving HTTP, not yet serving truth."

**Justification (what pulls the score up):**
- The **code core is genuinely strong and verified by execution**: 27/27 Bronze/Silver invariants, 24/25 identity, 60/60 money/measurement (exact-integer, closed-sum, 3-decimal-currency-proven), 19/19 scaffold-flag fail-closed checks; hexagonal boundaries mechanically enforced; zero `@ts-ignore` in production code (Phase 1 §4, Phase 2 V1–V3).
- **Infra baseline is clean**: committed IaC matches applied AWS state, IRSA NN-3 trust exact, S3 posture exemplary (KMS, TLS-deny, WORM audit bucket), digest-pinned GitOps, metrics-server + all HPAs now live (AUD-INFRA-009/020/026/034).
- **No event loss so far**: the Wave-1 e2e proved collector → spool → drainer → Kafka works in prod (first event accepted, spooled, drained), and the durability design held even with Bronze landing down — the test event is safe in Kafka.

**Justification (what pulls the score down):**
- **The product's first promise — Capture Truth — is not happening.** Bronze landing is fully down (all 10 Connect sink tasks FAILED on an IRSA trust mismatch, AUD-W1-001), the medallion Silver/Gold tiers have never been built in prod (AUD-LIVE-2), all scheduled Spark workflows Error on a missing ServiceAccount (AUD-LIVE-3 residual), and the serving layer has 1 of 60 views. Kafka's 7-day retention turns this from "delay" into a **data-loss countdown**.
- **Detection and escalation are dead**: Alertmanager routes everything to the null receiver (AUD-INFRA-027), the sole Bronze writer emits zero metrics (AUD-INFRA-028), the pipeline-stall alert keys on a deleted metric (AUD-INFRA-029), Trino is unscraped (AUD-INFRA-030). Two warnings are firing right now into /dev/null.
- **Privacy is components-not-a-system**: the RTBF orchestrator is unreachable (no producer of its trigger event), Bronze raw-PII erasure has zero invokers, the 7-day raw-retention TTL is unscheduled, and zero erasures have ever run in prod (AUD-OPS-036/037/038/039/040).
- **Cost and DR are misrepresented to the operator**: real spend is ~$850–990/mo (2× the $500 target) fully masked by credits with an inert budget (AUD-OPS-027); the identity system of record (Neo4j) has zero backups of any kind (AUD-OPS-012); the documented migration path destructively wipes every schema (AUD-OPS-017).

A score in the 50s reflects a platform whose engineering quality would merit 80+ if its production wiring, detection, privacy path, and operational guardrails matched the quality of its code. They currently do not.

### 1.2 Top 10 findings

| # | ID(s) | One-liner | Severity |
|---|---|---|---|
| 1 | **AUD-W1-001** (new, from Wave-1 verification) | Bronze landing is fully down: all 10 Kafka Connect Iceberg sink tasks FAILED — SA `kafka:kafka-connect-prod-kafka-connect` is annotated with role `brain-prod-spark-jobs` whose IRSA trust policy rejects it (`sts:AssumeRoleWithWebIdentity` 403). Events are durable in Kafka but the 7-day topic retention is a data-loss deadline. | CRITICAL |
| 2 | **AUD-LIVE-2 / AUD-LIVE-3 / AUD-W1-003** | The medallion still does not exist in prod (no `brain_silver`/`brain_gold`; 59/60 Trino views skipped on missing schemas) and every scheduled Spark workflow Errors on the missing `argo/brain-jobs` ServiceAccount — dashboards are empty shells and will stay stale even after first fill. | CRITICAL |
| 3 | **AUD-INFRA-027** | Alertmanager routes ALL alerts to the null receiver — 30+ SLO rules (and 2 currently-firing warnings) reach no human; a collector-shedding or event-loss event would notify no one. | CRITICAL |
| 4 | **AUD-OPS-036/037/038** | RTBF is not wired end-to-end: nothing produces the erasure trigger event, Bronze raw-PII erasure throws NotImplementedYet with a caller-less Spark job, and the 7-day raw-lane PII retention job is unscheduled — deletion does not actually happen. | CRITICAL |
| 5 | **AUD-OPS-027/028** | Real spend ~$850–990/mo (≈2× the $500 target) is invisible: credits net the bill to $0 and the only budget has `IncludeCredit:true`; $432/mo of it is the EKS 1.32 extended-support surcharge ($360/mo avoidable via 1.33). | CRITICAL |
| 6 | **AUD-OPS-012** | Neo4j — the identity system of record — has zero backups of any kind (no dumps, no EBS/DLM snapshots, no AWS Backup); RPO is effectively infinite. | CRITICAL |
| 7 | **AUD-OPS-017** | The canonical prod DB-migration procedure is an untracked script that DROPs every schema, and the committed chart comment points operators at it while GO-LIVE documents the opposite mechanism — one routine migration away from wiping prod once tenants exist. | CRITICAL |
| 8 | **AUD-INFRA-001/002** | The next routine `terraform apply` deletes the Redis-from-EKS SG rule (guaranteed cache outage), and the 3 Kafka broker data PVCs are live ArgoCD prune candidates — the committed guard verifiably never propagated (confirmed again by the Wave-1 strimzi sync). | HIGH |
| 9 | **AUD-INFRA-028/029/030** | The data spine is detection-blind: Connect emits zero metrics (both Bronze alerts can never fire), BrainIngestStale keys on a metric deleted at the ADR-0010 cutover, Trino and freshness are unscraped. | HIGH |
| 10 | **AUD-INFRA-021/022/025** | Flat pod network (zero NetworkPolicies), no Pod Security Admission / securityContexts anywhere, and the public collector accepts unauthenticated events with attacker-chosen `brand_id` (empty origin allowlist, no install_token→brand binding) — a cross-tenant injection surface on the internet. | HIGH |

### 1.3 Wave-1 completion — what actually closed (do not re-open)

The Wave-1 execution (2026-07-11) produced these verified outcomes, incorporated into the register below:

- **CLOSED — AUD-LIVE-1:** metrics-server live, all 5 HPAs resolving real utilization (also confirmed independently by Phase 3 AUD-INFRA-034).
- **CLOSED — AUD-SEC-1:** EKS API back to pinned /32, committed (Phase 3 confirmed).
- **CLOSED (resolved-by-verification) — AUD-LIVE-4:** Bronze landing verification executed. Result: **broken** — superseded by the new, sharper AUD-W1-001. The collector→Kafka half of the path is verified GOOD (AUD-W1-002, positive).
- **PARTIALLY CLOSED — AUD-LIVE-5:** `kube-prometheus-stack-prod` → Synced/Healthy (Bronze alert rules confirmed live in-cluster); `aws-load-balancer-controller-prod` → Synced/Healthy (webhook-cert ignoreDifferences guard worked). `neo4j-prod` and `external-secrets-config-prod` synced Successfully but remain cosmetically OutOfSync (ArgoCD v2.13 defaulted-field/SSA diff artifacts + 3 stale out-of-band `force-sync` annotations) → residual tracked as AUD-INFRA-003. `strimzi-kafka-prod` synced Successfully but its 3 Kafka data PVCs remain prune candidates with NO guard annotations live → residual tracked as AUD-INFRA-002.
- **PARTIAL — AUD-LIVE-2:** `run-trino-views.sh` ran clean and idempotently: `brain_serving` schema created, 1 view applied (Bronze lift), 59 skipped on missing `brain_silver`/`brain_gold` — re-run after Silver/Gold exist.
- **PARTIAL — AUD-LIVE-3:** CronWorkflows are now deployed (14 present in `argo` ns per Phase 2/4 evidence) but every run Errors on the missing `argo/brain-jobs` ServiceAccount (AUD-W1-003).
- **Operational note (not a finding):** GH build run 29160830209 was still in_progress at synthesis time (spark-bronze arm64 build; 4/5 jobs completed as not-affected). It will push a **second** spark digest; the locally-built `sha256:7eb800b4…` is already pinned in `infra/helm/cronworkflows/values-prod.yaml` — **either digest is fine, do not double-bump.**

---

## 2. Full findings register

Legend — **Status:** OPEN / CLOSED / SUPERSEDED (folded into the referenced ID; not separately counted) / MERGED / PARTIAL (some sub-scope closed) / POSITIVE (verified-good, no action). **Wave:** remediation wave assignment (§3). Severity and MEASURED/HYPOTHESIS tags are from the source phase.

### 2.1 Phase 1 — Architecture & live-prod (AUD-LIVE / AUD-OPS-001..011 / AUD-SEC / AUD-JE / AUD-ID / AUD-TP / AUD-SL / AUD-OBS / AUD-COST)

| ID | Sev | Finding (one-line) | Tag | Status | Wave |
|---|---|---|---|---|---|
| AUD-LIVE-1 | CRIT | metrics-server missing → autoscaling dead | MEASURED | **CLOSED** (Wave-1; re-confirmed AUD-INFRA-034) | — |
| AUD-LIVE-2 | CRIT | Medallion (Silver/Gold/serving) never initialized in prod | MEASURED | **OPEN (PARTIAL)** — brain_serving schema + 1/60 views applied; blocked on W1-001 + W1-003 | 1 |
| AUD-LIVE-3 | CRIT | Spark pipeline not scheduled | MEASURED | **OPEN (PARTIAL)** — 14 CronWorkflows now deployed; all runs Error on missing `argo/brain-jobs` SA (→ AUD-W1-003) | 1 |
| AUD-LIVE-4 | CRIT | Bronze landing unverified | HYPOTHESIS | **CLOSED (resolved by verification)** → superseded by AUD-W1-001 (verified BROKEN) | — |
| AUD-OPS-001 | HIGH | No PodDisruptionBudgets on any app workload | MEASURED | OPEN | 2 |
| AUD-OPS-002 | HIGH | No topologySpreadConstraints/anti-affinity | MEASURED | OPEN | 2 |
| AUD-LIVE-5 | HIGH | 5 ArgoCD apps OutOfSync (GitOps drift) | MEASURED | **PARTIALLY CLOSED** (Wave-1: 2 fully Synced; 3 residuals → AUD-INFRA-002/003) | — |
| AUD-SEC-1 | HIGH | EKS API open to 0.0.0.0/0 | MEASURED | **CLOSED** (pinned /32, committed) | — |
| AUD-JE-34/35 | HIGH | `matched_via` computed but serialized as null on timeline/trace APIs | MEASURED | OPEN | 2 |
| AUD-SEC-2 | HIGH | iceberg-rest logs plaintext JDBC password at startup | MEASURED | SUPERSEDED → AUD-INFRA-023 | 1 |
| AUD-ID-10 | MED | Probabilistic-quarantine guard not in CI | MEASURED | MERGED → AUD-IMPL-008 | 2 |
| AUD-OPS-003 | MED | No probes on kafka-connect/iceberg-rest/pgbouncer | MEASURED | OPEN | 2 |
| AUD-OPS-004 | MED | No terminationGracePeriod/preStop anywhere | MEASURED | OPEN | 2 |
| AUD-TP-22 | MED | RTBF does not bust Redis caches | MEASURED | OPEN | 2 |
| AUD-TP-23 | MED | Kafka retention vs RTBF SLA undocumented | MEASURED | OPEN | 4 |
| AUD-SL-10 | MED | Semantic pre-agg DDL compiled, never materialized | MEASURED | OPEN | 3 |
| AUD-SL-11 | MED | LIMIT-without-keyset on remaining list endpoints | MEASURED | OPEN | 3 |
| AUD-OBS-1 | MED | Freshness exporter not deployed to prod | MEASURED | SUPERSEDED → AUD-INFRA-030 | 2 |
| AUD-OBS-2 | MED | Observability F-items open (structured logging, error backend, OTel export) | MEASURED | OPEN | 3 |
| AUD-OPS-006 | MED | Trino coordinator+worker co-located on one Spot node | MEASURED | OPEN (accepted trade-off; revisit) | 3 |
| AUD-OPS-010/011 | MED | kafka-connect + iceberg-rest single-replica SPOFs | MEASURED | OPEN (alerting half → AUD-INFRA-028) | 3 |
| AUD-COST-1 | MED | Cost telemetry inconclusive ($0 reading) | MEASURED/HYP | SUPERSEDED → AUD-OPS-027 (cause now MEASURED: credits + IncludeCredit) | — |
| AUD-COST-2 | MED | Request over-provisioning skews HPA math | HYPOTHESIS | OPEN | 3 |

### 2.2 Phase 2 — Implementation (AUD-IMPL-001..029; V1–V3 assurance)

| ID | Sev | Finding (one-line) | Tag | Status | Wave |
|---|---|---|---|---|---|
| AUD-IMPL-001 | MED | apps/web has zero route-level error boundaries | MEASURED | OPEN | 3 |
| AUD-IMPL-002 | MED | No typescript-eslint / react-hooks rules (un-awaited promises uncaught) | MEASURED | OPEN | 3 |
| AUD-IMPL-003 | LOW | No process-level unhandledRejection/uncaughtException handlers | MEASURED | OPEN | 3 |
| AUD-IMPL-004 | LOW | `any` on the exported BrainAssetRuntime seam (pixel-sdk) | MEASURED | OPEN | 3 |
| AUD-IMPL-005 | LOW | apps/web disables noUncheckedIndexedAccess | MEASURED | OPEN | 3 |
| AUD-IMPL-006 | LOW | client.ts 2,640-line god-file | MEASURED | OPEN | 3 |
| AUD-IMPL-007 | MED | parseEnv `process.exit(1)` masks 14 core tests (incl. eval-gate) | MEASURED | OPEN | 3 |
| AUD-IMPL-008 | MED | db/iceberg/spark guard suite runs in no CI (2 guards red unnoticed); subsumes AUD-ID-10 | MEASURED | OPEN | 2 |
| AUD-IMPL-009 | MED | gate_admission_guard RED: gokwik order events un-catalogued | MEASURED | OPEN | 2 |
| AUD-IMPL-010 | LOW | Unmerge-reversion guard RED (stale string assertion only) | MEASURED | OPEN | 2 |
| AUD-IMPL-011 | MED | Silver merge_on_pk lacks staleness guard — historical replay regresses entities | HYPOTHESIS | OPEN | 2 |
| AUD-IMPL-012 | MED | Gold full-recompute MERGE never deletes disappeared-PK rows (the +₹0.98 Cr orphan class) | HYPOTHESIS | OPEN | 2 |
| AUD-IMPL-013 | MED | gold_attribution_credit insert-only — re-fold can break per-order closed-sum | HYPOTHESIS | OPEN | 2 |
| AUD-IMPL-014 | MED | Stitch v2 watermark on event time — late/backfilled touches never stitched | HYPOTHESIS | OPEN | 2 |
| AUD-IMPL-015 | LOW | Probabilistic stitch can accumulate multiple brain_ids/session | HYPOTHESIS | OPEN | 3 |
| AUD-IMPL-016 | LOW | test:unit not hermetic in 3 workspaces | MEASURED | OPEN | 3 |
| AUD-IMPL-017 | LOW | Order-economics docstring/validation nits (engine itself verified exact) | MEASURED | OPEN | 3 |
| AUD-IMPL-018 | HIGH | Spark `*_test.py` files baked into prod image AND matched by v4 submit globs (missing pytest ⇒ v4-gold aborts mid-run) | MEASURED | OPEN — **gates first pipeline run** | 1 |
| AUD-IMPL-019 | HIGH | bronze_raw_retention (ADR-0006 D4 raw-PII gate) has no prod CronWorkflow | MEASURED | OPEN — same gap as AUD-OPS-038 (merged; counted once) | 1 |
| AUD-IMPL-020 | MED | journeys/compare endpoint chain has zero consumers | MEASURED | OPEN | 3 |
| AUD-IMPL-021 | MED | StarRocks parity-oracle relics + dead SR_JDBC env plumbing | MEASURED | OPEN | 3 |
| AUD-IMPL-022 | LOW | knip orphans + pixel-sdk entry false-positives | MEASURED | OPEN | 3 |
| AUD-IMPL-023 | LOW | Empty connector scaffold dirs (.gitkeep taxonomy) | MEASURED | OPEN | 3 |
| AUD-IMPL-024 | HIGH | Kafka Connect idles at 79% of memory limit (~375Mi OOM headroom) — sole Bronze writer | MEASURED | OPEN — **do before ingestion ramps** | 1 |
| AUD-IMPL-025 | HIGH | Unpartitioned, forever-retained collector_events_connect forces hourly full-scan + JSON parse | HYPOTHESIS | OPEN | 3 |
| AUD-IMPL-026 | MED | Bronze health BFF endpoints uncached full-scans per request | HYPOTHESIS | OPEN | 3 |
| AUD-IMPL-027 | MED | Medallion runs single-JVM local[*] in 2CPU/4Gi pod (scaling ceiling) — overlaps AUD-OPS-029 | HYPOTHESIS | OPEN | 3 |
| AUD-IMPL-028 | LOW | Neo4j brand purge: label-less scan + one unbounded DETACH DELETE txn | HYPOTHESIS | OPEN | 3 |
| AUD-IMPL-029 | LOW | Insights briefing: 4 sequential Trino probes per cold read | HYPOTHESIS | OPEN | 3 |
| AUD-IMPL-V1/V2/V3 | — | Boundaries/logging, attribution math, JVM/Redis hygiene — verified strong | MEASURED | POSITIVE (no action) | — |

### 2.3 Phase 3 — Infrastructure (AUD-INFRA-001..034)

| ID | Sev | Finding (one-line) | Tag | Status | Wave |
|---|---|---|---|---|---|
| AUD-INFRA-001 | HIGH | Next `terraform apply` deletes the Redis-from-EKS SG rule (inline vs standalone conflict) | MEASURED | OPEN — **block all applies until fixed** | 1 |
| AUD-INFRA-002 | HIGH | Kafka broker data PVCs are live ArgoCD prune candidates; committed guard never propagated (re-confirmed by Wave-1 sync) | MEASURED (gap) / HYP (root cause) | OPEN | 1 |
| AUD-INFRA-003 | MED | 3 apps perpetually falsely OutOfSync (defaulted-field/SSA diffs + stale force-sync annotations) — drift signal unusable | MEASURED | OPEN (Wave-1 root-caused neo4j vct + ESO annotations; fix = ServerSideDiff / ignoreDifferences / annotation removal) | 4 |
| AUD-INFRA-004 | MED | external-dns can mutate ALL hosted zones | MEASURED | OPEN (fold into same apply as 001) | 1 |
| AUD-INFRA-005 | MED | Route53 zone + ACM certs exist outside Terraform; cert ARN hard-coded ×3 | MEASURED | OPEN | 4 |
| AUD-INFRA-006 | MED | cronworkflows-prod bypasses the manual promotion gate (automated+prune) | MEASURED | OPEN | 4 |
| AUD-INFRA-007 | LOW | Imperative deploy Jobs unmanaged; run-migrations.sh foot-gun (script half → AUD-OPS-017) | MEASURED | OPEN | 4 |
| AUD-INFRA-008 | LOW | Housekeeping: /32-only API access fragility, argocd-cm example.com URL, tfvars header lie | MEASURED | OPEN | 4 |
| AUD-INFRA-009 | LOW+ | IaC matches applied prod (baseline) | MEASURED | POSITIVE | — |
| AUD-INFRA-010 | HIGH | Cost Explorer $0 / budget can't fire | MEASURED/HYP | SUPERSEDED → AUD-OPS-027 | — |
| AUD-INFRA-011 | HIGH | Estimated run-rate $580–640/mo over target | HYP ($) | SUPERSEDED → AUD-OPS-027 (refined to $850–990 MEASURED) | — |
| AUD-INFRA-012 | MED | 5 interface endpoints × 3 AZ ≈ $110–140/mo, weak rationale vs fck-nat (= AUD-OPS-031; counted once) | MEASURED | OPEN | 3 |
| AUD-INFRA-013 | MED | Karpenter streaming pool on-demand fallback never re-consolidates to Spot | MEASURED | OPEN | 3 |
| AUD-INFRA-014 | MED | EKS/RDS CloudWatch log groups: no retention (unbounded growth) | MEASURED | OPEN | 3 |
| AUD-INFRA-015 | MED | Single-AZ availability posture (deliberate; record-the-risk) | MEASURED/HYP | OPEN (accepted; documented triggers) | 4 |
| AUD-INFRA-016 | LOW | Stray console SG with world-SSH (attached to nothing) | MEASURED | OPEN | 3 |
| AUD-INFRA-017 | LOW | No rotation on any application secret | MEASURED | OPEN | 4 |
| AUD-INFRA-018 | LOW | iceberg-rest ECR repo lacks lifecycle policy | MEASURED | OPEN | 3 |
| AUD-INFRA-019 | LOW | System MNG on AL2 AMI — blocks EKS 1.33 (prereq for AUD-OPS-028) | MEASURED | OPEN | 3 |
| AUD-INFRA-020 | LOW+ | S3 posture strong across all 4 buckets | MEASURED | POSITIVE | — |
| AUD-INFRA-021 | HIGH | Zero NetworkPolicies — flat pod network | MEASURED | OPEN | 2 |
| AUD-INFRA-022 | HIGH | No PSA labels, no securityContexts on any app workload | MEASURED | OPEN | 2 |
| AUD-INFRA-023 | HIGH | iceberg-rest plaintext-password logging unfixed; credential rotation owed (subsumes AUD-SEC-2) | MEASURED | OPEN | 1 |
| AUD-INFRA-024 | HIGH | Exposed GitHub PAT rotation still pending | HYPOTHESIS | OPEN | 1 |
| AUD-INFRA-025 | MED | Unauthenticated collector ingest + empty origin allowlist → cross-tenant event injection | MEASURED | OPEN | 2 |
| AUD-INFRA-026 | LOW+ | IRSA trust + policy scoping verified strong | MEASURED | POSITIVE | — |
| AUD-INFRA-027 | **CRIT** | Alertmanager routes ALL alerts to null receiver | MEASURED | OPEN | 1 |
| AUD-INFRA-028 | HIGH | Kafka Connect emits ZERO metrics — both Bronze alerts can never fire | MEASURED (absence) | OPEN | 2 |
| AUD-INFRA-029 | HIGH | BrainIngestStale keyed on a metric deleted at ADR-0010 cutover — dead alert | MEASURED | OPEN | 2 |
| AUD-INFRA-030 | HIGH | Trino unscraped; freshness exporter not deployed (subsumes AUD-OBS-1) | MEASURED | OPEN | 2 |
| AUD-INFRA-031 | MED | No OOM-kill alert despite OOM being the dominant historical failure mode | MEASURED | OPEN | 2 |
| AUD-INFRA-032 | MED | Brain Grafana dashboards not provisioned in prod | MEASURED | OPEN | 2 |
| AUD-INFRA-033 | MED | core/web have no ServiceMonitor — app tier unscraped | MEASURED | OPEN | 2 |
| AUD-INFRA-034 | LOW+ | metrics-server/HPAs/scrape targets/Thanos/budget wiring verified healthy | MEASURED | POSITIVE (closes AUD-LIVE-1) | — |

### 2.4 Phase 4 — Operational readiness (AUD-OPS-012..043)

| ID | Sev | Finding (one-line) | Tag | Status | Wave |
|---|---|---|---|---|---|
| AUD-OPS-012 | **CRIT** | Neo4j (identity SoR) has ZERO backups | MEASURED | OPEN | 1 |
| AUD-OPS-013 | HIGH | No DR runbook; RPO/RTO undefined; coordinated Aurora-catalog+S3 restore undesigned | MEASURED/HYP | OPEN | 4 |
| AUD-OPS-014 | MED | Entire backup estate single-region/single-account | MEASURED | OPEN | 4 |
| AUD-OPS-015 | MED | Iceberg time-travel window only ~7d; raw lanes retain 1 snapshot | MEASURED | OPEN | 4 |
| AUD-OPS-016 | LOW | Aurora backup healthy; single-writer availability gap accepted | MEASURED | POSITIVE/ACCEPTED | — |
| AUD-OPS-017 | **CRIT** | Untracked destructive migration script is the referenced canonical path; GO-LIVE documents the opposite | MEASURED | OPEN | 1 |
| AUD-OPS-018 | HIGH | Connect re-registration recovery exists only as an untracked YAML, no runbook | MEASURED | OPEN (commit rider in Wave 1; runbook section Wave 4) | 1 |
| AUD-OPS-019 | HIGH | enable-prod-cron-pipeline.md presents retired dbt/StarRocks as CURRENT | MEASURED | OPEN | 4 |
| AUD-OPS-020 | MED | No re-run/backfill runbook; FULL_REFRESH gotcha undocumented | MEASURED | OPEN | 4 |
| AUD-OPS-021 | MED | No restart-service runbook | MEASURED | OPEN | 4 |
| AUD-OPS-022 | MED | No prod OOM-investigation runbook | MEASURED | OPEN | 4 |
| AUD-OPS-023 | MED | No brand-onboarding playbook (go-live acceptance gate) | MEASURED | OPEN | 4 |
| AUD-OPS-024 | LOW | No per-secret consumer map / coupled-rotation procedure | MEASURED | OPEN | 4 |
| AUD-OPS-025 | LOW | Checkout-pixel runbook verify block uses retired StarRocks commands | MEASURED | OPEN | 4 |
| AUD-OPS-026 | LOW | Runbook index omits 8 of 12 runbooks | MEASURED | OPEN | 4 |
| AUD-OPS-027 | **CRIT** | Real spend ~$850–990/mo (2× target) masked by credits; budget IncludeCredit:true = inert (supersedes AUD-COST-1, AUD-INFRA-010/011) | MEASURED | OPEN | 1 |
| AUD-OPS-028 | HIGH | EKS 1.32 extended-support surcharge $432/mo ($360 avoidable) | MEASURED | OPEN | 3 |
| AUD-OPS-029 | HIGH | Spark local[*] 3g/2CPU single-JVM = first 10× bottleneck (overlaps AUD-IMPL-027) | MEASURED | OPEN | 3 |
| AUD-OPS-030 | MED | stream-worker HPA max 48 unschedulable AND >partitions(12); CPU not lag trigger | MEASURED | OPEN | 3 |
| AUD-OPS-031 | MED | VPC endpoints $140/mo (= AUD-INFRA-012; counted once) | MEASURED | OPEN | 3 |
| AUD-OPS-032 | MED | 10× ceilings: Aurora 2-ACU cap; 555MB Redis fronting OOM-prone Trino | MEASURED | OPEN (pre-agree knobs + tripwires) | 3 |
| AUD-OPS-033 | LOW | Karpenter capacity < sum-of-HPA-max; t4g-only spot pool (no diversity) | MEASURED | OPEN | 3 |
| AUD-OPS-034 | LOW | Kafka sizing adequate for 10× (combined-role spot caveat) | MEASURED | POSITIVE (optional hardening) | — |
| AUD-OPS-035 | LOW | Single fck-nat = sole connector egress, no auto-recovery | MEASURED | OPEN | 3 |
| AUD-OPS-036 | **CRIT** | Erasure orchestrator live but UNREACHABLE — nothing produces its trigger event | MEASURED | OPEN | 1 |
| AUD-OPS-037 | **CRIT** | Bronze Iceberg raw-PII erasure never executed by anything (NotImplementedYet seam; caller-less Spark job) | MEASURED | OPEN | 1 |
| AUD-OPS-038 | HIGH | Raw-lane PII retention TTL job unscheduled in prod (= AUD-IMPL-019; counted once) | MEASURED | OPEN | 1 |
| AUD-OPS-039 | HIGH | UI erase + Shopify redact perform PARTIAL deletion only (no shred/log/surrogate/CAPI/Bronze) | MEASURED | OPEN | 2 |
| AUD-OPS-040 | HIGH | End-to-end deletion never tested; DEK-shred-in-prod unproven | MEASURED (gap) / HYP (shred) | OPEN | 2 |
| AUD-OPS-041 | MED | Silver R3 consent gate has not yet run green in prod — verify silver_consent_rejected | MEASURED | OPEN (definition-of-done for medallion bring-up) | 1 |
| AUD-OPS-042 | LOW | Residency clean — all stores ap-south-1 | MEASURED | POSITIVE | — |
| AUD-OPS-043 | LOW | customers/data_request (DSAR) ack-only, no export pipeline | MEASURED | OPEN (manual runbook first) | 4 |

### 2.5 New findings from Wave-1 verification (AUD-W1-*)

| ID | Sev | Finding | Tag | Status | Wave |
|---|---|---|---|---|---|
| AUD-W1-001 | **CRIT** | **Kafka Connect IRSA trust mismatch — Bronze landing fully down.** All 10 connectors report RUNNING but every sink task is FAILED: SA `kafka:kafka-connect-prod-kafka-connect` is annotated with `arn:aws:iam::380254378136:role/brain-prod-spark-jobs`, whose trust policy does not allow that SA's `sub` → `sts:AssumeRoleWithWebIdentity` 403 → Iceberg coordinator terminates. Test event (correlation_id `wave1-e2e-test-4eeba80f…`) accepted by collector, drained to Kafka, NOT in Bronze (count=0 after 5 min of polling). Events are durable in Kafka (offsets precede the failure) — **no re-send needed after fix, but 7-day topic retention is the loss deadline.** No autoRestart configured; tasks stay FAILED until trust fixed + tasks restarted. | MEASURED | OPEN — top Wave-1 item | 1 |
| AUD-W1-002 | LOW+ | Collector ingest path verified working e2e in prod: POST /collect → 200 accepted → PG spool (X-Spool-Id: 1, first prod event) → drainer → Kafka. | MEASURED | POSITIVE | — |
| AUD-W1-003 | **CRIT** | `argo/brain-jobs` ServiceAccount missing — every scheduled/manual Spark workflow (v4-silver etc.) Errors before pod start. Residual of AUD-LIVE-3; also blocks AUD-LIVE-2 first fill and AUD-OPS-041 verification. | MEASURED | OPEN | 1 |

### 2.6 Register counts (deduplicated)

| Severity | Open | Closed / superseded / merged | Positive (no action) |
|---|---|---|---|
| CRITICAL | **9** (LIVE-2, LIVE-3/W1-003*, W1-001, INFRA-027, OPS-012, OPS-017, OPS-027, OPS-036, OPS-037) | 2 (LIVE-1, LIVE-4) | — |
| HIGH | **23** | 5 (SEC-1, LIVE-5, SEC-2→INFRA-023, INFRA-010/011→OPS-027) | — |
| MEDIUM | **44** | 3 (COST-1, OBS-1, ID-10 merged) | — |
| LOW | **24** | 1 (OPS-038 merged into IMPL-019 line) | 11 (incl. V1–V3, W1-002) |
| **Total** | **100 open** | 11 | 11 |

\* AUD-LIVE-3 and AUD-W1-003 are counted as one open CRITICAL (W1-003 is LIVE-3's concrete residual blocker). Dedupe pairs counted once: AUD-IMPL-019=AUD-OPS-038, AUD-INFRA-012=AUD-OPS-031, AUD-SEC-2⊂AUD-INFRA-023, AUD-ID-10⊂AUD-IMPL-008, AUD-IMPL-027≈AUD-OPS-029 (both kept — different fix surfaces: telemetry vs sizing — counted separately as in source phases).

---

## 3. Prioritized remediation backlog (waves)

### Wave 1 — Remaining CRITICAL: make prod functional, alertable, honest (19 items)

Ordering inside the wave is deliberate: 1–4 restore the data spine before the Kafka retention window burns; 5–8 make failure and cost visible; 9–13 close the wipe/loss/leak foot-guns; 14–19 are same-week riders.

1. **AUD-W1-001** — Fix Connect IRSA: either add `system:serviceaccount:kafka:kafka-connect-prod-kafka-connect` to the `brain-prod-spark-jobs` trust policy or (better) mint a dedicated `brain-prod-kafka-connect` IRSA role scoped to the Bronze S3 prefixes; restart all 10 sink tasks; **verify the wave1 test event flushes to `collector_events_connect`** (it is durable in Kafka — no re-send). Deadline-driven: Kafka retention 7d.
2. **AUD-W1-003 / AUD-LIVE-3** — Create/sync the `argo/brain-jobs` ServiceAccount (+ its IRSA annotation) so CronWorkflows can start pods.
3. **AUD-IMPL-018 + AUD-IMPL-024 + AUD-IMPL-019(=OPS-038)** — Pipeline pre-flight, BEFORE first scheduled run: exclude `*_test.py` from v4 submit globs (+ .dockerignore); bump Connect memory limit/heap; add the `bronze_raw_retention` CronWorkflow (ADR-0006 D4 gate — also first leg of the privacy chain).
4. **AUD-LIVE-2** — First medallion fill: run Phase-1+2 refresh (identity-export → silver → stitch → gold), re-run `run-trino-views.sh` (idempotent; 59 views pending), then **AUD-OPS-041**: verify `silver_consent_rejected` processes no-consent rows (definition-of-done).
5. **AUD-INFRA-027** — Alertmanager: real receiver for severity=critical (Slack/email via ExternalSecret), port the local routing; verify with a synthetic alert.
6. **AUD-OPS-027** — Second AWS Budget with `IncludeCredit=false` (+refunds excluded), 50/80/100% thresholds; confirm email subscription.
7. **AUD-INFRA-001 + AUD-INFRA-004** — One Terraform PR/apply: convert the elasticache SG to standalone rules (re-plan to "No changes") and scope external-dns to zone Z00011362R9ERGL7EC2J9. **No other `terraform apply` may run before this.**
8. **AUD-INFRA-002** — Operator annotates the 3 Kafka data PVCs (`Prune=false,IgnoreExtraneous`); runbook line "never prune-sync strimzi-kafka-prod"; then root-cause why the rendered KafkaNodePool omits the template annotations.
9. **AUD-OPS-017 (+AUD-OPS-018 rider)** — De-fang migrations: guarded reset script (refuses if rows exist), routine job-only script, commit `db-migrate-job.yaml` + `kafka-connect-reregister-job.yaml` + `run-migrations.sh` replacements; fix GO-LIVE step 11.
10. **AUD-OPS-012** — Neo4j backups: DLM daily EBS snapshot today; `neo4j-admin database dump` → S3 CronJob this week.
11. **AUD-OPS-036** — Erasure trigger bridge: one core producer module publishing the canonical erasure event from consent/withdraw(reason=erasure), the identity erase route, and Shopify customers/redact.
12. **AUD-OPS-037** — Argo WorkflowTemplate wrapping `erasure_raw_delete.py` + orchestrator submit adapter (the wave's long pole — L effort; start now, may land early Wave 2).
13. **AUD-INFRA-023 (subsumes AUD-SEC-2)** — Mask the iceberg-rest startup config dump; rotate the `iceberg_catalog` DB password.
14. **AUD-INFRA-024** — Rotate the exposed GitHub PAT; least-scope replacements (ArgoCD read / GITOPS write split).

### Wave 2 — Missing features: correctness, security hardening, detection (24 items)

- **Replay/backfill correctness (all HYPOTHESIS — staged-replay verification first):** AUD-IMPL-011 (Silver staleness predicate), AUD-IMPL-012 (Gold not-matched-by-source DELETE / overwritePartitions), AUD-IMPL-013 (attribution supersede-on-refold), AUD-IMPL-014 (stitch watermark on ingest axis).
- **Guard suite → CI:** AUD-IMPL-008 (subsumes AUD-ID-10) + fix the two red guards AUD-IMPL-009 (GoKwik gate catalog) and AUD-IMPL-010 (stale assertion).
- **Privacy completion:** AUD-OPS-039 (full-sequence erasure from all three entry points) → AUD-OPS-040 (live e2e test + synthetic-subject prod DPDP drill, proving the DEK-shred HYPOTHESIS); AUD-TP-22 (RTBF → cache-invalidate signal).
- **Tenant/ingest security:** AUD-INFRA-025 (EDGE_ORIGIN_ALLOWLIST + install_token→brand_id binding); AUD-INFRA-021 (default-deny NetworkPolicies as an ArgoCD-managed set); AUD-INFRA-022 (PSA `audit=restricted` → `enforce=restricted`; securityContexts in the 4 app charts).
- **Detection restored:** AUD-INFRA-028 (Connect JMX exporter + PodMonitor), AUD-INFRA-029 (rewrite BrainIngestStale for the Connect era; fix stale dbt/StarRocks alert descriptions), AUD-INFRA-030 (freshness exporter deploy + Trino JMX/ServiceMonitor + TrinoDown rule; closes AUD-OBS-1), AUD-INFRA-031 (OOM-kill rule), AUD-INFRA-032 (3 Grafana dashboards), AUD-INFRA-033 (core/web ServiceMonitors).
- **Resilience features:** AUD-OPS-001 (PDBs), AUD-OPS-002 (topologySpread), AUD-OPS-003 (probes), AUD-OPS-004 (grace/preStop).
- **Spec completeness:** AUD-JE-34/35 (`matched_via` serialization on timeline/trace).

### Wave 3 — Optimizations: cost, scale posture, code hygiene (37 items)

- **Cost levers (biggest first):** AUD-OPS-028 (EKS 1.33 upgrade, −$360/mo; prereq AUD-INFRA-019 AL2023 MNG), AUD-INFRA-012/OPS-031 (trim/de-AZ VPC endpoints, −$85–110/mo), AUD-INFRA-013 (streaming pool re-consolidation), AUD-INFRA-014 (log retention), AUD-INFRA-016 (delete stray SSH SG), AUD-INFRA-018 (ECR lifecycle), AUD-COST-2 (right-size requests from live `kubectl top`), AUD-OPS-006 (Trino coordinator placement revisit).
- **Scale posture:** AUD-IMPL-025 (kafka_timestamp watermark + partition spec on collector_events_connect — one-time metadata migration + parity check), AUD-IMPL-026 (cache-wrap Bronze health endpoints), AUD-IMPL-027 + AUD-OPS-029 (per-job wall-time telemetry, defined k8s-executionMode cutover trigger, staging rehearsal; short-term sizing bump in values-prod), AUD-OPS-030 (stream-worker HPA→12 + KEDA lag trigger), AUD-OPS-032 (pre-agreed Aurora ACU / Redis knobs + ACU/eviction tripwire alarms), AUD-OPS-033 (honest HPA maxima or instance diversity), AUD-OPS-035 (fck-nat HA/auto-recovery), AUD-OPS-010/011 (SPOF replica review), AUD-SL-10 (pre-agg materialization cron), AUD-SL-11 (keyset pagination).
- **Code hygiene:** AUD-IMPL-001/002/005 (web fail-safe wave: error boundaries, lint rules, noUncheckedIndexedAccess), AUD-IMPL-003 (process handlers), AUD-IMPL-007 (VITEST-gate parseEnv), AUD-IMPL-016 (hermetic test:unit), AUD-IMPL-017 (economics nits), AUD-IMPL-004/006 (pixel seam typing; client.ts split), AUD-IMPL-015 (probabilistic MERGE key), AUD-IMPL-028 (batched Neo4j purge), AUD-IMPL-029 (briefing probe fan-out), AUD-OBS-2 (structured logging / error backend / OTel export).
- **Cleanup:** AUD-IMPL-020 (journeys/compare decide mount-or-delete), AUD-IMPL-021 (StarRocks relics), AUD-IMPL-022/023 (knip orphans, scaffold dirs).

### Wave 4 — Operational: DR, runbooks, GitOps hygiene, accepted-risk documentation (20 items)

- **DR:** AUD-OPS-013 (DR.md with per-store RPO/RTO + RB-1/RB-2 authored in-repo, then ONE coordinated Aurora-PITR + S3-version-restore fire drill — proves/refutes the restore HYPOTHESES), AUD-OPS-014 (S3 CRR bronze+tfstate — a documented residency decision per AUD-OPS-042), AUD-OPS-015 (SNAPSHOT_TTL 14–30d for the collector lane + version-restore script).
- **Runbooks:** AUD-OPS-019 (SUPERSEDED banner), AUD-OPS-020 (rerun-medallion + FULL_REFRESH rule), AUD-OPS-021 (restart-services), AUD-OPS-022 (investigate-oom), AUD-OPS-023 (brand-onboarding playbook — before the pilot acceptance gate), AUD-OPS-024 (rotation appendix), AUD-OPS-025 (Trino-port verify blocks), AUD-OPS-026 (regenerated index), AUD-OPS-018 residual (reregister recovery section in ADR-0010 runbook), AUD-OPS-043 (manual DSAR runbook), AUD-TP-23 (Kafka-as-transient-transport RTBF policy doc).
- **GitOps/IaC hygiene:** AUD-INFRA-003 (ServerSideDiff + neo4j vct ignoreDifferences + remove the 3 stale force-sync annotations — per Wave-1 root-cause), AUD-INFRA-005 (import Route53/ACM), AUD-INFRA-006 (ratify or remove cronworkflows automated+prune), AUD-INFRA-007 (delete completed one-shot Jobs; guard scripts), AUD-INFRA-008 (SSM access path → private-only API; argocd-cm URL; tfvars header), AUD-INFRA-017 (secret-rotation runbooks/Lambda), AUD-INFRA-015 (document single-AZ triggers).

---

## 4. Implementation plan

### Wave 1 — "Functional, alertable, honest"
- **Milestones:** M1.1 (Day 0–1): Bronze unblocked — IRSA trust fixed, tasks restarted, wave1 test event verified in Bronze. M1.2 (Day 1–2): brain-jobs SA + pipeline pre-flight (test-glob fix, Connect memory, retention cron) + first full medallion fill + 60/60 views + consent-gate verification. M1.3 (Day 2–3): Alertmanager receiver firing a verified synthetic alert; usage budget live; SG/external-dns apply clean ("No changes" re-plan). M1.4 (Day 3–5): Neo4j snapshots + dump job; PVC annotations; migration de-fang committed; PAT + catalog-password rotations. AUD-OPS-037 (Argo erasure WorkflowTemplate) runs as the long pole into week 2.
- **Effort:** ~4–5 engineer-days; all S/M except OPS-037 (L). Hard external deadline: Kafka 7-day retention on the events already produced (clock started ≈2026-07-11 18:42 UTC).
- **Rollback strategy:** Everything is additive or GitOps-tracked. IRSA trust additions revert via Terraform; Connect task restarts are safe (exactly-once via the `control-iceberg` channel — restart cannot double-write). Medallion first fill is idempotent MERGE + idempotent view applier; a bad fill is dropped by re-running (Bronze is untouched source of truth). Alertmanager/budget/cron additions revert by git revert + sync. The SG refactor is the one change requiring care: stage as plan-review with the module change and the standalone rule in the SAME apply so the rule never has a deletion window. PVC annotations are inert metadata. **Explicit prohibitions carried from evidence: never prune-sync `strimzi-kafka-prod`; never Replace-sync `neo4j-prod`; no `terraform apply` before item 7; do not double-bump the spark digest when GH run 29160830209 completes.**

### Wave 2 — "Correct under replay, hard to attack, impossible to fail silently"
- **Milestones:** M2.1: guard suite in CI green (2 red guards fixed). M2.2: MERGE-discipline fixes validated by a staged replay in dev (parity oracle + FULL_REFRESH comparison) before prod merge — these are HYPOTHESIS findings; the replay is the proof. M2.3: erasure e2e drill passes from all three entry points against a synthetic subject in prod, evidence captured (pii_erasure_log). M2.4: detection restored — Bronze stall, Trino down, OOM, freshness all fire to a human; dashboards shipped. M2.5: NetworkPolicies + PSA enforced (audit-mode soak ≥3 days first); PDB/spread/probes/grace live; collector origin/token binding on.
- **Effort:** ~2–3 weeks. Correctness items M/L; hardening items S/M each but sequenced.
- **Rollback strategy:** MERGE/watermark changes ship one-mart-at-a-time behind the staged-replay gate; rollback = git revert + re-run (marts are recomputable from Bronze — the medallion's own recovery property). NetworkPolicies applied namespace-by-namespace default-deny-last; rollback = delete the policy object. PSA runs `audit=restricted` before `enforce`; rollback = relabel. Erasure-path changes are additive producers/consumers; the existing synchronous eraseCustomer stays as the UX fallback. Alert/exporter additions are pure adds.

### Wave 3 — "Cheaper, faster, honest capacity"
- **Milestones:** M3.1: EKS 1.33 (control plane → MNG (AL2023 first, AUD-INFRA-019) → Karpenter AMI roll) — requires Wave-2 PDBs in place; verifies −$360/mo on the now-truthful usage budget. M3.2: endpoint/consolidation/log-retention cost levers land; run-rate re-baselined ≈ $500 target. M3.3: Bronze partition-spec migration + kafka_timestamp watermark with a parity check; health endpoints cached. M3.4: scale tripwires (ACU/evictions/job-duration) + k8s executionMode rehearsed in staging. M3.5: web fail-safe + cleanup PRs.
- **Effort:** ~2–3 weeks elapsed (upgrade serialization dominates); most items S.
- **Rollback strategy:** EKS control-plane upgrades are NOT reversible — mitigate with the staged node-group sequence, PDB-protected rolls, and a pre-upgrade Velero-less fallback of "recreate nodegroup on previous AMI" for the node tiers; do it in a quiet window with Wave-2 alerting live. Partition-spec change: Iceberg metadata migration is transactional; keep the pre-migration snapshot ID recorded — rollback = `rollback_to_snapshot` + revert the watermark commit; parity oracle gates the cutover. VPC endpoint removal/consolidation reverts via Terraform (S3/ECR gateway/interface distinction preserved). Code-hygiene PRs are ordinary reverts.

### Wave 4 — "Provably recoverable, operable by someone who isn't you"
- **Milestones:** M4.1: DR.md + RB-1/RB-2 merged; severity ladder. M4.2: coordinated restore fire drill executed against a THROWAWAY restore target (Aurora PITR to new cluster + S3 version restore of one Bronze table + Trino read verification) — this converts the two restore HYPOTHESES to MEASURED. M4.3: full runbook set (rerun/restart/OOM/onboarding/rotation/DSAR) + regenerated index; stale docs bannered; optional v4-naming-guard extension to docs/. M4.4: GitOps hygiene — ServerSideDiff on, all 25 apps report Synced truthfully; Route53/ACM imported; cronworkflows sync-policy ratified; SSM path then private-only EKS API.
- **Effort:** ~1–2 weeks, mostly S; the fire drill is the only coordination-heavy item.
- **Rollback strategy:** Documentation and drill work carries no production risk by construction (drills restore to NEW resources, never in place). ServerSideDiff is a config flag (revert = remove flag). Terraform imports are state-only operations — verify with `plan` showing no changes before and after; the import itself never mutates AWS.

---

## 5. HYPOTHESIS ledger (honesty section)

These findings are believed-true from code/config reads but have NOT been proven live. Each lists its verification vehicle:

| ID | Hypothesis | Verified by |
|---|---|---|
| AUD-IMPL-011/012/013/014 | Replay/backfill idempotency blind spots (staleness, orphans, attribution re-fold, late-touch stitch) | Wave-2 staged replay + parity comparison in dev |
| AUD-IMPL-015 | Probabilistic stitch multi-brain_id accumulation | Same staged replay (flag-ON fixture) |
| AUD-IMPL-025/026/027 | Bronze full-scan cost growth; uncached health-endpoint latency; local[*] ceiling | Wave-3 telemetry (job wall-time, Trino query stats) after real ingest volume |
| AUD-IMPL-028/029 | Neo4j purge heap risk; briefing serial-probe latency | Load fixture / trace timing |
| AUD-COST-2 | Request over-provisioning | `kubectl top` profile post-traffic |
| AUD-INFRA-002 (root cause) | WHY the PVC guard annotations don't render through ArgoCD | repo-server rendered-manifest comparison (Wave-1 confirmed the propagation failure itself as MEASURED) |
| AUD-INFRA-024 | The argocd repo secret holds the exposed PAT (decode was correctly policy-blocked) | Rotate regardless — rotation is the fix either way |
| AUD-OPS-013 | Coordinated Aurora+S3 restore viability within 90d; Neo4j rebuild from silver_identity_map | Wave-4 fire drill |
| AUD-OPS-040 | DEK shred works under prod IRSA/KMS | Wave-2 synthetic-subject DPDP drill |
| AUD-INFRA-011 → resolved | Run-rate estimate | Now MEASURED as ~$850–990/mo by AUD-OPS-027 (usage-filtered Cost Explorer) |
| AUD-LIVE-4 → resolved | Bronze landing state | Now MEASURED by the Wave-1 e2e: broken at exactly one hop (AUD-W1-001) |

---

## 6. Scoreboard

- **Health score:** 52/100.
- **Open findings:** 100 (9 CRITICAL, 23 HIGH, 44 MEDIUM, 24 LOW) after dedupe; 11 closed/superseded/merged; 11 verified-positive.
- **Wave sizes:** Wave 1 = 19, Wave 2 = 24, Wave 3 = 37, Wave 4 = 20.
- **Single most urgent action:** AUD-W1-001 — the Connect IRSA fix, because Kafka's 7-day retention converts every day of delay into permanent event loss against the platform's most fundamental rule.

*End of audit. No remediation was started in this phase.*
