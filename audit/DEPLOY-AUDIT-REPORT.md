# Brain — Deployment Audit Report (Stage A)

**Date:** 2026-07-02 · **Branch:** `audit/stage-b-remediation` · **Scope:** local compose stack (spec §A1–A6) + prod terraform/helm/ArgoCD/CI-CD/secrets/naming (spec §B1–B11) · **Mode:** read-only audit, 11 agents (5 audit dims + adversarial verification), all evidence file:line-cited and live-verified where a running stack exists.

**Inputs:** 45 findings (0 refuted by the adversarial verifier), 53 conformant items. Findings renumbered into three unique registers: **AUD-LOCAL-001..015**, **AUD-PROD-001..023** (merging the three prod dims whose agents used overlapping numbers; ordered severity → spec_ref), **AUD-NAME-001..007**. Original IDs preserved in each entry for traceability.

---

## 1. Executive Summary

**Headline: most spec deviations are DOCUMENTED DECISIONS, not defects.** 21 of 45 findings are CONFLICT-ESCALATIONs — deliberate, in-repo-justified deviations (measured OOM evidence, AUD-COST-009/010/016/017/018, AUD-PERF-013, ADR-0009, unified-Bronze-landing supersession) where the *spec* is stale and needs ratification updates in ~15–20 places (20 queued as Wave-4 ratification decisions; the 21st, AUD-LOCAL-001, is pulled into Wave 1 by impact). Only 24 findings are genuine GAPs, and they cluster in four themes:

1. **Observability is the genuine gap cluster** — no Prometheus/Grafana ANYWHERE (local core-profile commented out 2026-07-02; prod has neither kube-prometheus-stack nor the ADR-006 Grafana-Cloud path — the observability TF module is instantiated in dev and staging but NOT prod). `brain-slo.rules.yml` is evaluated nowhere, no Thanos, and rollout AnalysisTemplates still say `REPLACE_WITH_PROMETHEUS_ADDRESS`.
2. **Two go-live-blocking IAM holes for secrets** — the 4 core boot secrets (JWT/cookie/Meta/Google-Ads) have no SM shells and no IRSA read grant (deterministic core CrashLoop), and `brain/connector/*` runtime secrets have ZERO IAM grants and no prod connector CMK (connector platform fully dead + boot FATAL).
3. **Workload-to-node-pool pinning is absent** — Trino coordinator not on the system group, Kafka brokers/Bronze sinks can land on aggressively-consolidating Spot pools (event-loss risk against a core product rule).
4. **KEDA is installed but scales nothing** — the Trino worker ScaledObject exists but `autoscaling.enabled=false` in values-prod (and its OFF-comment's precondition is already met).

### Top 10 gaps by impact

| # | ID | Spec | Impact |
|---|----|------|--------|
| 1 | AUD-PROD-002 | B8 | No Prometheus AT ALL in prod — SLO rules, rollout analyses, and the CD bake-window auto-rollback signals have no evaluator; prod goes live blind |
| 2 | AUD-PROD-001 | B2 | Observability TF module wired in dev+staging but NOT the prod root — no metrics/log-group/alarm path exists for prod (companion of #1) |
| 3 | AUD-PROD-003 | B10 | Core boot secrets (JWT/cookie/Meta/Google-Ads): no SM shells, no IRSA grant → deterministic core CrashLoop even after a perfect GO-LIVE fill pass |
| 4 | AUD-PROD-004 | B10 | `brain/connector/*` secrets: zero IAM grants + no prod connector CMK → whole connector platform dead; core/stream-worker FATAL at boot |
| 5 | AUD-PROD-006 | B2 | Zero workload-to-pool pinning — Kafka brokers/bronze sinks can land on bin-packing Spot pools; broker churn risk vs 'no event loss' |
| 6 | AUD-PROD-013 | B8 | `brain-slo.rules.yml` currently evaluated NOWHERE (local evaluator also off; its alertmanager target doesn't exist in compose) |
| 7 | AUD-LOCAL-001 | A1/A2 | Local core-profile Prometheus+Grafana commented out — base metrics/SLO pipeline dead locally (decision required: re-enable vs ratify) |
| 8 | AUD-PROD-010 / -007 | B7/B2 | Trino worker KEDA autoscaling unwired — fixed 3 replicas, installed KEDA scales nothing; spec says 0–2/0–3 KEDA-scaled |
| 9 | AUD-PROD-008 | B4 | ElastiCache silently provisions 2-node multi-AZ (module default) vs spec's single cache.t4g.micro — double cache spend |
| 10 | AUD-NAME-001 | B11 | 4 mandatory tags (Environment/Service/Owner/CostCenter) wired into ZERO env-root default_tags — most already-applied prod resources carry none |

### Deployment-readiness: **~78%**

Severity-weighted per spec section (each section scored on conformant items vs gap severity within it, then averaged):

| Section | Score | Basis |
|---|---|---|
| A1–A6 local | 90% | All limits/OOM-tiers/profiles/refresh-loop/PgSpool conformant + live-verified (9.7GiB used of ≤18GB); obs disabled (decision), minor oom_score_adj holes |
| B1 network | 95% | fck-nat, no managed NAT, endpoints, private everything — **fully conformant**; 3-AZ delta + documented API-endpoint bootstrap posture |
| B2 EKS/nodes | 70% | 1.32 pinned, Karpenter+KEDA installed e2e — but no pinning, no obs hosting, KEDA unwired |
| B3 Aurora | 100% | **Fully conformant** (Serverless v2 0.5–2 ACU, private, single-writer, 35d backups, encrypted) |
| B4 ElastiCache | 85% | Node class/privacy/encryption conform; node COUNT is 2 not 1 |
| B5 Kafka | 100% | **Fully conformant** (Strimzi KRaft 3-broker, 50Gi gp3, RF=3/minISR=2, no ZK, no MSK) |
| B6 S3/Iceberg | 90% | No-Object-Lock conformant, expire_snapshots scheduled, strong bucket posture; Intelligent-Tiering absent; single-bucket + 7d-TTL = ratification items |
| B7 Trino | 65% | REST-catalog/IRSA/coordinator conform; KEDA unwired, zero node placement, custom chart un-ratified |
| **B8 observability** | **10%** | **Weakest section** — rules files excellent but no evaluator anywhere, no Thanos, placeholders unfilled |
| B9 CI/CD | 95% | Functionally conformant and stronger than spec (digest-pinning, cosign, fail-closed placeholder guard, manual prod gate); filename delta only |
| B10 secrets | 60% | ESO+IRSA+shell architecture solid, but 2 go-live-blocking IAM holes + local/prod path parity partial |
| B11 naming/tagging | 80% | Names strongly convergent on brain-{env}-{resource}; the 4-tag default_tags wiring is authored but unwired |

Average ≈ 78%. The number is dominated by B8 (near-zero) and the two B10 IAM holes; all three are EFFORT-S/M fixes — readiness rises above 90% after Wave 1 alone.

---

## 2. Context Summary

**What deployment code exists (all verified in-repo):**

- **Local:** `docker-compose.yml` with a 4-profile model (core default / full-obs / debug / ai), per-service `mem_limit` + a coherent `oom_score_adj` kill-priority tier (postgres −900 … localstack +200), live-measured 9.7GiB total (≤18GB target); host-run apps via turbo (`pnpm dev:up`, 8-step bring-up); unified Spark Bronze sink (`tools/dev/dev-bronze-streaming.sh`, 7g cap) + synchronous guarded `v4-refresh-loop.sh` (42 Spark run-scripts, pidfile + per-script lock).
- **Terraform:** `infra/terraform/envs/prod` (22 module blocks) **APPLIED-in-part today to account 668848431102** — EKS control plane `brain-prod` (1.32) is LIVE but **node groups are blocked on the AWS Free-plan upgrade**; VPC/fck-nat/endpoints/Aurora Serverless v2/ElastiCache/KMS/S3 warehouse/IRSA/OIDC-GitHub/Karpenter-IRSA+SQS modules exist; `modules/observability` exists but is instantiated only in dev+staging.
- **Helm + GitOps:** in-repo charts (trino, strimzi-kafka CR, neo4j, iceberg-rest, core/web/collector/stream-worker, cronworkflows, karpenter NodePools, external-secrets-config) + **17 ArgoCD Applications** in `infra/argocd/envs/prod` behind an env-scoped app-of-apps + AppProject bootstrap chain; upstream charts pinned for KEDA 2.15.1 / Strimzi 0.45.0 / Karpenter 1.0.8.
- **CD:** `.github/workflows/main.yml` on push:[master] — affected-only matrix build of 4 services + spark-bronze image, OIDC ECR push, cosign keyless signing, immutable `repository@digest` bumps into values-staging, staging→prod digest promotion behind the `production` manual gate + `prod-placeholder-guard.sh --strict`; values-prod pins digest with `tag:""` fail-closed.
- **Runbook:** `docs/runbooks/GO-LIVE.md` (358 lines, added today, bd19fc4b).

**Immediate discrepancies:** (1) GO-LIVE.md contains **zero** observability/metrics/alerting steps and assumes post-launch connector reconnects that the missing B10 IAM grants would break; (2) prod is the ONLY env without the observability module; (3) rollout AnalysisTemplates reference a Prometheus nothing deploys; (4) the compose file's own §4.1 header still claims prometheus+grafana are core while both are commented out (internal contradiction, kafka JMX javaagent burns heap unscraped); (5) `docs/infra/naming-and-tagging.md` §3 still documents per-layer buckets, Bronze Object-Lock and 'RDS not Aurora' — all superseded by applied reality.

---

## 3. Findings Register

Legend: kind **GAP** = genuine deviation, no in-repo justification → remediate. **CONFLICT-ESCALATION (CE)** = deliberate, documented deviation → user ratification decision, NOT queued for code change. `orig:` = the auditing agent's original ID (pre-renumber).

### 3.1 AUD-LOCAL — local dev stack (§A1–A6) — 15 findings (4 GAP / 11 CE; the auditing agent filed AUD-LOCAL-001 as GAP, the adversarial verifier corrected it to CONFLICT-ESCALATION)

| ID | Sev | Effort | Spec | Kind | Wave | Title |
|---|---|---|---|---|---|---|
| AUD-LOCAL-001 | MED | S | A1/A2 | CE | 1 | Prometheus + Grafana absent from the running core profile (commented out) — base metrics/SLO pipeline dead |
| AUD-LOCAL-002 | MED | S | A2 | GAP | 2 | pgbouncer has no oom_score_adj — request-path connection pooler at default kill priority |
| AUD-LOCAL-003 | MED | S | A2 | GAP | 2 | host-run Bronze sink and ephemeral Spark job containers run at oom_score_adj 0 — ingest-critical container killed before protected caches |
| AUD-LOCAL-004 | LOW | S | A2 | GAP | 3 | full-obs (loki/tempo/otel-collector), kafka-exporter and one-shot init containers have neither mem_limit nor oom_score_adj |
| AUD-LOCAL-005 | LOW | S | A1 | CE | 4 | LocalStack SERVICES = 's3,secretsmanager,kms,ses,events' vs spec 'secretsmanager,s3' — kms/ses are load-bearing, 'events' appears unused |
| AUD-LOCAL-006 | LOW | S | A1 | CE | 4 | Apicurio lives in core, not a separate schema profile; dev-down.sh still passes a no-op --profile schema |
| AUD-LOCAL-007 | LOW | S | A2 | CE | 4 | Trino 7g limit / 70% RAMPercentage (~4.9g heap) vs spec 1G/768m |
| AUD-LOCAL-008 | LOW | S | A2 | CE | 4 | Kafka 2500m limit with pinned 1G heap vs spec 1G limit/768m heap |
| AUD-LOCAL-009 | LOW | S | A2 | CE | 4 | Neo4j 1500m limit (512m heap + 256m pagecache) vs spec 512M/256+256 |
| AUD-LOCAL-010 | LOW | S | A3/A2 | CE | 4 | unified Bronze sink container capped at 7g with 4g driver heap vs spec's 2GB-per-sink/1g-driver target (measured 2.145GiB steady) |
| AUD-LOCAL-011 | LOW | S | A2 | CE | 4 | ephemeral Spark transform job containers 7g/--driver-memory 4g vs spec 2G containers with 1g driver+executor |
| AUD-LOCAL-012 | LOW | S | A2 | CE | 4 | MinIO 5g (GOMEMLIMIT 4500MiB) and iceberg-rest 512m vs blueprint 256m/128m |
| AUD-LOCAL-013 | LOW | S | A1 | CE | 4 | LiteLLM (ai profile) commented out — `--profile ai` is currently a no-op |
| AUD-LOCAL-014 | MED | M | A5 | CE | 4 | pnpm dev:up is a multi-minute 8-step bring-up, not the spec's ~30s 'compose up + bootstrap' |
| AUD-LOCAL-015 | LOW | M | A3 | GAP | 3 | refresh loop spins ~42 ephemeral Spark containers every 300s even with zero new Bronze data — no idle short-circuit |

### AUD-LOCAL-001 — Prometheus + Grafana absent from the running core profile (commented out) — base metrics/SLO pipeline dead
`SEV-MED` · `EFFORT-S` · spec §A1/A2 · **CONFLICT-ESCALATION** · Wave 1 · orig `AUD-LOCAL-001` (local-env)

**Evidence (verbatim):** docker-compose.yml ~:545-563 (prometheus commented, 'DISABLED 2026-07-02') and ~:592-625 (grafana commented), while the same file's §4.1 header still declares 'prometheus + grafana → CORE (base metrics dashboards always available)' and :285-292 kafka JMX comments still claim prometheus scrapes :9404 — internal contradiction. Deliberate decision documented in commit 3cddd2a1 'chore(compose): disable unused observability containers' (2026-07-02 01:57, full rationale: unused leaf services, re-enable by uncommenting) and docs/ops/local-memory-budget.md Lever-2 footer ('Not running … prometheus + grafana'). Live docker ps confirms neither container runs; infra/observe/alerts/brain-slo.rules.yml + freshness.rules.yml have no local evaluator (DLQ-growth/ingest-freshness/consumer-lag alerts dark locally); kafka javaagent on :9404 burns heap unscraped. Prod alert lane (infra/observe/k8s/kafka-observability.yaml) is separate and unaffected. Not addressed by today's AUD-COST-016..025 / AUD-INFRA-011 / AUD-CODE-025 commits. Escalate: either ratify the disable (and fix the stale §4.1/JMX comments + drop the javaagent locally) or re-enable per the finding's proposed fix — user decision required.

**Proposed fix:** Uncomment the prometheus and grafana service blocks (both already carry the spec's 256m mem_limit, oom_score_adj 300/500, fixed healthchecks and the :3004 port fix). Zero new work — re-enable and verify prometheus scrapes kafka:9404.

**Verifier note (adversarial re-check, confirmed real):** All cited evidence verifies (prometheus/grafana commented in docker-compose.yml with DISABLED 2026-07-02 banners; commit 3cddd2a1 real; docker ps shows neither container; memory-budget doc confirms; kafka JMX agent on :9404 still runs with no scraper; brain-slo.rules.yml locally evaluator-less) and no later commit re-enables them. BUT the kind is wrong: this is a deliberate deviation with documented in-repo justification — commit 3cddd2a1's rationale (unused leaf services, lighten local stack, re-enable banners left in place) plus docs/ops/local-memory-budget.md recording the not-running state — conflicting with the compose file's own blueprint §4.1 note ('prometheus + grafana → CORE, base metrics dashboards always available') and the stale kafka/JMX comments claiming prometheus scrapes :9404. That is a CONFLICT-ESCALATION (revert-vs-keep needs a human decision), not a GAP, and 'uncomment, zero new work' would silently revert a same-day intentional change. Severity also overstated: local-env only, trivially reversible, prod alert lane (infra/observe/k8s/kafka-observability.yaml) unaffected → SEV-MED.

### AUD-LOCAL-002 — pgbouncer has no oom_score_adj — request-path connection pooler at default kill priority
`SEV-MED` · `EFFORT-S` · spec §A2 · **GAP** · Wave 2 · orig `AUD-LOCAL-002` (local-env)

**Evidence (verbatim):** docker-compose.yml:65-91 (mem_limit: 128m present, oom_score_adj absent); live `docker inspect brainv3-pgbouncer-1` → OOMScoreAdj=0. Every core-app DB read goes through it (compose comment :58-64); at 0 it is killed before redis (-300) and every SoR.

**Proposed fix:** Add `oom_score_adj: -850` (or similar, between postgres -900 and kafka -800) to the pgbouncer service — losing it severs the whole app→PG path.

### AUD-LOCAL-003 — host-run Bronze sink and ephemeral Spark job containers run at oom_score_adj 0 — ingest-critical container killed before protected caches
`SEV-MED` · `EFFORT-S` · spec §A2 · **GAP** · Wave 2 · orig `AUD-LOCAL-003` (local-env)

**Evidence (verbatim):** tools/dev/dev-bronze-streaming.sh:82-104 — `docker run --memory 7g` with no `--oom-score-adj`; live `docker inspect brain-bronze-sink` → OOMScoreAdj=0. Same for the 35 transform run-*.sh containers (PR #342 added only --memory). Under VM pressure the sole Bronze landing path is killed BEFORE redis (-300) and everything the compose tier protects; the durable checkpoint mitigates data loss but not ingest freezes.

**Proposed fix:** Add `--oom-score-adj=-600` (sink; kernel-doc range ok for docker run) to dev-bronze-streaming.sh, and a mild value (e.g. 0→+100) intentionally for ephemeral transform jobs so they die first — make the ordering explicit rather than accidental.

### AUD-LOCAL-004 — full-obs (loki/tempo/otel-collector), kafka-exporter and one-shot init containers have neither mem_limit nor oom_score_adj
`SEV-LOW` · `EFFORT-S` · spec §A2 · **GAP** · Wave 3 · orig `AUD-LOCAL-004` (local-env)

**Evidence (verbatim):** docker-compose.yml:564-588 (loki, tempo), :625-646 (otel-collector), :688-696 (kafka-exporter), :173-186/:340-382/:425-435/:664-683 (minio-init/kafka-init/iceberg-catalog-init/jmx-exporter-init) — none carry mem_limit or oom_score_adj. Spec A2 says every container is bounded. Non-core profiles / one-shots, so impact is low, but a runaway loki on a full-obs run is unbounded.

**Proposed fix:** Add mem_limit (e.g. loki/tempo 512m, otel-collector 256m, kafka-exporter 128m, inits 128m) + positive oom_score_adj (disposable) to the full-obs/debug services; inits can share a small cap.

### AUD-LOCAL-005 — LocalStack SERVICES = 's3,secretsmanager,kms,ses,events' vs spec 'secretsmanager,s3' — kms/ses are load-bearing, 'events' appears unused
`SEV-LOW` · `EFFORT-S` · spec §A1 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-LOCAL-005` (local-env)

**Evidence (verbatim):** docker-compose.yml:226 SERVICES: "s3,secretsmanager,kms,ses,events". kms is required by packages/pii-vault/src/index.ts (@aws-sdk/client-kms DEK wrap; commit 5d5d1bee bootstrap re-wraps brand keyrings via KMS); ses by apps/core/src/modules/notification/internal/ses-adapter.ts. 'events' (EventBridge): repo-wide grep over apps/packages/tools/db found no eventbridge client usage.

**Proposed fix:** Update the spec to 's3,secretsmanager,kms,ses'; separately trim the unused 'events' entry from SERVICES (tiny footprint win, avoids implying an EventBridge dependency).

**Conflict justification:** KMS and SES are functionally required by shipped code (PII-vault envelope encryption + notification email) — the spec's 'only secretsmanager+s3' predates the prod-on-local KMS PII-vault work (memory: prod-on-local MERGED 2026-06-21) and the SES adapter. The spec is stale for those two.

### AUD-LOCAL-006 — Apicurio lives in core, not a separate schema profile; dev-down.sh still passes a no-op --profile schema
`SEV-LOW` · `EFFORT-S` · spec §A1 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-LOCAL-006` (local-env)

**Evidence (verbatim):** docker-compose.yml:384-410 — apicurio profiles: ["core"] with documented rationale ('Folded into core alongside kafka … the collector/stream-worker validate schemas against it', ingest is a strict-SLA path); migration note :14-16. tools/dev/dev-down.sh:25 still passes `--profile schema` (ignored by compose — harmless but misleading).

**Proposed fix:** Accept core membership (update spec); optionally drop the dead `--profile schema` arg from dev-down.sh:25 for clarity.

**Conflict justification:** Per audit instructions and the compose comments: apicurio is on the collector's ingest-path schema-validation hot path, so a schema-profile-off run would break ingest. Deliberate fold-in, documented at docker-compose.yml:385-387.

### AUD-LOCAL-007 — Trino 7g limit / 70% RAMPercentage (~4.9g heap) vs spec 1G/768m
`SEV-LOW` · `EFFORT-S` · spec §A2 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-LOCAL-007` (local-env)

**Evidence (verbatim):** docker-compose.yml:516-521 ('CONFLICT REFUSED: blueprint §4.2 says 1g … A 1g limit reproduces the serving-tier OOM-kill outage. Kept 7g'); db/trino/jvm.config:3-13; docs/ops/local-memory-budget.md:32; live: brainv3-trino-1 2.688GiB/7GiB, OOMScoreAdj=-700, restart:unless-stopped.

**Proposed fix:** Update the spec's Trino row to 7g limit / MaxRAMPercentage=70; keep the current config.

**Conflict justification:** Measured outage evidence: Trino is the SOLE serving engine; at the stock/unbounded config it was OOM-killed under refresh (memory: trino-oom-serving-outage-fix, branch fix/trino-bounded-heap-autorestart), and 1g is documented as reproducing the outage. Heap is 70% of limit (within the ≤75% rule).

### AUD-LOCAL-008 — Kafka 2500m limit with pinned 1G heap vs spec 1G limit/768m heap
`SEV-LOW` · `EFFORT-S` · spec §A2 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-LOCAL-008` (local-env)

**Evidence (verbatim):** docker-compose.yml:262-271 ('CONFLICT REFUSED: blueprint §4.2 says 1g, but the budget doc verifies the KRaft broker at 2.5g steady'; KAFKA_HEAP_OPTS pinned -Xmx1G -Xms1G, commit 55b5b118 AUD-INFRA-007); docs/ops/local-memory-budget.md:36; live 1.423GiB/2.441GiB (58%) — already above a 1G limit at steady state.

**Proposed fix:** Update the spec's Kafka row to 2500m limit / 1G pinned heap.

**Conflict justification:** Live measurement: broker steady RSS 1.42GiB exceeds the spec's 1G limit — a 1G cap would OOM-kill the event backbone in normal operation. 1G heap / 2.5g limit = 40%, within the ≤75% JVM rule.

### AUD-LOCAL-009 — Neo4j 1500m limit (512m heap + 256m pagecache) vs spec 512M/256+256
`SEV-LOW` · `EFFORT-S` · spec §A2 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-LOCAL-009` (local-env)

**Evidence (verbatim):** docker-compose.yml:100-108 ('CONFLICT REFUSED: blueprint §4.2 says 512m, but that is the JVM HEAP alone — a 512m hard mem_limit would OOM-kill neo4j on boot. Kept the budget-verified 1500m'); docs/ops/local-memory-budget.md:37; live 869.9MiB/1.465GiB (58%) — proves 512m total is impossible.

**Proposed fix:** Update the spec's Neo4j row to 1500m container / 512m heap + 256m pagecache.

**Conflict justification:** Live RSS 870MiB > the spec's 512M container limit; the spec conflates JVM heap with container limit. Documented in the compose CONFLICT REFUSED note and the budget doc.

### AUD-LOCAL-010 — unified Bronze sink container capped at 7g with 4g driver heap vs spec's 2GB-per-sink/1g-driver target (measured 2.145GiB steady)
`SEV-LOW` · `EFFORT-S` · spec §A3/A2 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-LOCAL-010` (local-env)

**Evidence (verbatim):** tools/dev/dev-bronze-streaming.sh:17-26 (1g driver 'died with java.lang.OutOfMemoryError mid-drain … after ~73k tasks'), :83 `--memory ${SPARK_CONTAINER_MEMORY:-7g}`, :108 `--driver-memory 4g`; docs/ops/local-memory-budget.md:33,59-73 ('sized for cold-start backlog drain; if you ever need to claw back room, drop it to 2g in steady state'); live `docker stats`: brain-bronze-sink 2.145GiB/7GiB — already 7% over the spec's 2GB even at steady state.

**Proposed fix:** Update the spec to the unified sink @ 7g cap/4g driver (or, if the 2GB steady target matters, adopt the budget doc's own option: SPARK_DRIVER_MEMORY=2g steady-state with 4g reserved for cold-start drains). User decision — do not blindly shrink.

**Conflict justification:** The unified single sink (bronze_landing.py) supersedes the spec's two-sink model (memory: unified-bronze-landing MERGED 2026-07-01), and the 1g→4g heap raise is backed by a reproduced OOM during backlog drain plus the checkpoint-loss amplification analysis (AUD-INFRA-004). Delta vs spec: container 7g vs 2×2GB=4GB aggregate; measured steady usage 2.145GiB is BELOW the old two-sink aggregate. Heap+offheap (4g+512m)/7g ≈ 64% — within the ≤75% rule.

### AUD-LOCAL-011 — ephemeral Spark transform job containers 7g/--driver-memory 4g vs spec 2G containers with 1g driver+executor
`SEV-LOW` · `EFFORT-S` · spec §A2 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-LOCAL-011` (local-env)

**Evidence (verbatim):** commit 1eb6917d 'hard memory cap on every Spark job container (--memory, default 7g)' (PR #342); docs/ops/local-memory-budget.md:48-57 — Spark's default 1GB driver heap heap-OOMed silver-collector-event on the real 9,916-order Shopify backfill; all 35 run scripts now pass --driver-memory ${SPARK_DRIVER_MEMORY:-4g} inside --memory ${SPARK_CONTAINER_MEMORY:-7g}; loop runs them strictly sequentially so only ONE job's ~5GB is live at a time (budget doc:64-73).

**Proposed fix:** Update the spec's Spark-job row to 7g container/4g driver (env-tunable), noting strict sequential scheduling as the aggregate bound.

**Conflict justification:** Measured JVM heap OOM at the spec's 1g driver on real data; sequential execution keeps aggregate footprint bounded (one transform at a time), so the 7g cap does not multiply. Both env vars remain tunable to the spec values.

### AUD-LOCAL-012 — MinIO 5g (GOMEMLIMIT 4500MiB) and iceberg-rest 512m vs blueprint 256m/128m
`SEV-LOW` · `EFFORT-S` · spec §A2 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-LOCAL-012` (local-env)

**Evidence (verbatim):** docker-compose.yml:148-156 ('CONFLICT REFUSED: blueprint §4.2 says 256m … a 256m hard limit would OOM-kill it instantly. Kept the budget-verified 5g') and :440-444 ('blueprint §4.2 says 128m, but iceberg-rest-fixture is a JVM (Jetty) … Applied a SAFE bounded 512m'); live: minio 1.769GiB/5GiB, iceberg-rest 222MiB/512MiB — both already exceed the blueprint numbers in steady state.

**Proposed fix:** Update the spec rows to minio 5g/GOMEMLIMIT 4500MiB and iceberg-rest 512m; optionally pin iceberg-rest heap (e.g. -Xmx384m) for explicitness.

**Conflict justification:** Live usage (minio 1.77GiB, iceberg-rest 222MiB) makes the blueprint caps physically un-runnable; minio serves the entire Iceberg warehouse for Trino+Spark. Documented CONFLICT REFUSED notes plus docs/ops/local-memory-budget.md:35,41. Note: iceberg-rest has no explicit -Xmx pin (relies on JVM default 25% MaxRAMPercentage ≈128m under the 512m cgroup) — acceptable, but a pin would make the ≤75% rule explicit.

### AUD-LOCAL-013 — LiteLLM (ai profile) commented out — `--profile ai` is currently a no-op
`SEV-LOW` · `EFFORT-S` · spec §A1 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-LOCAL-013` (local-env)

**Evidence (verbatim):** docker-compose.yml:188-218 — entire litellm block commented ('DISABLED … 2026-07-02: the AI/NLQ features (Ask-Brain, MCP) that use this model gateway are not active yet'); commit 3cddd2a1. dev-up.sh:35 and package.json `dev` still pass --profile ai (harmless no-op). App seam (@brain/ai-gateway-client → LITELLM_BASE_URL) unchanged.

**Proposed fix:** Leave as-is until Ask-Brain/MCP go live; user decision whether the spec should mark ai as 'defined but dormant'.

**Conflict justification:** Documented deliberate disable with an explicit re-enable path (uncomment; stays in the ai profile) because no active feature consumes the gateway — running it would only burn memory. Spec's ai={LiteLLM} remains structurally true (the block is profile-tagged ai), just parked.

### AUD-LOCAL-014 — pnpm dev:up is a multi-minute 8-step bring-up, not the spec's ~30s 'compose up + bootstrap'
`SEV-MED` · `EFFORT-M` · spec §A5 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-LOCAL-014` (local-env)

**Evidence (verbatim):** tools/dev/dev-up.sh:1-111 — steps: preflight → postgres --wait → migrations → full core+ai health poll (compose-up-healthy.sh: up to 360s deadline; Trino alone has start_period 30s + retries) → host Bronze sink (Spark image + ivy resolution on first run) → pnpm bootstrap → ONESHOT full medallion refresh (dev-up.sh:104-106) which sequentially runs 42 Spark run scripts (counted: db/iceberg/spark/**/run-*.sh) each as an ephemeral docker-run spark-submit, plus 4 node jobs and the Trino view applier → then apps. Realistic cold-start wall time is tens of minutes; even a warm re-run is minutes because the refresh step is synchronous and blocks step 8 (apps).

**Proposed fix:** User decision: either update the spec's readiness expectation, or background step 7 (run ONESHOT refresh concurrently with step 8's app start — apps tolerate empty marts, the views applier is the only hard cold-start need) to cut app-ready time to the infra-health + bootstrap window (~2-5 min).

**Conflict justification:** Each extra step carries documented cause: migrate-before-sink prevents the sink's cold-start JDBC crash (dev-up.sh:19-22), bootstrap restores LocalStack secrets (LocalStack community non-persistence, compose:227-231), and the one-shot refresh exists so 'dashboards render (honest empty state on a cold DB, not 500s)' (dev-up.sh:15-17) — aligned with the product rule 'No empty charts as a success state'. The spec's 30s expectation predates the medallion refresh dependency chain.

### AUD-LOCAL-015 — refresh loop spins ~42 ephemeral Spark containers every 300s even with zero new Bronze data — no idle short-circuit
`SEV-LOW` · `EFFORT-M` · spec §A3 · **GAP** · Wave 3 · orig `AUD-LOCAL-015` (local-env)

**Evidence (verbatim):** tools/dev/v4-refresh-loop.sh:511-515 — unconditional `run_once` every INTERVAL (300s default); run_once always executes both phases (identity export, 42 run-*.sh spark-submit container launches, node jobs, view applier). Watermarks make each job's WORK a fast no-op, but every cycle still pays 42 JVM/container boots + ivy-cache mounts + catalog reads on an idle system — the loop is synchronous and non-overlapping (pidfile guard :501-508 + _spark_lock.sh) but not idle-cheap.

**Proposed fix:** Add a cheap pre-cycle gate: compare the Bronze high-watermark (max committed offset / brain_bronze.events snapshot-id via one Trino query or the sink checkpoint) to a stamp file, and skip Phases 1-2 when unchanged (still honor the daily maintenance jobs).

### 3.2 AUD-PROD — prod network/EKS, data plane, obs/CI-CD/secrets (§B1–B10) — 23 findings (16 GAP / 7 CE)

Renumbered from three agents' overlapping series (net-eks AUD-PROD-00x, prod-data AUD-PROD-00x, obs/cicd/secrets AUD-PROD-B8/B9/B10-0x), ordered severity → spec_ref.

| ID | Sev | Effort | Spec | Kind | Wave | Title |
|---|---|---|---|---|---|---|
| AUD-PROD-001 | HIGH | M | B2 | GAP | 1 | In-cluster Prometheus/Grafana entirely absent — nothing exists for the system node group to host, and the observability TF module is not wired into the prod root |
| AUD-PROD-002 | HIGH | M | B8 | GAP | 1 | No kube-prometheus-stack (no Prometheus AT ALL) in prod — SLO rules and rollout analyses have no evaluator |
| AUD-PROD-003 | HIGH | S | B10 | GAP | 1 | Prod core boot secrets (JWT/cookie/Meta/Google-Ads) have NO Secrets Manager shells and NO IRSA read grant — core fail-closes at startup |
| AUD-PROD-004 | HIGH | M | B10 | GAP | 1 | Connector runtime secrets (brain/connector/*) — zero IAM grants for core (CreateSecret/Get/Put) and stream-worker (Get), and no prod CMK for alias/brain-connector-secrets |
| AUD-PROD-005 | MED | M | B1/B2 | CE | 4 | EKS API endpoint is publicly reachable from one operator CIDR (not fully private) — deliberate, documented go-live bootstrap posture |
| AUD-PROD-006 | MED | M | B2 | GAP | 1 | No workload-to-pool pinning — Trino coordinator not pinned to system group, Kafka brokers / bronze sinks / Trino workers not pinned to their pools; all Karpenter pools untainted |
| AUD-PROD-007 | MED | S | B2 | GAP | 2 | KEDA scaling of Trino workers is chart-only — ScaledObject template exists but autoscaling.enabled=false in prod, so prod runs static workers and installed KEDA scales nothing |
| AUD-PROD-008 | MED | S | B4 | GAP | 2 | ElastiCache provisions 2-node multi-AZ replication group, not the spec's single cache.t4g.micro node |
| AUD-PROD-009 | MED | L | B6 | CE | 4 | ONE medallion warehouse bucket with Iceberg namespaces instead of the spec's three buckets brain-prod-{bronze,silver,gold} (plus account-id-suffixed naming) |
| AUD-PROD-010 | MED | S | B7 | GAP | 2 | Trino worker KEDA autoscaling is unwired — fixed 3 replicas, autoscaling.enabled=false, and min/max 3/8 instead of spec 0-3 |
| AUD-PROD-011 | MED | M | B7 | GAP | 2 | No node placement anywhere in the Trino chart — coordinator not pinned to the system node group, workers not pinned to the trino Karpenter pool |
| AUD-PROD-012 | MED | M | B8 | GAP | 3 | No Thanos sidecar / S3 long-term metrics anywhere |
| AUD-PROD-013 | MED | S | B8 | GAP | 2 | Local core-profile Prometheus + Grafana disabled (commented out) — brain-slo.rules.yml is evaluated NOWHERE, and its Alertmanager target does not exist in compose |
| AUD-PROD-014 | MED | S | B10 | GAP | 2 | LocalStack secret paths are NOT the same as prod — local names have no environment segment and prod k8s-env blobs have no local counterpart |
| AUD-PROD-015 | LOW | S | B1 | GAP | 3 | VPC spans 3 AZs, spec says 2 — undocumented, and each of the 5 interface endpoints pays for a 3rd-AZ ENI |
| AUD-PROD-016 | LOW | S | B2 | CE | 4 | System MNG is 2-6 nodes (desired 3), spec says t4g.medium x1 fixed — repo sizing is required by the HA platform controllers it pins there |
| AUD-PROD-017 | LOW | S | B2 | CE | 4 | streaming/batch/trino are Karpenter NodePools, not managed node groups — and streaming has no hard 2-3 floor (warm baseline is enforced indirectly) |
| AUD-PROD-018 | LOW | S | B2 | CE | 4 | Fifth node pool 'ondemand' (t4g.xlarge on-demand, tainted, 0-2) exists beyond the spec's 4-group table |
| AUD-PROD-019 | LOW | S | B6 | GAP | 3 | S3 Intelligent-Tiering absent on the medallion warehouse bucket (unexecuted Wave-3 item) |
| AUD-PROD-020 | LOW | S | B6 | CE | 4 | Iceberg expire_snapshots TTL is 7 days, not the spec's 90 days |
| AUD-PROD-021 | LOW | M | B7 | GAP | 3 | Trino deployed from a custom in-repo chart, not the official Trino helm chart |
| AUD-PROD-022 | LOW | S | B9 | GAP | 3 | CD workflow is main.yml on push:[master], not deploy.yml on push:[main] |
| AUD-PROD-023 | LOW | S | B9 | CE | 4 | CD builds AFFECTED services only, not all 4 unconditionally per push |

### AUD-PROD-001 — In-cluster Prometheus/Grafana entirely absent — nothing exists for the system node group to host, and the observability TF module is not wired into the prod root
`SEV-HIGH` · `EFFORT-M` · spec §B2 · **GAP** · Wave 1 · orig `AUD-PROD-001` (prod-net-eks)

**Evidence (verbatim):** infra/argocd/envs/prod/ = 17 apps, none observability (staging has only 6, also none); infra/terraform/envs/prod/bootstrap.tf = 22 module blocks, no observability module (grep 'observability' envs/prod/ = 0); envs/dev/main.tf:250-251 instantiates modules/observability and exports otel_collector_role_arn (:279); modules/observability/main.tf:1-5 ruling 'Grafana Cloud owns SLOs (no CloudWatch dashboards). OTel collector IRSA is provisioned here' — but no Grafana-Cloud agent/OTel collector is deployed for prod anywhere (infra/helm/ has no such chart; infra/observe/* is the local-compose stack; infra/observe/k8s/ = freshness-exporter + kafka-observability only; infra/argocd/rollouts/analysis-templates.yaml queries a prometheus nothing deploys); docs/runbooks/GO-LIVE.md (358 lines, commit bd19fc4b today) contains zero observability/metrics/alerting steps. Not addressed by any AUD-COST-016..025 / AUD-INFRA-011 commit (AUD-COST-021 only tf-validates modules, does not wire them). Nuance vs original title: in-cluster Prometheus/Grafana absence is per the documented ruling; the unjustified gap is that neither the observability TF module nor any metrics-shipping path exists in prod at all.

**Proposed fix:** Either add kube-prometheus-stack (or the intended Grafana-Cloud agent/OTel collector) as an infra/argocd/envs/prod app pinned to the system group (nodeSelector role: system) AND instantiate modules/observability in envs/prod/bootstrap.tf, or ratify the Grafana-Cloud-only ruling in an ADR and update the spec — today prod goes live with no metrics path at all

**Verifier note (adversarial re-check, confirmed real):** Every cited evidence point verified: infra/argocd/envs/prod/ has exactly the 17 listed apps with no prometheus/grafana/otel/grafana-agent Application; infra/terraform/envs/prod/bootstrap.tf instantiates 22 modules and none is observability (grep=0), while envs/dev/main.tf:250-251 does instantiate it (plus otel_collector_role_arn output at :279); modules/observability/main.tf:1-5 header matches verbatim; docs/runbooks/GO-LIVE.md (358 lines, written today) has ZERO mentions of prometheus/grafana/otel/metrics/observability/alarm/monitoring. None of today's commits (AUD-COST-016..025, AUD-INFRA-011, AUD-CODE-025) touch prod observability. Net effect confirmed: prod has no metrics path, no CloudWatch log groups, no EKS-unhealthy alarm, and no OTel/Grafana-Cloud shipping agent — dev has all of these. Kind=GAP is correct despite the in-module 'Grafana Cloud owns SLOs' ruling: that ruling justifies the absence of in-cluster dashboards, but presupposes the observability module (OTel IRSA + log groups + alarm) and a collector deployment, and nothing in-repo justifies prod omitting the module dev instantiates — an unexplained omission, not a ratified measured deviation. SEV-HIGH fits (prod goes live blind for a platform with SLO commitments and documented Trino/Spark OOM history; not CRITICAL since no data loss or security exposure).

### AUD-PROD-002 — No kube-prometheus-stack (no Prometheus AT ALL) in prod — SLO rules and rollout analyses have no evaluator
`SEV-HIGH` · `EFFORT-M` · spec §B8 · **GAP** · Wave 1 · orig `AUD-PROD-B8-01` (prod-obs-cicd-secrets)

**Evidence (verbatim):** infra/argocd/envs/prod/ contains 17 Application manifests (the 16 listed plus stream-worker.yaml) — none deploys Prometheus; grep -rn kube-prometheus infra/ hits only two advisory comments in infra/observe/k8s/kafka-observability.yaml. analysis-templates.yaml:25,49,71 and collector-rollout.yaml:48,59 retain REPLACE_WITH_PROMETHEUS_ADDRESS. The ADR-006-ruled fallback (Grafana Cloud owns SLOs, modules/observability/main.tf:2-4) is unimplemented in prod only: envs/staging/main.tf:244 and envs/dev/main.tf:250 instantiate modules/observability, but envs/prod/bootstrap.tf has zero observability references and no otel-collector/agent deployment exists in infra/helm or infra/argocd. infra/observe/alerts/{brain-slo,freshness}.rules.yml and the auto-rollback signals printed by .github/workflows/main.yml (bake-window step, incl. a Grafana Cloud dashboard URL nothing ships to) therefore have no prod evaluator. docs/runbooks/GO-LIVE.md (added today, bd19fc4b) contains no prometheus/grafana/alert step.

**Proposed fix:** Add a kube-prometheus-stack ArgoCD Application in infra/argocd/envs/prod (nodeSelector role: system like external-secrets.yaml does), mount infra/observe/alerts/*.rules.yml as PrometheusRule/ConfigMap, and fill analysis-templates PROMETHEUS_ADDRESS from the in-cluster service. Alternatively, if the ADR-006 'Grafana Cloud owns SLOs' ruling stands (modules/observability/main.tf:2-4, docs/requirements/04 ADR-006), actually wire it: instantiate modules/observability in envs/prod/bootstrap.tf, deploy the otel-collector/agent shipping to Grafana Cloud, and upload the alert rules to Mimir — today NEITHER path is implemented.

**Verifier note (adversarial re-check, confirmed real):** Every evidence pointer verified live: no prometheus/kube-prometheus-stack Application among the 17 prod ArgoCD manifests (grep -rn kube-prometheus infra/ = 2 comment-only hits); analysis-templates.yaml:25 (and collector-rollout.yaml:48,59) still say REPLACE_WITH_PROMETHEUS_ADDRESS; infra/terraform/envs/prod/bootstrap.tf instantiates ~22 modules but NOT modules/observability — while envs/staging/main.tf:244 and envs/dev/main.tf:250 both do, making prod the only env with neither path; no otel/grafana-agent deployment exists in infra/helm or infra/argocd; docs/runbooks/GO-LIVE.md has zero prometheus/grafana/alert mentions; main.yml bake-window step still prints the auto-rollback SLO signals with no runtime evaluator. None of today's remediation commits (AUD-COST-016..025, AUD-INFRA-011, AUD-CODE-025) touch observability. Kind=GAP is correct despite the ADR-006 'Grafana Cloud owns SLOs' ruling: that ruling would only justify the absence of in-cluster Prometheus, and the finding explicitly verifies the ruled Grafana Cloud path is ALSO unimplemented in prod — a ruling with zero implementation is a gap, not a justified deviation. SEV-HIGH fits (deploy-safety mechanisms quoted in CD are non-functional in prod; no direct data/serving outage so not CRITICAL). Only nit: the prod dir has 17 apps, not 16 (finding's list omitted stream-worker.yaml) — immaterial.

### AUD-PROD-003 — Prod core boot secrets (JWT/cookie/Meta/Google-Ads) have NO Secrets Manager shells and NO IRSA read grant — core fail-closes at startup
`SEV-HIGH` · `EFFORT-S` · spec §B10 · **GAP** · Wave 1 · orig `AUD-PROD-B10-01` (prod-obs-cicd-secrets)

**Evidence (verbatim):** apps/core/src/main.ts:134-176 — in production, JWT_SIGNING_SECRET / COOKIE_SECRET / META_APP_SECRET / GOOGLE_ADS_CLIENT_SECRET env values are treated as SM names/ARNs and fetched via AwsSecretsProvider, which is fail-closed (apps/core/src/infrastructure/secrets/AwsSecretsProvider.ts:37-42 — throws, startup aborts). But modules/secrets/main.tf creates shells only for db/kafka/grafana/apicurio + the 7 brain/prod/k8s/* env blobs (lines 35-121), and core's IRSA policy core_secrets_read grants GetSecretValue on ONLY db_app + kafka ARNs (modules/secrets/main.tf:208-233; attached at envs/prod/bootstrap.tf:227-240). infra/helm/external-secrets-config/README.md and PLACEHOLDERS.md §5 never mention these four secrets. Result: even a perfect GO-LIVE fill pass yields AccessDenied → core CrashLoop.

**Proposed fix:** Add the four secret shells to modules/secrets (brain/prod/app/jwt-signing-secret etc.), extend core_secrets_read to cover them, and document their refs as required keys of brain/prod/k8s/core-env in external-secrets-config/README.md + PLACEHOLDERS.md §5.

**Verifier note (adversarial re-check, confirmed real):** Verified, not refutable. apps/core/src/main.ts:134-176 confirms prod resolves JWT_SIGNING_SECRET, COOKIE_SECRET, META_APP_SECRET, GOOGLE_ADS_CLIENT_SECRET via AwsSecretsProvider, which is fail-closed (AwsSecretsProvider.ts:37-42 throws → startup aborts). infra/terraform/modules/secrets/main.tf creates shells only for db/kafka/grafana/apicurio + the 7 brain/prod/k8s/* env blobs, and core_secrets_read (lines 208-233) grants GetSecretValue on ONLY db_app+kafka ARNs, attached to module.irsa_core in envs/prod/bootstrap.tf. Today's AUD-COST-017 added the 7 k8s env-blob shells + platform IRSA roles but did NOT add these four app-secret shells or extend core_secrets_read; no commit in the last 60 touches them. Zero mentions of JWT_SIGNING_SECRET/COOKIE_SECRET anywhere in infra/ or docs/runbooks/GO-LIVE.md; the GO-LIVE core-env fill list and external-secrets-config/README.md core-env key contract omit all four (META_APP_SECRET appears only under stream-worker-env). No alternate delivery works: prod main.ts re-fetches the env value as an SM SecretId regardless, so a raw value in core-env is a bogus lookup and an ARN is an IRSA AccessDenied — deterministic core CrashLoop even after a perfect fill pass. Kind GAP is correct (no in-repo measured justification for the omission); SEV-HIGH is correct (loud fail-closed go-live blocker, not silent data loss/security exposure, so not CRITICAL). Proposed fix matches the established AUD-COST-017 shell+IRSA+README-contract pattern.

### AUD-PROD-004 — Connector runtime secrets (brain/connector/*) — zero IAM grants for core (CreateSecret/Get/Put) and stream-worker (Get), and no prod CMK for alias/brain-connector-secrets
`SEV-HIGH` · `EFFORT-M` · spec §B10 · **GAP** · Wave 1 · orig `AUD-PROD-B10-02` (prod-obs-cicd-secrets)

**Evidence (verbatim):** packages/connector-secrets/src/AwsSecretsManager.ts:~76-105 (storeSecret CreateSecret w/ KmsKeyId on brain/connector/<type>/<brandId>, PutSecretValue fallback) and ~185-205 (storeShopifyToken); apps/stream-worker/src/jobs/shopify-backfill/worker-secrets.ts:31-51 (prod AwsSecretsManager, throws w/o KMS_KEY_ID); apps/core/src/main.ts:699-709 (prod FATAL w/o CONNECTOR_SECRETS_KMS_KEY_ID — note: core var name differs from the finding's KMS_KEY_ID). grep 'brain/connector|CreateSecret|PutSecretValue' infra/terraform --include=*.tf = 0 hits; infra/terraform/modules/secrets/main.tf:150-260 grants core/stream-worker only GetSecretValue/DescribeSecret on db_app/kafka/apicurio (+k8s_env for ESO); infra/terraform/modules/kms/main.tf:46,67 creates only alias/brain-root-prod + alias/brain-audit-prod; alias/brain-connector-secrets provisioned only by tools/seed/prod-local-aws-bootstrap.sh:20-38 (LocalStack). Not remediated by AUD-COST-017 (2d0aa930 — platform IRSA + brain/prod/k8s/* shells only) or AUD-COST-004 (ESO env delivery); infra/helm has zero KMS_KEY_ID/CONNECTOR_SECRETS references; docs/runbooks/GO-LIVE.md step 12 assumes post-launch connector reconnects that these missing grants would break.

**Proposed fix:** Terraform: add a connector-secrets CMK (alias/brain-connector-secrets-prod or reuse root) + an IAM policy granting core Create/Get/Put/Delete and stream-worker Get/Describe scoped to arn:...:secret:brain/connector/* with kms:Encrypt/Decrypt on the CMK; attach to irsa_core / irsa_stream_worker. Document KMS_KEY_ID as a required core-env/stream-worker-env key.

**Verifier note (adversarial re-check, confirmed real):** Confirmed on all axes. (1) Cited code is real: AwsSecretsManager (packages/connector-secrets/src/AwsSecretsManager.ts) CreateSecret/PutSecretValue on brain/connector/* with KmsKeyId, used by prod core and by stream-worker's read path (worker-secrets.ts:31-51). (2) Terraform gap is real: grep for brain/connector|CreateSecret|PutSecretValue (and any secretsmanager write verbs/wildcards) across infra/terraform = 0 hits; modules/secrets/main.tf grants core/stream-worker only GetSecretValue/DescribeSecret on db_app/kafka/apicurio/k8s_env ARNs; modules/kms/main.tf creates only root+audit CMKs — alias/brain-connector-secrets exists only in tools/seed/prod-local-aws-bootstrap.sh (LocalStack). (3) Not fixed: AUD-COST-017 created platform IRSA roles + brain/prod/k8s/* env shells (different namespace, read-only); no commit in the last 60 touches connector-secret grants or a connector CMK; helm has zero KMS_KEY_ID/CONNECTOR_SECRETS refs; GO-LIVE.md assumes post-launch connector reconnects that this gap makes impossible. (4) Impact is actually slightly WORSE than stated: core FATALs at startup without CONNECTOR_SECRETS_KMS_KEY_ID (main.ts:699-709) and stream-worker throws without KMS_KEY_ID — before any Secrets Manager call. GAP kind correct (no documented justification for deferral found in-repo); SEV-HIGH fits (prod connector platform fully dead + boot failure, but no data loss/tenant breach). Minor nit: core env var is CONNECTOR_SECRETS_KMS_KEY_ID, not KMS_KEY_ID (that's the stream-worker var).

### AUD-PROD-005 — EKS API endpoint is publicly reachable from one operator CIDR (not fully private) — deliberate, documented go-live bootstrap posture
`SEV-MED` · `EFFORT-M` · spec §B1/B2 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-PROD-005` (prod-net-eks)

**Evidence (verbatim):** envs/prod/terraform.tfvars:14 eks_public_access_cidrs = ["94.204.52.169/32"]; modules/eks/main.tf:110-111 enables public access pinned to that allowlist

**Proposed fix:** User decision: accept the CIDR-pinned window and schedule the SSM-bastion (t4g.nano + AmazonSSMManagedInstanceCore + ssm/ssmmessages/ec2messages interface endpoints) follow-up that re-privatises the endpoint, or build the bastion before go-live

**Conflict justification:** AUD-COST-009 (modules/eks/main.tf:81-92, envs/prod/variables.tf:13-22): a private-only endpoint had NO access path (no bastion/VPN/SSM; GitHub runners are outside the VPC), making the one-time kubectl/helm/argocd bootstrap impossible; documented flip-back-to-[] instruction once an SSM bastion or Client VPN exists

### AUD-PROD-006 — No workload-to-pool pinning — Trino coordinator not pinned to system group, Kafka brokers / bronze sinks / Trino workers not pinned to their pools; all Karpenter pools untainted
`SEV-MED` · `EFFORT-M` · spec §B2 · **GAP** · Wave 1 · orig `AUD-PROD-002` (prod-net-eks)

**Evidence (verbatim):** grep -rln nodeSelector infra/helm → only neo4j/values-prod.yaml (plus karpenter chart itself); infra/helm/trino/templates/{coordinator,worker}-deployment.yaml and strimzi-kafka/values-prod.yaml have zero nodeSelector/affinity/toleration; infra/helm/karpenter/README.md:49-53 documents pinning as 'follow-up, deliberately out of scope here'; karpenter/values.yaml:66,77,88 taints: [] on all Spot pools

**Proposed fix:** Add nodeSelector {role: system} to the Trino coordinator (spec places it on the on-demand system MNG), nodeSelector {brain.platform/pool: streaming} to Strimzi Kafka brokers + bronze-sink/stream-worker pods, {brain.platform/pool: trino} to Trino workers, {brain.platform/pool: batch} to cronworkflow Spark pods. Without pinning, stateful Kafka brokers can land on the batch/trino pools whose WhenEmptyOrUnderutilized consolidation (values.yaml:70,81) actively bin-packs live pods off nodes — broker churn risk against the 'no event loss' core rule

### AUD-PROD-007 — KEDA scaling of Trino workers is chart-only — ScaledObject template exists but autoscaling.enabled=false in prod, so prod runs static workers and installed KEDA scales nothing
`SEV-MED` · `EFFORT-S` · spec §B2 · **GAP** · Wave 2 · orig `AUD-PROD-003` (prod-net-eks)

**Evidence (verbatim):** infra/helm/trino/templates/worker-scaledobject.yaml:1 gated on .Values.workers.autoscaling.enabled; infra/helm/trino/values-prod.yaml:26-30 'KEDA worker autoscaling stays OFF until KEDA is installed + a scale baseline is measured in prod' with enabled: false (minReplicas 3 / maxReplicas 8 pre-staged); KEDA itself IS installed via infra/argocd/envs/prod/keda.yaml (chart 2.15.1). Note the OFF comment is stale on its first condition — KEDA install is now wired

**Proposed fix:** Flip workers.autoscaling.enabled: true in trino/values-prod.yaml (the deployment already omits static replicas when enabled — worker-scaledobject.yaml comment), with minReplicas matching the current static replicaCount so behaviour is a strict superset; keep the CPU trigger at 70%. If the 'measure a baseline first' sequencing is intentional, put it in GO-LIVE.md as an explicit post-go-live step so it isn't lost

### AUD-PROD-008 — ElastiCache provisions 2-node multi-AZ replication group, not the spec's single cache.t4g.micro node
`SEV-MED` · `EFFORT-S` · spec §B4 · **GAP** · Wave 2 · orig `AUD-PROD-001` (prod-data)

**Evidence (verbatim):** infra/terraform/modules/elasticache/main.tf:49-51 (variable num_cache_nodes default = 2) and :75-77 (num_cache_clusters = var.num_cache_nodes; automatic_failover_enabled / multi_az_enabled = num_cache_nodes > 1). envs/prod/bootstrap.tf:374-383 passes node_type = "cache.t4g.micro" but never num_cache_nodes, so prod gets TWO t4g.micro nodes with multi-AZ + auto-failover. ADR-0009 documents only the t4g.micro starter sizing, not a 2-node decision; audit report line 1096 cites elasticache only for snapshot_retention_limit.

**Proposed fix:** Pass num_cache_nodes = 1 in envs/prod/bootstrap.tf module "elasticache" (module already degrades gracefully: automatic_failover/multi_az flip false when count is 1). Halves cache spend and matches the starter spec; document in ADR-0009 if 2-node HA is instead the intended decision.

### AUD-PROD-009 — ONE medallion warehouse bucket with Iceberg namespaces instead of the spec's three buckets brain-prod-{bronze,silver,gold} (plus account-id-suffixed naming)
`SEV-MED` · `EFFORT-L` · spec §B6 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-PROD-003` (prod-data)

**Evidence (verbatim):** infra/terraform/modules/s3-iceberg/main.tf:87-99 creates the single bucket brain-bronze-prod-<account_id> with medallion_namespaces [brain_bronze, brain_silver, brain_gold] as prefixes (:65-81); envs/prod/bootstrap.tf:167-188 instantiates only module.s3_iceberg; modules/s3-iceberg-medallion/main.tf:16-21 states "PROD NO LONGER USES THIS MODULE (AUD-COST-016)"; infra/helm/iceberg-rest/values-prod.yaml warehouse: s3://brain-bronze-prod-ACCOUNT_ID/ with the same rationale comment.

**Proposed fix:** User decision: either ratify the single-warehouse layout (update the deployment spec to match AUD-COST-016 — recommended, since it mirrors the proven local topology) or fund a migration to three buckets with per-namespace catalog location overrides + parity testing of that shape locally.

**Conflict justification:** AUD-COST-016 (documented in modules/s3-iceberg/main.tf:2-27, modules/s3-iceberg-medallion/main.tf:16-21, envs/prod/bootstrap.tf:167-172, iceberg-rest/values-prod.yaml comments): the single Iceberg REST/Jdbc catalog has ONE warehouse root — local compose runs exactly this shape (CATALOG_WAREHOUSE=s3://brain-bronze/ with layers as namespaces), and per-layer buckets would require per-namespace location overrides local never exercises, breaking local/prod parity. The account-id suffix is forced by S3 global bucket-name uniqueness; the historical -bronze- name keeps parity with the local warehouse root. IAM still separates layers via namespace-prefix policies (spark_medallion_rw vs analytics_s3 read-only).

### AUD-PROD-010 — Trino worker KEDA autoscaling is unwired — fixed 3 replicas, autoscaling.enabled=false, and min/max 3/8 instead of spec 0-3
`SEV-MED` · `EFFORT-S` · spec §B7 · **GAP** · Wave 2 · orig `AUD-PROD-005` (prod-data)

**Evidence (verbatim):** infra/helm/trino/values-prod.yaml:18-30 — workers.replicaCount: 3, autoscaling.enabled: false with comment "KEDA worker autoscaling stays OFF until KEDA is installed + a scale baseline is measured in prod", minReplicas: 3 / maxReplicas: 8. The ScaledObject template exists (templates/worker-scaledobject.yaml:1-25, CPU-utilization trigger, gated on the flag) and the KEDA operator IS declared (infra/argocd/envs/prod/keda.yaml, upstream chart 2.15.1 + infra/helm/keda/values-prod.yaml), so the stated prerequisite is already met by the manifests.

**Proposed fix:** Flip workers.autoscaling.enabled: true in values-prod.yaml and set minReplicas/maxReplicas per the spec (0/3) — note scale-to-zero means first-query cold start while a worker schedules; if that violates serving latency SLOs, propose min 1 as a spec amendment. Verify the worker Deployment omits static replicas when the flag is on (worker-deployment.yaml comment says it does).

### AUD-PROD-011 — No node placement anywhere in the Trino chart — coordinator not pinned to the system node group, workers not pinned to the trino Karpenter pool
`SEV-MED` · `EFFORT-M` · spec §B7 · **GAP** · Wave 2 · orig `AUD-PROD-006` (prod-data)

**Evidence (verbatim):** grep for nodeSelector/tolerations/affinity across infra/helm/trino/templates/{coordinator,worker}-deployment.yaml and values{,-prod}.yaml returns ZERO scheduling constraints (only the /etc/trino/node.properties mount matches 'node'). A dedicated trino Karpenter NodePool EXISTS (infra/helm/karpenter/values.yaml:78-88, t4g.xlarge Spot, untainted, comment even says "KEDA scales workers") but nothing routes Trino pods to it — pool selection falls to Karpenter weights, where the streaming pool (weight 30, values.yaml:62) is preferred over trino (weight 10), so the SOLE serving engine can land on streaming Spot nodes and the coordinator on any Spot node instead of the on-demand system group.

**Proposed fix:** Add nodeSelector (and tolerations if pools gain taints) values to the trino chart: coordinator → the EKS system managed node group label (on-demand, stable — matches KEDA/Karpenter-controller placement doctrine in infra/helm/keda/values-prod.yaml:12-13), workers → karpenter.sh/nodepool: trino. Wire through values-prod.yaml so dev/local rendering is unaffected.

### AUD-PROD-012 — No Thanos sidecar / S3 long-term metrics anywhere
`SEV-MED` · `EFFORT-M` · spec §B8 · **GAP** · Wave 3 · orig `AUD-PROD-B8-02` (prod-obs-cicd-secrets)

**Evidence (verbatim):** `find infra -iname '*thanos*'` = 0 files; `grep -rn -i thanos infra/ docs/` = 0 hits outside requirement docs; no metrics S3 bucket in modules/ (only s3-iceberg, s3-audit, s3-iceberg-medallion). Long-term metric retention has no implementation.

**Proposed fix:** Blocked on B8-01 (needs a Prometheus first). When kube-prometheus-stack lands, enable the Thanos sidecar with an S3 objstore bucket (new tf module or extend s3-audit pattern) — or record the Grafana-Cloud-retention decision as the explicit substitute and close this item as superseded.

### AUD-PROD-013 — Local core-profile Prometheus + Grafana disabled (commented out) — brain-slo.rules.yml is evaluated NOWHERE, and its Alertmanager target does not exist in compose
`SEV-MED` · `EFFORT-S` · spec §B8 · **GAP** · Wave 2 · orig `AUD-PROD-B8-03` (prod-obs-cicd-secrets)

**Evidence (verbatim):** docker-compose.yml:545-562 (`# prometheus — DISABLED (commented out) 2026-07-02`) and :591-597 (grafana same), commit 3cddd2a1 'chore(compose): disable unused observability containers'. Live check: `docker ps` shows no prometheus/grafana/alertmanager containers (core stack otherwise up). infra/observe/prometheus.yml:6-13 loads 'alerts/*.rules.yml' and routes to alertmanager:9093, but no alertmanager service exists in docker-compose.yml (grep = 0). Combined with B8-01, the SLO alert rules (whose own header warns against 'fantasy alerts that silently never fire') currently fire nowhere — the exact false-safety anti-pattern they document.

**Proposed fix:** Re-enable the prometheus block (256m mem_limit already budgeted per blueprint §4.2) so the rules are at least exercised locally, and either add an alertmanager service in a profile or drop the alerting stanza with a comment. Grafana can stay off if dashboards are unused, but prometheus is the rules evaluator, not just grafana's datasource.

### AUD-PROD-014 — LocalStack secret paths are NOT the same as prod — local names have no environment segment and prod k8s-env blobs have no local counterpart
`SEV-MED` · `EFFORT-S` · spec §B10 · **GAP** · Wave 2 · orig `AUD-PROD-B10-03` (prod-obs-cicd-secrets)

**Evidence (verbatim):** Local (tools/seed/prod-local-aws-bootstrap.sh:42,65): brain/jwt-signing-secret, brain/cookie-secret, brain/shopify-client-secret, brain/meta-app-secret, brain/google-ads-client-secret — flat, no env segment. Prod convention (modules/secrets/main.tf:36-111, external-secrets-config/README.md): brain/prod/{db,kafka,grafana,apicurio}/... + brain/prod/k8s/{core-env,web-env,collector-env,stream-worker-env,pgbouncer-env,iceberg-rest-catalog-db,neo4j-auth}. None of the 11 prod names exists locally and none of the 5 local names exists in prod. HONEST PARITY NOTE: the connector token paths ARE identical local↔prod — brain/connector/<provider>/<brandId>... is generated by the same shared code (packages/connector-secrets/src/AwsSecretsManager.ts:76 vs LocalSecretsManager.ts:79) — and the app-level secrets are ref-driven env vars (main.ts:138-139), so the mismatch is seed-script convention, not hardcoded paths.

**Proposed fix:** Rename the LocalStack-seeded names to the prod convention (brain/prod/... or brain/local/... with a single SECRET_PREFIX) OR seed the brain/prod/k8s/* env-blob shapes into LocalStack so prod-local rehearses the exact ESO contract; update .env.local-prod.example refs accordingly. Cheap, and it makes prod-on-local actually rehearse the go-live fill pass.

### AUD-PROD-015 — VPC spans 3 AZs, spec says 2 — undocumented, and each of the 5 interface endpoints pays for a 3rd-AZ ENI
`SEV-LOW` · `EFFORT-S` · spec §B1 · **GAP** · Wave 3 · orig `AUD-PROD-004` (prod-net-eks)

**Evidence (verbatim):** modules/network/main.tf:34-37 availability_zones default = [ap-south-1a, ap-south-1b, ap-south-1c]; envs/prod/bootstrap.tf:82-89 does not override it; modules/vpc-endpoints/main.tf:162-169 places interface ENIs in ALL private subnets (5 services x 3 AZs). No doc/ADR found justifying 3 AZs (grep AZ docs/adr/0009 covers only NAT/Aurora)

**Proposed fix:** Pass availability_zones = ["ap-south-1a","ap-south-1b"] from envs/prod/bootstrap.tf (or restrict vpc-endpoints private_subnet_ids to 2 AZs) to match the spec and save ~5 x $7/mo of PrivateLink AZ cost — or document the 3-AZ choice (Aurora/EKS subnet spread headroom) and update the spec. Subnet CIDR changes are destructive; decide BEFORE more of envs/prod is applied

### AUD-PROD-016 — System MNG is 2-6 nodes (desired 3), spec says t4g.medium x1 fixed — repo sizing is required by the HA platform controllers it pins there
`SEV-LOW` · `EFFORT-S` · spec §B2 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-PROD-006` (prod-net-eks)

**Evidence (verbatim):** envs/prod/terraform.tfvars:17-19 system_node_desired=3 min=2 max=6; envs/prod/variables.tf:24-40; instance type/on-demand DO match spec (modules/eks/main.tf:220-221 t4g.medium, no capacity_type = on-demand)

**Proposed fix:** User decision: update the spec table to system = t4g.medium 2-6 (desired 3), or accept single-node non-HA system capacity and drop Karpenter controller to 1 replica

**Conflict justification:** infra/argocd/envs/prod/karpenter.yaml:58,81-82 runs the Karpenter controller with replicas: 2 pinned nodeSelector role: system (README.md:15-24: 'an autoscaler must not run on the Spot capacity it manages'); a single t4g.medium cannot host 2 controller replicas + CoreDNS + ArgoCD + KEDA + ALB-controller with any node-failure tolerance — spec's x1 fixed is likely stale vs this HA requirement

### AUD-PROD-017 — streaming/batch/trino are Karpenter NodePools, not managed node groups — and streaming has no hard 2-3 floor (warm baseline is enforced indirectly)
`SEV-LOW` · `EFFORT-S` · spec §B2 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-PROD-007` (prod-net-eks)

**Evidence (verbatim):** infra/helm/karpenter/values.yaml:55-88 (streaming t4g.large spot WhenEmpty cpu20/80Gi; batch t4g.xlarge spot 0-3-equivalent cpu12/48Gi; trino t4g.xlarge spot 0-2-equivalent cpu8/32Gi); no fixed minimum exists for streaming (values.yaml:63 'no fixed minimum'); streaming upper bound (cpu 20 = ~10 t4g.large) also exceeds the spec's 3

**Proposed fix:** User decision: ratify Karpenter-pools-with-bounded-limits as the superseding topology (update spec), or add a 2-node floor for streaming (e.g. a small fixed streaming MNG or a placeholder Deployment with pool nodeSelector) if a hard warm minimum independent of workload replicas is required

**Conflict justification:** infra/helm/karpenter/README.md:26-47 explicitly documents the design ('Node pools (match the blueprint node groups)'; 'streaming = no scale-to-zero is enforced two ways: WhenEmpty consolidation + warm workload replica baseline'), and values.yaml:49-54 repeats the rationale; the pools deliver the same instance types/capacity classes with consolidation-based cost recovery the fixed MNGs can't

### AUD-PROD-018 — Fifth node pool 'ondemand' (t4g.xlarge on-demand, tainted, 0-2) exists beyond the spec's 4-group table
`SEV-LOW` · `EFFORT-S` · spec §B2 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-PROD-008` (prod-net-eks)

**Evidence (verbatim):** infra/helm/karpenter/values.yaml:89-109 (ondemand pool, taint brain.platform/pool=ondemand:NoSchedule); README.md:33-39

**Proposed fix:** Update the spec's node-group table to include the ondemand stateful pool; no code change needed

**Conflict justification:** AUD-COST-018 (values.yaml:89-95): Neo4j is the identity SYSTEM OF RECORD (ADR-0004) running Community edition (no HA) — a Spot reclaim bounces the only replica; the tainted on-demand pool scales to zero when unused so it adds no idle cost. Neo4j pins there via infra/helm/neo4j/values-prod.yaml nodeSelector+toleration

### AUD-PROD-019 — S3 Intelligent-Tiering absent on the medallion warehouse bucket (unexecuted Wave-3 item)
`SEV-LOW` · `EFFORT-S` · spec §B6 · **GAP** · Wave 3 · orig `AUD-PROD-002` (prod-data)

**Evidence (verbatim):** grep -rni intelligent infra/ returns ZERO hits; modules/s3-iceberg/main.tf:134-149 defines only a noncurrent-version-cleanup lifecycle rule (90d noncurrent + multipart abort) — no aws_s3_bucket_intelligent_tiering_configuration resource anywhere in infra/terraform.

**Proposed fix:** Add aws_s3_bucket_intelligent_tiering_configuration to modules/s3-iceberg (warehouse bucket, whole-bucket or per-namespace prefix filters brain_bronze/ brain_silver/ brain_gold/). Safe for Iceberg data: IT frequent/infrequent tiers have no retrieval fee and do not move/delete objects, so it cannot corrupt catalog-referenced files (unlike lifecycle expiry, which the module header correctly forbids).

### AUD-PROD-020 — Iceberg expire_snapshots TTL is 7 days, not the spec's 90 days
`SEV-LOW` · `EFFORT-S` · spec §B6 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-PROD-004` (prod-data)

**Evidence (verbatim):** db/iceberg/spark/medallion_maintenance.py:53 SNAPSHOT_TTL_MS default 604_800_000 (7 days) and bronze_maintenance.py:48 same; scheduled weekly via infra/helm/cronworkflows/values.yaml:142-148 (medallion maintenance, Sun 04:45) with the daily Bronze maintenance slot at 03:00.

**Proposed fix:** User decision: update the spec's 90-day figure to 7-day snapshot TTL + separate 24-month data-retention policy, or explicitly require a longer time-travel window and accept the measured storage/metadata growth.

**Conflict justification:** AUD-PERF-013, documented in medallion_maintenance.py:47-53: snapshot TTL ≠ data retention — expire_snapshots only drops history/superseded files and never deletes rows from current state, so a long cutoff (the former 24-month one) delivered NO retention while retaining every micro-batch snapshot and every file it references (unbounded metadata + storage = mart_size × refresh cycles). Snapshots need only a short bounded time-travel window; the 24-month DATA retention contract is enforced separately as row/partition DELETEs (bronze_raw_retention.py D4 window). Also load-bearing for erasure: bronze_maintenance.py:89-91 purges pre-deletion snapshots with ttl_ms=0 so erased rows aren't time-travel-readable.

### AUD-PROD-021 — Trino deployed from a custom in-repo chart, not the official Trino helm chart
`SEV-LOW` · `EFFORT-M` · spec §B7 · **GAP** · Wave 3 · orig `AUD-PROD-007` (prod-data)

**Evidence (verbatim):** infra/helm/trino/Chart.yaml — name: trino, version 0.1.0, description "Brain serving tier" (home-built; templates/ = hand-written coordinator/worker deployments, configmaps, ScaledObject). infra/argocd/envs/prod/trino.yaml sources path infra/helm/trino from this repo, unlike keda.yaml/strimzi-kafka.yaml which pull upstream charts. No ADR or comment documents rejecting the official trinodb chart.

**Proposed fix:** Either migrate to the official trinodb/charts trino chart — MUST carry over the measured bounded-heap jvm.config (configmaps.yaml:39-42 InitialRAMPercentage 35 / MaxRAMPercentage 70, mirrors db/trino/jvm.config; unbounded heap reproduced the prod serving outage) and the REST-catalog/IRSA catalog properties — or write a short ADR ratifying the custom chart so the spec deviation is documented rather than accidental.

### AUD-PROD-022 — CD workflow is main.yml on push:[master], not deploy.yml on push:[main]
`SEV-LOW` · `EFFORT-S` · spec §B9 · **GAP** · Wave 3 · orig `AUD-PROD-B9-01` (prod-obs-cicd-secrets)

**Evidence (verbatim):** .github/workflows/main.yml:1-4 — `name: main`, `on: push: branches: [master]`. No deploy.yml exists. Note the repo default branch IS master (a previous audit fixed a DORMANT-CD bug where the trigger said [main]≠master), so the branch delta is the spec being stale; only the filename/name differs functionally-neutrally.

**Proposed fix:** Either rename the workflow file/name to deploy.yml for spec alignment (pure rename — job graph unchanged), or update the spec to 'main.yml on master'. Do NOT change the branch trigger: [master] is correct for this repo.

### AUD-PROD-023 — CD builds AFFECTED services only, not all 4 unconditionally per push
`SEV-LOW` · `EFFORT-S` · spec §B9 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-PROD-B9-02` (prod-obs-cicd-secrets)

**Evidence (verbatim):** .github/workflows/main.yml:37-78 (matrix [collector, stream-worker, core, web] + affected-set skip), :271-285 (gitops bump skips apps without an imgref artifact).

**Proposed fix:** User decision: keep affected-only (add a periodic scheduled full rebuild for CVE hygiene), or drop the skip step to match the spec's build-all-4. Do not blindly remediate — the fail-closed affected logic was itself a deliberate audit fix.

**Conflict justification:** main.yml:60-78 computes the turbo --affected set FAIL-CLOSED (comment at :64-67 documents the prior silent-skip bug and the deliberate design), and unaffected services keep their previously pinned immutable repository@digest in Helm values (main.yml:105-124, 271-285) — build-once/promote-same-artifact is the documented posture (main.yml:14-18, prod-promote :352-388). Deployment correctness is preserved; the deviation saves CI/ECR cost. Residual risk is only that base-image/CVE rebuilds don't occur for untouched apps.

### 3.3 AUD-NAME — naming & tagging (§B11) — 7 findings (4 GAP / 3 CE)

| ID | Sev | Effort | Spec | Kind | Wave | Title |
|---|---|---|---|---|---|---|
| AUD-NAME-001 | MED | S | B11 | GAP | 2 | 4 mandatory tags (Environment/Service/Owner/CostCenter) absent from all provider default_tags — _shared tags module authored but wired into ZERO env roots |
| AUD-NAME-002 | LOW | S | B11 | GAP | 2 | ArgoCD Application `collector` breaks the prod convention — named brain-collector-prod under AppProject `brain` while the other 16 prod apps are {service}-prod under brain-prod |
| AUD-NAME-003 | LOW | L | B11 | CE | 4 | EKS cluster named brain-prod, not brain-prod-eks (spec example) — deliberate, standardized, and already APPLIED |
| AUD-NAME-004 | LOW | M | B11 | CE | 4 | no brain-prod-streaming-ng node group — topology is brain-prod-system managed NG + Karpenter NodePools (streaming/batch/trino), per AUD-COST-010 |
| AUD-NAME-005 | LOW | L | B11 | CE | 4 | medallion bucket named brain-bronze-prod-{account_id}, not brain-prod-bronze — documented ordering exception + deliberate legacy-name retention for the unified warehouse |
| AUD-NAME-006 | LOW | S | B11 | GAP | 3 | canonical naming doc is stale vs the applied prod root — still documents per-layer Silver/Gold buckets, Bronze Object-Lock 7yr WORM, and 'RDS not Aurora' |
| AUD-NAME-007 | LOW | S | B11 | GAP | 3 | KMS aliases invert the convention — alias/brain-root-prod, alias/brain-audit-prod, alias/brain-tfstate-prod instead of brain-{env}-{resource} |

### AUD-NAME-001 — 4 mandatory tags (Environment/Service/Owner/CostCenter) absent from all provider default_tags — _shared tags module authored but wired into ZERO env roots
`SEV-MED` · `EFFORT-S` · spec §B11 · **GAP** · Wave 2 · orig `AUD-NAME-001` (naming-tagging)

**Evidence (verbatim):** envs/prod/bootstrap.tf:33-39, envs/dev/main.tf:22-29, envs/staging/main.tf:23-29, bootstrap/main.tf:42-48 set only lowercase {project, environment, managed_by} in provider default_tags. modules/_shared/tags.tf defines the mandatory PascalCase set (Environment/Service/Owner/CostCenter; Owner=data-team, CostCenter=brain-platform) but is instantiated in ZERO env roots (grep -rn _shared envs bootstrap = 0). Per-resource coverage: only aurora (main.tf:95-98), nat-instance (103-106), vpc-endpoints (98-101) carry all 4; karpenter (main.tf:65-72) carries 3 of 4 (lowercase environment, no PascalCase Environment). All other modules emit none of the 4 keys. AWS treats environment/Environment as distinct keys. docs/infra/naming-and-tagging.md §6 is an explicitly "NOT done" reconciliation checklist (env-root module wiring + tools/lint tag CI both unchecked); tools/lint/ contains only prod-placeholder-guard.sh + v4-naming-guard.sh. MITIGATION (severity-relevant): every resource already carries lowercase project/environment/managed_by via default_tags and §5 states cost reports can group on either key; account-per-environment isolates cost regardless; Owner/CostCenter are currently single-valued org-wide; fix is a tag-only apply with no resource replacement.

**Proposed fix:** Execute the doc's own §6 checklist, minimal compliant step first: in each of envs/{dev,staging,prod} + bootstrap add `module "tags" { source = ../../modules/_shared }` and set `default_tags { tags = module.tags.common_tags }` (Service=platform inherited, override per-resource where service-scoped). Add PascalCase Environment to modules/karpenter/main.tf common_tags. Then (follow-up) strip lowercase duplicates per §6 and add the tools/lint tag assertion. Apply is tag-only — no resource replacement.

**Verifier note (adversarial re-check, confirmed real):** Every evidence claim verified in-repo: all 4 env-root provider default_tags blocks carry only lowercase {project, environment, managed_by} (dev adds region); modules/_shared/tags.tf defines the mandatory PascalCase set but grep for _shared under envs/ and bootstrap/ returns 0 instantiations; per-resource sweep confirms only aurora/nat-instance/vpc-endpoints carry all 4, karpenter carries 3 of 4 (lowercase environment only, no PascalCase Environment on its SQS/EventBridge/IAM resources), and no other module emits any of the 4 keys; docs/infra/naming-and-tagging.md §6 is explicitly headed "NOT done by this deliverable" with every reconciliation checkbox unchecked; tools/lint/ has no tag lint. Not fixed by any recent commit (no AUD-NAME commits; AUD-COST-010 is what created the karpenter 3-of-4 partial). Kind GAP is correct — the doc mandates the tags and marks reconciliation as pending; there is no documented justification for accepting the deviation, so CONFLICT-ESCALATION does not apply. Severity corrected HIGH→MED: lowercase project/environment tags already exist on every resource via default_tags (§5 notes cost reports can group on either), account-per-environment gives hard cost isolation, and Owner/CostCenter are single-valued constants today, so the practical cost-attribution/governance loss is moderate and the fix is a tag-only apply with no availability/security/correctness exposure.

### AUD-NAME-002 — ArgoCD Application `collector` breaks the prod convention — named brain-collector-prod under AppProject `brain` while the other 16 prod apps are {service}-prod under brain-prod
`SEV-LOW` · `EFFORT-S` · spec §B11 · **GAP** · Wave 2 · orig `AUD-NAME-002` (naming-tagging)

**Evidence (verbatim):** infra/argocd/envs/prod/collector.yaml:10 `name: brain-collector-prod`, :21 `project: brain` — vs core.yaml:4/13 (core-prod, brain-prod), web.yaml, trino.yaml, stream-worker.yaml, iceberg-rest.yaml, cronworkflows.yaml, karpenter.yaml, keda.yaml, neo4j.yaml, strimzi-kafka.yaml, external-secrets.yaml, external-dns.yaml, cert-manager.yaml, argo-workflows.yaml, aws-load-balancer-controller.yaml, pgbouncer.yaml — ALL {service}-prod + project brain-prod. docs/infra/naming-and-tagging.md §3 codifies {service}-{env} + spec.project brain-{env}. Both AppProjects are currently equally permissive (bootstrap/appprojects.yaml:20-29 vs 38-60), so no security delta today, but collector escapes any future brain-prod project guardrails and env-scoped RBAC/reporting.

**Proposed fix:** Rename the Application to collector-prod and set spec.project: brain-prod (ArgoCD app rename = delete+recreate of the Application CR only; the underlying helm release/namespace is unaffected if done with the finalizer removed or via `argocd app` move procedure).

### AUD-NAME-003 — EKS cluster named brain-prod, not brain-prod-eks (spec example) — deliberate, standardized, and already APPLIED
`SEV-LOW` · `EFFORT-L` · spec §B11 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-NAME-003` (naming-tagging)

**Evidence (verbatim):** modules/eks/main.tf:98 name = "${var.project}-${var.environment}" → brain-prod. The entire discovery graph keys on it: network/main.tf:69,101,120 kubernetes.io/cluster/brain-prod=shared, :123,266 karpenter.sh/discovery=brain-prod; helm/karpenter/values-prod.yaml:3-5 clusterName/discoveryTag=brain-prod; karpenter interruption queue name == cluster name (modules/karpenter/main.tf:78).

**Proposed fix:** User decision: ratify brain-prod (update the deployment spec) or schedule a cluster rebuild — do NOT queue for blind remediation.

**Conflict justification:** docs/infra/naming-and-tagging.md §1+§3 canonize `brain-{env}` for the cluster ({layer} segment optional where the resource type implies it) and note renames force resource replacement. The prod control plane is ALREADY APPLIED to account 668848431102 (audit context AUD-COST-001..022); renaming an EKS cluster = destroy/recreate plus retagging every subnet/SG and all helm/ArgoCD values. Spec example appears stale vs the repo's ratified standard.

### AUD-NAME-004 — no brain-prod-streaming-ng node group — topology is brain-prod-system managed NG + Karpenter NodePools (streaming/batch/trino), per AUD-COST-010
`SEV-LOW` · `EFFORT-M` · spec §B11 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-NAME-004` (naming-tagging)

**Evidence (verbatim):** modules/eks/main.tf:210 node_group_name = brain-prod-system (only managed NG); helm/karpenter/values.yaml:55-85 NodePools `streaming`/`batch`/`trino` (k8s CRs, no env prefix — cluster is single-env); envs/prod/bootstrap.tf:113-114 'system node group only; all workload capacity is Karpenter-managed'. Karpenter-launched instances DO carry the 4 mandatory AWS tags (helm/karpenter/values.yaml:41-47 → templates/ec2nodeclass.yaml spec.tags).

**Proposed fix:** User decision: accept NodePool names streaming/batch/trino as the k8s-side equivalent of brain-prod-{pool}-ng (optionally prefix NodePool CR names brain-prod-* for grep-ability — rename is cheap, CRs are declarative), or amend the spec.

**Conflict justification:** AUD-COST-010 (envs/prod/bootstrap.tf:136-139, module header modules/karpenter/main.tf) deliberately replaces fixed workload node groups with Karpenter Spot for cost — the spec's named streaming node group has no counterpart by design. The spec's fixed-NG naming example is superseded by the merged cost-audit architecture (#324 lineage).

### AUD-NAME-005 — medallion bucket named brain-bronze-prod-{account_id}, not brain-prod-bronze — documented ordering exception + deliberate legacy-name retention for the unified warehouse
`SEV-LOW` · `EFFORT-L` · spec §B11 · **CONFLICT-ESCALATION** · Wave 4 · orig `AUD-NAME-005` (naming-tagging)

**Evidence (verbatim):** modules/s3-iceberg/main.tf:89 bucket = "${var.project}-bronze-${var.environment}-${account_id}"; tags at :92-98 say purpose=medallion-warehouse (the ONE bucket now holds Bronze+Silver+Gold namespaces per AUD-COST-016). s3-audit/main.tf:38 and s3-iceberg-medallion/main.tf:87 follow the same brain-{layer}-{env}-{acct} ordering.

**Proposed fix:** User decision: ratify brain-{layer}-{env}-{acct} in the spec (recommended), or if the misleading '-bronze-' warehouse name must go, plan a migration to brain-warehouse-prod-{acct} before real data lands (cheapest window is NOW, pre-node-group).

**Conflict justification:** docs/infra/naming-and-tagging.md §1 lists 'S3 medallion buckets put the layer before the env and append the account id for global uniqueness' as a baked-in ordering exception (stable identifiers; rename forces replacement + data migration). modules/s3-iceberg/main.tf:11-12 explicitly keeps the historical -bronze- name 'for parity with the local warehouse root (s3://brain-bronze/)'. The prod S3 bucket is in the already-APPLIED set — an S3 rename means create-new + copy + repoint every catalog/IAM/checkpoint reference.

### AUD-NAME-006 — canonical naming doc is stale vs the applied prod root — still documents per-layer Silver/Gold buckets, Bronze Object-Lock 7yr WORM, and 'RDS not Aurora'
`SEV-LOW` · `EFFORT-S` · spec §B11 · **GAP** · Wave 3 · orig `AUD-NAME-006` (naming-tagging)

**Evidence (verbatim):** docs/infra/naming-and-tagging.md §3: 'Silver bucket brain-silver-{env}-… (s3-iceberg-medallion)', 'Bronze carries Object-Lock COMPLIANCE + 7-yr retention (NN-4)', 'the engine is PostgreSQL 16 (not Aurora)' — all three superseded: modules/s3-iceberg/main.tf:14-20 (AUD-COST-016 removed Object Lock; one warehouse bucket), envs/prod/bootstrap.tf:154-164 uses modules/aurora (cluster brain-prod-postgres). Doc self-declares as 'the canonical reference'. Also missing: KMS alias + Karpenter NodePool naming rows.

**Proposed fix:** Refresh §3 to match the AUD-COST-016/ADR-0009 end-state (single warehouse bucket, no data-bucket Object Lock, Aurora Serverless v2 rows, KMS aliases, NodePools); prod rows should be greppable against envs/prod/bootstrap.tf outputs.

### AUD-NAME-007 — KMS aliases invert the convention — alias/brain-root-prod, alias/brain-audit-prod, alias/brain-tfstate-prod instead of brain-{env}-{resource}
`SEV-LOW` · `EFFORT-S` · spec §B11 · **GAP** · Wave 3 · orig `AUD-NAME-007` (naming-tagging)

**Evidence (verbatim):** modules/kms/main.tf:46 alias/${var.project}-root-${var.environment}, :67 alias/${var.project}-audit-${var.environment}; bootstrap/main.tf:67 alias/brain-tfstate-${var.environment}, :90 state bucket brain-tfstate-{env}-{acct}. No documented exception in docs/infra/naming-and-tagging.md (unlike the S3/ECR ordering exceptions in §1). Prod keys are already applied, but an alias rename replaces only the aws_kms_alias resource — the CMK (and everything encrypted with it) is untouched.

**Proposed fix:** Either rename aliases to alias/brain-{env}-root|audit|tfstate (cheap: alias-resource replacement only, key retained; update the few references) or add KMS to the §1 documented ordering exceptions. Low stakes; pick one and record it.

---

## 4. Conformant Register (53 items)

These prove the done sections: **B3 (Aurora) and B5 (Kafka) are fully conformant, B1 essentially so**; the local A-sections are live-measured conformant. Grouped by spec section, verbatim from the audit.

### §A1 (3 items)

- [local-env] A1 profile model exists as specced: core(default)/full-obs/debug/ai declared docker-compose.yml:1-27; core = postgres+pgbouncer, neo4j, redis, minio(+init), kafka KRaft single broker (KAFKA_NODE_ID=1, broker+controller, docker-compose.yml:259-285)+kafka-init, iceberg-rest(+catalog-init), trino, localstack, apicurio; full-obs = tempo+loki(+otel-collector, additive); debug = kafka-exporter+jmx-exporter-init
- [local-env] A1 core footprint <=18GB: live `docker stats --no-stream` sum across all 11 running containers (incl. the host bronze sink) = ~9.7GiB used; budget doc's worst-case steady estimate 17.5GB also under target (docs/ops/local-memory-budget.md:64-73); sum-of-caps (~25.6GB) intentionally exceeds usage per documented runaway-cap policy, not a budget
- [local-env] A1 LocalStack in core with secretsmanager+s3 present (docker-compose.yml:220-240); extra services escalated separately (AUD-LOCAL-005)

### §A2 (5 items)

- [local-env] A2 every core compose service has mem_limit — live-verified: trino 7g, kafka 2441m, minio 5g, neo4j 1500m, apicurio 768m, postgres/localstack/iceberg-rest 512m, redis 256m, pgbouncer 128m (docker stats LIMIT column, all bounded)
- [local-env] A2 oom_score_adj kill-priority tier on core services, live-verified via docker inspect: postgres -900, kafka -800, trino/iceberg-rest -700, apicurio -600, neo4j/minio -500, redis -300, localstack +200 — SoRs killed last, disposables first (docker-compose.yml:37,104,122,152,224,266,396,444,521)
- [local-env] A2 JVM heap <=75% of container limit everywhere a JVM runs: kafka 1G/2441m=41% (KAFKA_HEAP_OPTS pinned, compose:271), trino MaxRAMPercentage=70 (db/trino/jvm.config:13), apicurio 512m/768m=67% (compose:399), neo4j heap512+pagecache256/1500m=51% (compose:107-108), bronze sink 4g+512m offheap/7g≈64% (dev-bronze-streaming.sh:108,103)
- [local-env] A2 Redis 256m limit + maxmemory 192mb (75% of cgroup, documented headroom rationale) + volatile-lru evict-not-kill (docker-compose.yml:118-134, commit 8d3ff4eb) — matches spec 256m/~200m; Postgres 512m exactly per spec (compose:36)
- [local-env] A2/A1 stateful durability hardening beyond spec: named volumes for all stateful services (AUD-INFRA-011, docker-compose.yml:698-716) — compose down no longer wipes PG/Kafka/Neo4j/MinIO/warehouse

### §A3 (2 items)

- [local-env] A3 unified single Bronze sink conformant-by-supersession: bronze_landing.py, one driver/one query/one table brain_bronze.events, per-lane dedup, durable checkpoint volume (AUD-INFRA-004), bounded supervisor auto-restart with idempotent-MERGE replay safety (tools/dev/dev-bronze-streaming.sh:1-27,60-116)
- [local-env] A3 v4-refresh-loop.sh synchronous + no overlapping runs + clean stop: strictly sequential run_once/run_spark_tier, single-loop pidfile guard (AUD-INFRA-006, v4-refresh-loop.sh:498-508), per-script _spark_lock.sh admission lock (exists, db/iceberg/spark/_spark_lock.sh), bounded retries (retry(), :179-200), ONESHOT mode, pidfile trap cleanup + dev-down.sh kills supervisors before containers (dev-down.sh:11-22)

### §A4 (1 items)

- [local-env] A4 app tier on host via turbo dev, NOT containerized: dev-up.sh:109-111 `APP_ENV=local-prod turbo run dev --filter=@brain/core|web|collector|stream-worker`; package.json dev/dev:core/dev:ingest scripts same pattern; docker-compose.yml contains zero app services

### §A5 (1 items)

- [local-env] A5 structure: pnpm dev:up is a single command doing compose core up + bootstrap (+ documented extra steps; timing gap escalated as AUD-LOCAL-014); compose-up-healthy.sh gives deterministic health with the --wait one-shot-exit gotcha fixed

### §A6 (1 items)

- [local-env] A6 PgSpool + in-process drainer, no separate service: apps/collector/src/main.ts:24-28 (PgSpoolRepository, DrainEventsUseCase, Drainer imports), :101/:124-127/:197-198 (drainer started as an in-process async loop after the HTTP listener), plus in-process spool reaper (:204-213); no drainer container/compose service exists

### §B1 (4 items)

- [prod-net-eks] B1 VPC with public+private subnets, EKS/Aurora/ElastiCache/Karpenter capacity all in private subnets — modules/network/main.tf:87-125 (subnets), modules/eks/main.tf:102-103 (cluster on private_subnet_ids), envs/prod/bootstrap.tf:159,378 (aurora/elasticache subnet_ids = private), modules/network/main.tf:121-124 (karpenter.sh/discovery tag on PRIVATE subnets only)
- [prod-net-eks] B1 NO managed NAT gateways in prod — envs/prod/bootstrap.tf:88 enable_nat_gateway=false; modules/network/main.tf:130-135,192-199 gates all aws_nat_gateway/aws_route resources to count 0
- [prod-net-eks] B1 single fck-nat t4g.nano instance in a public subnet owns the private default routes — modules/nat-instance/main.tf:67-71 (default t4g.nano), :188-228 (instance in public subnet, source_dest_check=false, IMDSv2, encrypted gp3, aws_route per private RT); envs/prod/bootstrap.tf:91-99 wires it; ADR docs/adr/0009-aurora-and-fck-nat.md Decision 2
- [prod-net-eks] B1 VPC endpoints: Gateway S3 associated to private route tables + Interface STS/SecretsManager/ECR-api/ECR-dkr (plus Logs, a harmless superset) — modules/vpc-endpoints/main.tf:69-79 (service list), :148-157 (S3 Gateway), :162-175 (interface, private_dns_enabled); envs/prod/bootstrap.tf:101-110

### §B2 (8 items)

- [prod-net-eks] B2 EKS version 1.32 pinned — modules/eks/main.tf:63-66 (kubernetes_version default "1.32") consumed by aws_eks_cluster.main:98-99; prod uses the module pin (envs/prod/bootstrap.tf:115-132)
- [prod-net-eks] B2 system node group instance/capacity class: t4g.medium, on-demand (no capacity_type = ON_DEMAND), AL2_ARM_64, labeled role=system — modules/eks/main.tf:208-243; hosts ArgoCD/ALB-ingress/Karpenter/KEDA per infra/helm/karpenter/README.md:15-24 (size delta escalated separately)
- [prod-net-eks] B2 batch capacity: t4g.xlarge SPOT, Karpenter scale-to-zero, bounded ~0-3 nodes (cpu 12 / 48Gi), WhenEmptyOrUnderutilized 30s — infra/helm/karpenter/values.yaml:67-77
- [prod-net-eks] B2 trino capacity pool: t4g.xlarge SPOT, bounded ~0-2 nodes (cpu 8 / 32Gi) — infra/helm/karpenter/values.yaml:78-88 (KEDA pod-scaling gap escalated separately)
- [prod-net-eks] B2 streaming capacity: t4g.large SPOT with WhenEmpty (never bin-packs live consumers off) — infra/helm/karpenter/values.yaml:56-66
- [prod-net-eks] B2 Karpenter INSTALLED end-to-end: controller IRSA role + SQS interruption queue + 4 EventBridge rules in terraform (modules/karpenter/main.tf:80-286, wired envs/prod/bootstrap.tf:140-148) + 3 ordered ArgoCD apps (CRDs/controller-1.0.8-pinned-to-system-nodes/nodepools) in infra/argocd/envs/prod/karpenter.yaml; discovery tags set by terraform (modules/network/main.tf:121-124,264-267) — the ACCOUNT_ID placeholder is the documented post-apply fill pass (infra/helm/PLACEHOLDERS.md:16, bootstrap.tf:449 output)
- [prod-net-eks] B2 KEDA operator INSTALLED: infra/argocd/envs/prod/keda.yaml (upstream chart pinned 2.15.1, keda namespace, values-prod ref) — wiring-to-Trino gap reported separately
- [prod-net-eks] B2 EC2NodeClass hygiene: arm64 AL2023 alias AMI, reused eks node role, IMDSv2-required, encrypted gp3 50Gi root, mandatory Brain tags on launched instances — infra/helm/karpenter/templates/ec2nodeclass.yaml:11-38

### §B3 (3 items)

- [prod-data] B3 Aurora Serverless v2 PostgreSQL: modules/aurora/main.tf:171-189 (engine aurora-postgresql, engine_mode provisioned + serverlessv2_scaling_configuration), ACU 0.5-2 via envs/prod/terraform.tfvars (aurora_min_capacity 0.5 / aurora_max_capacity 2) wired at bootstrap.tf:154-164
- [prod-data] B3 Aurora private + no multi-AZ: modules/aurora/main.tf:105-114 private-subnet-only subnet group, :225 publicly_accessible=false, :78-81+215 instance_count default 1 (single db.serverless writer, not overridden by prod root), SG ingress restricted to approved SGs (:119-134)
- [prod-data] B3 Aurora backups on: modules/aurora/main.tf:198-203 backup_retention_period=35, skip_final_snapshot=false, deletion_protection=true for prod; storage encrypted with the root CMK (:195-196)

### §B4 (1 items)

- [prod-data] B4 (partial) ElastiCache node class + privacy: envs/prod/bootstrap.tf:374-383 node_type cache.t4g.micro on module.network.private_subnet_ids with the dedicated elasticache SG; at-rest KMS + transit encryption (modules/elasticache/main.tf:82-84) — only the node COUNT deviates (finding AUD-PROD-001)

### §B5 (4 items)

- [prod-data] B5 Strimzi not MSK: zero MSK terraform repo-wide (audit report line 1096 confirms); operator installed from upstream strimzi chart 0.45.0 via infra/argocd/envs/prod/strimzi-kafka.yaml (wave 0) with the CR chart at wave 1
- [prod-data] B5 3 brokers KRaft, no ZooKeeper: infra/helm/strimzi-kafka/values-prod.yaml:9-14 combined controller+broker node pool replicas 3; templates/kafka-cr.yaml:58-60 annotations strimzi.io/kraft: enabled + strimzi.io/node-pools: enabled (header: "KRaft mode (NO ZooKeeper)")
- [prod-data] B5 50Gi gp3 per broker: values-prod.yaml:15-18 storage size 50Gi class gp3 deleteClaim false (jbod persistent-claim, kafka-cr.yaml:25-33)
- [prod-data] B5 RF=3 / min.insync.replicas=2: values-prod.yaml:38-44 defaultReplicationFactor 3, minInsyncReplicas 2, offsets/transaction RF 3, txn min ISR 2; topics.replicas 3 (:57); rendered at kafka-cr.yaml:81-90

### §B6 (3 items)

- [prod-data] B6 NO Object Lock (starter spec): conformant — Object Lock was REMOVED by AUD-COST-016; modules/s3-iceberg/main.tf:88 checkov:skip CKV_AWS_53 with rationale (MERGE/compaction/row-TTL/right-to-erasure all DELETE objects); WORM retention lives only on the audit bucket (modules/s3-audit)
- [prod-data] B6 expire_snapshots mechanism present and scheduled: db/iceberg/spark/medallion_maintenance.py:83-93 CALL system.expire_snapshots per table over Silver+Gold, weekly cron infra/helm/cronworkflows/values.yaml:142-148; bronze_maintenance.py mirrors it for Bronze (TTL value itself is finding AUD-PROD-004)
- [prod-data] B6 bucket security posture: versioning + SSE-KMS + bucket-key + full public-access block + DenyUnencryptedPuts/DenyNonTLS bucket policy on the warehouse bucket (modules/s3-iceberg/main.tf:101-149, 362-402)

### §B7 (3 items)

- [prod-data] B7 coordinator 1 pod: infra/helm/trino/values-prod.yaml:7-8 coordinator.replicaCount 1; node-scheduler.include-coordinator=false so it never runs splits (templates/configmaps.yaml:16-17)
- [prod-data] B7 Iceberg REST catalog connector reading S3: templates/configmaps.yaml:60-76 connector.name=iceberg, iceberg.catalog.type=rest, restUri → iceberg-rest.iceberg.svc (values-prod.yaml:34), fs.native-s3.enabled=true, s3.region ap-south-1 (AUD-COST-008 fix landed, values-prod.yaml:37-41), IRSA role brain-prod-trino with read-only analytics_s3 policy (bootstrap.tf:266-276) — no static keys
- [prod-data] B7 KEDA prerequisite present: infra/argocd/envs/prod/keda.yaml installs upstream kedacore/keda 2.15.1 with Brain values (infra/helm/keda/values-prod.yaml); Trino ScaledObject template exists (worker-scaledobject.yaml) — only the enable/limits wiring deviates (finding AUD-PROD-005)

### §B8 (2 items)

- [prod-obs-cicd-secrets] B8: SLO alert rules file exists and is real — infra/observe/alerts/brain-slo.rules.yml (multi-window burn-rate on the 99.95% collector accept+ack SLO, freshness/DLQ/lag/liveness; every rule names a live metric source, header lines 1-27) + freshness.rules.yml; loaded via infra/observe/prometheus.yml:6-7 rule_files 'alerts/*.rules.yml'
- [prod-obs-cicd-secrets] B8: Loki is optional/profiled — docker-compose.yml:564-566 loki grafana/loki:3.0.0 under profiles ["full-obs"] (trace/log pipeline layered on core), tempo likewise :576-577

### §B9 (3 items)

- [prod-obs-cicd-secrets] B9: builds all 4 service images from one matrix [collector, stream-worker, core, web] (.github/workflows/main.yml:40-43) + the spark-bronze data image (:150-160), tags with github.sha (:97-103), pushes to ECR via OIDC role AWS_ECR_PUSH_ROLE_ARN in ap-south-1 (:81-116) with cosign keyless signing (:126-139)
- [prod-obs-cicd-secrets] B9: image references updated in Helm values by CI — immutable repository@digest bumped into infra/helm/<app>/values-staging.yaml + cronworkflows via yq (main.yml:271-307), then staging→prod digest promotion behind the 'production' GitHub Environment manual gate with a strict placeholder guard (main.yml:330-409; tools/lint/prod-placeholder-guard.sh --strict); values-prod pin digest with tag:"" fail-closed (infra/helm/core/values-prod.yaml:3-6)
- [prod-obs-cicd-secrets] B9: ArgoCD watches infra/argocd/envs/prod syncing the Helm charts — app-of-apps.yaml:26-32 path infra/argocd/envs/prod (env-scoped per AUD-COST-005), children e.g. envs/prod/core.yaml source path infra/helm/core valueFiles values-prod.yaml with NO automated sync (manual prod gate)

### §B10 (3 items)

- [prod-obs-cicd-secrets] B10: Secrets Manager for all secrets — terraform modules/secrets creates all shells (4 legacy + 7 brain/prod/k8s/* env secrets, main.tf:35-121; values never in TF state, fill = put-secret-value per PLACEHOLDERS.md §5); no plaintext secrets in any infra/helm/*/values-prod.yaml (grep clean); ESO ClusterSecretStore + one ExternalSecret per consumed k8s Secret with refreshInterval 1h rotation (infra/helm/external-secrets-config/README.md + values-prod.yaml)
- [prod-obs-cicd-secrets] B10: IRSA for pod access — per-workload roles with NN-3 StringEquals on both oidc:sub and oidc:aud (modules/irsa/main.tf:1-6): collector/stream-worker/core/web/trino/iceberg-rest/external-secrets/spark-jobs/alb-controller/external-dns/karpenter all wired in envs/prod/bootstrap.tf:200-450; ESO controller scoped to exactly brain/prod/k8s/* (eso_k8s_secrets_read, modules/secrets/main.tf:130-152); ESO SA name pinned + role annotated in infra/argocd/envs/prod/external-secrets.yaml
- [prod-obs-cicd-secrets] B10: LocalStack in local dev emulates the prod secret machinery (SM + KMS via docker-compose core profile localstack; tools/seed/prod-local-aws-bootstrap.sh) and the connector-token secret paths brain/connector/<provider>/<brandId>... ARE byte-identical local↔prod (shared generation in packages/connector-secrets AwsSecretsManager.ts:76 / LocalSecretsManager.ts:79)

### §B11 (6 items)

- [naming-tagging] B11 subnets 'properly tagged' (B1 cross-check): public subnets kubernetes.io/role/elb + kubernetes.io/cluster/brain-prod=shared (modules/network/main.tf:95-102); private subnets kubernetes.io/role/internal-elb + cluster tag + karpenter.sh/discovery=brain-prod (network/main.tf:114-124); VPC cluster tag (network/main.tf:69); node SG karpenter.sh/discovery (network/main.tf:261-266) — all match helm/karpenter EC2NodeClass selector terms (templates/ec2nodeclass.yaml:18-23, values-prod.yaml discoveryTag=brain-prod)
- [naming-tagging] B11 Redis naming matches spec example exactly: brain-prod-redis replication group + subnet group + SG (modules/elasticache/main.tf:59,70; network/main.tf:300)
- [naming-tagging] B11 IAM role naming brain-{env}-{role} consistent: IRSA roles brain-prod-{collector,stream-worker,core,web,trino,iceberg-rest,external-secrets,external-dns,jobs,aws-load-balancer-controller} (modules/irsa/main.tf:102 + envs/prod/bootstrap.tf:200-405); CI roles brain-prod-github-{plan,ecr-push,apply} (modules/oidc-github/main.tf:118,263,314) — matches the spec's brain-prod-github-ecr-push style
- [naming-tagging] B11 compute/DB/streaming names conform: node group brain-prod-system (eks/main.tf:210), EKS IAM roles brain-prod-eks-{cluster,node} (eks/main.tf:161,185), Aurora brain-prod-postgres + brain-prod-postgres-N instances (aurora/main.tf:174,218), Strimzi cluster brain-prod-kafka (helm/strimzi-kafka/values-prod.yaml:1-3), Trino fullname brain-prod-trino (helm/trino/values.yaml:8, bootstrap.tf:272), SGs brain-prod-{eks-cluster,eks-nodes,rds,elasticache} (network/main.tf:213-300), secrets brain/prod/* (modules/secrets/main.tf:36-111), log groups /brain/prod/* (observability/main.tf:53)
- [naming-tagging] B11 ArgoCD/helm convention: 16 of 17 prod Applications follow {service}-prod under AppProject brain-prod with per-service namespaces (infra/argocd/envs/prod/*.yaml); the {service}-{env} order is explicitly documented as the intentional k8s/Argo convention (docs/infra/naming-and-tagging.md §3 note); all referenced AppProjects exist (infra/argocd/bootstrap/appprojects.yaml)
- [naming-tagging] B11 mandatory-tag machinery exists and is correct where present: modules/_shared/tags.tf:58-63 defines exactly Environment/Service/Owner=data-team/CostCenter=brain-platform; aurora/nat-instance/vpc-endpoints modules carry all 4 per-resource (aurora/main.tf:91-99, nat-instance/main.tf:101-110, vpc-endpoints/main.tf:96-105); Karpenter-launched EC2 instances receive all 4 via EC2NodeClass spec.tags (helm/karpenter/values.yaml:41-47)

---

## 5. Remediation Backlog by Wave

### Wave 1 — go-live blockers (SEV-HIGH GAPs + event-loss-risk pinning + local-obs decision)

- **AUD-PROD-001** (`SEV-HIGH`/`EFFORT-M`, §B2) — In-cluster Prometheus/Grafana entirely absent — nothing exists for the system node group to host, and the observability TF module is not wired into the prod root
- **AUD-PROD-002** (`SEV-HIGH`/`EFFORT-M`, §B8) — No kube-prometheus-stack (no Prometheus AT ALL) in prod — SLO rules and rollout analyses have no evaluator — *fix jointly with AUD-PROD-001: ONE decision — kube-prometheus-stack on the system group vs actually wiring the ADR-006 Grafana-Cloud path (module + otel agent + Mimir rules); today NEITHER exists*
- **AUD-PROD-003** (`SEV-HIGH`/`EFFORT-S`, §B10) — Prod core boot secrets (JWT/cookie/Meta/Google-Ads) have NO Secrets Manager shells and NO IRSA read grant — core fail-closes at startup
- **AUD-PROD-004** (`SEV-HIGH`/`EFFORT-M`, §B10) — Connector runtime secrets (brain/connector/*) — zero IAM grants for core (CreateSecret/Get/Put) and stream-worker (Get), and no prod CMK for alias/brain-connector-secrets
- **AUD-PROD-006** (`SEV-MED`/`EFFORT-M`, §B2) — No workload-to-pool pinning — Trino coordinator not pinned to system group, Kafka brokers / bronze sinks / Trino workers not pinned to their pools; all Karpenter pools untainted
- **AUD-LOCAL-001** (`SEV-MED`/`EFFORT-S`, §A1/A2) — Prometheus + Grafana absent from the running core profile (commented out) — base metrics/SLO pipeline dead — *CE, pulled into Wave 1 by impact: user must pick re-enable (uncomment; zero new work) OR ratify the disable and fix the stale §4.1/JMX comments + drop the unscraped javaagent*

### Wave 2 — profiles/limits/naming/KEDA-flip/ElastiCache-node-count/secret-path parity (SEV-MED GAPs, small efforts)

- **AUD-LOCAL-002** (`SEV-MED`/`EFFORT-S`, §A2) — pgbouncer has no oom_score_adj — request-path connection pooler at default kill priority
- **AUD-LOCAL-003** (`SEV-MED`/`EFFORT-S`, §A2) — host-run Bronze sink and ephemeral Spark job containers run at oom_score_adj 0 — ingest-critical container killed before protected caches
- **AUD-PROD-007** (`SEV-MED`/`EFFORT-S`, §B2) — KEDA scaling of Trino workers is chart-only — ScaledObject template exists but autoscaling.enabled=false in prod, so prod runs static workers and installed KEDA scales nothing
- **AUD-PROD-008** (`SEV-MED`/`EFFORT-S`, §B4) — ElastiCache provisions 2-node multi-AZ replication group, not the spec's single cache.t4g.micro node
- **AUD-PROD-010** (`SEV-MED`/`EFFORT-S`, §B7) — Trino worker KEDA autoscaling is unwired — fixed 3 replicas, autoscaling.enabled=false, and min/max 3/8 instead of spec 0-3
- **AUD-PROD-011** (`SEV-MED`/`EFFORT-M`, §B7) — No node placement anywhere in the Trino chart — coordinator not pinned to the system node group, workers not pinned to the trino Karpenter pool
- **AUD-PROD-013** (`SEV-MED`/`EFFORT-S`, §B8) — Local core-profile Prometheus + Grafana disabled (commented out) — brain-slo.rules.yml is evaluated NOWHERE, and its Alertmanager target does not exist in compose
- **AUD-PROD-014** (`SEV-MED`/`EFFORT-S`, §B10) — LocalStack secret paths are NOT the same as prod — local names have no environment segment and prod k8s-env blobs have no local counterpart
- **AUD-NAME-001** (`SEV-MED`/`EFFORT-S`, §B11) — 4 mandatory tags (Environment/Service/Owner/CostCenter) absent from all provider default_tags — _shared tags module authored but wired into ZERO env roots
- **AUD-NAME-002** (`SEV-LOW`/`EFFORT-S`, §B11) — ArgoCD Application `collector` breaks the prod convention — named brain-collector-prod under AppProject `brain` while the other 16 prod apps are {service}-prod under brain-prod

*(AUD-PROD-007 and AUD-PROD-010 are the same flip — `workers.autoscaling.enabled: true` in `infra/helm/trino/values-prod.yaml` — seen from B2 and B7; one change closes both. AUD-PROD-011 shares its fix surface with Wave-1 AUD-PROD-006.)*

### Wave 3 — nice-to-have (Intelligent-Tiering, doc refreshes, workflow rename, KMS aliases, Thanos, idle-gate)

- **AUD-PROD-019** (`SEV-LOW`/`EFFORT-S`, §B6) — S3 Intelligent-Tiering absent on the medallion warehouse bucket (unexecuted Wave-3 item)
- **AUD-PROD-012** (`SEV-MED`/`EFFORT-M`, §B8) — No Thanos sidecar / S3 long-term metrics anywhere — *blocked on Wave-1 Prometheus decision; close as superseded if Grafana-Cloud retention is ratified*
- **AUD-PROD-022** (`SEV-LOW`/`EFFORT-S`, §B9) — CD workflow is main.yml on push:[master], not deploy.yml on push:[main]
- **AUD-PROD-015** (`SEV-LOW`/`EFFORT-S`, §B1) — VPC spans 3 AZs, spec says 2 — undocumented, and each of the 5 interface endpoints pays for a 3rd-AZ ENI
- **AUD-PROD-021** (`SEV-LOW`/`EFFORT-M`, §B7) — Trino deployed from a custom in-repo chart, not the official Trino helm chart
- **AUD-NAME-006** (`SEV-LOW`/`EFFORT-S`, §B11) — canonical naming doc is stale vs the applied prod root — still documents per-layer Silver/Gold buckets, Bronze Object-Lock 7yr WORM, and 'RDS not Aurora'
- **AUD-NAME-007** (`SEV-LOW`/`EFFORT-S`, §B11) — KMS aliases invert the convention — alias/brain-root-prod, alias/brain-audit-prod, alias/brain-tfstate-prod instead of brain-{env}-{resource}
- **AUD-LOCAL-004** (`SEV-LOW`/`EFFORT-S`, §A2) — full-obs (loki/tempo/otel-collector), kafka-exporter and one-shot init containers have neither mem_limit nor oom_score_adj
- **AUD-LOCAL-015** (`SEV-LOW`/`EFFORT-M`, §A3) — refresh loop spins ~42 ephemeral Spark containers every 300s even with zero new Bronze data — no idle short-circuit

### Wave 4 — SPEC-RATIFICATION DECISIONS (CONFLICT-ESCALATIONs) — explicitly NOT queued for code changes

Each line: current state → what ratifying means. These are the ~15–20 places the spec needs updating to match documented, evidence-backed reality (or the user overrides and funds a revert).

| ID | Current state | Ratifying means |
|---|---|---|
| AUD-LOCAL-005 | LocalStack SERVICES `s3,secretsmanager,kms,ses,events`; kms/ses load-bearing (PII-vault DEK wrap, SES adapter), `events` unused | Spec → `s3,secretsmanager,kms,ses`; separately trim unused `events` |
| AUD-LOCAL-006 | Apicurio folded into core (ingest-path schema validation); `--profile schema` in dev-down.sh is a no-op | Spec moves apicurio to core; optionally drop the dead flag |
| AUD-LOCAL-007 | Trino 7g / MaxRAMPercentage 70 (1g reproduces the serving-tier OOM outage) | Spec Trino row → 7g/70% |
| AUD-LOCAL-008 | Kafka 2500m limit / pinned 1G heap (steady RSS 1.42GiB > spec's 1G limit) | Spec Kafka row → 2500m/1G |
| AUD-LOCAL-009 | Neo4j 1500m (512m heap + 256m pagecache; live RSS 870MiB) — spec conflated heap with container limit | Spec Neo4j row → 1500m container |
| AUD-LOCAL-010 | ONE unified Bronze sink @7g/4g driver (supersedes two-sink model; 1g driver OOMed mid-drain) | Spec adopts unified sink @7g/4g (or 2g steady + 4g drain option) |
| AUD-LOCAL-011 | Spark transform jobs 7g/4g driver, strictly sequential (1g driver heap-OOMed on the real 9,916-order backfill) | Spec Spark-job row → 7g/4g + sequential-scheduling note |
| AUD-LOCAL-012 | MinIO 5g (GOMEMLIMIT 4500MiB), iceberg-rest 512m — blueprint caps physically un-runnable | Spec rows → 5g / 512m |
| AUD-LOCAL-013 | LiteLLM commented out; `--profile ai` no-op (no active AI/NLQ consumer) | Spec marks ai profile 'defined but dormant' |
| AUD-LOCAL-014 | `pnpm dev:up` = documented multi-minute 8-step bring-up (migrate→health→sink→bootstrap→refresh→apps), not ~30s | Spec readiness expectation updated (or approve backgrounding the refresh step) |
| AUD-PROD-005 | EKS API public-but-CIDR-pinned to one operator /32 (AUD-COST-009: private-only had NO access path for bootstrap) | Accept the window + schedule SSM-bastion flip-back to `[]`, or build the bastion pre-go-live |
| AUD-PROD-009 | ONE warehouse bucket `brain-bronze-prod-{acct}` with Bronze/Silver/Gold namespaces (AUD-COST-016; mirrors local; IAM separates layers by prefix) | Spec → single-warehouse layout (recommended), or fund a 3-bucket migration + parity testing |
| AUD-PROD-016 | System MNG 2–6 (desired 3) — required to host 2 HA Karpenter controller replicas + CoreDNS/ArgoCD/KEDA/ALB | Spec table → t4g.medium 2–6, or accept single-node non-HA + 1 controller replica |
| AUD-PROD-017 | streaming/batch/trino are bounded Karpenter Spot NodePools, not MNGs; streaming floor enforced via workload replicas + WhenEmpty | Ratify pools topology, or add a hard 2-node streaming floor |
| AUD-PROD-018 | Fifth tainted on-demand pool (0–2) exists for Neo4j (identity SoR, Community=no HA; AUD-COST-018) | Add the ondemand pool to the spec's node table; no code change |
| AUD-PROD-020 | expire_snapshots TTL 7d (AUD-PERF-013: snapshot TTL ≠ data retention; 24-month retention = row DELETEs; erasure needs ttl 0 purge) | Spec → 7d snapshot TTL + separate 24-month data-retention policy |
| AUD-PROD-023 | CD builds AFFECTED services only, fail-closed; unaffected keep pinned digests (build-once/promote-same-artifact) | Ratify affected-only + add scheduled full rebuild for CVE hygiene, or drop the skip |
| AUD-NAME-003 | EKS cluster `brain-prod` (whole discovery graph keys on it; already APPLIED) vs spec example `brain-prod-eks` | Spec adopts `brain-{env}`; rename = destroy/recreate cluster |
| AUD-NAME-004 | No `brain-prod-streaming-ng`; topology = brain-prod-system MNG + Karpenter NodePools (AUD-COST-010) | Ratify NodePool names as the k8s-side equivalent (optionally prefix `brain-prod-*`) |
| AUD-NAME-005 | Bucket `brain-bronze-prod-{acct}` — documented ordering exception + deliberate legacy name for local parity | Ratify `brain-{layer}-{env}-{acct}`; if the `-bronze-` name must go, migrate NOW pre-data |

---

## 6. Verification Plan per Wave

**Wave 1**
- `terraform plan` in `infra/terraform/envs/prod` clean and ADDITIVE-only: new SM shells (brain/prod/app/*), extended `core_secrets_read`, new connector-secrets CMK + policy, `module "observability"` instantiation — zero destroys.
- `helm template` green for trino/strimzi-kafka with the new nodeSelectors; rendered manifests show coordinator→`role: system`, brokers/sinks→streaming pool, workers→trino pool.
- ArgoCD app render: `helm template` / `argocd app diff` for the new kube-prometheus-stack (or otel-agent) Application; AnalysisTemplates no longer contain `REPLACE_WITH_PROMETHEUS_ADDRESS`.
- Local: `pnpm dev:up` green from `down`; if re-enable ratified — prometheus targets page shows kafka:9404 UP, grafana on :3004; `docker stats --no-stream` total **< 18GB**.

**Wave 2**
- `terraform plan`: elasticache shows the replica-node destroy ONLY (num_cache_clusters 2→1, failover/multi-az flip false) — reviewed before apply.
- `helm template` green with `workers.autoscaling.enabled: true` (worker Deployment omits static replicas; ScaledObject renders); ArgoCD renders `collector-prod` under project `brain-prod`.
- `terraform plan` after `_shared` tags wiring = tag-only diffs, NO resource replacement.
- `docker inspect` shows pgbouncer/bronze-sink OOMScoreAdj set as designed; LocalStack re-seed produces prod-convention secret names; `pnpm dev:up` green.

**Wave 3**
- `terraform plan` additive: `aws_s3_bucket_intelligent_tiering_configuration` only.
- Workflow rename: `actionlint` clean; a master push exercises deploy.yml end-to-end (matrix unchanged).
- Docs: naming-and-tagging.md §3 rows greppable against `envs/prod/bootstrap.tf`; `tools/lint/v4-naming-guard.sh` + `prod-placeholder-guard.sh` stay green.
- Refresh-loop idle-gate: two consecutive idle cycles run 0 Spark containers; a produced event un-gates the next cycle; `ONESHOT=1` unaffected.

**Wave 4**
- No code verification — spec/ADR text updates only. After ratification pass: re-run this audit's conflict list; every CE either has a matching spec row or an approved revert ticket. CI gates (`v4-naming-guard`, placeholder guard) remain green; `pnpm dev:up` untouched.

---

**STAGE A COMPLETE — awaiting wave-by-wave approval before Stage B.**

---

## Stage B — Remediation Report (2026-07-02)

**Branch:** `deploy/stage-b-remediation` · **Range:** `b0e9fbe6..HEAD` — 25 commits (23 remediation/docs commits from 4 parallel lanes + follow-ups, plus 2 pre-branch fixes carried in). Every commit ID below maps to a Stage-A finding register entry (§3) or a Wave-4 ratification.

### B.1 Commit table

| AUD ID | SHA | One-line verification |
|---|---|---|
| AUD-COST-024 *(carried in, pre-branch)* | `f7f0d053` | ASCII-only descriptions on AWS-facing resources — EC2/RDS reject en/em dashes; merged into the branch base |
| AUD-CODE-025 *(carried in, pre-branch)* | `4f37ca09` | CI integration uses the shared compose health-poll (`up --wait` dies on one-shot inits); merged into the branch base |
| AUD-PROD-022 | `3c3430d4` | `git mv` main.yml→deploy.yml (99% rename similarity), name: aligned, trigger kept `[master]` with do-not-flip note; yaml parses, placeholder-guard `--selftest` green, zero main.yml refs left in `.github/workflows/` |
| AUD-PROD-003 | `2d47427c` | 4 `brain/prod/app/*` boot-secret shells + `core_secrets_read` extension + `app_boot_secret_arns` outputs; `terraform fmt -check` clean, `validate` green in envs/prod |
| AUD-LOCAL-001 | `5bd54cbf` | prometheus+grafana re-enabled in core + NEW alertmanager + the missing alerts mount (rule_files previously matched NOTHING in-container); LIVE: `/-/ready` 200, `/api/v1/rules` = 6 groups/21 rules, kafka-jmx target UP, grafana `/api/health` 200 |
| AUD-LOCAL-002 | `8a2187b0` | pgbouncer `oom_score_adj: -850` (between postgres −900 and kafka −800); `compose config -q` clean, takes effect on next recreate |
| AUD-PROD-004 | `73155c7e` | prod connector CMK (`alias/brain-connector-secrets-prod`) + ARN-scoped `brain/connector/*` IAM (core write+KMS, stream-worker read) appended to both IRSA roles; `validate` green in prod/dev/staging |
| AUD-NAME-006 (+007, PROD-015 doc-side) | `4dbe942c` | naming-and-tagging.md refreshed to applied reality (single warehouse bucket, aurora rows, KMS-alias exception, Karpenter table, 3-AZ note); every new row grepped against terraform ground truth |
| AUD-PROD-008 | `947e20ae` | `num_cache_nodes = 1` in envs/prod (module auto-flips failover/multi-AZ false at 1); pre-apply sizing (ElastiCache not yet applied), fmt+validate green |
| AUD-NAME-001 (default_tags) | `2b886f80` | `modules/_shared` tags wired into provider `default_tags` of all three env roots via strictly-additive merge; validate green on all roots, no resource replacement |
| AUD-LOCAL-003 | `f4f001c3` | explicit `--oom-score-adj` on every host-run Spark container: sink −600, all 43 ephemeral transform run-scripts +100 (die first, retried by loop); `bash -n` clean, daemon accepts flag |
| AUD-PROD-019 | `fb69f409` | Intelligent-Tiering via day-0 lifecycle TRANSITION rule (deliberate deviation — see B.3); fmt+validate green |
| AUD-PROD-012 (terraform half) | `650f8d4a` | `modules/s3-metrics` Thanos bucket (SSE-KMS, versioned, TLS-only, NO block expiry) + `brain-prod-thanos` IRSA (NN-3 trust on `monitoring/kube-prometheus-stack-prometheus`); fmt+validate green |
| AUD-NAME-001 (karpenter tag) | `e00cfc8a` | PascalCase `Environment` added as the missing 4th mandatory key in karpenter `common_tags` (SQS queue, 4 EventBridge rules, controller role); tag-only in-place update |
| AUD-PROD-014 | `5451ceae` | prod-local bootstrap seeds the exact 7 `brain/prod/k8s/*` ESO env-blob names into LocalStack (chart key contracts honored), ADDITIVE to legacy flat names; executed live — all 7 created, JSON keys verified |
| AUD-LOCAL-004 | `b6cbc8d2` | last unbounded containers bounded: loki/tempo 512m, otel-collector 256m, kafka-exporter 128m, inits 128m (kafka-init 512m — JVM CLI heap needs it), all with oom_score_adj; `compose config -q` clean across all profile sets |
| AUD-WAVE4 ratifications | `9b8fe41e` | `docs/infra/deployment-spec-ratifications.md` — exactly 20 rows, one per CONFLICT-ESCALATION item, IDs match the Wave-4 table one-for-one |
| AUD-PROD-002 (+001; Thanos half of 012) | `f0e9ccef` | kube-prometheus-stack ArgoCD app (chart PINNED 65.1.1, ns monitoring, release name locked to the IRSA trust) + values-prod: role:system pinning, brain-slo.rules.yml loaded VERBATIM (byte-identical, python-checked), Thanos sidecar → metrics bucket with IRSA-native objstore (zero static keys); helm template green |
| AUD-PROD-006 (+011) | `62e1b179` | workload→pool pinning values-prod-only: Kafka brokers→streaming (nodeAffinity — Strimzi PodTemplate has no nodeSelector), collector/stream-worker→streaming, Trino workers→trino pool, coordinator→ondemand pool (see B.3), 5 Spark crons→batch; python-asserted on rendered pods, defaults render with ZERO constraints |
| AUD-PROD-010 (+007) | `ef8182f8` | Trino worker KEDA flipped ON in values-prod: min 1 / max 3, CPU 70% (user decision); ScaledObject renders, static replicas omitted, default render unchanged |
| AUD-NAME-002 | `d0b5660b` | ArgoCD app renamed `brain-collector-prod` → `collector-prod` under project `brain-prod`; yaml-parse asserted, no stale references outside the audit report |
| AUD-PROD-002 (rollouts half) | `8ff341fb` | all 5 `REPLACE_WITH_PROMETHEUS_ADDRESS` filled with the in-cluster kube-prometheus-stack service URL (verified against the 65.1.1 rendered chart); zero occurrences left, guard green |
| AUD-LOCAL-017 | `54fd1b89` | kafka-ui (provectuslabs v0.7.2, 512m/-Xmx384m, oom 500) in debug profile on :8085 — topics/messages/consumer-groups view; verified live :8085 200, cluster visible. Also un-tripped the v4-naming-guard false positive (sentence-final `brain_gold.` in a helm comment reworded; guard exits 0) |
| AUD-PROD-022 (sweep) | `e9cf2044` | swept the 10 remaining main.yml comment/prose references → deploy.yml (incl. docs/requirements build-plan, GO-LIVE.md, oidc-github/eks TF comments); historical docs/audit + docs/cleanup records deliberately untouched |
| AUD-LOCAL-016 | `a1965e28` | real `/metrics` endpoints: new `packages/observability` prom-client registry (+45-line test), collector metrics route, stream-worker HealthServer exposure, prometheus.yml scrape fix — app counters now reach Prometheus end-to-end (see B.5 measured proof) |

### B.2 User decisions applied

- **Waves 1–3 executed** (all GAP items remediated or justified-skipped per B.3); Wave 4 executed as a ratification RECORD, not code changes, per the Stage-A plan.
- **Prod observability path: kube-prometheus-stack + Thanos** chosen (over the unimplemented ADR-006 Grafana-Cloud path) — in-cluster Prometheus on the system group, brain-slo rules verbatim, Thanos sidecar → S3 metrics bucket via IRSA.
- **Trino KEDA bounds: min 1 / max 3** (user decision — not the spec's scale-to-zero, not the pre-staged max 8).
- **All 20 CONFLICT-ESCALATION items RATIFIED** — recorded one-per-row in `docs/infra/deployment-spec-ratifications.md` (commit `9b8fe41e`), cross-referencing the same-day AUD-PROD-022 rename and AUD-NAME-006/007 + AUD-PROD-015 doc refreshes.

### B.3 Justified skips and deliberate deviations

- **AUD-LOCAL-015 (refresh-loop idle short-circuit) — SKIPPED.** Ground truth: Phase 1 folds NON-Bronze inputs every cycle (Neo4j identity export → `ops` schema, PG `connector_journey_stitch_map`), so a Bronze-snapshot-only gate would silently freeze identity-merge propagation, stitch updates and Customer360 re-resolution on zero new Bronze data. A correct gate needs a multi-source watermark (Bronze snapshot + Neo4j export delta + PG stitch state) — exactly the load-bearing-loop complication the remediation bar forbade. Remains open as a designed follow-up.
- **AUD-PROD-019 — Intelligent-Tiering via lifecycle TRANSITION, not the report's literal resource.** `aws_s3_bucket_intelligent_tiering_configuration` can only enable the opt-in ARCHIVE tiers (API requires ≥1 archive tiering), whose async restore would make cold-but-catalog-referenced Iceberg files fail Trino/Spark GETs (`InvalidObjectState`) — a serving/SLA break. The day-0 lifecycle transition to the `INTELLIGENT_TIERING` storage class delivers exactly the no-retrieval-fee frequent/infrequent auto-tiering intended. Archive tiers, if ever wanted, are a separate SLA-impacting decision.
- **AUD-PROD-006 — Trino coordinator pinned to the tainted ON-DEMAND Karpenter pool, NOT the system MNG.** The system MNG is t4g.medium (4 GiB) while the coordinator's RATIFIED memory bound is a 6Gi request / 7Gi limit (measured-OOM evidence) — `role: system` would make the sole serving engine permanently unschedulable, and shrinking the request would weaken a ratified bound. The ondemand pool (t4g.xlarge, AUD-COST-018/Neo4j precedent) preserves the intent: stable on-demand capacity, never Spot. Record coordinator=ondemand in any AUD-PROD-016 spec-table update.

### B.4 New findings raised during Stage B

Follow-ups discovered while remediating — **NOT remediated unless marked FIXED**:

1. **SLO-rules dual-copy needs a CI parity check** — brain-slo rules now deliberately exist in two places (canonical `infra/observe/alerts/brain-slo.rules.yml` + the `additionalPrometheusRulesMap` copy in kube-prometheus-stack values-prod, python-verified identical at commit time); a rule edit must touch both. A tiny yaml-compare CI gate would make drift impossible.
2. **ServiceMonitors/PodMonitors missing on the prod cluster** — the SLO rules reference scrape jobs (`brain-.*`, kafka-jmx-exporter, kafka-exporter) that no chart yet creates monitors for, so several rules will be vacuously silent in prod until app/kafka exporters are wired to the new Prometheus.
3. **`freshness.rules.yml` has no prod evaluator** — only brain-slo.rules.yml was scoped into `additionalPrometheusRulesMap`; same one-block addition when the freshness-exporter is deployed on the cluster.
4. **Legacy `brain/prod/{db,kafka,grafana,apicurio}` shells unseeded locally** — no local consumer exists, so AUD-PROD-014 seeded only the 7 k8s env blobs; parity is shape-not-value (localhost endpoints) by design.
5. **App boot secrets flat-named locally vs `brain/prod/app/*` in prod** — the local flat legacy names remain the live app refs (nothing repointed); full path parity lands when local consumers move to the new shells created by AUD-PROD-003.
6. **`docs/requirements/05_Brain_Implementation_Build_Plan.md` said `main.yml`** — one spec surface actually documented the old filename; aligned to deploy.yml in the `e9cf2044` sweep.
7. **FIXED (AUD-LOCAL-016, `a1965e28`)** — local Prometheus scrape config had a stream-worker target colliding with the Kafka host port (:9092) and the apps exposed no `/metrics` at all; real endpoints + scrape fix landed, counters verified end-to-end.
8. **FIXED (AUD-LOCAL-017, `54fd1b89`)** — `v4-naming-guard` false positive: a helm comment's sentence-final `brain_gold.` matched the retired-DB pattern (introduced by AUD-COST-013 commit `321f8735`); comment reworded, guard NOT weakened.

### B.5 Verification evidence (MEASURED 2026-07-02)

- **Local memory budget:** `docker stats` total **10.70 GiB < 18 GB** with prometheus + grafana + alertmanager UP.
- **SLO pipeline live:** Prometheus `/api/v1/rules` = **6 groups / 21 rules** loaded from BOTH brain-slo.rules.yml and freshness.rules.yml (previously the rule_files glob matched nothing in-container).
- **App metrics end-to-end:** `brain_collector_accept_total` scraped — POST `/collect` → collector `/metrics` → Prometheus query returns 1.
- **Kafka visibility:** kafka-ui :8085 → 200 with cluster visible; kafka-exporter serving **234 lag series**.
- **Terraform:** `fmt -check -recursive` clean + `validate` green on **all roots** (prod/dev/staging). (Note: `init -backend=false` exits 1 in envs/prod on an ambient-credential STS probe AFTER successful module install — not a config error; validate passes.)
- **Helm:** `helm template` green with BOTH defaults and values-prod on every touched chart (trino, strimzi-kafka, collector, stream-worker, cronworkflows, kube-prometheus-stack 65.1.1); scheduling constraints python-asserted on rendered pods, defaults render constraint-free.
- **Guards:** `tools/lint/v4-naming-guard.sh` green (post 54fd1b89) + `prod-placeholder-guard.sh` PR mode and `--selftest` green.
- **Build:** turbo `typecheck` + `build` green.
- **Tests:** `test:unit` green EXCEPT pre-existing env-state live-test failures in stream-worker (meta-token-refresh / identity-merge / capi-deletion) — verified IDENTICAL at baseline `b0e9fbe6` against the same restored dev DB; they pass in CI's fresh-DB environment; **not a branch regression**.

**STAGE B COMPLETE — 25 commits on `deploy/stage-b-remediation`; Waves 1–3 remediated, Wave 4 ratified; open follow-ups tracked in B.4.**
