# Phase 5 — Final Audit Report: Brain Platform (Synthesis)

**Date:** 2026-07-11 — **register statuses updated 2026-07-12** after the Waves 1–4 remediation program completed (closure notes + closing PR numbers added in §2; new post-program operational findings in §6).
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

### 1.1.1 Post-remediation reassessment (2026-07-12)

The remediation program is complete: Waves 1–4 executed as PRs #18–#26 (Wave 1, on top of the bring-up fixes #5/#6/#7/#9/#10/#13/#14), #30–#36 (Wave 2), #39 + #41 (Waves 3+4 integration), plus post-integration fixes #43, #47/#50, #48, #51, #55, #56, #58, #60, #62. Of the 100 open findings in §2.6, **~96 are now CLOSED — including every CRITICAL except AUD-INFRA-027** (Alertmanager receiver, parked pending Slack credentials, user-owned). Concretely: Bronze landing recovered with zero event loss (#10/#13), the medallion runs in prod (first Silver fold live-verified, 1,878 rows, #48), the privacy chain is wired end-to-end (#24/#25/#35), detection is restored (#36), cost levers are applied with an honest budget (expected run-rate ~$450–500/mo, #21/#56), and DR/runbook coverage is authored (#39). What remains open is operator-owned wiring and decisions: the Alertmanager receiver, GitHub PAT rotation, DR fire-drill execution, and the CRR decision (SES production access is likewise user-owned but was never a register row). This section deliberately does **not** assert a re-scored number — the 52/100 reflected missing production wiring, and that mass is closed; a fresh scoring pass should also weigh the §6 post-program findings before publishing a new figure.

### 1.2 Top 10 findings *(statuses as of audit close 2026-07-11 — see §2 for the 2026-07-12 closure state; 9 of 10 are now CLOSED)*

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

**Statuses updated 2026-07-12** post-remediation. Closure notes cite the closing PR (`Pipadacapital/Brain-V3`): Wave 1 = #18–#26 (+ bring-up #5/#6/#7/#9/#10/#13/#14), Wave 2 = #30–#36, Waves 3+4 = #39 (+#41 hygiene-data theme), post-integration fixes #43/#47/#48/#50/#51/#55/#56/#58/#60/#62. Findings that remain OPEN are user-owned (credentials, rotations, cost/residency decisions, drill execution) and carry a status note.

### 2.1 Phase 1 — Architecture & live-prod (AUD-LIVE / AUD-OPS-001..011 / AUD-SEC / AUD-JE / AUD-ID / AUD-TP / AUD-SL / AUD-OBS / AUD-COST)

| ID | Sev | Finding (one-line) | Tag | Status | Wave |
|---|---|---|---|---|---|
| AUD-LIVE-1 | CRIT | metrics-server missing → autoscaling dead | MEASURED | **CLOSED** (Wave-1 + AppProject allowlist #6; re-confirmed AUD-INFRA-034) | — |
| AUD-LIVE-2 | CRIT | Medallion (Silver/Gold/serving) never initialized in prod | MEASURED | **CLOSED** — serving S3 prefix #14; first prod Silver fold LIVE-VERIFIED 1,878 rows #48; identity-chain crons unblocked #26/#51/#55; preagg CTAS grant #60. Residual: v4-gold wall-time → §6 AUD-POST-004 | 1 |
| AUD-LIVE-3 | CRIT | Spark pipeline not scheduled | MEASURED | **CLOSED** — brain-jobs SA #7 + executor RBAC #9 + tsx job entrypoints #26 + SERVICE_NAME env drop #51; crons run in prod. Residual empty-state crashes → §6 AUD-POST-005 | 1 |
| AUD-LIVE-4 | CRIT | Bronze landing unverified | HYPOTHESIS | **CLOSED (resolved by verification)** → superseded by AUD-W1-001 (verified BROKEN, then fixed #10/#13) | — |
| AUD-OPS-001 | HIGH | No PodDisruptionBudgets on any app workload | MEASURED | **CLOSED** — #33: PDB minAvailable=1 in all 4 app charts | 2 |
| AUD-OPS-002 | HIGH | No topologySpreadConstraints/anti-affinity | MEASURED | **CLOSED** — #33: zone+hostname spread (maxSkew 1, ScheduleAnyway) in all 4 charts | 2 |
| AUD-LIVE-5 | HIGH | 5 ArgoCD apps OutOfSync (GitOps drift) | MEASURED | **CLOSED** — Wave-1 synced 2; residuals closed: PVC-guard root cause #22 (AUD-INFRA-002), false-OutOfSync/ServerSideDiff #39 (AUD-INFRA-003) | — |
| AUD-SEC-1 | HIGH | EKS API open to 0.0.0.0/0 | MEASURED | **CLOSED** (pinned /32, committed #5) | — |
| AUD-JE-34/35 | HIGH | `matched_via` computed but serialized as null on timeline/trace APIs | MEASURED | **CLOSED** — #31: provenance serialized on both APIs, wire back-compatible | 2 |
| AUD-SEC-2 | HIGH | iceberg-rest logs plaintext JDBC password at startup | MEASURED | SUPERSEDED → AUD-INFRA-023 (**CLOSED** #19) | 1 |
| AUD-ID-10 | MED | Probabilistic-quarantine guard not in CI | MEASURED | MERGED → AUD-IMPL-008 (**CLOSED** #30) | 2 |
| AUD-OPS-003 | MED | No probes on kafka-connect/iceberg-rest/pgbouncer | MEASURED | **CLOSED** — verified already present on `release` at Wave-2 time; documented in #33 | 2 |
| AUD-OPS-004 | MED | No terminationGracePeriod/preStop anywhere | MEASURED | **CLOSED** — #33: grace periods + preStop drains on ALB-fronted tiers | 2 |
| AUD-TP-22 | MED | RTBF does not bust Redis caches | MEASURED | **CLOSED** — #35: erasure publishes `cache.invalidate.v1` (brand-scoped eviction) | 2 |
| AUD-TP-23 | MED | Kafka retention vs RTBF SLA undocumented | MEASURED | **CLOSED** — #39: `docs/ops/rtbf-kafka-transport-policy.md` | 4 |
| AUD-SL-10 | MED | Semantic pre-agg DDL compiled, never materialized | MEASURED | **CLOSED** — #39: Trino atomic CTAS + hourly cron; write grant fixed #60 | 3 |
| AUD-SL-11 | MED | LIMIT-without-keyset on remaining list endpoints | MEASURED | **CLOSED** — #39: keyset pagination on the customer order list | 3 |
| AUD-OBS-1 | MED | Freshness exporter not deployed to prod | MEASURED | SUPERSEDED → AUD-INFRA-030 (**CLOSED** #36) | 2 |
| AUD-OBS-2 | MED | Observability F-items open (structured logging, error backend, OTel export) | MEASURED | **CLOSED** — #39/#41: OTel export flag, error-backend secret seam, structured-log guard | 3 |
| AUD-OPS-006 | MED | Trino coordinator+worker co-located on one Spot node | MEASURED | **CLOSED** — #39: coordinator pinned to the on-demand pool | 3 |
| AUD-OPS-010/011 | MED | kafka-connect + iceberg-rest single-replica SPOFs | MEASURED | **CLOSED** — #39: iceberg-rest 2 replicas; alerting half via Connect JMX #36 | 3 |
| AUD-COST-1 | MED | Cost telemetry inconclusive ($0 reading) | MEASURED/HYP | SUPERSEDED → AUD-OPS-027 (**CLOSED** #21/#56; cause was credits + IncludeCredit) | — |
| AUD-COST-2 | MED | Request over-provisioning skews HPA math | HYPOTHESIS | **CLOSED** — #39: requests right-sized from live 2d Prometheus p95 (limits untouched) | 3 |

### 2.2 Phase 2 — Implementation (AUD-IMPL-001..029; V1–V3 assurance)

| ID | Sev | Finding (one-line) | Tag | Status | Wave |
|---|---|---|---|---|---|
| AUD-IMPL-001 | MED | apps/web has zero route-level error boundaries | MEASURED | **CLOSED** — #39 (w3/hygiene-web): route-level error boundaries | 3 |
| AUD-IMPL-002 | MED | No typescript-eslint / react-hooks rules (un-awaited promises uncaught) | MEASURED | **CLOSED** — #39: promise-safety + react-hooks lint | 3 |
| AUD-IMPL-003 | LOW | No process-level unhandledRejection/uncaughtException handlers | MEASURED | **CLOSED** — #39: last-resort process handlers | 3 |
| AUD-IMPL-004 | LOW | `any` on the exported BrainAssetRuntime seam (pixel-sdk) | MEASURED | **CLOSED** — #39/#41: typed runtime seam + autodetect | 3 |
| AUD-IMPL-005 | LOW | apps/web disables noUncheckedIndexedAccess | MEASURED | **CLOSED** — #39: noUncheckedIndexedAccess burn-down | 3 |
| AUD-IMPL-006 | LOW | client.ts 2,640-line god-file | MEASURED | **CLOSED** — #39/#41: split into per-domain modules | 3 |
| AUD-IMPL-007 | MED | parseEnv `process.exit(1)` masks 14 core tests (incl. eval-gate) | MEASURED | **CLOSED** — #39: VITEST-gated parseEnv exit | 3 |
| AUD-IMPL-008 | MED | db/iceberg/spark guard suite runs in no CI (2 guards red unnoticed); subsumes AUD-ID-10 | MEASURED | **CLOSED** — #30: `spark-guard-suite` blocking job in pr.yml (21 guards, selftest-proven) | 2 |
| AUD-IMPL-009 | MED | gate_admission_guard RED: gokwik order events un-catalogued | MEASURED | **CLOSED** — #30: catalogued DORMANT_ALIAS_EVENTS (verified producer-less; gokwik orders ride `order.live.v1`) | 2 |
| AUD-IMPL-010 | LOW | Unmerge-reversion guard RED (stale string assertion only) | MEASURED | **CLOSED** — #30: assertion pins both `_flip_and_copy` call sites (cause=merge/unmerge) | 2 |
| AUD-IMPL-011 | MED | Silver merge_on_pk lacks staleness guard — historical replay regresses entities | HYPOTHESIS | **CLOSED** — #34 (hypothesis confirmed TRUE): NULL-safe staleness guard, windowed mode only | 2 |
| AUD-IMPL-012 | MED | Gold full-recompute MERGE never deletes disappeared-PK rows (the +₹0.98 Cr orphan class) | HYPOTHESIS | **CLOSED** — #34 (TRUE): opt-in `WHEN NOT MATCHED BY SOURCE THEN DELETE`, enabled on the 10 full-recompute marts | 2 |
| AUD-IMPL-013 | MED | gold_attribution_credit insert-only — re-fold can break per-order closed-sum | HYPOTHESIS | **CLOSED** — #34 (TRUE): supersede-on-refold restores Σ=1 per (order, model) | 2 |
| AUD-IMPL-014 | MED | Stitch v2 watermark on event time — late/backfilled touches never stitched | HYPOTHESIS | **CLOSED** — #34 (TRUE): watermark + filter moved to `updated_at`, session-grain re-fold | 2 |
| AUD-IMPL-015 | LOW | Probabilistic stitch can accumulate multiple brain_ids/session | HYPOTHESIS | **CLOSED** — #39/#41: MERGE key fix (brand_id, session_id, …) | 3 |
| AUD-IMPL-016 | LOW | test:unit not hermetic in 3 workspaces | MEASURED | **CLOSED** — #39: hermetic test:unit tier | 3 |
| AUD-IMPL-017 | LOW | Order-economics docstring/validation nits (engine itself verified exact) | MEASURED | **CLOSED** — #39: apportion determinism + doc fixes | 3 |
| AUD-IMPL-018 | HIGH | Spark `*_test.py` files baked into prod image AND matched by v4 submit globs (missing pytest ⇒ v4-gold aborts mid-run) | MEASURED | **CLOSED** — #20: submit-glob exclusion + `.dockerignore` | 1 |
| AUD-IMPL-019 | HIGH | bronze_raw_retention (ADR-0006 D4 raw-PII gate) has no prod CronWorkflow | MEASURED | **CLOSED** — #20: daily `bronze-raw-retention` CronWorkflow, enabled by default (= AUD-OPS-038; counted once) | 1 |
| AUD-IMPL-020 | MED | journeys/compare endpoint chain has zero consumers | MEASURED | **CLOSED** — #39: consumer-less chain deleted (contracts + route + client) | 3 |
| AUD-IMPL-021 | MED | StarRocks parity-oracle relics + dead SR_JDBC env plumbing | MEASURED | **CLOSED** — #39: relics swept (Dockerfile follow-up #43) | 3 |
| AUD-IMPL-022 | LOW | knip orphans + pixel-sdk entry false-positives | MEASURED | **CLOSED** — #39 (w3/cleanup) | 3 |
| AUD-IMPL-023 | LOW | Empty connector scaffold dirs (.gitkeep taxonomy) | MEASURED | **CLOSED** — #39 (w3/cleanup) | 3 |
| AUD-IMPL-024 | HIGH | Kafka Connect idles at 79% of memory limit (~375Mi OOM headroom) — sole Bronze writer | MEASURED | **CLOSED** — #20: heap `-Xmx1280M` + request/limit 1792Mi/2560Mi | 1 |
| AUD-IMPL-025 | HIGH | Unpartitioned, forever-retained collector_events_connect forces hourly full-scan + JSON parse | HYPOTHESIS | **CLOSED** — #39: kafka_timestamp watermark + day partitioning | 3 |
| AUD-IMPL-026 | MED | Bronze health BFF endpoints uncached full-scans per request | HYPOTHESIS | **CLOSED** — #39: cache-wrapped (5-min executive tier) | 3 |
| AUD-IMPL-027 | MED | Medallion runs single-JVM local[*] in 2CPU/4Gi pod (scaling ceiling) — overlaps AUD-OPS-029 | HYPOTHESIS | **CLOSED** — #39: per-run wall-time telemetry + defined k8s-executionMode cutover trigger + prod sizing bump | 3 |
| AUD-IMPL-028 | LOW | Neo4j brand purge: label-less scan + one unbounded DETACH DELETE txn | HYPOTHESIS | **CLOSED** — #39/#41: per-label batched `IN TRANSACTIONS` purge | 3 |
| AUD-IMPL-029 | LOW | Insights briefing: 4 sequential Trino probes per cold read | HYPOTHESIS | **CLOSED** — #39/#41: probes fanned out | 3 |
| AUD-IMPL-V1/V2/V3 | — | Boundaries/logging, attribution math, JVM/Redis hygiene — verified strong | MEASURED | POSITIVE (no action) | — |

### 2.3 Phase 3 — Infrastructure (AUD-INFRA-001..034)

| ID | Sev | Finding (one-line) | Tag | Status | Wave |
|---|---|---|---|---|---|
| AUD-INFRA-001 | HIGH | Next `terraform apply` deletes the Redis-from-EKS SG rule (inline vs standalone conflict) | MEASURED | **CLOSED** — #21: standalone `aws_vpc_security_group_*_rule` + one-shot imports; re-plan "No changes" | 1 |
| AUD-INFRA-002 | HIGH | Kafka broker data PVCs are live ArgoCD prune candidates; committed guard never propagated (re-confirmed by Wave-1 sync) | MEASURED (gap) / HYP (root cause) | **CLOSED** — #22: root cause MEASURED (relative `manifest-generate-paths` → stale render cache) fixed with absolute path; kafka-operations runbook added | 1 |
| AUD-INFRA-003 | MED | 3 apps perpetually falsely OutOfSync (defaulted-field/SSA diffs + stale force-sync annotations) — drift signal unusable | MEASURED | **CLOSED** — #39 (w4/gitops): ServerSideDiff + targeted ignoreDifferences + stale annotations removed | 4 |
| AUD-INFRA-004 | MED | external-dns can mutate ALL hosted zones | MEASURED | **CLOSED** — #21: IRSA policy scoped to the Brain hosted zone | 1 |
| AUD-INFRA-005 | MED | Route53 zone + ACM certs exist outside Terraform; cert ARN hard-coded ×3 | MEASURED | **CLOSED** — #39: one-shot Route53 zone + ACM cert import | 4 |
| AUD-INFRA-006 | MED | cronworkflows-prod bypasses the manual promotion gate (automated+prune) | MEASURED | **CLOSED** — #39: sync policy ratified as automated WITHOUT prune | 4 |
| AUD-INFRA-007 | LOW | Imperative deploy Jobs unmanaged; run-migrations.sh foot-gun (script half → AUD-OPS-017) | MEASURED | **CLOSED** — #39: `ttlSecondsAfterFinished` on deploy Jobs; script half closed by #18 | 4 |
| AUD-INFRA-008 | LOW | Housekeeping: /32-only API access fragility, argocd-cm example.com URL, tfvars header lie | MEASURED | **CLOSED** — #39: SSM API-access path + argocd-cm URL fix (+ tfvars fmt #58); private-only EKS API remains a separate documented apply decision | 4 |
| AUD-INFRA-009 | LOW+ | IaC matches applied prod (baseline) | MEASURED | POSITIVE | — |
| AUD-INFRA-010 | HIGH | Cost Explorer $0 / budget can't fire | MEASURED/HYP | SUPERSEDED → AUD-OPS-027 | — |
| AUD-INFRA-011 | HIGH | Estimated run-rate $580–640/mo over target | HYP ($) | SUPERSEDED → AUD-OPS-027 (refined to $850–990 MEASURED) | — |
| AUD-INFRA-012 | MED | 5 interface endpoints × 3 AZ ≈ $110–140/mo, weak rationale vs fck-nat (= AUD-OPS-031; counted once) | MEASURED | **CLOSED** — #39 trim to ecr.api+ecr.dkr ×1 subnet; APPLIED #56 | 3 |
| AUD-INFRA-013 | MED | Karpenter streaming pool on-demand fallback never re-consolidates to Spot | MEASURED | **CLOSED** — #39: `WhenEmptyOrUnderutilized` (spot-volatility follow-on → §6 AUD-POST-001) | 3 |
| AUD-INFRA-014 | MED | EKS/RDS CloudWatch log groups: no retention (unbounded growth) | MEASURED | **CLOSED** — #39 import blocks; imported at 30d #56 | 3 |
| AUD-INFRA-015 | MED | Single-AZ availability posture (deliberate; record-the-risk) | MEASURED/HYP | **CLOSED (accepted risk documented)** — #39: `docs/infra/single-az-posture.md` with explicit upgrade triggers | 4 |
| AUD-INFRA-016 | LOW | Stray console SG with world-SSH (attached to nothing) | MEASURED | **CLOSED** — #39: two-phase delete (phase-1 import merged; phase-2 file removal rides a later apply) | 3 |
| AUD-INFRA-017 | LOW | No rotation on any application secret | MEASURED | **CLOSED** — #39: manual secret-rotation runbook (`docs/runbooks/secret-rotation.md`) | 4 |
| AUD-INFRA-018 | LOW | iceberg-rest ECR repo lacks lifecycle policy | MEASURED | **CLOSED** — #39; APPLIED #56 | 3 |
| AUD-INFRA-019 | LOW | System MNG on AL2 AMI — blocks EKS 1.33 (prereq for AUD-OPS-028) | MEASURED | **CLOSED** — #39 gated path; AL2023 MNG flip APPLIED #56 | 3 |
| AUD-INFRA-020 | LOW+ | S3 posture strong across all 4 buckets | MEASURED | POSITIVE | — |
| AUD-INFRA-021 | HIGH | Zero NetworkPolicies — flat pod network | MEASURED | **CLOSED** — #33: `network-policies` chart + prod app, default-deny + inventoried allows (ns `kafka` deliberately Strimzi-owned) | 2 |
| AUD-INFRA-022 | HIGH | No PSA labels, no securityContexts on any app workload | MEASURED | **CLOSED** — #33: PSA `enforce=restricted` on the 4 app namespaces + securityContexts (readOnlyRootFilesystem toggle staged) | 2 |
| AUD-INFRA-023 | HIGH | iceberg-rest plaintext-password logging unfixed; credential rotation owed (subsumes AUD-SEC-2) | MEASURED | **CLOSED** — #19: RESTCatalogServer logger capped at WARN via JAVA_TOOL_OPTIONS + rotation runbook | 1 |
| AUD-INFRA-024 | HIGH | Exposed GitHub PAT rotation still pending | HYPOTHESIS | **OPEN — user-owned**: PAT rotation + least-scope replacements still pending (rotation is the fix regardless of the decode hypothesis) | 1 |
| AUD-INFRA-025 | MED | Unauthenticated collector ingest + empty origin allowlist → cross-tenant event injection | MEASURED | **CLOSED** — #32: install_token→brand_id binding (enforce, fail-safe admit on oracle failure) + loud origin-allowlist posture | 2 |
| AUD-INFRA-026 | LOW+ | IRSA trust + policy scoping verified strong | MEASURED | POSITIVE | — |
| AUD-INFRA-027 | **CRIT** | Alertmanager routes ALL alerts to null receiver | MEASURED | **OPEN — parked (user-owned)**: receiver wiring pending Slack webhook credentials; rules/dashboards/scrapes are live (#36), so this is the last dead hop | 1 |
| AUD-INFRA-028 | HIGH | Kafka Connect emits ZERO metrics — both Bronze alerts can never fire | MEASURED (absence) | **CLOSED** — #36: JMX exporter javaagent + mapping ConfigMap + PodMonitor | 2 |
| AUD-INFRA-029 | HIGH | BrainIngestStale keyed on a metric deleted at ADR-0010 cutover — dead alert | MEASURED | **CLOSED** — #36: rewritten onto Connect sink metrics with `absent()` honesty arm; lag alert moved to embedded-consumer JMX | 2 |
| AUD-INFRA-030 | HIGH | Trino unscraped; freshness exporter not deployed (subsumes AUD-OBS-1) | MEASURED | **CLOSED** — #36: `observability` chart deploys the freshness exporter; Trino JMX + TrinoServingDown/failure-rate rules | 2 |
| AUD-INFRA-031 | MED | No OOM-kill alert despite OOM being the dominant historical failure mode | MEASURED | **CLOSED** — #36: BrainContainerOomKilled + BrainDataSpineOomKilled rules | 2 |
| AUD-INFRA-032 | MED | Brain Grafana dashboards not provisioned in prod | MEASURED | **CLOSED** — #36: connector-health / ingest-health / revenue-integrity dashboards | 2 |
| AUD-INFRA-033 | MED | core/web have no ServiceMonitor — app tier unscraped | MEASURED | **CLOSED** — #36 | 2 |
| AUD-INFRA-034 | LOW+ | metrics-server/HPAs/scrape targets/Thanos/budget wiring verified healthy | MEASURED | POSITIVE (closes AUD-LIVE-1) | — |

### 2.4 Phase 4 — Operational readiness (AUD-OPS-012..043)

| ID | Sev | Finding (one-line) | Tag | Status | Wave |
|---|---|---|---|---|---|
| AUD-OPS-012 | **CRIT** | Neo4j (identity SoR) has ZERO backups | MEASURED | **CLOSED** — #23: DLM daily EBS snapshots (7 retained) + nightly dump-to-S3 CronJob (write-only IAM, dedicated bucket) | 1 |
| AUD-OPS-013 | HIGH | No DR runbook; RPO/RTO undefined; coordinated Aurora-catalog+S3 restore undesigned | MEASURED/HYP | **OPEN (PARTIAL) — user-owned residual**: DR.md + RB-1 (Aurora PITR) + RB-2 (EKS recovery) + fire-drill procedure merged #39; the coordinated fire drill itself is PENDING owner cost sign-off — restore hypotheses stay unproven until it runs | 4 |
| AUD-OPS-014 | MED | Entire backup estate single-region/single-account | MEASURED | **OPEN — user-owned decision**: in-country S3 CRR (ap-south-2) gated in TF #39, HELD at apply #56 (cost + residency decision; ap-south-2 opt-in not enabled on the account) | 4 |
| AUD-OPS-015 | MED | Iceberg time-travel window only ~7d; raw lanes retain 1 snapshot | MEASURED | **CLOSED** — #39: 14d snapshot window on the durable collector lane + `tools/dr/s3-version-restore.sh` | 4 |
| AUD-OPS-016 | LOW | Aurora backup healthy; single-writer availability gap accepted | MEASURED | POSITIVE/ACCEPTED | — |
| AUD-OPS-017 | **CRIT** | Untracked destructive migration script is the referenced canonical path; GO-LIVE documents the opposite | MEASURED | **CLOSED** — #18: routine-only script + guarded `reset-and-migrate.sh` (data-presence refusal) + GO-LIVE step-11 rewrite | 1 |
| AUD-OPS-018 | HIGH | Connect re-registration recovery exists only as an untracked YAML, no runbook | MEASURED | **CLOSED** — #5 committed the deploy manifests; #18 replaced the scripts; #39 (w4/runbooks) added the recovery runbook section | 1 |
| AUD-OPS-019 | HIGH | enable-prod-cron-pipeline.md presents retired dbt/StarRocks as CURRENT | MEASURED | **CLOSED** — #39: SUPERSEDED banners on stale docs | 4 |
| AUD-OPS-020 | MED | No re-run/backfill runbook; FULL_REFRESH gotcha undocumented | MEASURED | **CLOSED** — #39: `docs/runbooks/rerun-medallion.md` incl. FULL_REFRESH rule | 4 |
| AUD-OPS-021 | MED | No restart-service runbook | MEASURED | **CLOSED** — #39: `docs/runbooks/restart-services.md` | 4 |
| AUD-OPS-022 | MED | No prod OOM-investigation runbook | MEASURED | **CLOSED** — #39: `docs/runbooks/investigate-oom.md` | 4 |
| AUD-OPS-023 | MED | No brand-onboarding playbook (go-live acceptance gate) | MEASURED | **CLOSED** — #39: `docs/playbooks/brand-onboarding.md` | 4 |
| AUD-OPS-024 | LOW | No per-secret consumer map / coupled-rotation procedure | MEASURED | **CLOSED** — #39: secrets-rotation appendix | 4 |
| AUD-OPS-025 | LOW | Checkout-pixel runbook verify block uses retired StarRocks commands | MEASURED | **CLOSED** — #39: verify blocks ported to Trino | 4 |
| AUD-OPS-026 | LOW | Runbook index omits 8 of 12 runbooks | MEASURED | **CLOSED** — #39: regenerated status-tagged index | 4 |
| AUD-OPS-027 | **CRIT** | Real spend ~$850–990/mo (2× target) masked by credits; budget IncludeCredit:true = inert (supersedes AUD-COST-1, AUD-INFRA-010/011) | MEASURED | **CLOSED** — #21: second budget with IncludeCredit=false + 50/80/100% thresholds; cost levers APPLIED #56 → expected real run-rate ~$450–500/mo | 1 |
| AUD-OPS-028 | HIGH | EKS 1.32 extended-support surcharge $432/mo ($360 avoidable) | MEASURED | **CLOSED** — #39 staged the gated upgrade; EKS 1.33 + STANDARD support APPLIED #56 (zero availability impact) | 3 |
| AUD-OPS-029 | HIGH | Spark local[*] 3g/2CPU single-JVM = first 10× bottleneck (overlaps AUD-IMPL-027) | MEASURED | **CLOSED** — #39: wall-time metrics + defined k8s-executionMode cutover trigger + prod sizing bump (gold wall-time residual → §6 AUD-POST-004) | 3 |
| AUD-OPS-030 | MED | stream-worker HPA max 48 unschedulable AND >partitions(12); CPU not lag trigger | MEASURED | **CLOSED** — #39: honest maxReplicas=12 + KEDA kafka-lag ScaledObject | 3 |
| AUD-OPS-031 | MED | VPC endpoints $140/mo (= AUD-INFRA-012; counted once) | MEASURED | **CLOSED** — #39; APPLIED #56 | 3 |
| AUD-OPS-032 | MED | 10× ceilings: Aurora 2-ACU cap; 555MB Redis fronting OOM-prone Trino | MEASURED | **CLOSED** — #39: ACU/eviction CloudWatch tripwires + `docs/ops/scale-knobs.md` decision record | 3 |
| AUD-OPS-033 | LOW | Karpenter capacity < sum-of-HPA-max; t4g-only spot pool (no diversity) | MEASURED | **CLOSED** — #39: m7g spot diversity + documented 48 vCPU/192Gi ceiling | 3 |
| AUD-OPS-034 | LOW | Kafka sizing adequate for 10× (combined-role spot caveat) | MEASURED | POSITIVE (optional hardening; spot caveat materialized → §6 AUD-POST-001) | — |
| AUD-OPS-035 | LOW | Single fck-nat = sole connector egress, no auto-recovery | MEASURED | **CLOSED** — #39: auto-recovery alarms (HA remains a documented trigger) | 3 |
| AUD-OPS-036 | **CRIT** | Erasure orchestrator live but UNREACHABLE — nothing produces its trigger event | MEASURED | **CLOSED** — #25: `ErasureEventPublisher` bridges all 3 RTBF entry points to the canonical trigger event | 1 |
| AUD-OPS-037 | **CRIT** | Bronze Iceberg raw-PII erasure never executed by anything (NotImplementedYet seam; caller-less Spark job) | MEASURED | **CLOSED** — #24: `bronze-raw-erasure` WorkflowTemplate + fail-safe orchestrator submit adapter (STEP 4 live) | 1 |
| AUD-OPS-038 | HIGH | Raw-lane PII retention TTL job unscheduled in prod (= AUD-IMPL-019; counted once) | MEASURED | **CLOSED** — #20: daily bronze-raw-retention CronWorkflow | 1 |
| AUD-OPS-039 | HIGH | UI erase + Shopify redact perform PARTIAL deletion only (no shred/log/surrogate/CAPI/Bronze) | MEASURED | **CLOSED** — #25 (trigger bridge) + #35 (consumer-side Neo4j purge, hash-keyed Bronze sweep; brain_id-only raw-anon residual documented, covered by raw-lane retention) | 2 |
| AUD-OPS-040 | HIGH | End-to-end deletion never tested; DEK-shred-in-prod unproven | MEASURED (gap) / HYP (shred) | **CLOSED** — #35: runnable gated e2e drill harness (`tools/privacy` rtbf-drill) with full assertion list + drill-evidence log fields | 2 |
| AUD-OPS-041 | MED | Silver R3 consent gate has not yet run green in prod — verify silver_consent_rejected | MEASURED | **CLOSED** — #48: first prod Silver fold ran the Stage-1 gates live (2,011 Bronze → 1,878 Silver through dedup + gates) | 1 |
| AUD-OPS-042 | LOW | Residency clean — all stores ap-south-1 | MEASURED | POSITIVE (CRR decision, if taken, stays in-country per ADR-0011) | — |
| AUD-OPS-043 | LOW | customers/data_request (DSAR) ack-only, no export pipeline | MEASURED | **CLOSED** — #39: `docs/runbooks/dsar-manual-export.md` (manual-first per plan) | 4 |

### 2.5 New findings from Wave-1 verification (AUD-W1-*)

| ID | Sev | Finding | Tag | Status | Wave |
|---|---|---|---|---|---|
| AUD-W1-001 | **CRIT** | **Kafka Connect IRSA trust mismatch — Bronze landing fully down.** All 10 connectors report RUNNING but every sink task is FAILED: SA `kafka:kafka-connect-prod-kafka-connect` is annotated with `arn:aws:iam::380254378136:role/brain-prod-spark-jobs`, whose trust policy does not allow that SA's `sub` → `sts:AssumeRoleWithWebIdentity` 403 → Iceberg coordinator terminates. Test event (correlation_id `wave1-e2e-test-4eeba80f…`) accepted by collector, drained to Kafka, NOT in Bronze (count=0 after 5 min of polling). Events are durable in Kafka (offsets precede the failure) — **no re-send needed after fix, but 7-day topic retention is the loss deadline.** No autoRestart configured; tasks stay FAILED until trust fixed + tasks restarted. | MEASURED | **CLOSED** — #10 (dedicated `brain-prod-kafka-connect` IRSA role — the annotated role NEVER EXISTED) + #13 (second root cause: `control-iceberg` topic never declared) + #5 (S3 DenyUnencryptedPuts fix). Bronze landing recovered with ZERO event loss — commits live-verified | 1 |
| AUD-W1-002 | LOW+ | Collector ingest path verified working e2e in prod: POST /collect → 200 accepted → PG spool (X-Spool-Id: 1, first prod event) → drainer → Kafka. | MEASURED | POSITIVE | — |
| AUD-W1-003 | **CRIT** | `argo/brain-jobs` ServiceAccount missing — every scheduled/manual Spark workflow (v4-silver etc.) Errors before pod start. Residual of AUD-LIVE-3; also blocks AUD-LIVE-2 first fill and AUD-OPS-041 verification. | MEASURED | **CLOSED** — #7 (SA + IRSA annotation) + #9 (executor RBAC); downstream job-command/env layers fixed in #26/#51, salt IAM #55 | 1 |

### 2.6 Register counts (deduplicated)

**At audit close (2026-07-11):**

| Severity | Open | Closed / superseded / merged | Positive (no action) |
|---|---|---|---|
| CRITICAL | **9** (LIVE-2, LIVE-3/W1-003*, W1-001, INFRA-027, OPS-012, OPS-017, OPS-027, OPS-036, OPS-037) | 2 (LIVE-1, LIVE-4) | — |
| HIGH | **23** | 5 (SEC-1, LIVE-5, SEC-2→INFRA-023, INFRA-010/011→OPS-027) | — |
| MEDIUM | **44** | 3 (COST-1, OBS-1, ID-10 merged) | — |
| LOW | **24** | 1 (OPS-038 merged into IMPL-019 line) | 11 (incl. V1–V3, W1-002) |
| **Total** | **100 open** | 11 | 11 |

**Post-remediation (2026-07-12):** ~**96 of the 100 then-open findings are CLOSED**. Still OPEN (all user-owned wiring/decisions):

| Severity | Still open | Why |
|---|---|---|
| CRITICAL | AUD-INFRA-027 | Alertmanager receiver — pending Slack webhook credentials (detection stack itself is live, #36) |
| HIGH | AUD-INFRA-024 | Exposed GitHub PAT rotation — pending user action |
| HIGH | AUD-OPS-013 (partial) | DR docs/runbooks merged #39; the coordinated restore fire drill awaits owner cost sign-off |
| MEDIUM | AUD-OPS-014 | S3 CRR — deliberate hold (#56): cost + residency decision, ap-south-2 opt-in not enabled |

New post-program operational findings (2026-07-12) are tracked separately in **§6** (5 findings: 2 closed, 3 in flight).

\* AUD-LIVE-3 and AUD-W1-003 are counted as one open CRITICAL (W1-003 is LIVE-3's concrete residual blocker). Dedupe pairs counted once: AUD-IMPL-019=AUD-OPS-038, AUD-INFRA-012=AUD-OPS-031, AUD-SEC-2⊂AUD-INFRA-023, AUD-ID-10⊂AUD-IMPL-008, AUD-IMPL-027≈AUD-OPS-029 (both kept — different fix surfaces: telemetry vs sizing — counted separately as in source phases).

---

## 3. Prioritized remediation backlog (waves)

> **2026-07-12: EXECUTED.** This backlog and the §4 plan are retained as the historical program of record. Closure state per finding lives in §2; the four remaining user-owned items and the §6 post-program findings are the live worklist.

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

> **2026-07-12 update:** AUD-IMPL-011/012/013/014 were each verified in code during Wave 2 and **all four confirmed TRUE** before being fixed (#34). AUD-INFRA-002's root cause is now MEASURED (relative `manifest-generate-paths` → stale render cache, #22). Still genuinely unproven: the AUD-OPS-013 coordinated-restore hypotheses (await the fire drill) and the AUD-OPS-040 DEK-shred-under-prod-KMS hypothesis (harness shipped #35; prod drill execution pending).

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

## 6. Post-program findings (2026-07-12 operations)

New findings surfaced by real production operation DURING and immediately after the remediation program (the #42/#44 promotions, the EKS 1.33 upgrade, and the first real-data pipeline runs). Same register conventions as §2 (severity / effort / evidence / tag); ids are `AUD-POST-*`.

| ID | Sev | Finding (one-line) | Effort | Evidence | Tag | Status |
|---|---|---|---|---|---|---|
| AUD-POST-001 | HIGH | **Kafka broker spot-churn quorum loss** — ap-south-1a spot reclaims churned all 3 KRaft brokers through 3 node generations in ~40 min (3× quorum loss, 2026-07-12, during the #44 rollout); the Wave-3 pool consolidation (AUD-INFRA-013) increased spot-volatility exposure. Collector spooling covered the gaps — no event loss — but every churn cycle is risk against the platform's most fundamental rule. On-demand broker pin authored #47, then reverted quota-gated #50 after it tripped AUD-POST-002 (the roll itself lost quorum on `VcpuLimitExceeded`). | S | #47/#50 incident bodies; `docs/runbooks/kafka-operations.md` | MEASURED | **OPEN (interim: brokers on spot)** — quota now 32; re-enabling the gated pin (#50) is an owner flip, ~+$100/mo |
| AUD-POST-002 | HIGH | **EC2 on-demand vCPU quota ceiling (16)** was an invisible capacity wall: it broke the #47 broker on-demand roll mid-flight (quorum loss) AND was nearly hit by the AL2023 system-MNG flip during the EKS 1.33 upgrade. | S | #50 (`VcpuLimitExceeded`); #56 | MEASURED | **CLOSED** — quota L-1216C47A raised to 32 (approved, #56). **LESSON:** service-quota headroom check belongs in every capacity-change pre-flight |
| AUD-POST-003 | HIGH | **Strimzi 0.45.0 incompatible with Kubernetes 1.33** — the cluster operator's fabric8 client fails parsing 1.33's new `/version` fields (`UnrecognizedPropertyException: emulationMajor`) → operator crashloop, CR reconciliation down (brokers/data plane unaffected). | S | operator logs post-1.33 upgrade; #62 | MEASURED | **CLOSED** — pinned 0.45.2 (backported client fix), live-verified reconciling, #62. **LESSON:** operator client-library compat (strimzi/ESO/KEDA/argo) is a mandatory k8s-upgrade pre-flight item |
| AUD-POST-004 | MED | **v4-gold outgrows `activeDeadlineSeconds` 1800 with real data** — the gold fold is killed mid-run at the workflow deadline once real volumes are in play (the limit predates any real-data run). | S | prod v4-gold workflow runs, 2026-07-12 | MEASURED | **OPEN** — deadline bump in flight |
| AUD-POST-005 | MED | **Empty-state cron crashes** — `audit-checkpoint` dies on an empty-uuid and `attribution-reconcile` on an empty credit basis when upstream data is absent; cold-start/empty states must no-op cleanly, not crash (violates "fail safely" and pollutes the new alerting with false reds). | S | prod cron logs, 2026-07-12 | MEASURED | **OPEN** — fix in flight |

---

## 7. Scoreboard

**At audit close (2026-07-11):**
- **Health score:** 52/100.
- **Open findings:** 100 (9 CRITICAL, 23 HIGH, 44 MEDIUM, 24 LOW) after dedupe; 11 closed/superseded/merged; 11 verified-positive.
- **Wave sizes:** Wave 1 = 19, Wave 2 = 24, Wave 3 = 37, Wave 4 = 20.
- **Single most urgent action:** AUD-W1-001 — the Connect IRSA fix, because Kafka's 7-day retention converts every day of delay into permanent event loss against the platform's most fundamental rule.

**Post-remediation (2026-07-12):**
- **Closure:** ~96 of 100 open findings CLOSED (see §1.1.1 and §2.6); every CRITICAL closed except AUD-INFRA-027 (Alertmanager receiver — user-owned Slack credentials). No re-scored health number is asserted; re-score after the §6 items and the fire drill.
- **Still open (user-owned):** AUD-INFRA-027, AUD-INFRA-024 (PAT rotation), AUD-OPS-013 fire-drill execution, AUD-OPS-014 CRR decision. (SES production access is a user-owned pending item outside this register.)
- **Post-program findings (§6):** 5 new (AUD-POST-001..005) — 2 CLOSED, 3 in flight.
- **Single most urgent action now:** wire the Alertmanager receiver (AUD-INFRA-027) — the whole Wave-2 detection stack terminates in a null receiver until then.

*End of audit report. Waves 1–4 remediation completed 2026-07-12; register statuses above are the record of that program.*
