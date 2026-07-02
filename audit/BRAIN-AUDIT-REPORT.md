# Brain — Principal-Engineer Audit Report

**Date:** 2026-07-02 · **Branch:** `audit/stage-b-remediation` · **Scope:** 8 dimensions (arch-conformance, infra-memory, app-perf, data-perf, code-cleanup, tenancy-critical, cost-prod, ts-hygiene), 33 verification agents.
**Findings:** 23 confirmed CRITICAL/HIGH · 60 MED/LOW · 2 refuted · 3 closed prior to report. Every confirmed finding carries an adversarial verifier note; all evidence below is verbatim from the audit record.

---

## 1. Executive summary

The platform's *logical* architecture is in good shape — the tenancy seam, the medallion design, the idempotent-MERGE discipline, and the TS hygiene all verified sound. The exposure clusters in four places: **(a)** production AWS is a never-applied blueprint with ~12 independent go-live chain-breakers; **(b)** the unauthenticated collector edge has admission-gate bypasses and a hard throughput ceiling; **(c)** operational data hygiene (compaction, checkpoints, PII retention) never runs; **(d)** identity ingestion structurally bypasses the Silver consent/tenant gates.

### Top 10 findings by impact

| # | ID | Finding | Sev | Why it matters |
|---|----|---------|-----|----------------|
| 1 | AUD-COST-001 | Prod Terraform never applied; bootstrap has no state, placeholder account id | CRITICAL | Gates every other go-live item; chicken-and-egg between prod-apply.yml and the role it assumes |
| 2 | AUD-COST-003 | No public ingress/TLS/DNS anywhere (collector/web/core ClusterIP-only) | CRITICAL | Zero pixel/app/API traffic can reach prod — event loss by construction |
| 3 | AUD-COST-006 | Neo4j (identity SoR, ADR-0004) has NO prod deployment path | CRITICAL | identity-export → silver_identity_link → brain_id resolution → attribution all fail |
| 4 | AUD-ARCH-002 | Identity ingestion consumes the raw Kafka topic pre-R2/R3 gate; vaults RAW email from non-consented events under a claimed (publicly discoverable) brand_id | HIGH | Tenant-isolation + DPDP exposure on the identity SoR; pollution re-enters the gated medallion via the export |
| 5 | AUD-PERF-001 | Collector `/batch` bypasses ALL admission gates; query-string suffix bypasses them on `/collect` too | HIGH | Unauthenticated public ingest; 50x amplification into the spool; empirically reproduced |
| 6 | AUD-PERF-003 | ADR-0006 D4 raw-PII retention job unscheduled, blind to unified `brain_bronze.events`, row-TTL DELETE is a stub | HIGH | Raw un-hashed PII / razorpay PCI payloads persist ~2 years vs the mandated 7 days; named prod-flip gate |
| 7 | AUD-INFRA-004 | Bronze sink checkpoint is ephemeral (`docker run --rm`, in-container /tmp) — every crash re-drains ALL topics from `earliest` | HIGH | OOM→restart→full-re-drain amplification loop on the sole Bronze ingestion path |
| 8 | AUD-INFRA-003 | Apicurio schema registry: unbounded JVM (MaxHeap 7.82GiB measured) on the strict-SLA ingest path, in-memory, no restart policy | HIGH | OOM-kill loses all schemas and stays down → collector→Kafka ingest degradation |
| 9 | AUD-PERF-004 | No Iceberg compaction/snapshot expiry EVER runs for Silver/Gold — 1,726 files for 27 MB measured | HIGH | Unbounded file/snapshot growth in dev AND prod against the sole serving engine with OOM history |
| 10 | AUD-CODE-002 | Bronze e2e coverage silently dead: 8 suites permanently self-skip on a removed StarRocks seam | HIGH | Coverage for the "no event loss" core invariant reports green-by-skip forever |

Honorable mentions: AUD-PERF-002 (drainer ~100 events/s ceiling — one in-rate-limit tenant can outpace it and trigger a *global* SPOOL_FULL shed), AUD-COST-008 (Trino prod pinned to us-east-1 while everything else is ap-south-1 — deterministic serving outage at go-live).

### OOM root cause (verified)

Per-container caps are now **sound** after PR #342 (hard `--memory` caps on every Spark job container) and the earlier Trino bounded-heap fix (7g limit, MaxRAMPercentage 70, restart:unless-stopped). The residual OOM risk is not cap sizing — it is: **(1)** the two unbounded containers, apicurio (a JVM that can claim 7.82GiB, measured) and pgbouncer (AUD-INFRA-003); **(2)** Redis configured to be cgroup OOM-killed rather than evict (no `maxmemory`/policy — AUD-INFRA-005), which drops the whole serving cache + stampede locks at once; **(3)** the Bronze sink's ephemeral checkpoint (AUD-INFRA-004), which converts every OOM into a full-history Kafka re-drain — exactly the large-backlog profile that historically OOMed the sink, i.e. an OOM *amplification* loop rather than a one-off; **(4)** no global concurrency guard on Spark job containers (AUD-INFRA-006), so overlapping refresh loops stack 7g-cap JVMs with no admission control; and **(5)** host-side Node apps with no `--max-old-space-size` (AUD-INFRA-009) competing for the ~16.7GB left outside the Docker VM. The often-cited "24GB target" was **REFUTED**: it exists nowhere in the repo. The repo's documented OOM-prevention contract (`docs/ops/local-memory-budget.md`) mandates a **≥32GB Docker VM** and deliberately sets caps above steady usage as runaway protection, with kill-ordering engineered via `oom_score_adj`. That contract stands; the budget doc itself, however, is stale (AUD-INFRA-008) and must be rewritten to the current topology.

---

## 2. Context summary

### Architecture mandates (CLAUDE.md doctrine)
Spark-on-Iceberg is the **sole** compute (dbt and StarRocks REMOVED); the medallion is Iceberg (`brain_{bronze,silver,gold}_local` rest catalogs, MinIO/S3), and Iceberg is the system of record. Serving is **Trino-over-Iceberg** fronted by a Redis analytics cache — app/BFF/metric-engine read only `brain_serving.mv_*` views. Operational state is PostgreSQL `ops` schema; features are RUNTIME (no precompute tables). Money is bigint minor units + `currency_code`. Tenant isolation is `brand_id`-first everywhere plus the fail-closed `${BRAND_PREDICATE}` seam on every Trino serving read. Core rules: no event loss, Bronze is source of truth, deterministic first, revenue truth over platform truth, confidence before decisions. Invariants are CI-enforced by `tools/lint/v4-naming-guard.sh`.

### Services & strict-SLA path
Local stack: collector / core / web / stream-worker (host Node via turbo) + compose services postgres, pgbouncer, redis, kafka (KRaft), apicurio, neo4j, minio, iceberg-rest, trino, localstack — plus two out-of-compose Spark containers (streaming Bronze sink + one sequential transform per refresh cycle, `tools/dev/v4-refresh-loop.sh`).

**Strict-SLA ingest path:** pixel/webhook → **collector** (Fastify, edge-guard rate-limit + origin allowlist) → **PgSpool** (durable-before-ACK, D-1) → **drainer** (poll → Kafka produce) → **Kafka** → **bronze_landing.py streaming sink** (idempotent MERGE on dedup_key) → **Iceberg `brain_bronze.events`**. Downstream: Spark Silver (Stage-1 technical gate incl. R2 install_token→brand + R3 consent, quarantine tables) → Gold marts → Trino `brain_serving.mv_*` → Redis cache → BFF/app. Identity: stream-worker → Neo4j (SoR) → identity-export → `ops.silver_identity_link` → Silver/Gold joins.

### Conformance scorecard (14 finalized requirements)

**CONFORMANT (verified):**
- Unified Bronze sink — `bronze_landing.py` is the **sole launched** sink (dev launcher + prod helm cron); legacy modules retained only as gated rollback.
- Silver never mints `brain_id` — joins pre-resolved Neo4j exports only.
- `event_category` enum + UDF (behaviour/transaction/fulfillment/support/marketing) live.
- `silver_version` seeded, bumped only on payload-changed MERGE updates.
- Pixel R2/R3 gate correctly lives in Silver (`silver_collector_event`); Bronze is pure raw.
- Bi-temporal `silver_identity_map` exists — deterministic projection of the append-only Neo4j graph.
- `customer_360.journey_summary` (last-200 JSON) exists.
- Analytics Gateway = ratified ADR-0007 decision (BFF + metric-engine cache-aside), not a violation.
- Collector PgSpool → drainer → Kafka with hysteresis back-pressure is solid.

**DEVIATIONS (findings):**
- `BRONZE_SOURCE` split-brain — prod templates omit the flag; code defaults `legacy` (AUD-ARCH-001; dev verified NOT split-brained — downgraded to LOW).
- Identity bridge consumes the raw Kafka topic **pre-gate** (AUD-ARCH-002 — the single largest structural deviation).
- Three parallel identity projections; production revenue joins still on the flat PG export (AUD-ARCH-004).
- Composite touchpoint dedup partial — never pairs pixel `purchase` with server `order.created` (AUD-ARCH-005).
- No versioned `journey_events` mart — **de-scoped in #338, PARKED escalation** (AUD-ARCH-006).
- `BRN-` flat public id vs hierarchical `<tenant>-YYYYMMDD-<b32>` — **PARKED escalation; no in-repo doc mandates the hierarchical form** (AUD-ARCH-007).
- 7 shadow `*_normalize` jobs still 10-col — cutover blocker (AUD-ARCH-008).

---

## 3. Memory budget — live measurements + reconciled proposal

Measured 2026-07-02 during `pnpm dev:up` + refresh loop. Docker VM = **31.29GiB**; host = 48GB macOS. Steady-state total ≈ **12GiB** + one 7g-cap Spark job during refresh. The **≥32GB VM contract** (`docs/ops/local-memory-budget.md`) **stands**; the "24GB target" was refuted (see Appendix).

| Container | Measured (live) | Current limit | App-level cap | Proposal |
|---|---|---|---|---|
| brain-bronze-sink | 5.57GiB | 7GiB (`--memory`) | driver 4g + offHeap 512m | Keep; add **durable checkpoint volume** (AUD-INFRA-004); drop no-op `--executor-memory 4g` (AUD-INFRA-010) |
| trino | 2.08GiB (idle 0.88, grows under query) | 7GiB | jvm MaxRAMPercentage 70 → ~4.9g heap | **Keep** — verified SOUND; 7g is the merged permanent fix for the serving-outage class ("CONFLICT REFUSED" comments) |
| minio | 1.4–2.2GiB | 5GiB | GOMEMLIMIT 4500MiB | Keep (budget doc records 4.4g steady under refresh); optional verify-then-4g only if refresh peak < 3.5GiB |
| kafka | 1.37GiB | 2.441GiB | image default -Xmx1G (unpinned) | Keep limit; **pin `KAFKA_HEAP_OPTS: "-Xmx1G -Xms1G"`** (AUD-INFRA-007) |
| neo4j | 0.67GiB | 1.465GiB | heap 512M + pagecache 256M | **Keep** — verified SOUND (51% of limit) |
| apicurio | 0.38GiB | **UNLIMITED** (MaxHeap 7.82GiB claimable) | none | **Add `mem_limit: 768m` + `-Xmx512m` + oom_score_adj ~-600** (AUD-INFRA-003) |
| localstack | 161MiB | 512MiB | — | Keep |
| iceberg-rest | 243MiB | 512MiB | — | Keep |
| postgres | 80MiB | 512MiB | — | Keep |
| redis | 22MiB | 256MiB | **no maxmemory/eviction** | **Add `--maxmemory 192mb --maxmemory-policy volatile-lru`** (AUD-INFRA-005) |
| pgbouncer | 6MiB | **UNLIMITED** | — | **Add `mem_limit: 128m`** (AUD-INFRA-003) |
| Spark job containers | peak observed 1.7GiB each (sequential) | 7GiB each (`docker run --rm --memory 7g`, PR #342) | driver 4g; no offHeap for batch jobs | Keep for now; candidate 5.5g after AUD-INFRA-010 measurement; **add global flock concurrency guard** (AUD-INFRA-006) |
| Host Node apps (core/web/collector/stream-worker) | not measured (apps down) | none (outside VM) | V8 default ~4GB each | Measure, then `NODE_OPTIONS=--max-old-space-size=1024` (2048 for web) (AUD-INFRA-009) |

Rewrite `docs/ops/local-memory-budget.md` + `docs/runbooks/local-dev-startup.md` to this topology (AUD-INFRA-008): the doc still budgets removed two-sink services, calls kafka "redpanda", lists litellm, calls iceberg-rest "unbounded" (it is 512m-bounded), and omits apicurio — the actual unbounded JVM.

---

## 4. Findings register

Legend: Sev = SEV-{CRITICAL,HIGH,MED,LOW} · Effort = EFFORT-{S,M,L} · Tag = MEASURED | HYPOTHESIS · Wave = remediation wave (1–5; 5/escalations detailed in §5).

### 4.0 Closed prior to report

| ID | Finding | Closed via |
|---|---|---|
| AUD-INFRA-001 | Spark job containers had no hard memory caps — every `docker run` Spark job now carries `--memory` (default 7g) | PR #342, commit `1eb6917d` |
| AUD-INFRA-002 | Bootstrap re-wraps brand keyrings + identity salts for ALL brands (LocalStack KMS ARN drift after restart) | commit `5d5d1bee` |
| AUD-CODE-001 | Duplicate `KAFKA_BROKERS` key in the integration workflow broke knip runs | commit `c48c88f4` |

---

### 4.1 AUD-INFRA — local infrastructure & memory

| ID | Title | Sev | Effort | Tag | Wave |
|---|---|---|---|---|---|
| AUD-INFRA-003 | Apicurio + pgbouncer unbounded (apicurio = ~7.8GiB-claimable JVM on the ingest path) | HIGH | S | MEASURED | 1 |
| AUD-INFRA-004 | Bronze sink checkpoint ephemeral — every restart re-drains ALL topics from `earliest` (merged: infra-memory + data-perf) | HIGH | S | MEASURED | 1 |
| AUD-INFRA-005 | Redis 256m limit but no maxmemory/eviction — OOM-kill instead of evict | MED | S | MEASURED | 1 |
| AUD-INFRA-006 | No global concurrency guard on Spark job containers | MED | S | MEASURED | 4 |
| AUD-INFRA-007 | Kafka broker heap unpinned (image default) | LOW | S | MEASURED | 1 |
| AUD-INFRA-008 | OOM-budget doc + startup runbook stale (removed services, two-sink arch) | MED | S | MEASURED | 2 |
| AUD-INFRA-009 | Host Node apps: no `--max-old-space-size` | LOW | S | HYPOTHESIS | 5 |
| AUD-INFRA-010 | Spark job memory hygiene MOSTLY sound — two minor inconsistencies (no-op `--executor-memory`, transform caps sized for sink overhead) | LOW | S | MEASURED | 3 |

---

#### AUD-INFRA-003 — Apicurio schema registry has NO mem_limit (an unbounded JVM on the strict-SLA ingest path); pgbouncer also unbounded
**SEV-HIGH · EFFORT-S · MEASURED · Wave 1** · *(merged: infra-memory confirmed finding + cost-prod "LOCAL: apicurio and pgbouncer" finding — both evidence trails below)*

**Evidence (infra-memory):** docker-compose.yml:355-369 — the apicurio service (apicurio/apicurio-registry-mem:2.6.3.Final, a Quarkus JVM) has no mem_limit, no oom_score_adj, and no restart policy. It is the only long-running JVM in the core profile without a memory cap (pgbouncer and tempo — small non-JVM daemons — and the one-shot init jobs also lack limits, so it is not literally the ONLY uncapped core service). MEASURED live in the running container (brainv3-apicurio-1): java -XX:+PrintFlagsFinal shows MaxHeapSize=8401190912 (7.82GiB) at default MaxRAMPercentage=25 of the 31.29GiB Docker VM; docker stats shows 381.4MiB / 31.29GiB (no cgroup limit applied; steady-state confirms the ~300-600MiB estimate). It is an IN-MEMORY registry (-mem image), so an OOM-kill loses all registered schemas and, with no restart policy, the container stays down. Collector/stream-worker validate schemas against it (docker-compose.yml:352-354 comment), so a kill degrades the collector→Kafka ingest path. This host has demonstrated OOM-kill outages (Trino serving outage, Spark sink), and apicurio's default oom_score_adj=0 means the kernel kills it before every negative-adj protected service.

**Evidence (cost-prod LOCAL):** docker-compose.yml:355-367 apicurio block has no mem_limit (all 11 mem_limit keys belong to other services); MEASURED via `docker stats --no-stream`: brainv3-apicurio-1 360.1MiB / 31.29GiB (limit = whole host VM) and brainv3-pgbouncer-1 6.2MiB / 31.29GiB, while every other core member is capped (postgres 512m, neo4j 1500m, redis 256m, minio 5g, localstack 512m, kafka 2500m, iceberg-rest 512m, trino 7g ≈ 17.75g budgeted). An apicurio (JVM, in-memory registry) leak would pressure the docker VM and trigger kernel OOM-kills of the capped SoR containers per docs/ops/local-memory-budget.md:11.

**Remediation:** Add mem_limit: 768m and JAVA_OPTS/JAVA_OPTS_APPEND '-Xmx512m' (heap = 67% of limit) plus an oom_score_adj consistent with its ingest-path criticality (e.g. -600), matching the pattern used for every other core JVM. Add mem_limit: 128m to pgbouncer (blueprint §4.2 bound-everything rule).

**Risk:** If real registry heap exceeds 512m (many Avro artifacts under FULL_TRANSITIVE history) the JVM OOMs; verify live heap first. Too-tight apicurio cap OOM-kills schema validation → collector 5xx; 768m gives 2x measured headroom. Verify with one refresh-loop pass after capping.

**Verifier note:** Confirmed by direct measurement. docker-compose.yml:355-369 defines apicurio (apicurio-registry-mem:2.6.3.Final) with no mem_limit, no oom_score_adj, and no restart policy, while every other long-running core service is capped (postgres 512m/-900, kafka 2500m/-800, trino 7g/-700, iceberg-rest 512m/-700, neo4j 1500m/-500, minio 5g/-500, redis 256m/-300, localstack 512m/+200). Measured inside the RUNNING container: MaxHeapSize=8401190912 (7.82GiB) at default MaxRAMPercentage=25 of the 31.29GiB Docker VM — the ~7.8GiB claimable-heap figure is exact. docker stats shows 381.4MiB / 31.29GiB limit (unbounded confirmed; steady-state inside the finding's 300-600MiB hypothesis). Not fixed by any recent commit (#342 capped Spark job containers only; Trino heap bounded separately). Ingest-path criticality confirmed by compose comment at lines 352-354 (collector/stream-worker validate schemas against it). SEV-HIGH justified: this host has real OOM-kill outage precedent (Trino, Spark sink), apicurio's default oom_score_adj=0 means it dies before every negative-adj SoR, and the -mem image loses all registered schemas on a kill with no restart policy — an ingest-path outage violating the no-event-loss rule. Two evidence details corrected (container is up, not down; two small non-JVM services also lack limits).

---

#### AUD-INFRA-004 — Bronze streaming sink checkpoint lives in the container's /tmp under `docker run --rm` — every crash/OOM restart destroys it and re-drains ALL topics from `earliest`
**SEV-HIGH · EFFORT-S · MEASURED · Wave 1** · *(merged: infra-memory HIGH + data-perf MED — both evidence trails below)*

**Evidence (infra-memory):** db/iceberg/spark/bronze_landing.py:81-82 — CHECKPOINT defaults to file:///tmp/bronze-landing-checkpoint and STARTING_OFFSETS defaults to 'earliest'; tools/dev/dev-bronze-streaming.sh:70-105 — the supervisor loop does `docker rm -f` then `docker run --rm` with NO volume mounted for the checkpoint path (only /opt/spike:ro + the ivy cache, L78-79), and L94 explicitly passes CHECKPOINT_LOCATION with the same ephemeral /tmp default; no CHECKPOINT_LOCATION override exists anywhere in .env* or tools/dev (repo grep: the only durable-checkpoint configs are the PROD Argo helm values, infra/helm/cronworkflows/values.yaml:60,77,81, which explicitly require 'a DURABLE s3a:// path' — confirming the invariant the dev launcher violates). So the comment at dev-bronze-streaming.sh:66 ('recreate from the DURABLE checkpoint') is false: each auto-restart re-reads full retention across all 11 subscribed lanes (collector + backfill + 9 connector raw lanes) — 7-day retention.ms=604800000 on collector/raw lanes and 30-day (2592000000) on the backfill lane per docker-compose.yml kafka-init. The idempotent MERGE on dedup_key prevents duplicates/data loss, but a restart-after-OOM triggers exactly the large-backlog-drain profile the 4g heap comment (dev-bronze-streaming.sh:17-26) documents as the historic sink OOM — an OOM→restart→full-re-drain pressure-amplification loop on the collector→Kafka→Bronze path, plus a Bronze freshness gap for every re-drain. repair_incomplete_checkpoint (bronze_landing.py:414-442) only trims half-written checkpoint files and cannot help when the whole checkpoint dir vanishes with the container.

**Evidence (data-perf, live-verified):** tools/dev/dev-bronze-streaming.sh:94 sets CHECKPOINT_LOCATION default file:///tmp/bronze-landing-checkpoint with NO volume mount for it (only /opt/spike ro at line 78 + brain-spark-ivy at line 79); the container runs `docker run --rm` (line 73) and the supervisor loop `docker rm -f`s the container before every run (line 72), so the checkpoint is destroyed on EVERY restart, including the supervisor's own auto-restarts. Verified live: `docker inspect brain-bronze-sink` shows AutoRemove=true and Mounts=[spark src ro, brain-spark-ivy] only; checkpoint commits/ inside the container at batch 289 while the container is minutes old, and /tmp/bronze-sink.log:206-208 shows "phase 1/2 — draining backlog (availableNow, chunked)… done — rest.brain_bronze.events now has 69544 rows", i.e. this restart re-read the full topic history from STARTING_OFFSETS=earliest (db/iceberg/spark/bronze_landing.py:81) as full idempotent MERGEs. The comment "recreate from the DURABLE checkpoint" (dev-bronze-streaming.sh:66) is false. Mitigations that cap severity: the MERGE on (brand_id,event_id) makes replay lossless/duplicate-free, and prod Argo cron already mandates a DURABLE s3a CHECKPOINT_LOCATION (infra/helm/cronworkflows/values.yaml:60,77; templates/spark-bronze.yaml:92) — the gap is dev-only (freshness lag + wasted compute + growing re-drain/OOM window as topic history grows).

**Remediation:** Mount a durable named volume (or host dir) for the checkpoint: add `docker volume create brain-bronze-checkpoint` and `-v brain-bronze-checkpoint:/checkpoint` with CHECKPOINT_LOCATION=file:///checkpoint/bronze-landing; keep the existing repair_incomplete_checkpoint self-heal (bronze_landing.py:414-442) for unclean kills. Keep STARTING_OFFSETS=earliest as the cold-start fallback.

**Risk:** Low — a stale-but-valid checkpoint resumes from committed offsets; the existing repair path already handles half-written checkpoints. One-time behavior change: first restart after the fix no longer re-drains (expected). A persisted checkpoint must be discarded when the subscribed topic set / query plan changes (Spark refuses or misbehaves on incompatible checkpoints) — document a 'wipe volume on topic-set change' rule.

**Verifier note (infra-memory):** Every cited evidence point verified exactly. bronze_landing.py:81-82 defaults CHECKPOINT to file:///tmp/bronze-landing-checkpoint and STARTING_OFFSETS to 'earliest'. tools/dev/dev-bronze-streaming.sh:70-105 supervisor does `docker rm -f` + `docker run --rm` mounting only /opt/spike:ro (L78) and the ivy volume (L79); L94 passes the /tmp default into the container, whose writable layer is destroyed on each restart — so the L66 comment 'recreate from the DURABLE checkpoint' is false and each auto-restart re-drains from earliest. Repo-wide grep confirms no CHECKPOINT_LOCATION override anywhere in .env*/tools/dev; the only durable-checkpoint configs are the prod Argo helm values (infra/helm/cronworkflows/values.yaml:60,77,81 explicitly require a DURABLE s3a:// path), proving prod is covered but the local-prod launcher (the live environment's sole Bronze sink) is not. Not fixed on audit/stage-b-remediation: #342 only added --memory 7g (L74); no commit touches checkpoint durability. repair_incomplete_checkpoint exists at bronze_landing.py:414-442 but only trims half-written files — useless when the whole directory vanishes. Kafka retention verified in docker-compose.yml kafka-init: 7 days on collector + 9 raw lanes. SEV-HIGH justified: OOM→restart→full-re-drain is exactly the large-backlog OOM profile documented at dev-bronze-streaming.sh:17-26, a self-amplifying availability/freshness loop on the sole Bronze ingestion path; idempotent MERGE prevents data loss/dupes, keeping it below CRITICAL. *(Data-perf verifier independently confirmed end-to-end with live docker inspect + log evidence; rated dev-launcher-only freshness/compute defect → MED from that dimension's lens.)*

---

#### AUD-INFRA-005 — Redis has mem_limit 256m but no maxmemory/eviction policy — failure mode is cgroup OOM-kill of the serving cache instead of graceful eviction
**SEV-MED · EFFORT-S · MEASURED · Wave 1**

**Evidence:** docker-compose.yml:111-121 — redis:7 with mem_limit: 256m, default command, no --maxmemory / --maxmemory-policy and no config mount (redis default maxmemory=0 = unlimited). Redis is the analytics serving cache + SETNX stampede lock (PR #341, per-dataset TTL tiers). When keyspace growth crosses ~256m the kernel OOM-kills the container (oom_score_adj -300, L115) — dropping ALL cache entries and in-flight stampede locks at once (thundering-herd onto Trino) rather than evicting oldest keys. Current keyspace size unmeasurable (container down) — breach likelihood HYPOTHESIS; the config gap itself is measured.

**Remediation:** Add `command: ["redis-server", "--maxmemory", "192mb", "--maxmemory-policy", "volatile-lru"]` (75% of the cgroup limit; volatile-lru is safe because serving-cache keys and the stampede-lock keys all carry TTLs per #341).

**Risk:** volatile-lru can evict a stampede-lock key under extreme pressure → brief duplicate Trino query (correctness-safe, perf-only). Any key written WITHOUT a TTL would become unevictable — grep serving cache writers to confirm all SETs are EX/PX before choosing volatile-lru over allkeys-lru.

---

#### AUD-INFRA-006 — No global concurrency guard on Spark job containers — overlapping refresh loops / manual run scripts each add a 7g-cap JVM with no admission control
**SEV-MED · EFFORT-S · MEASURED · Wave 4**

**Evidence:** tools/dev/v4-refresh-loop.sh — runs its ~35 transform scripts strictly SEQUENTIALLY (run_spark_tier for-loop, L224-232) so ONE loop = sink + 1 transform = 14GiB of caps max; but the script has NO flock/pidfile/pgrep guard (grep flock|lockfile|pgrep across v4-refresh-loop.sh + db/iceberg/spark/run-*.sh = 0 hits). dev-up.sh:131 runs ONESHOT=1 refresh while the runbook (docs/runbooks/local-dev-startup.md:104-107) tells the user to also run the continuous loop; two loops + the sink + any manual run-*.sh = 3-4 concurrent 7g-cap Spark containers (21-28GiB of caps) on top of the 17.65GiB compose stack — guaranteed VM oversubscription. The Spark job containers also get default oom_score_adj 0 (docker run passes none), so they are correctly the kernel's first kill targets, but a kill mid-MERGE wastes the whole retried job. This is the still-open 'cron scheduling-overlap gap' from the #323/#324 audit. Worst-case concurrency impact is HYPOTHESIS (not reproduced); the guard's absence is measured.

**Remediation:** Add a single flock (e.g. /tmp/brain-spark-transform.lock) taken by run_spark_script in v4-refresh-loop.sh AND by each run-*.sh docker-run wrapper, so at most one transform container exists at a time regardless of how many loops/manual invocations run; optionally a second loop-level pidfile so a second `pnpm dev:v4-refresh` exits with a clear message.

**Risk:** A stale lock after a hard kill would block refreshes — use flock -w with a timeout + the lock auto-releases on fd close (flock semantics), so risk is minimal.

---

#### AUD-INFRA-007 — Kafka broker heap is the implicit image default (KAFKA_HEAP_OPTS unset) rather than pinned
**SEV-LOW · EFFORT-S · MEASURED · Wave 1**

**Evidence:** docker-compose.yml:234-292 — the kafka service sets KAFKA_OPTS (javaagent, L263) but never KAFKA_HEAP_OPTS, so heap = apache/kafka:3.8.1's kafka-server-start.sh default (-Xmx1G -Xms1G). Under the 2500m mem_limit (L240) that is ~40% heap/limit — safe headroom for the JMX agent, metaspace, and page cache today, but the budget contract (mem_limit sized to heap) silently breaks if an image bump changes the default. On the strict-SLA path, but currently correctly sized → stays LOW.

**Remediation:** Pin KAFKA_HEAP_OPTS: "-Xmx1G -Xms1G" in the kafka service environment and note the pairing (1G heap / 2.5g limit) in docs/ops/local-memory-budget.md. **Risk:** None — pins the value already in effect.

---

#### AUD-INFRA-008 — The OOM-budget contract doc and startup runbook are stale — they describe removed services, the old two-sink architecture, and mandate a ≥32GB VM that the (refuted) 24GB goal contradicted
**SEV-MED · EFFORT-S · MEASURED · Wave 2**

**Evidence:** docs/ops/local-memory-budget.md:18 mandates 'Docker VM must be ≥ 32 GB' (actual allocation is 31.3GiB); L30-31 budget rows for 'spark-bronze-sink 7g' / 'spark-bronze-raw-sink 6g' compose services that were REMOVED (docker-compose.yml:453-459 removal note — replaced by ONE host-launched bronze_landing container); L34 says 'redpanda (Kafka KRaft)'; L35 lists litellm (now commented out, docker-compose.yml:166-196) and calls iceberg-rest 'unbounded' (it is bounded 512m, L402); it omits apicurio entirely (the actual unbounded JVM). docs/runbooks/local-dev-startup.md:68-94 still documents combined_bronze_sinks.py with 'driver 1g + executor 1g + offHeap 256m ≈ ~2 GB' defaults, while the live launcher is bronze_landing.py with driver 4g + offHeap 512m in a 7g-cap container (tools/dev/dev-bronze-streaming.sh:57,74,98). Since this doc is cited as the authority by 5 'CONFLICT REFUSED' compose comments (docker-compose.yml:95-97,130-132,237-239,399-401,475-477), its staleness propagates wrong numbers into future sizing decisions.

**Remediation:** Rewrite the budget table in docs/ops/local-memory-budget.md to the current topology (unified sink, kafka naming, apicurio row, disabled prometheus/grafana/litellm noted) and to the ratified VM target (the ≥32GB contract stands — the 24GB proposal was refuted); update local-dev-startup.md's Bronze section to bronze_landing.py + the 4g/7g numbers. **Risk:** None — documentation only.

---

#### AUD-INFRA-009 — Host-side Node apps (core/web/collector/stream-worker via turbo) have no --max-old-space-size — up to ~4GB V8 default each in the ~16.7GB left outside the Docker VM
**SEV-LOW · EFFORT-S · HYPOTHESIS · Wave 5 (parked pending measurement)**

**Evidence:** tools/dev/dev-up.sh:137-139 starts 4 apps on the macOS HOST (outside the 31.3GiB Docker VM) via `turbo run dev`; grep for max-old-space-size/NODE_OPTIONS across package.json, apps/*/package.json, turbo.json, dev-up.sh, .env.local-prod.example = 0 hits. On the 48GB host, 31.3GiB is reserved by the Docker VM, leaving ~16.7GB for macOS + 4 Node apps + next-dev compiler workers + turbo/tsx + browser; V8's default old-space cap on a large-memory host is ~4GB per process. macOS compresses/swaps rather than OOM-kills, so this manifests as host-wide slowdown (and Docker VM I/O starvation), not container kills. Live RSS unmeasurable now (apps down — ps shows only VS Code helpers); classic Leaking/Unbounded candidate.

**Verification:** With the full dev stack + apps running, `ps -o rss=,command= | grep -E 'tsx|next|node' | sort -rn` after 1h of use; if any process exceeds ~1.5GB RSS investigate before capping.
**Remediation:** Set NODE_OPTIONS=--max-old-space-size=1024 (2048 for web/next) in the dev-up apps step or per-app dev scripts, keeping host Node total ≤~6GB. **Risk:** A heap cap below a real working set crashes that app with heap-OOM — measure first.

---

#### AUD-INFRA-010 — Spark job memory hygiene verified MOSTLY SOUND: explicit 4g driver on all 35 run scripts + 7g container caps + bounded streaming batches; two minor inconsistencies
**SEV-LOW · EFFORT-S · MEASURED · Wave 3**

**Evidence:** All 35 run scripts pass --driver-memory ${SPARK_DRIVER_MEMORY:-4g} inside --memory ${SPARK_CONTAINER_MEMORY:-7g} docker run (grep across db/iceberg/spark: 35/35 hits; e.g. run-silver-orders.sh:36,62). Sink: maxOffsetsPerTrigger=5000 + startingOffsets bounded batches (bronze_landing.py:85,401-404), offHeap 512m (dev-bronze-streaming.sh:93 + bronze_landing.py:156-157), minBatchesToRetain=10 (dev-bronze-streaming.sh:102). AQE + shuffle.partitions=64 + 64MB advisory in iceberg_base.py:72-77,124-126. Two minor inconsistencies: (a) batch transform jobs never set SPARK_OFFHEAP_SIZE so offHeap is disabled for them (iceberg_base.py:93-94) — fine, but the 7g cap was sized assuming sink-style overhead → supports shrinking transform caps to 5.5g; (b) dev-bronze-streaming.sh:99 passes --executor-memory 4g which is a documented no-op under local[*] (its own comment L18-19) and misleads readers into double-counting 8g. Worst-case simultaneous Spark JVMs under the CURRENT scripts with one refresh loop = 2 (sink + 1 sequential transform) = 14GiB caps / ~9-10GiB realistic (peak HYPOTHESIS — stack down); unguarded extra invocations covered in AUD-INFRA-006.

**Remediation:** Drop the no-op --executor-memory flag from dev-bronze-streaming.sh and lower SPARK_CONTAINER_MEMORY defaults to 5.5g per the budget (driver 4g = 73% of cap). **Risk:** None for the flag removal; container-cap reduction gated on peak measurement.

---

### 4.2 AUD-PERF — application & data-plane performance (app-perf + data-perf + ts-hygiene perf)

| ID | Title | Sev | Effort | Tag | Wave |
|---|---|---|---|---|---|
| AUD-PERF-001 | Collector /batch bypasses ALL admission gates; query-string suffix bypasses them on /collect | HIGH | S | MEASURED | 1 |
| AUD-PERF-002 | Drainer throughput ceiling ~100 events/s per instance | HIGH | M | HYPOTHESIS | 3 |
| AUD-PERF-003 | ADR-0006 D4 raw-PII retention: unscheduled, blind to unified events table, DELETE stub | HIGH | M | HYPOTHESIS | 1 |
| AUD-PERF-004 | No Iceberg compaction/snapshot expiry EVER for Silver/Gold (1,726 files / 27 MB measured) | HIGH | M | MEASURED | 3 |
| AUD-PERF-005 | 13 Bronze-bridge consumer groups re-consume + JSON.parse the entire live topic (missing event_name header on pixel lane) | MED | S | HYPOTHESIS | 3 |
| AUD-PERF-006 | Drainer tick overlap + no row claim (no FOR UPDATE SKIP LOCKED) → duplicate produces (merged: app-perf + ts-hygiene) | MED | S | HYPOTHESIS | 3 |
| AUD-PERF-007 | /batch ACKs after up to 50 SERIAL single-row spool INSERTs (merged: app-perf + ts-hygiene) | MED | S | HYPOTHESIS | 3 |
| AUD-PERF-008 | Trino HTTP adapter silently returns TRUNCATED results; no fetch timeout; never cancels queries | MED | S | MEASURED | 2 |
| AUD-PERF-009 | Stream-worker per-message overhead: broker commitOffsets + unconditional Redis DEL + info log per event (merged: app-perf + ts-hygiene) | MED | M | HYPOTHESIS | 3 |
| AUD-PERF-010 | resolveBrandByInstallToken: one uncached PG round trip per pixel event | MED | S | HYPOTHESIS | 3 |
| AUD-PERF-011 | Webhook pipeline: per-webhook SecretsManager GetSecretValue + duplicate resolver query | MED | S | HYPOTHESIS | 3 |
| AUD-PERF-012 | Spool jsonb round-trip: 2 parses + 2 stringifies per event on the SLA path | MED | S | HYPOTHESIS | 3 |
| AUD-PERF-013 | Snapshot-expiry cutoff conflates 24-month DATA retention with snapshot TTL | MED | S | MEASURED | 3 |
| AUD-PERF-014 | bronze_landing per-batch MERGE joins whole events table on unprunable dedup_key | MED | M | HYPOTHESIS | 3 |
| AUD-PERF-015 | ~20 Silver jobs still FULL-scan + re-MERGE every run | MED | L | MEASURED | 4 |
| AUD-PERF-016 | gold_attribution_credit collects whole corpus + un-brand-filtered basis to driver | MED | L | HYPOTHESIS | 4 |
| AUD-PERF-017 | Neo4j identity graph missing indexes for hot lookups + export predicates | LOW | S | HYPOTHESIS | 3 |
| AUD-PERF-018 | Refresh freshness bounded by ~57 serial docker+JVM cold starts (>8.5 min measured) | MED | L | MEASURED | 4 |
| AUD-PERF-019 | gold_revenue_ledger full fold + overwritePartitions every cycle (deliberate; amplifier) | LOW | M | MEASURED | 5 |

---

#### AUD-PERF-001 — Collector /batch endpoint bypasses ALL admission gates (edge rate-limit, origin allowlist, body-shape, spool back-pressure); query-string suffix bypasses them on /collect too
**SEV-HIGH · EFFORT-S · MEASURED · Wave 1 · confirmed**

**Evidence:** apps/collector/src/interfaces/rest/edge-guard.ts:98 and apps/collector/src/interfaces/rest/spool-backpressure.ts:131 both contain `if (req.url !== '/collect' && req.url !== '/v1/events') return;`. apps/collector/src/interfaces/rest/collect.route.ts:123 registers `app.post('/batch', ...)` (MAX_BATCH=50 at line 167), routes are mounted at root (main.ts:187 registerCollectRoute, no prefix), and the /batch handler calls acceptUseCase.execute() per event with only an envelope-shape check — no rate limit, origin allowlist, or back-pressure. Empirically confirmed with the repo's Fastify version: in a preHandler, req.url for `POST /collect?x=1` is `'/collect?x=1'` while req.routeOptions.url is `'/collect'`, so strict equality on req.url skips both guards for any query-suffixed request. No fix exists on the current branch (git log on all three files ends at commit b90d78d8; none of the recent audit-remediation commits touch collector admission gating).

**Remediation:** Match on request.routeOptions.url (the route pattern, query-string-free) instead of raw req.url, and add '/batch' to the guarded set in both registerEdgeGuard and registerSpoolBackpressure. Count a /batch POST as N events against the rate-limit bucket. Add a regression test: tripped gate + POST /batch and POST '/collect?x=1' must 503/429.

**Risk:** Low — tightens admission only; legitimate pixel SDK traffic posts bare /collect. Verify the pixel SDK batch transport (if enabled) tolerates 429/503 + Retry-After (the SDK queue/backoff already handles failed sends).

**Verifier note:** All cited evidence confirmed verbatim and the bypass was empirically reproduced. Both preHandlers gate with strict raw-URL equality at edge-guard.ts:98 and spool-backpressure.ts:131. `/batch` (collect.route.ts:123, MAX_BATCH=50, spools each event in a loop = 50x amplification) is registered at root with no prefix and appears in neither guard's set; no other rate-limit/origin/back-pressure mechanism covers it. Reproduced with the repo's own Fastify that in a preHandler `req.url` for `POST /collect?x=1` is `'/collect?x=1'` (raw URL incl. query string) while `req.routeOptions.url` is `'/collect'` — so a query-string suffix skips both guards on /collect and /v1/events too. Not fixed on branch audit/stage-b-remediation. SEV-HIGH is justified: the collector is the unauthenticated public pixel ingest, and spool-backpressure.ts:4-14 itself documents that unbounded spool growth fills the PG volume and fails the durability anchor for ALL tenants at once — a tripped gate is trivially bypassed with 50x amplification. Not CRITICAL because it is an availability/resource-exhaustion risk requiring a sustained flood, with no tenant-isolation or data-integrity breach.

---

#### AUD-PERF-002 — Drainer throughput ceiling ~100 events/s per instance: serial per-event Kafka produce + per-event PG UPDATE inside a 1s-poll, 100-row batch
**SEV-HIGH · EFFORT-M · HYPOTHESIS · Wave 3 · confirmed**

**Evidence:** apps/collector/src/application/drain-events.usecase.ts:32-56 — serial `for (const entry of pending) { await this.kafka.produce(...); await this.spool.markDrained(entry.id); }`; apps/collector/src/infrastructure/kafka-producer.ts:95-105 — one producer.send per event, messages array of length 1, CompressionTypes.None; apps/collector/src/infrastructure/pg-spool.repository.ts:80-87 — single-row UPDATE per markDrained; packages/config/src/collector.ts:45,47 — DRAIN_POLL_INTERVAL_MS default 1000, DRAIN_BATCH_SIZE default 100; apps/collector/src/interfaces/jobs/drainer.ts — plain setInterval, one execute() per tick, no re-loop on full batch (also no reentrancy guard, and pollPending at pg-spool.repository.ts:51-58 has no FOR UPDATE SKIP LOCKED, so an overlapping >1s tick re-selects the same rows → duplicate produces, not extra throughput). Amplifiers: packages/config/src/collector.ts:22 — RATE_LIMIT_EVENTS_PER_MINUTE default 10000 (~167/s) means a single brand within its rate limit exceeds the ~100/s drain ceiling; apps/collector/src/interfaces/rest/spool-backpressure.ts + countPendingBounded (pg-spool.repository.ts:67-78) — pending gauge has no brand dimension, so hitting SPOOL_MAX_PENDING (default 100000, collector.ts:28) sheds ALL tenants with 503 SPOOL_FULL.

**Verification:** Run the existing harness `k6 run tools/load-test/ingest.js -e VUS=100` (>150 eps) against local dev and watch /readyz spool.pendingDepth (health.route.ts:34) — if it climbs monotonically while Kafka is healthy, the ceiling is confirmed. Then measure a single tick duration from drainer logs.

**Remediation:** Produce the whole polled batch in ONE producer.send({messages: [...]}) (kafkajs batches natively; add compression), then mark drained with one `UPDATE collector_spool SET status='drained' WHERE id = ANY($1)` for the successfully-produced ids. Optionally loop immediately (no sleep) while a full batch was drained.

**Risk:** Medium — batch send changes failure granularity (a batch-level produce error must leave the WHOLE batch pending, which the existing back-pressure semantics already tolerate); keep event_id-keyed downstream dedup as the safety net. Preserve D-1 ordering (drain stays off the request path).

**Verifier note:** Every cited line verified verbatim. The drainer is a plain setInterval with one execute() per tick and no immediate re-loop on a full batch, so the ~batch/tick ≈ 100 events/s ceiling is structurally correct. Not fixed on this branch. Severity is strengthened, not weakened, by two additional facts: (1) the default per-brand rate limit RATE_LIMIT_EVENTS_PER_MINUTE=10000 (~167/s) lets ONE tenant within its allowed rate outpace the drainer; (2) the back-pressure gauge counts pending rows with no brand dimension, so the resulting 503 SPOOL_FULL shed is global across all tenants — a cross-tenant availability blast radius, justifying SEV-HIGH (not CRITICAL: no event loss while spooled, 100k high-water headroom, batch size env-tunable). Remediation is valid (kafkajs natively batches a messages[] array; UPDATE ... WHERE id = ANY($1)).

---

#### AUD-PERF-003 — ADR-0006 D4 raw-PII short-retention job is unscheduled, does not cover the unified brain_bronze.events table, and its row-level TTL DELETE is unimplemented
**SEV-HIGH · EFFORT-M · HYPOTHESIS · Wave 1 · confirmed**

**Evidence:** db/iceberg/spark/bronze_raw_retention.py:35-46 RAW_TABLES lists only collector_events_raw + the nine legacy *_raw tables — NOT the unified brain_bronze.events that bronze_landing.py:69-79 (RAW_LANE_SUFFIXES) now lands all nine raw connector lanes into. bronze_raw_retention.py:78 `_ = older_than` — the row-level TTL DELETE is an unimplemented stub (no DELETE anywhere in the file; RAW_ROW_TTL env is mentioned only in that comment, never read). No scheduler invokes the job: db/iceberg/spark/ has no run-bronze-raw-retention.sh; infra/helm/cronworkflows/templates/spark-bronze.yaml defines only bronze-landing + bronze-maintenance CronWorkflows; zero hits in tools/, .github/, package.json. The gap is repo-acknowledged as open: docs/architecture/phase0-ingestion-refined.md:57-58 ("BUILT (no cron)"; "PARTIAL (stub)") + R7 (line 157), and db/iceberg/spark/teardown/unify-bronze-decommission.md:54 (G1: retention/erasure jobs still target legacy *_raw tables). AGGRAVATING: the only scheduled job that touches brain_bronze.events, bronze_maintenance.py, applies a 24-MONTH snapshot TTL (RETAIN_MS default 63_072_000_000 ms) — so raw un-hashed PII and razorpay PCI payloads landing in events persist ~2 years, versus the 7-day D4 window (RAW_RETENTION_HOURS=168) mandated by docs/runbooks/adr-0006-cutover-and-prod.md:15,38 which calls this job the prod-flip gate.

**Verification:** After a connector sync lands raw lanes (current local events table holds only connector='collector' rows — Trino probe of non-collector payloads for email/card/phone/contact returned 0), re-run: SELECT count(*) FROM iceberg.brain_bronze.events WHERE connector<>'collector' AND (payload LIKE '%"email"%' OR payload LIKE '%card%'). If >0, un-hashed PII persists with NO retention.

**Remediation:** Add 'events' (with a per-connector row DELETE WHERE connector<>'collector' AND written_at < now()-RAW_RETENTION_HOURS) to bronze_raw_retention.py, actually implement the row-TTL DELETE, and schedule it (Argo CronWorkflow next to bronze-maintenance + optionally the dev refresh loop).

**Risk:** Row deletion from Bronze conflicts with 'Bronze is source of truth / no event loss' — must only apply to raw connector lanes whose Silver normalization has already admitted the rows (per ADR-0006 the gated Silver is the durable layer); coordinate with the Phase-8 legacy decommission bake.

**Verifier note:** All three claims verified against the repo: (1) RAW_TABLES covers only the 10 legacy *_raw tables while bronze_landing.py lands all nine raw connector lanes into the unified brain_bronze.events; (2) line 78 is the exact stub `_ = older_than` and no DELETE exists in the file (RAW_ROW_TTL is never read); (3) no cron/run-script/loop invokes it. Not fixed by any recent commit; the repo itself tracks it as open (unify-bronze-decommission.md G1, phase0-ingestion-refined.md rows 57-58 + R7). Aggravating fact missed by the finding: the only scheduled maintenance covering `events` (bronze_maintenance.py) uses a 24-MONTH snapshot TTL, so raw un-hashed PII / razorpay PCI payloads persist ~2 years. SEV-HIGH stands (not CRITICAL: prod is not live — helm values are REPLACE_WITH_ECR_REGISTRY placeholders — and the runbook gates the prod flip on this job).

---

#### AUD-PERF-004 — No Iceberg compaction or snapshot expiry EVER runs for Silver/Gold (and nothing at all runs locally) — measured 1,726 files for 27 MB in silver_collector_event
**SEV-HIGH · EFFORT-M · MEASURED · Wave 3 · confirmed** · *(prod scheduling half = AUD-COST-013)*

**Evidence:** db/iceberg/spark/medallion_maintenance.py (Silver+Gold rewrite_data_files + expire_snapshots, MAINT_NAMESPACES default silver,gold) and run-medallion-maintenance.sh exist but are referenced ONLY by the Spark Dockerfile and docs/architecture/phase0-ingestion-refined.md — no CronWorkflow (infra/helm/cronworkflows/templates/spark-v4.yaml has no maintenance job; only bronze-maintenance in spark-bronze.yaml lines ~97-143 runs bronze_maintenance.py) and no invocation in tools/dev/v4-refresh-loop.sh. MEASURED live 2026-07-02 via Trino: iceberg.brain_silver."silver_collector_event$files" = 1,726 files / 27,643,562 bytes / 69,499 rows (avg ~16 KB/file); silver_touchpoint = 39 files; brain_bronze."events$files" = 365 files / 27,388,361 bytes; events$snapshots = 513. Minor correction: EVENTS_BRAND_BUCKETS default 256 is bronze_landing.py:85 (not :86).

**Remediation:** Add a medallion-maintenance CronWorkflow (mirror of bronze-maintenance) invoking medallion_maintenance.py daily, and invoke run-medallion-maintenance.sh from v4-refresh-loop.sh every Nth cycle locally. Also consider lowering EVENTS_BRAND_BUCKETS / the marts' bucket(256, brand_id) in dev (env-overridable) since 256 brand buckets shard tiny data into permanently-small files compaction cannot merge across partitions.

**Risk:** rewrite_data_files/expire_snapshots contend with concurrent MERGEs on the SQLite-backed REST catalog (known lock issue, pinned CATALOG_CLIENTS=1) — schedule maintenance in a quiet window or after a refresh cycle; expire_snapshots is irreversible (time-travel window shrinks).

**Verifier note:** Every cited fact verified. medallion_maintenance.py + run-medallion-maintenance.sh exist and cover Silver+Gold via MAINT_NAMESPACES with table auto-discovery, but a repo-wide grep confirms zero invocations: no helm CronWorkflow, no reference in tools/dev/v4-refresh-loop.sh, no TS/job caller — only the Dockerfile COPY and a docs mention. Not fixed by any recent commit. Live re-measurement via Trino reproduces and slightly exceeds the audit numbers (avg ~16 KB/file vs 128 MB target). SEV-HIGH stands: Iceberg is system-of-record, Trino-over-Iceberg is the sole serving engine (with prior OOM outage history), and file/snapshot counts grow unboundedly in both dev and prod with no compaction or expiry ever scheduled for Silver/Gold.

---

#### AUD-PERF-005 — 13 Bronze-bridge consumer groups each re-consume and JSON.parse the ENTIRE live topic because the pixel-lane producer never sets an event_name header
**SEV-MED · EFFORT-S · HYPOTHESIS · Wave 3 · confirmed (downgraded from the original claim)**

**Evidence:** apps/stream-worker/src/interfaces/consumers/bronzeBridges.ts:33-120 (13 registry entries, one consumer group each, all on the shared live topic COLLECTOR_TOPIC wired in apps/stream-worker/src/main.ts:149,264); apps/stream-worker/src/interfaces/consumers/EventBronzeBridgeConsumer.ts:74-90 (header peek falls back to full-body JSON.parse when 'event_name' header absent; per-message commitOffsets even for skipped messages); apps/collector/src/infrastructure/kafka-producer.ts:89-93 + apps/collector/src/main.ts:104 (collector drainer sets only correlation_id + source — NO event_name — on the same topic, so every pixel-lane message triggers the JSON.parse fallback in all 13 groups). NOTE: connector-lane producers DO set the event_name header (WebhookPipeline.ts:388-392, shopifyWebhookHandler.ts:261-266, razorpayWebhookHandler.ts:388-392, CaptureRtoPredictCommand.ts:123-127), so the redundant-parse cost is confined to pixel-lane traffic; the proposed remediation (stamp event_name in CollectorKafkaProducer.produce) is correct and additive.

**Verification:** Produce 10k pixel events via the k6 harness (tools/) and measure stream-worker CPU + Kafka OffsetCommit request rate with 13 bridges enabled vs disabled; add a temporary counter around EventBronzeBridgeConsumer.ts:80 to confirm ~13 full-body parses per pixel event.

**Remediation:** Stamp `event_name: rawBody['event_name']` into the Kafka headers in CollectorKafkaProducer.produce (and the connector-lane producers). The bridges already prefer the header (line 76-77), so this is additive and immediately removes 13 redundant full-body JSON.parse calls per event. Longer term: collapse the 13 groups into ONE dispatcher consumer keyed on event_name (the registry already centralizes the mapping).

**Risk:** Header addition is additive/backward-compatible (fallback path remains). Group consolidation changes offset ownership — requires a drain-and-cutover of the 13 group ids.

**Verifier note:** The mechanism is real but the finding overstates it. Confirmed: 13 bridge consumer groups each consume the entire shared live topic; the consumer falls back to full-body JSON.parse when the event_name header is absent and issues a per-message commitOffsets even for skipped messages; the collector drainer indeed never sets event_name. REFUTED portion: the claim that the header is "NEVER set so the fallback fires for every message in every group" is false — all connector-lane producers on the same topic DO stamp event_name, and those are exactly the events the bridges land. The residual real issue: pixel-lane (collector drainer) messages — the highest-volume lane — lack the header, so every pixel event is JSON.parsed 13 times just to be skipped, plus 13 per-message sync commits. Severity downgraded: pure CPU/throughput efficiency, no correctness/data-loss/tenant impact, and the 13x broker-read fan-out is inherent to the group design regardless of headers.

---

#### AUD-PERF-006 — Drainer ticks can overlap (setInterval with no in-flight guard) and pollPending has no row claim (no FOR UPDATE SKIP LOCKED) — overlapping ticks or any second collector replica double-produces the same spool rows
**SEV-MED · EFFORT-S · HYPOTHESIS · Wave 3** · *(merged: app-perf + ts-hygiene duplicates — both evidence trails below)*

**Evidence (app-perf):** apps/collector/src/interfaces/jobs/drainer.ts:48-50 `this.timer = setInterval(() => { void this.tick(); }, pollIntervalMs)` — tick is async and unguarded, so a tick slower than 1s (realistic per AUD-PERF-002) runs concurrently with the next. apps/collector/src/infrastructure/pg-spool.repository.ts:51-65 pollPending is a plain `SELECT ... WHERE status='pending' ORDER BY id LIMIT $1` — no lock, no claim: two concurrent pollers read the SAME rows and each produces them to Kafka before markDrained lands. Also blocks horizontal scale-out of the collector (a stated prod concern given it is the single ingest edge).

**Evidence (ts-hygiene):** drainer.ts:48-50 (`setInterval(() => { void this.tick(); })` — `running` only gates stop, not concurrent ticks); pg-spool.repository.ts:51-65 (pollPending = plain SELECT ... LIMIT, no row lock/claim); drain-events.usecase.ts:32-56 (sequential per-row produce + markDrained = 2 awaited round trips per event, ~100 events/tick ceiling — see AUD-PERF-002); kafka-producer.ts:95-105 (one producer.send per message, no batching).

**Verification:** Start two collector processes against one spool DB (or set DRAIN_POLL_INTERVAL_MS=50 with a slow Kafka), run the k6 ingest script, and count duplicate (brand_id,event_id) messages on the collector topic vs spool rows. Alternative: inject a 3s artificial delay into kafka.produce locally and observe two concurrent ticks selecting the same pending rows (duplicate produce visible as bronze dedup_hit/pk_conflict counters).

**Remediation:** Guard tick with an `inFlight` boolean (skip if previous tick still running), and claim rows atomically: `UPDATE collector_spool SET status='draining' WHERE id IN (SELECT id FROM collector_spool WHERE status='pending' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id, raw_body`, with a stale-'draining' requeue on startup. Downstream event_id dedup already absorbs the duplicates today, so this is safe to ship independently (and ship the batch produce with AUD-PERF-002).

**Risk:** Low — duplicates are already absorbed downstream, so the change only reduces waste; the requeue-on-crash path for 'draining' rows needs a test to keep the no-event-loss invariant.

---

#### AUD-PERF-007 — Collector /batch ACKs after up to 50 SERIAL single-row spool INSERTs (50 sequential PG round-trips per request)
**SEV-MED · EFFORT-S · HYPOTHESIS · Wave 3** · *(merged: app-perf + ts-hygiene duplicates — both evidence trails below)*

**Evidence (app-perf):** apps/collector/src/interfaces/rest/collect.route.ts:148-154 — `for (const ev of events) { const result = await acceptUseCase.execute(rawEvent); ... }` with MAX_BATCH=50 (line 165); each execute is one INSERT round-trip (pg-spool.repository.ts:39-44). ACK latency scales linearly with batch size and each in-flight /batch holds a pool connection (pool max=10, pg-spool.repository.ts:27) for the whole loop — 10 concurrent 50-event batches saturate the pool and stall /collect ACKs (the strict-SLA durability anchor).

**Evidence (ts-hygiene):** collect.route.ts:146-154 (for..of with `await acceptUseCase.execute(rawEvent)` per event → one INSERT round trip each, 50 max per collect.route.ts:165) — batch ACK latency = 50 × spool-insert RTT on the strict-SLA accept path.

**Verification:** k6 ingest.js with -e BATCH_RATIO=1 -e BATCH_SIZE=50: compare /batch p95 vs /collect p95, and watch /collect p95 degrade as batch VUs rise (pool starvation). Compare against a single multi-row `INSERT ... SELECT jsonb_array_elements($1) RETURNING id`.

**Remediation:** Add SpoolRepository.insertMany(envelopes) doing ONE multi-row `INSERT ... VALUES ($1),($2)... RETURNING id` (single commit still satisfies D-1: durable before ACK); keep per-event independence semantics by never validating in the route (drainer quarantines malformed events downstream, exactly as today).

**Risk:** Low — single-statement multi-row INSERT is atomic; the 400-on-invalid-envelope shape check stays before the insert. One failed batch INSERT now fails the whole batch atomically instead of partially spooling (arguably cleaner for the 500-retry client contract, but verify pixel SDK retry behavior). Update durability tests that assert per-event spool ids.

---

#### AUD-PERF-008 — Trino HTTP adapter silently returns TRUNCATED results when maxPolls is exhausted, has no fetch timeout, and never cancels abandoned queries
**SEV-MED · EFFORT-S · MEASURED · Wave 2**

**Evidence:** packages/metric-engine/src/trino-adapter.ts:207-240 — the poll loop exits when `polls >= maxPolls` with resp.nextUri still set; unless resp.error happens to be populated, the accumulated partial `allData` is returned to the caller as a complete result set (no throw, no warning). Additionally no AbortController/timeout on doFetch (a hung coordinator pins the BFF request forever, trino-adapter.ts:185/209) and no `DELETE nextUri` cancellation, so an abandoned query keeps running on the coordinator (the same Trino whose OOM history required the 7g bound). This violates the 'revenue truth' doctrine: a truncated ledger read renders as a plausible—but wrong—dashboard number and can be CACHED by the Redis serving layer for its full TTL.

**Remediation:** After the loop: `if (resp.nextUri) { fire-and-forget DELETE resp.nextUri; throw new Error('query exceeded poll budget') }`. Add AbortSignal.timeout(~30s) to each fetch, and DELETE nextUri on any throw path so coordinator slots are released.

**Risk:** Low — converts a silent-wrong-data path into a loud 500/degraded state (consistent with fail-safe doctrine). Slow-but-legitimate queries that today 'succeeded' partially will now error; confirm maxPolls×server-long-poll budget (~10 min) is generous enough that only genuinely stuck queries hit it.

---

#### AUD-PERF-009 — Stream-worker live pixel lane pays per-message overhead: broker commitOffsets per message + unconditional Redis DEL + info-level log on every event (all 9 eachMessage consumers / 13 bridges)
**SEV-MED · EFFORT-M · HYPOTHESIS · Wave 3** · *(merged: app-perf "3 network round-trips per message" + ts-hygiene "per-message commitOffsets + Redis DEL + info log" — both evidence trails below; the uncached brand resolve leg is tracked separately as AUD-PERF-010)*

**Evidence (app-perf):** apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts:135-138 — `commitOffsets` (a synchronous broker request) + `retryCounter.reset` called for EVERY message under autoCommit:false; same pattern in EventBronzeBridgeConsumer.ts:58-62 and the other 7 eachMessage consumers. apps/stream-worker/src/infrastructure/pg/BronzeRepository.ts:68-90 — resolveBrandByInstallToken runs `SELECT brand_id FROM resolve_brand_by_install_token($1)` per pixel event with no cache, although install_token→brand_id is a stable mapping. No partitionsConsumedConcurrently/eachBatch tuning anywhere (grep across src/interfaces/consumers: only eachMessage).

**Evidence (ts-hygiene):** CollectorEventConsumer.ts:135-139 (commitOffsets + retryCounter.reset + msgLog.info per message on the success path); apps/stream-worker/src/infrastructure/redis/RetryCounterAdapter.ts:73-75 (reset = unconditional Redis DEL, issued even when no failure ever incremented the counter); same triple in EventBronzeBridgeConsumer.ts:113-115 for all 13 bridge groups.

**Verification:** Run k6 ingest at 200+ eps and measure consumer lag on the collector topic (kafka-ui) plus PG statement rate; MONITOR Redis DEL ops/sec and Kafka OffsetCommit rate; compare consumer lag/throughput with (a) reset gated on an in-memory 'sawFailure' flag per (partition,offset) and (b) offset commits batched every N messages / T ms. If lag grows while stream-worker CPU is idle, round-trip overhead is the bottleneck.

**Remediation:** (1) Track failed offsets in a small in-memory Set (populated only in the catch path) and call retryCounter.reset only for offsets present in it — the durable counter only exists after a failure, so this preserves T2-8 exactly. (2) Move to eachBatch with resolveOffset()+commitOffsetsIfNecessary, committing once per batch AFTER all writes confirm — D-7 (commit-only-after-write) is preserved at batch granularity. (3) Demote the per-event success log to debug (it already exists at debug in the collector accept path).

**Risk:** Medium — batch-granularity commits mean a mid-batch crash redelivers already-processed messages of that batch; the existing event_id dedup (Redis NX + PK backstop) makes this safe, but the D-7 invariant tests must be extended. Offset-commit batching widens the at-least-once replay window on crash — safe here because Bronze dedup (PK/dedup_key) is the durable dedup, but must keep commit-after-write ordering per partition.

---

#### AUD-PERF-010 — resolveBrandByInstallToken issues one uncached Postgres round trip per pixel event on the hot lane
**SEV-MED · EFFORT-S · HYPOTHESIS · Wave 3**

**Evidence:** apps/stream-worker/src/application/ProcessEventUseCase.ts:185-186 (await this.bronze.resolveBrandByInstallToken per event, before any dedup); apps/stream-worker/src/infrastructure/pg/BronzeRepository.ts:68-90 (pool.connect + SELECT resolve_brand_by_install_token per call, no caching); install_token→brand_id changes only on pixel reinstall.

**Verification:** pg_stat_statements: confirm resolve_brand_by_install_token call count ≈ pixel event count under load; bench eachMessage latency with and without a 60s in-process LRU in front of the query.

**Remediation:** Add a small TTL-bounded (≤60s) in-process Map cache keyed by install_token in BronzeRepository. Cache positive results only (or negatives for ≤5s) so a newly-installed pixel is not quarantined for a minute.

**Risk:** A revoked/rotated install token keeps admitting events for up to the TTL — bound TTL ≤60s and document; tenant derivation itself is unchanged (same SECURITY DEFINER fn is the source).

---

#### AUD-PERF-011 — Webhook pipeline: per-webhook AWS SecretsManager GetSecretValue (no cache) plus a DUPLICATE connector-resolver PG query per request
**SEV-MED · EFFORT-S · HYPOTHESIS · Wave 3**

**Evidence:** apps/core/src/modules/connector/webhooks/platform/WebhookPipeline.ts:210-219 — signatureVerify's getSecret closure runs `SELECT ... FROM resolverFn($1)` then `secretsManager.getSecret(row.secret_ref)`; WebhookPipeline.ts:245-251 then re-runs the IDENTICAL resolverFn query for the same lookupKey (Step 3). packages/connector-secrets/src/AwsSecretsManager.ts:47-68 has no caching layer (grep 'cache|ttl' = 0 hits), so in production every Shopify/Razorpay/Shiprocket webhook burst is 1:1 GetSecretValue API calls — added p95 latency (~10-50ms) and AWS per-secret throttling risk during order spikes (exactly when webhooks burst).

**Verification:** In prod-local (LocalStack) fire 100 concurrent webhooks at one provider route and count GetSecretValue calls in LocalStack logs vs requests; time p95 with/without a memoized secret.

**Remediation:** Reuse the connector row fetched inside signatureVerify for Step 3 (thread it through the verify result instead of re-querying), and wrap secretsManager.getSecret in a short-TTL (30-60s) in-memory cache keyed by secret_ref, invalidated on connector reconnect (which rotates secret_ref anyway per the bootstrap re-point design).

**Risk:** Low — secret_ref changes on rotation/reconnect so a TTL cache is naturally coherent; keep the fail-closed behavior (cache only successful fetches, never negative-cache).

---

#### AUD-PERF-012 — Spool jsonb round-trip: every event is stringified → jsonb-parsed by PG → parsed by the pg driver → re-stringified for Kafka
**SEV-MED · EFFORT-S · HYPOTHESIS · Wave 3**

**Evidence:** apps/collector/src/infrastructure/pg-spool.repository.ts:39-44 (INSERT $1::jsonb with JSON.stringify(payload)); pg-spool.repository.ts:52-64 (pollPending returns raw_body as a driver-parsed object); apps/collector/src/infrastructure/kafka-producer.ts:101 (JSON.stringify(rawBody) again) — 2 full parses + 2 full stringifies per event on the collector→Kafka SLA path.

**Verification:** Bench pollPending+produce for 10k spooled events selecting `raw_body::text` (string passthrough, brand/correlation extracted via `raw_body->>'correlation_id'` in SQL) vs the current object round-trip; measure drainer CPU + events/sec.

**Remediation:** SELECT `raw_body::text` in pollPending and pass the string straight through to producer.send; extract the two fields the drainer needs (correlation_id, brand_id) as SQL projections in the same query. No schema change (column stays jsonb).

**Risk:** Low — byte-for-byte payload semantics preserved (jsonb normalizes key order/whitespace at INSERT already, so downstream consumers see the same canonical form).

---

#### AUD-PERF-013 — Snapshot-expiry cutoff conflates the 24-month DATA retention with snapshot TTL — superseded files and snapshot metadata are retained for 2 years even where maintenance runs
**SEV-MED · EFFORT-S · MEASURED · Wave 3**

**Evidence:** db/iceberg/spark/bronze_maintenance.py:42 and medallion_maintenance.py:46 both set RETAIN_MS = 63_072_000_000 (24 months) as the expire_snapshots older_than cutoff, with comments calling it the 'retention contract'/'rolling retention guarantee'. Expiring snapshots never deletes rows from current table state — so this delivers NO data retention — while every snapshot younger than 24 months (a streaming sink commits one per micro-batch: 513 already on brain_bronze.events; gold_revenue_ledger full overwritePartitions per cycle, gold_revenue_ledger.py:362-372) and every file it references is kept for 2 years: unbounded metadata growth + storage = mart_size × refresh cycles.

**Remediation:** Split the two concerns: expire snapshots after days (e.g. RETENTION_MS default 3-7 days, keeping bounded time-travel) and implement the 24-month DATA retention, where contractually required, as a partition/row DELETE job.

**Risk:** Shorter snapshot window removes >7-day time-travel — verify no runbook/consumer (parity oracles, erasure verification) relies on longer time-travel before changing the default.

---

#### AUD-PERF-014 — bronze_landing per-batch MERGE joins the whole events table on an unprunable dedup_key — per-micro-batch cost grows O(table size) on the strict-SLA path
**SEV-MED · EFFORT-M · HYPOTHESIS · Wave 3**

**Evidence:** db/iceberg/spark/bronze_landing.py:376-389 — MERGE INTO events t ON t.dedup_key = s.dedup_key runs every trigger (15 s continuous / each drain chunk). dedup_key values ('evt:{brand}:{uuid}' / 'raw:{topic}:{p}:{o}') share only two prefixes, so file-level min/max stats on dedup_key barely prune and the ON clause carries no partition column (spec is identity(connector), bucket(256,brand_id), days(kafka_timestamp) — bronze_landing.py:228); the copy-on-write MERGE must scan the target's dedup_key across all live files each batch. The restart-replay behavior (AUD-INFRA-004) multiplies this: 289 such MERGEs per restart.

**Verification:** Track micro-batch durations / 'scan files' metrics in the Spark UI (or streaming progress JSON) as brain_bronze.events grows from 70 k → 10 M rows; confirm batch time scales with table size rather than batch size.

**Remediation:** Add tenant/partition alignment to the ON clause where safe (e.g. AND t.connector = s.connector AND t.brand_id <=> s.brand_id — both key-spaces embed them), and/or schedule rewrite_data_files with sort-order on dedup_key so min/max pruning becomes effective; evaluate write.merge.mode=merge-on-read for the sink table.

**Risk:** The ON-clause change must preserve dedup semantics for rows with NULL brand_id (malformed collector rows) — needs null-safe equality and a replay test (bronze_landing_test.py) before rollout; merge-on-read shifts cost to readers until compaction runs.

---

#### AUD-PERF-015 — ~20 Silver jobs still FULL-scan their Bronze/Silver source and re-MERGE every run (no watermark, no entity-incremental)
**SEV-MED · EFFORT-L · MEASURED · Wave 4**

**Evidence:** grep for entity_incremental/run_entity_incremental/target_table= across db/iceberg/spark/silver/*.py leaves these with NO incremental marker: silver_{ad_spend,ga4,razorpay,shiprocket,shopflo,shopify_order,woocommerce}_normalize (each re-reads its whole Bronze lane per run — e.g. silver_shopify_order_normalize.py has no watermark logic), plus entity-fold jobs silver_shipment, silver_shipment_event, silver_return, silver_coupon, silver_checkout_signal, silver_product, silver_product_variant, silver_inventory_level, silver_marketing_spend, silver_customer, silver_customer_identity, silver_identity_alias/map. _silver_base.py:289-291 documents the grain-safety rule that these fold jobs 'must stay full-refresh … until they adopt an ENTITY-incremental pattern' — that adoption has landed only for order_state/touchpoint/sessions/journey and the run_job(target_table=…) per-event jobs.

**Remediation:** Extend the existing entity-incremental driver (iceberg_base.run_entity_incremental / _silver_base entity_incremental cfg) to the fold-grain jobs above (entity keys already exist: shipment_id, return_id, coupon_code, product_id, …), and add the per-event watermark (target_table=) to the seven *_normalize jobs once their 10-col→widened schema follow-up lands (AUD-ARCH-008).

**Risk:** Grain safety — a wrong entity key regresses aggregates (documented rule); each conversion needs the FULL_REFRESH=1 one-time backfill gotcha applied (entity-incremental watermark misses history below the watermark, per the merged #341-era fix).

---

#### AUD-PERF-016 — gold_attribution_credit collects the whole touchpoint corpus and the ENTIRE (un-brand-filtered) recognized-order basis to the driver
**SEV-MED · EFFORT-L · HYPOTHESIS · Wave 4**

**Evidence:** db/iceberg/spark/gold/gold_attribution_credit.py:273-282 — tp.select(…).orderBy(…).collect() and basis_rows = basis_df.collect(); the partition-incremental filter is applied only to tp (line 260-262 gold_partition_filter), while _read_recognized_basis (line ~156-172) reads ALL brands' recognized orders every run; Markov weights + apportionment then run single-threaded in driver Python. Same pattern (smaller) in silver_customer_identity.py:177 (deduped.collect() of every customer, as a Neo4j-connector re-evaluation workaround).

**Verification:** Measure driver RSS and job duration with a production-scale corpus (millions of silver_touchpoint rows / 100k+ recognized orders): spark-submit the job against a synthetic large brand and watch driver heap vs the 7g container cap.

**Remediation:** Brand-filter the basis with the same gold_partition_filter commit; move the per-journey apportionment to a groupBy(brand, anon).applyInPandas / mapGroups so credit math runs distributed (the pure-python _attribution_math module is already worker-shippable via addPyFile).

**Risk:** The apportionment is golden-locked to the TS writer (largest-remainder exactness) — a distributed rewrite needs the existing parity tests re-run to prove byte-identical credit rows; unchanged-brand skip semantics (continue-on-no-touches) must be preserved so MERGE never clobbers prior credit.

---

#### AUD-PERF-017 — Neo4j identity graph lacks the indexes its hot lookups and the incremental export predicates use — every 5-min identity-export scans all IDENTIFIES edges
**SEV-LOW · EFFORT-S · HYPOTHESIS · Wave 3**

**Evidence:** apps/stream-worker/src/infrastructure/neo4j/Neo4jIdentityRepository.ts:103-112 creates ONLY four uniqueness constraints (Identifier, Customer, MergeEvent.merge_id, SharedUtility). But: identity-export's incremental query filters on relationship properties r.created_at / r.is_active and c.lifecycle_state (apps/stream-worker/src/jobs/identity-export/run.ts:264-271) — no relationship-property index exists, so each 300 s cycle is O(all IDENTIFIES edges); core reader label-scans MergeEvent by brand+canonical/merged_brain_id (neo4j-identity-reader.ts:123-125) and MergeReview {brand_id, status:'pending'} (line 250) with no index on either label's properties.

**Verification:** PROFILE the incremental export Cypher and the MergeEvent/MergeReview reads on a graph with >100 k edges; confirm NodeByLabelScan/RelationshipTypeScan instead of index seeks.

**Remediation:** Add to the ensureSchema block: CREATE INDEX FOR ()-[r:IDENTIFIES]-() ON (r.created_at); CREATE INDEX FOR ()-[r:IDENTIFIES]-() ON (r.is_active); CREATE INDEX FOR (m:MergeEvent) ON (m.brand_id, m.canonical_brain_id); CREATE INDEX FOR (m:MergeEvent) ON (m.brand_id, m.merged_brain_id); CREATE INDEX FOR (mr:MergeReview) ON (mr.brand_id, mr.status); CREATE INDEX FOR (c:Customer) ON (c.lifecycle_state).

**Risk:** Index builds on a large live graph consume memory on the small-heap dev Neo4j (the same heap pressure that already hangs the Spark connector) — create them off-peak; otherwise additive and safe.

---

#### AUD-PERF-018 — Refresh-cycle freshness is bounded by ~57 serial docker+JVM cold starts, not by the 300 s interval — measured cycle already >8.5 min while still mid-Silver
**SEV-MED · EFFORT-L · MEASURED · Wave 4**

**Evidence:** tools/dev/v4-refresh-loop.sh runs every run-*.sh sequentially (SILVER_REST glob line 112-136 + GOLD_BI ~30 scripts), each a fresh `docker run` + spark-submit JVM. MEASURED live (2026-07-02): cycle started 09:18 (identity-export log mtime), /tmp/v4-refresh-silver.log still being written at 09:26:35 with only 23/36 silver jobs DONE; 19 structured job lines sum 208,180 ms of in-session time alone for tables of 0–67 k rows (per-job overhead dominates: e.g. silver-search 6.2 s for 22 rows). Prod mirrors this shape: spark-v4.yaml:96-100 loops ~38 serial spark-submits per hourly v4-silver pod.

**Remediation:** Add a multi-mart runner that executes N build(spark) functions inside ONE SparkSession per tier (the jobs already share iceberg_base.build_spark and a uniform (fqtn, rows) contract), or at minimum group the per-event Silver jobs into one submit; keep per-job structured jlog lines.

**Risk:** One shared session couples job failures (a fatal in job k must not skip k+1 — needs per-build try/except preserving fail-loud semantics) and shared spark.conf mutations (silver_collector_event sets session confs at build time) must be namespaced.

---

#### AUD-PERF-019 — gold_revenue_ledger performs a complete full fold + overwritePartitions of the whole mart every cycle (deliberate, but amplifies AUD-PERF-004/013)
**SEV-LOW · EFFORT-M · MEASURED · Wave 5 (parked behind AUD-PERF-004/013)**

**Evidence:** db/iceberg/spark/gold/gold_revenue_ledger.py:362-372 — 'This job is a COMPLETE full fold of ALL … overwritePartitions() atomically REPLACES every brand-bucket partition' each run (300 s locally, hourly prod). Every cycle rewrites all 19,820 rows / 1.1 MB (30 snapshots already on a fresh stack), so with no snapshot expiry storage grows mart_size × cycles even with zero data change; the full fold also rescans the entire Bronze order corpus each run.

**Remediation:** Parked until AUD-PERF-004/013 land (expiry bounds the cost); longer term move the ledger to the proven entity-incremental fold (silver_order_state pattern) — the overwrite-vs-MERGE choice was made to fix a real drift/orphan bug (documented in-file), so any change must re-prove the exact 3-way reconcile.

**Risk:** The overwrite semantics currently guarantee orphan-free exact reconciliation (₹1,746,754,034 3-way match per merged fix); an incremental MERGE reintroduces the orphan class it was built to kill — requires the reconcile oracle in CI before touching.

---

### 4.3 AUD-CODE — code cleanup & TypeScript hygiene (code-cleanup + ts-hygiene code)

| ID | Title | Sev | Effort | Tag | Wave |
|---|---|---|---|---|---|
| AUD-CODE-002 | Bronze e2e coverage silently dead — 8 suites self-skip on removed StarRocks seam | HIGH | M | MEASURED | 3 |
| AUD-CODE-003 | Pending-window compliance flush handler written + documented load-bearing but never wired | MED | M | MEASURED | 4 |
| AUD-CODE-004 | Dead StarRocks-era dev script seed-silver-dev.mjs | MED | S | MEASURED | 2 |
| AUD-CODE-005 | Unmounted legacy per-provider webhook receivers (duplicate HMAC path) | MED | S | MEASURED | 2 |
| AUD-CODE-006 | Superseded bespoke HMAC value-objects ×4 | LOW | S | MEASURED | 2 |
| AUD-CODE-007 | ConnectRazorpayCommand — confident dead file | LOW | S | MEASURED | 2 |
| AUD-CODE-008 | IA-redesign orphan cluster in apps/web (15 files + hooks + dep) | MED | S | MEASURED | 2 |
| AUD-CODE-009 | Dead deps: mysql2 (core), pg + @types/pg (attribution-writer), @types/argon2 | LOW | S | MEASURED | 2 |
| AUD-CODE-010 | 4 dormant StarRocks live-test files in metric-engine keep mysql2 alive | LOW | S | MEASURED | 2 |
| AUD-CODE-011 | Dead module barrels — module-boundary pattern fictional, ~200 knip noise lines | LOW | M | MEASURED | 4 |
| AUD-CODE-012 | stream-worker identity explainability leftovers (zero importers) | LOW | S | HYPOTHESIS | 5 |
| AUD-CODE-013 | knip.json stale globs — false positives + dead ignores | LOW | S | MEASURED | 2 |
| AUD-CODE-014 | Workspace dep version drift (fastify v4/v5 split, pg/zod/@types/node) | LOW | M | MEASURED | 4 |
| AUD-CODE-015 | Legacy Bronze sinks: cutover-gated, NOT deletable (status/tracking) | LOW | S | MEASURED | 5 |
| AUD-CODE-016 | Cosmetic leftovers: redpandaTopic field, generated d.ts, packages/ui husk | LOW | S | MEASURED | 2 |
| AUD-CODE-017 | tools/dev/e2e-gate.wf.js — deferred deletion decision still open | LOW | S | MEASURED | 5 |
| AUD-CODE-018 | ESLint: TS parser but NO type-aware rule set | LOW | M | MEASURED | 4 |
| AUD-CODE-019 | tsconfig strictness drift: apps/web opts out of noUncheckedIndexedAccess | LOW | M | MEASURED | 4 |
| AUD-CODE-020 | packages/ui stale untracked build-artifact directory | LOW | S | MEASURED | 2 |

---

#### AUD-CODE-002 — Bronze e2e coverage silently dead: shared helper still reads Bronze via removed StarRocks (:9030/mysql2) — 8 e2e suites permanently self-skip
**SEV-HIGH · EFFORT-M · MEASURED · Wave 3 · confirmed**

**Evidence:** apps/stream-worker/src/tests/helpers/iceberg-bronze.ts:26 (import mysql from 'mysql2/promise'), :30 (SR_PORT default 9030), :35 (BRONZE_TABLE = brain_bronze_local.brain_bronze.collector_events — legacy pre-unified-landing table), :41-51 (makeStarrocksPool), :54-61 (icebergBronzeAvailable probe → suites skip when false), :142 (REFRESH EXTERNAL TABLE). StarRocks absent from docker-compose.yml (zero starrocks/9030 matches) — the probe can never succeed. 8 gated suites (actual setup lines): bronze.e2e.test.ts:28-34+60-61, backfill.e2e.test.ts:42+170-171, pipeline-wire.e2e.test.ts:32+165-166, live-connector.e2e.test.ts:39-43+152-153, ingest-hardening.e2e.test.ts:44+203-204, live-order-bronze-wiring.e2e.test.ts:22-28+66-67, shopflo-bronze-wiring.e2e.test.ts:17-23+63-64, gokwik-rto-predict-bronze-wiring.e2e.test.ts:25-31+67-68. mysql2 ^3.22.5 still declared at apps/stream-worker/package.json:40. CI blind spot: tools/lint/v4-naming-guard.sh:86 exempts */tests/* from R5 (mysql2/:9030/STARROCKS_*). CORRECTION to remediation's coverage claim: bronze-dedup-effectively-once.live.test.ts:48+121-123 already reads Bronze via createTrinoPool (catalog 'iceberg', live-verified in #323/#324) and imports only the producer helpers — it is the porting template, and it means one Bronze-landing e2e does still run; the 8 dead suites uniquely cover isolation/backfill/connector-wiring paths.

**Remediation:** Port the helper's read-back seam from mysql2/StarRocks to the Trino REST client (iceberg.brain_bronze.events / collector_events depending on BRONZE_SOURCE), drop the REFRESH EXTERNAL TABLE cache-bust (Trino reads Iceberg snapshots directly), then delete the mysql2 dep from apps/stream-worker once green. Test-coverage status: these ARE the tests; nothing else covers Bronze landing e2e. Blast radius: test-only file — zero runtime impact.

**Risk:** None to production. Risk is only that re-enabled suites surface real regressions that were masked while skipping.

**Verifier note:** Fully confirmed on the current branch. The shared helper still imports mysql2/promise (line 26), defaults to StarRocks port 9030 (line 30), reads the legacy table (line 35), and issues REFRESH EXTERNAL TABLE (line 142). StarRocks was removed in PR #285 and no compose file defines it or exposes :9030, so icebergBronzeAvailable() always returns false and all 8 importing e2e suites permanently self-skip. Not fixed by any recent commit; mysql2 ^3.22.5 still in apps/stream-worker/package.json:40. CI never flags it because v4-naming-guard.sh:86 exempts */tests/* from the R5 mysql2/:9030 checks. One overstatement in the remediation: bronze-dedup-effectively-once.live.test.ts was ALREADY ported to Trino and live-verified in #323/#324, so a single Bronze-landing e2e does exist and demonstrates the exact porting pattern — but the 8 dead suites uniquely cover brand isolation, backfill, and per-connector Bronze wiring. SEV-HIGH stands: coverage for the 'no event loss' core invariant reports green-by-skip forever, and a Trino port must also respect BRONZE_SOURCE (legacy collector_events vs unified brain_bronze.events, default 'events' deployed per #336).

---

#### AUD-CODE-003 — Pending-window compliance flush handler is written and documented as load-bearing but never wired — queued sends can never release
**SEV-MED · EFFORT-M · MEASURED · Wave 4**

**Evidence:** apps/core/src/modules/notification/internal/pending-window.handler.ts:1-19 (docblock: 'runs at/after 09:00 IST... load-bearing: a consent WITHDRAWAL between queue-time and flush-time MUST suppress the send'). Only reference in the entire src tree is the export in the DEAD barrel apps/core/src/modules/notification/index.ts:33 (barrel itself has zero importers — knip unused-files list, line 10 of audit/knip-raw.txt). The queue-side IS live: can-contact.engine.ts:176 emits 'queue_pending_window' and send-log.ts:26 persists status='pending_window' — but no scheduler/composition-root instantiates PendingWindowFlushHandler (grep across apps/core/src + apps/stream-worker/src = 0 non-barrel hits). No test file covers it (notification/tests/ has no pending-window test).

**Verification:** SELECT count(*) FROM send_log WHERE status='pending_window' AND release_after < now() — a non-zero, growing count proves rows queue and never flush.

**Remediation:** Decide: (a) wire the handler as an in-service scheduled job in main.ts (the docblock says in-service handler, NOT a new deployable — I-E05) and add a flush test, or (b) if the send-window feature is not yet launched, delete handler + the queue path together. Do not delete the handler alone — it fail-closes today (rows stay queued, never wrongly sent) but the feature is silently broken.

**Risk:** Wiring it activates real sends of previously-queued rows — verify the re-evaluation gate (consent withdrawal) with a test before enabling in prod.

---

#### AUD-CODE-004 — Dead StarRocks-era dev script: seed-silver-dev.mjs reads db/starrocks/ddl which no longer exists
**SEV-MED · EFFORT-S · MEASURED · Wave 2**

**Evidence:** apps/stream-worker/scripts/seed-silver-dev.mjs:2-4 ('provision the StarRocks Silver tier... filled by dbt full-refresh'), :30 (STARROCKS_HOST/:9030), :45 reads db/starrocks/ddl — but db/starrocks/ contains ONLY teardown/ (ls db/starrocks = teardown). Script crashes on first ddl read and violates the V4 doctrine (StarRocks + dbt REMOVED). knip unused-files line 13. Zero references from package.json scripts, CI, or tools/.

**Remediation:** Delete the file. Test coverage: none. Blast radius: zero — unreferenced, and cannot run (missing ddl dir + no StarRocks). **Risk:** None.

---

#### AUD-CODE-005 — Unmounted legacy per-provider webhook receivers duplicate the live WebhookPipeline (security-critical HMAC path exists twice)
**SEV-MED · EFFORT-S · MEASURED · Wave 2**

**Evidence:** apps/core/src/modules/connector/sources/storefront/shopify/interfaces/webhooks/shopifyWebhookHandler.ts (registerShopifyWebhookRoutes:71) and .../payment/razorpay/interfaces/webhooks/razorpayWebhookHandler.ts (registerRazorpayWebhookRoutes:95) are imported ONLY by their own integration tests (shopifyWebhookHandler.integration.test.ts:43, razorpayWebhookHandler.integration.test.ts:49). Production mounts only registerAllWebhookRoutes (bootstrap/registerConnectors.ts:27 → webhooks/platform/registerWebhookRoutes.ts, which registers /api/v1/webhooks/shopify/:topic at :115 and /api/v1/webhooks/razorpay at :130 via the strategy pipeline). The razorpay-local RedisDedupAdapter (sources/payment/razorpay/infrastructure/RedisDedupAdapter.ts) is used only by this unmounted handler (single non-test importer: razorpayWebhookHandler.ts:36).

**Remediation:** Delete both legacy handlers, their integration tests, and razorpay/infrastructure/RedisDedupAdapter.ts. Test coverage: the LIVE path is covered by webhooks/tests/HmacConfig.test.ts + strategy/pipeline tests; the integration tests being deleted only exercise the dead route registrations. Blast radius: zero runtime routes change (handlers were never mounted). Violated principle: 'prefer small, reversible, auditable changes' — a dead parallel implementation of the NN-4 HMAC gate is an audit hazard.

**Risk:** Low. Confirm no out-of-tree consumer mounts registerShopifyWebhookRoutes/registerRazorpayWebhookRoutes (grep already shows none).

---

#### AUD-CODE-006 — Superseded bespoke HMAC value-objects still present after HmacConfig consolidation (duplicate ~25-line timing-safe verify blocks ×4)
**SEV-LOW · EFFORT-S · MEASURED · Wave 2**

**Evidence:** apps/core/src/modules/connector/webhooks/platform/HmacConfig.ts:2 states 'ONE primitive replacing the 4 bespoke *Hmac value-objects', yet all four survive: WooCommerceHmac.ts:35-57 and ShopfloHmac.ts validateWebhook (:20-77) have ZERO runtime callers (only byte-compat pins in webhooks/tests/HmacConfig.test.ts:81-96 + own unit tests); RazorpayHmac.ts:15-57 is called only from the unmounted legacy handler (razorpayWebhookHandler.ts:221); ShopifyHmac.validateWebhook (ShopifyHmac.ts:70-91, byte-identical to WooCommerceHmac.validateWebhook:35-57 and to HmacConfig.validateWebhook:51-68) is called only from the unmounted shopifyWebhookHandler.ts:110. ONLY ShopifyHmac.validateOAuthCallback (ShopifyHmac.ts:27-59) is live (HandleOAuthCallbackCommand.ts:144) — a genuinely different scheme (query-param HMAC).

**Remediation:** Delete WooCommerceHmac.ts, ShopfloHmac.ts, RazorpayHmac.ts and ShopifyHmac.validateWebhook (keep validateOAuthCallback, or move it beside HandleOAuthCallbackCommand). Update HmacConfig.test.ts byte-compat pins to assert against fixed known-good digests instead of the legacy VOs (preserves the regression pin without the dead code). Blast radius: apps/core only; goes with AUD-CODE-005.

**Risk:** Low — the byte-compat tests already prove HmacConfig equivalence; converting them to golden digests keeps that proof.

---

#### AUD-CODE-007 — ConnectRazorpayCommand superseded by generic planCredentialConnect — confident dead file
**SEV-LOW · EFFORT-S · MEASURED · Wave 2**

**Evidence:** apps/core/src/modules/connector/sources/payment/razorpay/application/commands/ConnectRazorpayCommand.ts — knip unused file (audit/knip-raw.txt line 4); zero importers in src (grep 'ConnectRazorpay' non-self = only comments in ConnectWooCommerceCommand.ts:4 / ConnectShopfloCommand.ts:4 and the parity-pin note in credential-schema.test.ts:114-129, which asserts planCredentialConnect produces the exact bundle this command used to hard-code without importing it).

**Remediation:** Delete the file (and fix the two 'Clone/Mirror of ConnectRazorpayCommand' comments to point at planCredentialConnect). Test coverage: parity is pinned in credential-schema.test.ts independent of the file. Blast radius: none — razorpay connect flows through the generic credential path; RotateWebhookSecretCommand (still live via writeRoutes.ts:17) is a separate file. **Risk:** None.

---

#### AUD-CODE-008 — IA-redesign orphan cluster in apps/web: 6 superseded route-content components + 9 supporting components/hooks are unreachable behind redirect pages
**SEV-MED · EFFORT-S · MEASURED · Wave 2**

**Evidence:** The old routes are now pure redirects: app/(dashboard)/dashboard/page.tsx:10 redirect('/home') (home has its own home-content.tsx), analytics/journey/page.tsx:10 redirect('/journeys'), identity/customer-360|customers|merge-review|pii-vault/page.tsx all redirect. Their sibling content components have 0 importers (verified per-file grep): journey-content.tsx, dashboard-content.tsx, customer-360-content.tsx, identity/customers/customers-content.tsx, merge-review-content.tsx, pii-vault-content.tsx; plus transitively-dead components/analytics/recent-activity.tsx (sole importer = dead dashboard-content.tsx:26), components/dashboard/{brand-summary-card,connection-status-card,onboarding-progress-card,realized-revenue-card}.tsx, components/onboarding/{create-brand-form,create-workspace-form}.tsx, components/ui/{confidence-meter,separator}.tsx, and dead hooks flagged by knip (use-analytics.ts:194 useRecentActivity, use-dashboard.ts:33,42, use-workspace.ts:21-54). @radix-ui/react-separator (apps/web/package.json:22) becomes removable with separator.tsx.

**Remediation:** Delete the 15 component files + dead hooks + @radix-ui/react-separator dep in one reviewed commit. Test coverage: e2e specs (e2e/demo/dashboard.demo.spec.ts etc.) navigate the redirect ROUTES, not these files — keep the redirect page.tsx files (deep-link contract). Blast radius: none at runtime (unreachable); Next build shrinks.

**Risk:** Low. Verify `pnpm --filter @brain/web build` after deletion; grep e2e specs for data-testids that only existed in the deleted components.

---

#### AUD-CODE-009 — Removable dependencies confirmed dead: mysql2 (apps/core), pg + @types/pg (attribution-writer), @types/argon2 (apps/core)
**SEV-LOW · EFFORT-S · MEASURED · Wave 2**

**Evidence:** apps/core/package.json:51 mysql2 — main.ts:26-28 states 'mysql2 is no longer used in this composition root'; zero non-comment mysql2 imports in apps/core/src (grep). packages/attribution-writer/package.json:16 'pg' + :20 '@types/pg' — zero `from 'pg'` imports in packages/attribution-writer/src (grep). apps/core/package.json @types/argon2 ^0.15.3 — argon2 ^0.44 ships its own types (@types/argon2 is a deprecated stub). All four flagged by knip (audit/knip-raw.txt lines 48-58). NOTE the two knip dep flags that must NOT be removed: @aws-sdk/client-ses (loaded via the hidden dynamic import in notification/internal/ses-adapter.ts:52-55) and @aws-sdk/client-kms (deliberately added to apps/core to fix the empty-keyring-DEK cold-start bug; pii-vault loads it via dynamic import, packages/pii-vault/src/index.ts:120,300).

**Remediation:** Remove the four dead deps; add @aws-sdk/client-ses and @aws-sdk/client-kms to knip.json ignoreDependencies with a comment explaining the dynamic-import resolution so they are never 'cleaned' by mistake. Test: pnpm install + full typecheck + apps/core boot (bootstrap:prodlocal exercises the KMS path). Note mysql2 in packages/metric-engine (package.json:17) and apps/stream-worker is only removable after AUD-CODE-002/010 land.

**Risk:** Low; the KMS/SES guard comment is the important part — removing those two would reintroduce a known production bug.

---

#### AUD-CODE-010 — Four dormant StarRocks live-test files in metric-engine can never run again and keep mysql2 alive
**SEV-LOW · EFFORT-S · MEASURED · Wave 2**

**Evidence:** packages/metric-engine/src/storefront-abandoned-cart.live.test.ts:1-20 (header: 'SUPERSEDED... StarRocks is removed in V4, so every assertion below self-skips (srUp=false)... Kept dormant pending a Trino live harness'; imports mysql2/promise, pool on :9030), same pattern in storefront-engagement.live.test.ts:10-13, storefront-funnel.live.test.ts:14-17, customer-360.live.test.ts:8. mysql2 dep pinned by these at packages/metric-engine/package.json:17.

**Remediation:** Either port the four suites to the Trino live harness (the repointed behavior already has mocked-seam coverage per the headers, e.g. storefront-abandoned-cart.test.ts) or delete them now and file the Trino-live-harness gap once; then drop mysql2 from metric-engine. Blast radius: test-only. Coverage status: mocked-seam unit tests exist for each superseded compute.

**Risk:** None if the mocked-seam tests are confirmed present for all four (verified for abandoned-cart via its header; spot-check the other three).

---

#### AUD-CODE-011 — Dead module barrels (apps/core + stream-worker) make the module-boundary pattern fictional and generate ~200 knip unused-export noise lines
**SEV-LOW · EFFORT-M · MEASURED · Wave 4**

**Evidence:** knip unused FILES: apps/core/src/modules/connector/index.ts, frontend-api/index.ts, job-orchestration/index.ts, notification/index.ts, notification/internal/compliance/index.ts, apps/stream-worker/src/domain/identity/{decisions,matchers}/index.ts (audit/knip-raw.txt lines 3,8-11,16,18). Root cause: main.ts deep-imports internals directly (e.g. main.ts:67-75 imports notification/internal/* directly), so barrels have zero importers — and most of the 224 'unused exports' (knip-raw.txt lines 61-285) are barrel re-exports. The repo's own architecture-compliance program treats module index.ts as the public API (god-file split work), which main.ts bypasses.

**Remediation:** Pick one: (a) repoint main.ts/bootstrap to consume module barrels (restores the boundary, silences knip), or (b) delete the dead barrels and declare deep-imports the convention. Do (a) for notification/connector/frontend-api where the barrel documents a real seam; (b) for stream-worker domain sub-barrels. Blast radius: import-path churn only, route-identical.

**Risk:** Low — pure import rewiring; typecheck + existing tests gate it.

---

#### AUD-CODE-012 — stream-worker identity explainability leftovers: use-cases + PG repository with zero importers (core owns the live timeline reader)
**SEV-LOW · EFFORT-S · HYPOTHESIS · Wave 5 (parked — verify #284 deferral intent first)**

**Evidence:** knip unused files: apps/stream-worker/src/application/AssembleIdentityTimelineUseCase.ts, application/ExplainIdentityDecisionUseCase.ts, infrastructure/pg/PgIdentityTimelineRepository.ts (audit/knip-raw.txt lines 14-19); grep confirms zero importers. The live read surface is apps/core/src/modules/identity/internal/infrastructure/identity-timeline-reader.ts (PG identity_audit projection) wired via core main.ts; the pure domain (buildIdentityTimeline) is tested directly by apps/stream-worker/src/tests/identity-timeline.test.ts (imports domain files, not the use-cases).

**Verification:** Confirm with the #284 Section-H proof map / owner whether these use-cases are the deferred seams or genuinely superseded by core's identity-timeline-reader; also `git log --oneline -3` on each file for a DEFERRED marker.

**Remediation:** Delete the three files IF they are not the deliberate 'honest DISABLED-throw seams' deferred from PR #284. Domain logic + tests stay untouched. **Risk:** Deleting a deliberate deferral seam re-opens a planned wiring task with no anchor.

---

#### AUD-CODE-013 — knip.json stale globs cause both false positives and dead ignores — the non-blocking report is too noisy to promote to a gate
**SEV-LOW · EFFORT-S · MEASURED · Wave 2**

**Evidence:** knip.json apps/web block: entry 'src/app/**/...' and ignore 'src/components/ui/**' — but the app lives at apps/web/app/ and components at apps/web/components/ (no src/), so the ui ignore never applies (components/ui/separator.tsx got flagged despite the ignore intent). Confirmed false positives in the current report: tools/load-test/{ingest,serving}.js (k6 CLI — invoked per docs/runbooks/prod-deploy.md:144-154), stream-worker CLI/cron job entrypoints (gold-rewritten-publish/run.ts + journey-stitch-export/run.ts invoked by tools/dev/v4-refresh-loop.sh:398 and infra/helm/cronworkflows/values.yaml:187-189,251-253; partition-maintenance.ts ditto; identity/replay-identity.ts operator CLI), tools/eslint-rules/fixtures/*.ts (negative-control fixtures), extensions/brain-web-pixel/src/index.js (Shopify-CLI-built extension, shopify.extension.toml), root devDeps tsx (load-bearing: v4-refresh-loop.sh:249 `pnpm exec tsx`) and prettier (.prettierrc exists).

**Remediation:** Fix apps/web globs (app/**, components/), add entry globs for src/jobs/**/run.ts + src/jobs/*.ts in stream-worker, ignore tools/load-test/**, tools/eslint-rules/fixtures/**, extensions/**, and add ignoreDependencies for tsx/prettier/@aws-sdk/client-{kms,ses}/mysql2-until-e2e-port. Then the residual report is real dead code and .github/workflows/knip.yml can be promoted to blocking per its own comment ('Promote to a blocking gate later once the baseline is clean'). **Risk:** None — report-only config.

---

#### AUD-CODE-014 — Workspace dependency version drift: fastify major split (collector v4 vs core v5), pg/zod/@types/node scattered
**SEV-LOW · EFFORT-M · MEASURED · Wave 4**

**Evidence:** Computed from all workspace package.jsons: fastify ^4.28.0 (apps/collector — the strict-SLA ingest edge) vs ^5.7.2 (apps/core); pg ^8.13.0 (collector) / ^8.13.1 (web, isolation-fuzz) / ^8.21.0 (core, stream-worker, 4 packages); @types/node ^20 (10 mapper packages) / ^22 (collector +3) / 25.9.3|^25.9.3 (web, config, events, identity-core, pii-vault); zod ^3.23.8 (tools/data-quality) vs ^3.25.76 (web/config/contracts); @types/pg 3-way split.

**Remediation:** Adopt pnpm catalog: (pnpm-workspace.yaml) for pg/zod/@types/*; schedule the collector fastify 4→5 upgrade separately with its own load-test pass (tools/load-test/ingest.js) since it sits on the collector→Kafka SLA path.

**Risk:** fastify v5 has breaking changes (plugin/typing); do NOT fold it into a bulk alignment PR — isolate + k6-verify.

---

#### AUD-CODE-015 — Legacy Bronze sinks: cutover-gated, NOT deletable — status report (Phase 8 pending; e2e helper must be repointed before decommission)
**SEV-LOW · EFFORT-S · MEASURED · Wave 5 (tracking only)**

**Evidence:** STATUS not deletion: db/iceberg/spark/{bronze_materialize.py,bronze_raw_landing.py,combined_bronze_sinks.py} remain the deployed legacy path (docker-compose.yml:332 lane comments; dev-bronze-streaming.sh:45 keeps sibling-import compat). The unified sink is live in dev: tools/dev/v4-refresh-loop.sh:84 defaults `BRONZE_SOURCE=events` and dev-up.sh:107 pgreps bronze_landing.py. Decommission is explicitly gated on bake+D4 (unified-bronze-landing memory). Dependency: the e2e helper (AUD-CODE-002) asserts the LEGACY table brain_bronze.collector_events — it must move to brain_bronze.events as part of, or before, Phase 8.

**Remediation:** No action now beyond tracking: when Phase 8 executes, delete the two legacy sink jobs + combined_bronze_sinks.py + the compose lane comments in the same PR as the e2e-helper repoint, so no window exists where tests assert a dropped table.

**Risk:** Deleting before bake+D4 sign-off violates the documented cutover gate (rollback = BRONZE_SOURCE=legacy needs the code present).

---

#### AUD-CODE-016 — Cosmetic stale-by-decision leftovers: redpandaTopic field name, checked-in generated d.ts with no consumers, git-ignored packages/ui husk
**SEV-LOW · EFFORT-S · MEASURED · Wave 2**

**Evidence:** (1) tools/data-quality/src/index.ts:57 `redpandaTopic: z.string()` and :123 `redpandaTopic: 'dev.collector.event.v1'` — broker renamed redpanda→kafka (docker-compose.yml:221); the memory-flagged package.json/dev-up.sh leftovers are RESOLVED (grep clean). (2) packages/contracts/generated/types/index.d.ts — auto-generated (header line 1), zero references in contracts package.json exports or any tsconfig. (3) packages/ui/ contains only dist/ + tsconfig.tsbuildinfo, no package.json, git-ignored (git status --ignored: '!! packages/ui/') — husk from the removed ui package (cleanup commit 61c76ee5).

**Remediation:** (1) rename field to kafkaTopic (tool-internal schema, 2 lines). (2) either wire generated/types into contracts exports or delete it + its codegen output path. (3) rm -rf packages/ui locally (not a repo change). Test coverage: tools/data-quality has its own tests; run them after the rename. **Risk:** None.

---

#### AUD-CODE-017 — tools/dev/e2e-gate.wf.js — deferred deletion decision still open (hardcoded absolute repo path + brand UUIDs, zero in-graph references)
**SEV-LOW · EFFORT-S · MEASURED · Wave 5 (needs owner confirm)**

**Evidence:** docs/cleanup/repo-cleanup-plan.md:69,89: 'e2e-gate.wf.js removal is deferred to Wave 3 (conflicting audit verdicts)... CI/CD audit says remove; Test audit says needs-user-confirm (orchestrator may invoke by direct path)'. knip flags it unused (audit/knip-raw.txt line 41). It also carries stale prompt text referencing redpanda and a hardcoded /Users/... path (e2e-gate.wf.js:30).

**Verification:** Ask the owner / grep any private orchestration configs outside the repo for 'e2e-gate.wf'; check shell history or .eos-workflows for path invocations.

**Remediation:** Escalate the parked owner decision from the previous cleanup program: confirm no out-of-graph orchestrator invokes it by path, then remove; otherwise parameterize REPO path + brand UUIDs and update the redpanda→kafka wording.

**Risk:** If an external workflow invokes it by absolute path, deletion silently breaks that gate — hence user-confirm first.

---

#### AUD-CODE-018 — ESLint runs the TypeScript parser but NO type-aware rule set — no-floating-promises / no-misused-promises / no-explicit-any are mechanically unenforced
**SEV-LOW · EFFORT-M · MEASURED · Wave 4**

**Evidence:** eslint.config.mjs:19-46 + rules blocks (only eslint-plugin-boundaries, no-restricted-imports, and the 3 custom brain-* rules); package.json:43-46 (@typescript-eslint/parser present, @typescript-eslint/eslint-plugin absent from devDependencies). Current discipline is excellent (grep found ~0 non-comment `any` in packages/{contracts,db,metric-engine,events} and only intentional documented fire-and-forget, e.g. registration.service.ts:172), but nothing prevents regression — the D-7 offset-commit ordering and audit-write paths are exactly where a silently floating promise would be costly.

**Remediation:** Add @typescript-eslint/eslint-plugin with a minimal type-checked slice: no-floating-promises, no-misused-promises, no-explicit-any (error on exported declarations, warn elsewhere), scoped to apps/ + packages/ with projectService. Roll out per-package to contain lint noise.

**Risk:** Type-aware linting is slow on a monorepo this size (mitigate with projectService + CI cache); initial run will surface intentional fire-and-forgets needing `void` annotations.

---

#### AUD-CODE-019 — tsconfig strictness drift: apps/web hand-rolls its config with noUncheckedIndexedAccess disabled; exactOptionalPropertyTypes absent workspace-wide
**SEV-LOW · EFFORT-M · MEASURED · Wave 4**

**Evidence:** apps/web/tsconfig.json (does not extend tsconfig.base.json; sets "noUncheckedIndexedAccess": false explicitly, line 12) vs tsconfig.base.json:6-7 (strict + noUncheckedIndexedAccess true for all 30 other projects); no tsconfig in the repo sets exactOptionalPropertyTypes (grep: 0 hits). All other apps/packages extend base uniformly.

**Remediation:** Make apps/web extend the base (overriding only module/moduleResolution/jsx/noEmit/lib for Next) and flip noUncheckedIndexedAccess to true, fixing surfaced index accesses; decide exactOptionalPropertyTypes ONCE in the base (contracts package would benefit most — optional-vs-undefined matters for Zod-derived API types) or document the omission as deliberate.

**Risk:** Enabling noUncheckedIndexedAccess in web will surface a batch of `possibly undefined` errors in array/record access — mechanical but nonzero churn; exactOptionalPropertyTypes is the most breaking strict flag and needs a dedicated pass over spread-into-optional patterns.

---

#### AUD-CODE-020 — packages/ui is a stale untracked build-artifact directory (dist + tsconfig.tsbuildinfo, no package.json, not in git)
**SEV-LOW · EFFORT-S · MEASURED · Wave 2**

**Evidence:** `ls packages/ui` → only `dist` + `tsconfig.tsbuildinfo`; `git ls-files packages/ui` → empty (untracked); no tsconfig.json/package.json, so it is inert to pnpm-workspace `packages/*` but pollutes the workspace and can shadow a future @brain/ui resolution via the base `paths: {"@brain/*": ["packages/*/src"]}` mapping.

**Remediation:** Delete the directory (it is local build residue of the removed ui package from the cleanup program) and add `packages/*/dist` to a periodic clean; verify `pnpm -r build` afterwards. **Risk:** None — untracked, no src, nothing imports @brain/ui (grep over apps/packages: 0 source hits).

---

### 4.4 AUD-ARCH — architecture conformance & tenancy (arch-conformance + tenancy-critical)

| ID | Title | Sev | Effort | Tag | Wave |
|---|---|---|---|---|---|
| AUD-ARCH-001 | BRONZE_SOURCE split-brain — prod templates omit the flag (dev verified aligned) | LOW | S | HYPOTHESIS | 1 |
| AUD-ARCH-002 | Identity ingestion consumes raw Kafka topic pre-R2/R3 gate | HIGH | L | MEASURED | 4 (Parked: needs-user-decision) |
| AUD-ARCH-003 | tools/data-quality crashes at import under BRONZE_SOURCE=legacy (TDZ) | MED | S | MEASURED | 3 |
| AUD-ARCH-004 | Three parallel identity projections; prod brain_id resolution on flat PG export | MED | M | MEASURED | 5 |
| AUD-ARCH-005 | Composite touchpoint dedup partial (never pairs pixel purchase + server order) | MED | M | MEASURED | 5 |
| AUD-ARCH-006 | No versioned journey_events mart — de-scoped #338 | LOW | L | MEASURED | 5 (Parked escalation) |
| AUD-ARCH-007 | BRN- flat public id vs hierarchical form | LOW | S | MEASURED | 5 (Parked escalation) |
| AUD-ARCH-008 | 7 shadow *_normalize jobs 10-col — Silver cutover blocker | MED | M | MEASURED | 4 |
| AUD-ARCH-009 | Hexagonal leak: recommendation detectors receive concrete DbClient | LOW | M | MEASURED | 4 |
| AUD-ARCH-010 | ops.* tenant tables have NO row-level security | MED | M | HYPOTHESIS | 4 (Parked: needs-user-decision) |
| AUD-ARCH-011 | RTBF does NOT purge raw Bronze Iceberg (raw-delete step is a disabled stub) | MED | M | MEASURED | 5 |
| AUD-ARCH-012 | journey-stitch-from-identity bypasses fail-closed withTrinoBrand seam | LOW | S | MEASURED | 4 |
| AUD-ARCH-013 | Trino positional ?-substitution brand-binding invariant unguarded | LOW | S | HYPOTHESIS | 4 |

---

#### AUD-ARCH-001 — BRONZE_SOURCE split-brain defaults: app/DQ Bronze reads default 'legacy' while the only running sink writes brain_bronze.events; prod templates omit the flag
**SEV-LOW · EFFORT-S · HYPOTHESIS · Wave 1 · confirmed (headline downgraded from HIGH by verifier)**

**Evidence:** Code defaults 'legacy': apps/core/src/modules/analytics/internal/application/queries/_bronze-source.ts:31-33 and apps/stream-worker/src/jobs/dq/silver-reader.ts:49-51 (both documented as deliberate rollback defaults for the gated unified-Bronze cutover). Dev is NOT split-brained: apps self-load env via `tsx watch --env-file=../../.env.${APP_ENV:-local-prod}` (apps/core/package.json:10, apps/stream-worker/package.json:10, apps/collector/package.json:10 — turbo env stripping cannot remove env-file-loaded vars; APP_ENV IS in turbo.json globalPassThroughEnv), and .env.local-prod:133 sets BRONZE_SOURCE=events, matching the sole dev sink tools/dev/dev-bronze-streaming.sh (bronze_landing.py → brain_bronze.events) and tools/dev/v4-refresh-loop.sh:84 (default events). Residual gap (the real finding): prod templates omit the flag — .env.production.example has no BRONZE_SOURCE (grep=0, 150-line template; the local-prod example got it at line 107 in Phase 5 but the production example was missed) and infra/helm/core + infra/helm/stream-worker charts/values set no BRONZE_SOURCE (env via envSecretName core-env + values.env, infra/helm/core/templates/deployment.yaml:39-47), while prod Spark crons default events (infra/helm/cronworkflows/templates/spark-v4.yaml:104,169) and the prod Argo Bronze sink was cut over to bronze_landing (commit 41a42d6e, Phase 6). Mitigation already in-repo: db/iceberg/spark/teardown/unify-bronze-decommission.md:3-13 gates any decommission on BRONZE_SOURCE=events being set + downstream-read bake verification, and legacy tables are retained as the rollback path until then.

**Remediation:** Set BRONZE_SOURCE=events in .env.production.example and helm core/stream-worker values; align the code-level defaults (app _bronze-source.ts + silver-reader.ts vs refresh-loop/helm) to ONE default so the pipeline and the serving reads can never disagree. Keep legacy as an explicit rollback value only. (The turbo.json passthrough addition is unnecessary per the verifier — env-file loading bypasses turbo — though harmless.)

**Risk:** Low — env passthrough is additive; flipping the app default to events requires the unified sink to be the deployed sink (it already is in dev script + prod helm). Rollback = set BRONZE_SOURCE=legacy explicitly.

**Verifier note:** The headline SEV-HIGH split-brain is refuted. The load-bearing mechanism — 'BRONZE_SOURCE is not in turbo globalPassThroughEnv so .env.local-prod's events value is stripped from apps' — is false: turbo env filtering only affects the inherited parent environment, and every backend app self-loads the env file inside the process. APP_ENV (the file selector, the only var that must cross turbo) IS in globalPassThroughEnv, and the actual .env.local-prod:133 sets BRONZE_SOURCE=events — so in dev the apps, DQ reader, refresh loop, and sink all agree on brain_bronze.events. No live environment reads the frozen table. The code-default 'legacy' is a deliberate, documented rollback posture for a runbook-gated cutover. What survives is a small real kernel: the production templates omit the flag — a future prod deployment configured purely from the templates would silently point app/DQ Bronze surfaces at frozen collector_events. That is a template-completeness footgun (prod cluster not yet live, runbook gates on the flag), justifying SEV-LOW, not HIGH.

---

#### AUD-ARCH-002 — Identity ingestion consumes the raw Kafka collector topic directly (pre-Silver): identity resolution runs BEFORE the R2 install_token→brand and R3 consent gates, trusting the claimed envelope brand_id
**SEV-HIGH · EFFORT-L · MEASURED · Wave 4 → PARKED (needs-user-decision: identity path repoint) · confirmed**

**Evidence:** apps/stream-worker/src/main.ts:149-151,343-345 — IdentityBridgeConsumer subscribes to cfg.COLLECTOR_TOPIC (raw Kafka collector topic); apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts:9 ('consumes the SAME Bronze event topic (dev.collector.event.v1)'); apps/stream-worker/src/application/ResolveIdentityUseCase.ts — zero occurrences of consent/install_token (grep=0), trusts claimed envelope brand_id (:126), extracts email/phone/device/anon identifiers (:143-260) AND vaults the RAW email to PG contact_pii (:252-260, rawValue for contact_pii write) before writing the graph under the claimed brand. Gates live only in Silver: db/iceberg/spark/silver/silver_collector_event.py:21-48 (gate spec) + :224-262 (R3 consent_missing → silver_consent_rejected at :230-245; R2 install_token LEFT join → tenant_unresolved/brand_mismatch quarantine at :247-262); db/iceberg/spark/bronze_landing.py:12-16 ('DOES NOT apply the R2/R3 pixel admission gate... brand_id on a pixel row is the CLAIMED envelope brand'). No upstream mitigation: collector edge-guard (edge-guard.ts:108-112) only rate-limits per install_token, never resolves/verifies it; pixel sends events WITHOUT consent_flags when no consent signal exists (fail-safe-absent, pixel-asset.route.ts:179); IdentityResolver's 'suppressed' outcome is phone-guard suppression, not consent (IdentityResolver.ts:9,142-149). Exploitability: brand_id is publicly served in the pixel bootstrap (pixel-asset.route.ts:553 window.__brain={install_token,brand_id}), and polluted Neo4j identities re-enter the gated medallion via the identity export (ops.silver_identity_link / silver_customer_identity projections). Architecture requirement: the approved fixed flow places Phase 1 Identity Intelligence AFTER Iceberg Silver (docs/architecture/phase1-identity-resolution-spec.md:8-9, 'The approved Brain architecture is fixed and must be preserved'); note the same spec's §1.1 reviews the current pre-Silver spine's layering as clean without flagging source placement, so this is a flow-diagram deviation, not a violated explicit sentence.

**Verification:** Produce a pixel event with a bogus install_token + no consent_flags to the collector topic in dev; confirm it lands in silver_consent_rejected/quarantine yet ResolveIdentityUseCase processed it (identity_audit row / Neo4j identifier node under the claimed brand_id).

**Remediation:** ESCALATE (structural): either (a) repoint identity ingestion to a post-gate source — consume admitted rows from silver_collector_event (batch, like journey-stitch-from-identity) or an admitted-events topic emitted by the Silver gate; or (b) as an interim, replicate the R2 (pixel_installation lookup) + R3 (consent_flags presence) checks inside IdentityBridgeConsumer/ResolveIdentityUseCase before any graph write.

**Risk:** Option (a) changes identity latency from streaming to batch and alters replay semantics (offsets → watermarks); option (b) duplicates gate logic in two places (drift risk) but is small and reversible. Consent-rejected identities already in Neo4j may need a cleanup pass.

**Verifier note:** Every cited evidence location verified exactly. Refutation attempts failed: the collector does not verify install_token→brand (edge-guard only rate-limits), the pixel sends events without consent_flags (fail-safe-absent), the resolver's 'suppressed' outcome is phone-guard not consent, and no recent commit touches identity ingestion. The impact is understated if anything: ResolveIdentityUseCase.ts:259 vaults the RAW email into PG contact_pii from non-consented events, brand_id is publicly discoverable in the served pixel JS making claimed-brand cross-tenant writes practically exploitable, and Neo4j is projected back into Silver (ops.silver_identity_link / silver_customer_identity), so pollution re-enters the gated medallion. SEV-HIGH is justified (tenant-isolation + consent/DPDP exposure on the identity SoR). Only correction: the 'finalized architecture requirement' is a paraphrase — the approved flow diagram places Identity Intelligence after Iceberg Silver, but the same spec's §1.1 describes the current pre-Silver spine as BUILT/clean layering without flagging source placement, so the citation should be the fixed flow diagram rather than an explicit sentence.

---

#### AUD-ARCH-003 — tools/data-quality module crashes at import under the default BRONZE_SOURCE=legacy — self-referential const ternary (TDZ ReferenceError)
**SEV-MED · EFFORT-S · MEASURED · Wave 3**

**Evidence:** tools/data-quality/src/index.ts:21 — `const BRONZE_TABLE = BRONZE_SOURCE === 'events' ? 'brain_bronze.events' : BRONZE_TABLE;` references itself in its own initializer. MEASURED: `BRONZE_SOURCE=legacy npx vitest run` in tools/data-quality fails at collect — 'Test Files 1 failed, Tests no tests' (Cannot access 'BRONZE_TABLE' before initialization); the checked-in green .turbo test log only passes because the run inherited BRONZE_SOURCE=events. BRONZE_TABLE feeds tableName of the freshness/completeness/reconciliation check declarations (lines 87-122).

**Remediation:** Fix the else-branch to the legacy literal: `: 'brain_bronze.collector_events'` (the pre-cutover table name), and add a test that imports the module with BRONZE_SOURCE unset.

**Risk:** None — one-line literal fix restoring the obviously intended legacy table name; unit tests cover the declarations.

---

#### AUD-ARCH-004 — Three parallel identity projections coexist: bi-temporal silver_identity_map alongside flat silver_identity_alias (Iceberg) AND flat ops.silver_identity_link (PG export) — production brain_id resolution still joins the flat PG export
**SEV-MED · EFFORT-M · MEASURED · Wave 5 (program item)**

**Evidence:** db/iceberg/spark/silver/silver_identity_map.py:15-28,117-121 (bi-temporal effective_from/effective_to/is_current, deterministic projection of the append-only Neo4j graph); db/iceberg/spark/silver/silver_identity_alias.py:19-34,69-122 (flat current-state alias mart, same Neo4j source, still built via run-silver-entities.sh); db/iceberg/spark/silver/silver_order_state.py:14,37,115-123 + db/iceberg/spark/gold/gold_revenue_ledger.py:45,118-141 — hashed-email→brain_id resolution reads PG ops.silver_identity_link (the identity-export job), NOT silver_identity_map; db/iceberg/spark/gold/snap_identity_link.py:19 snapshots the PG export too. Requirement 7 explicitly asks to flag the flat link surviving in parallel.

**Remediation:** PARKED/program item: define the read-contract — which consumers need point-in-time (→ silver_identity_map with is_current=true predicate) vs current-state (could be a view over the map) — then repoint silver_order_state/gold_revenue_ledger/snap_identity_link and retire silver_identity_alias + the ops.silver_identity_link export. Do it one consumer at a time with parity checks (the map is a deterministic projection so parity is checkable).

**Risk:** brain_id resolution feeds revenue-ledger identity joins — a wrong repoint mis-attributes revenue to customers; each repoint needs the 3-way reconcile re-run. Keeping the flat tables meanwhile is safe but drifts (three sources of the same truth).

---

#### AUD-ARCH-005 — Composite touchpoint dedup is partial: is_composite only flags SAME-event_type doubles within 60s — never matches the pixel `purchase` + server `order.created` pair, and nothing merges the pair into one row
**SEV-MED · EFFORT-M · MEASURED · Wave 5 (escalate scope first)**

**Evidence:** db/iceberg/spark/silver/silver_touchpoint.py:392-405 — the CASE partitions the lag window `by brand_id, brain_anon_id, event_type`, so a pixel 'purchase.completed' and a server 'order.created' within 60s each stay is_composite=false; comment itself scopes it to 'SPA re-render / retry / pixel double-fire'. It is an additive boolean flag only ('no row removal', :393-395) — there is no merged composite touchpoint carrying the server row's money + the pixel row's utm/click-id attribution columns, which is what the finalized requirement 10 specifies.

**Remediation:** ESCALATE scope first (the merged-#337 flag may have been an accepted narrower scope): if the cross-source composite is required, add a second pass that pairs transaction-category pixel events with server order.created for the same (brand_id, brain_anon_id) within 60s, emitting one composite row (server amount/currency + pixel utm/fbclid/gclid) and flagging the constituents; keep it additive/parity-neutral like the current flag.

**Risk:** Attribution-affecting: a wrong pairing key double-counts or drops purchase touchpoints; needs golden tests on the pairing window and a parity check that non-composite consumers are byte-identical.

---

#### AUD-ARCH-006 — No versioned journey_events mart in Gold (data_version/is_current/sequence_number) — de-scoped in #338; merge re-versioning is a hard DELETE of superseded customer_360 rows
**SEV-LOW · EFFORT-L · MEASURED · Wave 5 · PARKED ESCALATION (needs-user-decision)**

**Evidence:** No gold journey_events builder exists (db/iceberg/spark/gold/ listing: gold_journey.py/gold_journey_paths.py are path aggregates; grep data_version/is_current in gold_journey.py = 0). Merge handling instead: db/iceberg/spark/gold/gold_customer_360.py:294-317 — superseded brain_ids are MERGE ... WHEN MATCHED THEN DELETE'd from Customer360 ('merge re-versioning: deleted superseded brain_id rows'). journey_summary is a denormalized last-200 JSON on the surviving row (gold_customer_360.py:254-286), not an event-sourced log. Deviates from finalized requirement 9; project memory records the de-scope as deliberate in PR #338.

**Remediation:** PARKED/ESCALATION: ratify the de-scope (bi-temporal silver_identity_map + Neo4j append-only graph already give replayability upstream, and Customer360 is derivable) or schedule the event-sourced gold journey_events mart. Do not build unilaterally — it was an explicit product decision in #338.

**Risk:** Building it adds a large always-growing mart + re-versioning MERGE cost per identity merge; not building it means point-in-time journey state is reconstructable only by re-running Silver→Gold, not by querying Gold.

---

#### AUD-ARCH-007 — Brain public-ID format conflict: implemented customer_ref is flat 'BRN-' + 26 Crockford chars vs the finalized architecture's hierarchical <tenant>-YYYYMMDD-<b32> — no in-repo doc mandates the hierarchical form
**SEV-LOW · EFFORT-S · MEASURED · Wave 5 · PARKED ESCALATION (needs-user-decision)**

**Evidence:** packages/contracts/src/identity/brain-ref.ts:8,17,27 — 'BRN-' + 26 Crockford-base32 chars of the raw 128-bit brain_id UUID, no tenant or date segment; mirrored in db/iceberg/spark/_identity_ref.py with golden vectors (_identity_ref_test.py) so the format is contract-locked. grep for 'YYYYMMDD'/hierarchical-id across docs/ + knowledge-base = 0 hits — the hierarchical requirement exists only in the finalized-architecture list, not in any repo ADR/spec.

**Remediation:** PARKED/ESCALATION only — do not change unilaterally: the BRN- format is golden-locked across two languages and (per #338) already user-facing. Decide: (a) accept BRN- flat as the ratified format and record an ADR, or (b) if tenant/date segments are genuinely required (support routing / shard hints), introduce them as a NEW ref version with dual-accept parsing. Note a tenant+date-bearing public id leaks acquisition date and tenant cardinality — arguably worse for a public identifier.

**Risk:** Changing the format breaks every stored/displayed customer_ref and the golden vectors; option (b) needs a dual-format acceptance window.

---

#### AUD-ARCH-008 — Unified-Bronze Silver cutover blocker still open: the 7 shadow *_normalize jobs write a 10-column schema missing the Stage-1 gap columns — TARGET_TABLE=silver_collector_event cutover would break
**SEV-MED · EFFORT-M · MEASURED · Wave 4**

**Evidence:** db/iceberg/spark/silver/silver_shopify_order_normalize.py:50-65 — COLUMNS_SQL is exactly 10 cols (event_id…payload), and TARGET defaults to the shadow table with 'Set TARGET_TABLE=silver_collector_event at cutover' (:50-51); same pattern in the other 6 (silver_{ad_spend,ga4,razorpay,shopflo,shiprocket,woocommerce}_normalize.py — all grep-match TARGET_TABLE). The live target was widened in #337: db/iceberg/spark/silver/silver_collector_event.py:146-151 adds event_category + silver_version (and the MERGE bumps silver_version at :314-323). A cutover write from the 10-col SELECT would either fail schema resolution or permanently NULL the gap columns for all connector-sourced events.

**Remediation:** Widen the shared normalize output (add event_category via the existing event_category_udf in _silver_technical.py, seed silver_version=1, project anonymous_id/device_id where the provider payload has them) across all 7 jobs + their shadow DDL, re-run shadow parity, THEN the TARGET_TABLE cutover becomes unblocked.

**Risk:** Low while dual-run: changes only shadow tables until cutover; parity harness (_p4_golden) already exists to prove byte-identity of the untouched columns.

---

#### AUD-ARCH-009 — Hexagonal leak (minor): recommendation domain detectors receive the concrete DbClient/QueryContext from @brain/db and execute operational PG reads inside the domain layer
**SEV-LOW · EFFORT-M · MEASURED · Wave 4**

**Evidence:** apps/core/src/modules/recommendation/internal/domain/detectors/registry.ts:20 (`import type { DbClient, QueryContext } from '@brain/db'`) and :55-59 — SignalDeps hands `client: DbClient` into domain detectors; the file's own header (:17-19) says the CM2 COST half 'remains a PostgreSQL operational read here', i.e. domain code runs DB reads. Contrast with the repo's own stated convention: apps/stream-worker/src/domain/identity/IdentityEventPublisher.ts:5 'HEXAGONAL: this is DOMAIN — it imports NO infrastructure (no kafkajs, …)'. Sweep of all apps/core/src/modules/*/internal/domain dirs found NO runtime kafkajs/pg/ioredis imports — this type-level + query-execution leak in recommendation is the only hit.

**Remediation:** Define a narrow CostInputReader (or SignalSourcePort) interface in the domain, implement it in the module's infrastructure layer wrapping DbClient, and inject it via SignalDeps — route-identical, tests unchanged.

**Risk:** Pure refactor risk only; detectors are covered by outcome-measurement tests, and the port is a mechanical extraction.

---

#### AUD-ARCH-010 — ops.* schema tenant tables (identity linkage, ML predictions, journey stitch) have NO row-level security — cross-tenant isolation rests entirely on caller discipline
**SEV-MED · EFFORT-M · HYPOTHESIS · Wave 4 → PARKED (needs-user-decision: RLS + ETL role posture)**

**Evidence:** db/migrations/0116_brain_ops_to_pg.sql:39-57 explicitly declares 'we do NOT ENABLE/FORCE RLS' for ops.silver_identity_link, ops.silver_customer_identity, ops.silver_journey_stitch, ops.scoped_recompute_request, ops.ops_ml_prediction_log. silver_identity_link holds hashed email/phone→brain_id linkage (0116:79-95). Contrast: ops.saved_segment (0120_saved_segment.sql:62-69) IS FORCE-RLS. Verified current readers all scope: apps/core/src/modules/notification/internal/capi-source.query.ts:162 (WHERE ... brand_id=$1), apps/core/src/modules/ml/internal/application/serve-customer-score.ts:179,185 (brand_id=$1), apps/stream-worker/src/jobs/journey-stitch-from-identity.ts:125 (brand_id=$1) — no active leak found, but there is zero DB-enforced backstop.

**Verification:** Confirm the trusted ETL writers (journey-stitch-export/run.ts:59 does a full-table `DELETE FROM ops.silver_journey_stitch` with no WHERE; identity-export reload) genuinely require cross-brand access with no brand GUC. The correct pattern is FORCE-RLS with brand-scoped isolation policy PLUS a dedicated `etl_reader`/`BYPASSRLS` role for the all-brand jobs, rather than no RLS at all — verify no reader can omit brand_id after the change (grep all `FROM ops.` call sites).

**Remediation:** Enable + FORCE ROW LEVEL SECURITY on the five ops.* tenant tables with a born-secure `brand_id = current_setting('app.current_brand_id', TRUE)::uuid` isolation policy for brain_app (mirroring 0120), and route the cross-brand ETL reload/upsert jobs through a distinct BYPASSRLS role (or a SECURITY DEFINER reload fn) so the app read path is fail-closed while the trusted all-brand jobs still work.

**Risk:** Medium — if the ETL writers' role/GUC posture is misjudged, forcing RLS could silently truncate the identity/stitch projections (0 rows visible → empty dashboards/attribution). Must be staged with the BYPASSRLS ETL role landed first and verified against a full refresh cycle.

---

#### AUD-ARCH-011 — DPDP/GDPR Right-to-be-Forgotten does NOT purge raw Bronze Iceberg — the on-demand erasure orchestrator's raw-delete step is a disabled stub that always throws
**SEV-MED · EFFORT-M · MEASURED · Wave 5**

**Evidence:** apps/stream-worker/src/application/EraseSubjectUseCase.ts:91-93 `shredIcebergSnapshots()` unconditionally throws NotImplementedYet; the erasure consumer catches + logs it and continues (EraseSubjectUseCase.ts:22-25,253-254). A working Spark job db/iceberg/spark/erasure_raw_delete.py exists and hard-deletes a subject's rows across all raw Bronze tables (collector_events_raw, shopify_orders_raw, ga4_rows_raw, etc. — RAW_TABLE_IDENTIFIER_COLS at erasure_raw_delete.py:82-93) but grep of infra/, tools/, .github/, and the stream-worker shows it is referenced ONLY in a doc comment (EraseSubjectUseCase.ts:85) and never invoked. So a subject's hashed identifiers + anonymous_id + raw payloads survive in Bronze after erasure. Compensating control: bronze_raw_retention.py expires snapshots on a ~7-day rolling window, bounding exposure — **but see AUD-PERF-003: that retention job is itself unscheduled and blind to the unified events table, so the compensating control is currently inoperative.**

**Remediation:** Wire the existing erasure_raw_delete.py into the erasure orchestrator (replace the shredIcebergSnapshots throw with a spark-submit invocation keyed on brand_id + identifier_hash, or enqueue it to the Spark job runner) so on-demand RTBF physically deletes raw Bronze rows; keep the retention job as the temporal backstop. Until wired, the code correctly refuses to claim I-S05 conformance — do not represent RTBF as complete.

**Risk:** Low-Medium — the raw-delete job is idempotent (Spark SQL DELETE WHERE) and brand_id-first scoped, but invoking Spark from the erasure consumer adds an external dependency; on Spark-down the erasure must not be marked complete (fail-closed, retry via existing DLQ path).

---

#### AUD-ARCH-012 — journey-stitch-from-identity Trino serving reads bypass the fail-closed withTrinoBrand seam, using a raw createTrinoPool with a hand-written brand_id predicate
**SEV-LOW · EFFORT-S · MEASURED · Wave 4**

**Evidence:** apps/stream-worker/src/jobs/journey-stitch-from-identity.ts:72-80 constructs a raw createTrinoPool and calls trino.query(sql, params) directly at lines 98-102 and 151-156 with literal `WHERE brand_id = ? AND ...` bound to [brand.id]. This is correctly scoped per-brand today, but unlike packages/metric-engine/src/trino-deps.ts withTrinoBrand (which THROWS if the ${BRAND_PREDICATE} sentinel is absent — trino-deps.ts:122-127) and unlike the sibling DQ reader (apps/stream-worker/src/jobs/dq/silver-reader.ts:75-79 which re-implements the fail-closed guard), this path has NO fail-closed protection: a future edit dropping the brand_id predicate would run cross-brand with no guard.

**Remediation:** Route these two serving reads through withTrinoBrand per brand (call it inside the per-brand loop with brand.id), or reuse the SilverReader.scopedQuery sentinel-guard helper, so the fail-closed ${BRAND_PREDICATE} check protects this cross-brand ETL the same way the metric-engine and DQ paths are protected.

**Risk:** Low — mechanical refactor of a trusted job; the per-brand loop already has brand.id in scope, so wrapping each query in withTrinoBrand is behavior-preserving.

---

#### AUD-ARCH-013 — Trino brand isolation depends on positional client-side ?-substitution with no bound-parameter engine — a stray literal ? in any serving query would misalign the brandId predicate
**SEV-LOW · EFFORT-S · HYPOTHESIS · Wave 4**

**Evidence:** packages/metric-engine/src/trino-adapter.ts:104-142 substituteParams replaces EVERY `?` in the SQL left-to-right with the positional param; the seam appends brandId as the LAST param and relies on ${BRAND_PREDICATE} (→ `brand_id = ?`) being placed LAST in the WHERE (documented across metric-engine files, e.g. journey-mix.ts:296,367,382). If any serving query ever contains a literal `?` inside a string literal or before the sentinel, the positional mapping shifts and a data value could bind into the brand_id slot (cross-brand or error). Current scan of packages/metric-engine/src found no literal `?` inside SQL string literals, so no active defect — but the invariant is unguarded.

**Verification:** Add a lint/unit assertion that in every runScoped SQL the number of `?` equals params.length+1 AND the ${BRAND_PREDICATE} sentinel is the last placeholder; run it across all metric-engine + apps query files to prove the positional-binding invariant holds and stays enforced.

**Remediation:** Either add the CI assertion above (cheapest), or make substituteParams count-check (throw if placeholder count != param count, which it partially does at :107-112 only for underflow, not overflow/misalignment), guaranteeing a misaligned query fails loud instead of silently cross-binding brand_id.

**Risk:** Low — a pure test/guard addition; no runtime behavior change.

---

### 4.5 AUD-COST — production go-live & cost (cost-prod)

AUD-COST-001..012 are the **go-live blockers, ordered by dependency** (the sequence in which they must land): terraform apply → CI/CD identity & registry (OIDC + ECR) → ingress → secrets → ArgoCD/Workflows → Neo4j → placeholders → region fix → cluster access → Karpenter → migration runner → catalog.

| ID | Title | Sev | Effort | Tag | Wave |
|---|---|---|---|---|---|
| AUD-COST-001 | Prod Terraform never applied; bootstrap has no state; placeholder account id | CRITICAL | L | MEASURED | 1 |
| AUD-COST-002 | CI/CD identity & registry: OIDC trust + ArgoCD point at nonexistent repo; ECR push/apply IAM roles undefined (merged: 2 findings) | HIGH | M | MEASURED | 1 |
| AUD-COST-003 | No public ingress/TLS/DNS layer anywhere | CRITICAL | M | MEASURED | 1 |
| AUD-COST-004 | K8s secret delivery completely unwired (no ESO/CSI; nothing creates core-env) | HIGH | M | MEASURED | 1 |
| AUD-COST-005 | GitOps execution chain: Argo Workflows controller/CRDs + AppProjects installed nowhere | HIGH | M | MEASURED | 1 |
| AUD-COST-006 | Neo4j (identity SoR) has NO production deployment path | CRITICAL | M | MEASURED | 1 |
| AUD-COST-007 | 30+ unfilled placeholders across prod values; no CI guard | MED | S | MEASURED | 1 |
| AUD-COST-008 | Trino prod configured for WRONG AWS region (us-east-1 vs ap-south-1) | HIGH | S | MEASURED | 1 |
| AUD-COST-009 | Private-only EKS endpoint with NO access path (no bastion/VPN/SSM) | HIGH | M | MEASURED | 1 |
| AUD-COST-010 | Karpenter exists only as helm intent (no IRSA role, no discovery tags, no queue) | HIGH | M | MEASURED | 1 |
| AUD-COST-011 | No production DB migration runner for 120 PG migrations | HIGH | S | MEASURED | 1 |
| AUD-COST-012 | Dual Iceberg catalog ambiguity: Glue DBs provisioned, runtime uses JDBC REST catalog on an Aurora DB nothing creates | MED | M | MEASURED | 1 |
| AUD-COST-013 | Silver/Gold Iceberg maintenance not scheduled in prod; NO tier has orphan-file cleanup | MED | S | MEASURED | 3 |
| AUD-COST-014 | No S3 storage-class transitions (Intelligent-Tiering) on medallion buckets | LOW | S | MEASURED | 3 |
| AUD-COST-015 | Strimzi-over-MSK is a de-facto (undocumented) decision — ADR addendum | LOW | S | MEASURED | 5 |

Go-live decisions already recorded: Aurora Serverless v2 + fck-nat are ACCEPTED per ADR-0009 (2026-06-30) — the "decision needed" finding was refuted (see Appendix). Estimated prod steady-state cost ~$290-450/mo.

---

#### AUD-COST-001 — GO-LIVE: prod Terraform has never been applied — envs/prod is bootstrap-only with every runtime module commented out, and even the bootstrap has no state
**SEV-CRITICAL · EFFORT-L · MEASURED · Wave 1 · confirmed**

**Evidence:** infra/terraform/envs/prod/bootstrap.tf:5-6 ('NO apply of compute until M4. Zero running AWS resources; zero idle spend'); bootstrap.tf:64-246 all runtime modules (network, nat_instance, vpc_endpoints, eks, aurora, secrets, s3_iceberg, s3_audit, irsa_collector/stream_worker/core, elasticache, s3_iceberg_silver/gold, irsa_spark_jobs) commented out — only kms + oidc_github live; infra/terraform/envs/prod/backend.tf:8 bucket = "brain-tfstate-prod-<PROD_ACCOUNT_ID>" (placeholder → terraform init cannot run); find infra/terraform -name '*.tfstate*' returns nothing; infra/terraform/bootstrap/ contains only main.tf + .terraform/ + .terraform.lock.hcl (init'd 2026-06-15, never applied; local-state root so an apply would leave terraform.tfstate in-dir); infra/terraform/bootstrap/main.tf creates ONLY state bucket + DynamoDB lock + state KMS — no OIDC provider/apply role, contradicting .github/workflows/prod-apply.yml:9-10 prerequisites. NUANCE vs original: the OIDC provider + apply role ARE declared (uncommented) in envs/prod/bootstrap.tf module "oidc_github" — not absent from the repo, but placed in the envs/prod root, creating a chicken-and-egg: prod-apply.yml assumes via OIDC the role that only an initial manual/local apply of envs/prod can create, and envs/prod's S3 backend needs the state bucket from the never-applied bootstrap root. CAVEAT: this state is intentional and documented (EC10 deferred-apply discipline, ADR-0009, gated prod-apply.yml with confirm phrase + production environment approval, docs/runbooks/prod-m4-turn-on.md) — a planned milestone, not a hidden defect; severity holds only under GO-LIVE framing.

**Remediation:** Execute the M4 turn-on path end-to-end: (1) create/choose the prod AWS account, fill <PROD_ACCOUNT_ID> in backend.tf + bootstrap.tf; (2) apply infra/terraform/bootstrap (state bucket/lock/KMS); (3) apply envs/prod bootstrap layer (kms + oidc_github); (4) uncomment and apply the M4 blocks in dependency order (network → nat_instance + vpc_endpoints → eks → aurora/elasticache/secrets/s3_* → irsa_*) via the existing prod-apply.yml staged -target input. Budget 1-2 full days; the workflow's own estimate is ~$240-320/mo (estimate).

**Risk:** Applying infra creates real spend and real state; a staged -target apply order that violates module dependencies fails cleanly (plan errors), low technical risk. Main risk is schedule: this is the critical path for the 2-day go-live.

**Verifier note:** Every evidence citation verified exactly: bootstrap.tf header lines 5-6; all runtime modules commented out at lines 64-246; backend.tf:8 has the literal <PROD_ACCOUNT_ID> placeholder (init impossible); no *.tfstate anywhere under infra/terraform; bootstrap/ init'd Jun 15, never applied; bootstrap/main.tf creates only state bucket + lock table + KMS, contradicting prod-apply.yml:9-10's prerequisite claim of 'OIDC provider + apply role'. No commit on audit/stage-b-remediation or recent master (#338-#342) touches infra/terraform. The only mitigation is that this state is INTENTIONAL and documented (EC10 deferred-apply, ADR-0009, gated prod-apply.yml, runbook prod-m4-turn-on.md) — it is a planned milestone, not a latent defect — but as a GO-LIVE blocker the MEASURED claim is fully accurate and SEV-CRITICAL is justified for go-live scope: prod cannot be stood up without manual placeholder-filling, a chicken-and-egg local bootstrap apply, then staged uncommenting.

---

#### AUD-COST-002 — GO-LIVE: CI/CD identity & registry — GitHub OIDC trust + all ArgoCD Applications point at a repo that does not exist (brain-platform/brain@main vs Rishabhporwal/Brain-V4@master); ECR push/apply IAM roles defined nowhere
**SEV-HIGH · EFFORT-M · MEASURED · Wave 1 · confirmed (merged: OIDC-trust finding [HIGH] + ECR/IAM-roles finding [MED, half-refuted] — both evidence trails below)**

**Evidence (OIDC/repo mismatch):** git remote -v → https://github.com/Rishabhporwal/Brain-V4.git (default branch master); GitHub API: brain-platform/brain → 404, Rishabhporwal/Brain-V4 → 200. infra/terraform/envs/prod/bootstrap.tf:53-54 github_org="brain-platform" github_repo="brain" (line 55 allowed_branches=["master"] was ALREADY corrected from "main", proving the org/repo half was missed; header comment says module is "APPLIED in bootstrap"). infra/terraform/envs/staging/main.tf:63-65 same org/repo + allowed_branches=["main"] (wrong branch too). ArgoCD: all 10 prod manifests reference repoURL https://github.com/brain-platform/brain — core.yaml:15-16, web.yaml:15-16, trino.yaml:16-17, stream-worker.yaml:16-17, cronworkflows.yaml:15-16, iceberg-rest.yaml:15-16 (targetRevision: main), collector.yaml:24-25 (targetRevision: HEAD), strimzi-kafka.yaml:91-92, karpenter.yaml:113-114, keda.yaml:29-30 (main). ALSO affected beyond original citation: infra/argocd/app-of-apps.yaml:24 and all 5 staging manifests (core/web/stream-worker/cronworkflows/collector) same wrong repoURL; infra/terraform/envs/dev/main.tf:63 carries literal "Replace with actual org name" placeholder comment.

**Evidence (ECR + IAM roles):** ECR repositories DO exist in terraform: infra/terraform/modules/eks/main.tf:242-281 defines aws_ecr_repository "services" for_each over ["collector","stream-worker","core","web","spark-bronze"] (IMMUTABLE tags, scan_on_push, KMS encryption) plus aws_ecr_lifecycle_policy (line 263); the module is commented out in infra/terraform/envs/prod/bootstrap.tf:96 pending the documented M4 uncomment step (docs/runbooks/prod-m4-turn-on.md:45). The REAL gap is the two CI IAM roles: (1) .github/workflows/main.yml:63 and :163 assume vars.AWS_ECR_PUSH_ROLE_ARN, but no terraform defines any role with ECR push permissions (grep for GetAuthorizationToken/ecr:Put/InitiateLayerUpload in infra/terraform = 0); (2) .github/workflows/prod-apply.yml:55 assumes vars.AWS_PROD_APPLY_ROLE_ARN and its prerequisite comment (lines 9-10) plus docs/runbooks/prod-m4-turn-on.md:48 claim infra/terraform/bootstrap creates "OIDC provider + apply role", but infra/terraform/bootstrap/main.tf (173 lines) contains only the state KMS key/alias, S3 state bucket, and DynamoDB lock table — no aws_iam_role and no aws_iam_openid_connect_provider. The only CI role in the repo is github_plan (infra/terraform/modules/oidc-github/main.tf:101-190, read-level Describe*/List* — cannot apply); the OIDC provider itself IS created there (line 56) via the oidc_github module instantiated at envs/prod/bootstrap.tf:49. REPLACE_WITH_ECR_REGISTRY helm placeholders are expected (registry URL is a terraform output, unknowable pre-apply).

**Remediation:** (a) Set github_org="Rishabhporwal", github_repo="Brain-V4" in envs/prod/bootstrap.tf + envs/staging/main.tf (staging also allowed_branches=["master"]), and sed repoURL→https://github.com/Rishabhporwal/Brain-V4 + targetRevision→master across infra/argocd/envs/*/*.yaml. (b) Add to the prod bootstrap layer: a github-ecr-push role (scoped to the 5 existing-in-module ECR repos) and a github-apply role (admin-scoped or PowerUser + IAM-limited) trusted by the existing OIDC provider; set the repo variables (AWS_ECR_PUSH_ROLE_ARN, AWS_PROD_APPLY_ROLE_ARN, ENVIRONMENT) and fill REPLACE_WITH_ECR_REGISTRY; fix the false prerequisite comments in prod-apply.yml + the runbook.

**Risk:** Repo/branch values are currently non-functional; correcting them cannot break anything running. The apply role is powerful — restrict its trust to workflow_dispatch on master + the production GitHub Environment (already gated in prod-apply.yml:39).

**Verifier note (OIDC):** Verified: brain-platform/brain returns 404 on the GitHub API while the real remote is Rishabhporwal/Brain-V4 (default branch master). The prod bootstrap comment explicitly says the OIDC module is APPLIED for the CI plan gate, and the branch half of this exact mismatch was already fixed (allowed_branches "main"→"master" with a comment) while the org/repo half was missed — so this is a live, real defect, not an unapplied placeholder. SEV-HIGH GO-LIVE is justified: every GitHub Actions OIDC role assumption would be rejected and every ArgoCD sync would 404, breaking the entire deploy path (fails loudly at first deploy, so not CRITICAL).
**Verifier note (ECR/IAM):** Half-refuted, half-confirmed. REFUTED: the headline "no ECR repositories exist in any terraform" is false — the audit's grep missed infra/terraform/modules/eks/main.tf:242-281, which defines aws_ecr_repository ×5 with lifecycle policy; most of the proposed repo-creation remediation already exists (M4 uncomment step). CONFIRMED: no terraform anywhere creates the ECR-push or prod-apply IAM roles referenced by main.yml:63,163 and prod-apply.yml:55; modules/oidc-github creates only the read-level github_plan role, and infra/terraform/bootstrap/main.tf contains no IAM role and no OIDC provider — despite prod-apply.yml:9-10 and the runbook claiming bootstrap creates the apply role. Following the documented runbook dead-ends. Severity for this half: SEV-MED (deliberately gated blueprint, zero current impact).

---

#### AUD-COST-003 — GO-LIVE: no public ingress/TLS/DNS layer exists anywhere — collector (pixel endpoint), web, and core are ClusterIP-only with no ALB controller, cert-manager, external-dns, or Route53
**SEV-CRITICAL · EFFORT-M · MEASURED · Wave 1 · confirmed**

**Evidence:** infra/helm/collector/values.yaml:11-15 service.type: ClusterIP (port 80→targetPort 3001), with no override in infra/helm/{collector,web,core}/values-prod.yaml; infra/helm/web/values.yaml:12 and infra/helm/core/values.yaml:12 also type: ClusterIP. infra/helm/{collector,web,core}/templates/ contain only _helpers.tpl + deployment/hpa/service/serviceaccount.yaml (no ingress.yaml). Repo-wide grep (all *.yaml/*.tf, not just infra/) for 'kind: Ingress|alb.ingress|cert-manager|external-dns|aws-load-balancer-controller' = ZERO files. infra/terraform has no aws_lb/aws_acm*/aws_route53*/elbv2 resources or LB/DNS/cert module (envs/prod = backend.tf + bootstrap.tf only). infra/argocd/envs/prod/*.yaml deploys only collector/core/web/stream-worker/trino/strimzi-kafka/iceberg-rest/karpenter/keda/cronworkflows — no LB controller. No alternate ingress path: no CloudFront/API Gateway/nginx/traefik/LoadBalancer-type Service anywhere; infra/helm/strimzi-kafka/templates/kafka-cr.yaml:67 explicitly "INTERNAL listeners only — no external/LoadBalancer exposure".

**Remediation:** Add an ingress lane before go-live: install aws-load-balancer-controller (ArgoCD app + IRSA role in terraform), add Ingress templates (or switch collector/web Service to type LoadBalancer via NLB annotations as a 2-day stopgap), provision an ACM cert + Route53 zone/records for the collector and app hostnames.

**Risk:** Low — purely additive manifests. Stopgap NLB-per-service costs ~$16-20/mo each (estimate) vs one shared ALB; can consolidate post-launch.

**Verifier note:** Every evidence element verified exactly; no alternate ingress exists either (cloudflared tunnel is local-dev only, absent from infra/). Recent commits touch nothing ingress-related. SEV-CRITICAL is justified as a GO-LIVE blocker: with ClusterIP-only services and no ingress/TLS/DNS layer, zero pixel/app/API traffic can reach prod — event loss by construction, violating the "No event loss" core rule. Nuance: prod terraform is a not-yet-applied blueprint, so this is a launch blocker rather than a live outage, which matches the GO-LIVE tag.

---

#### AUD-COST-004 — GO-LIVE: Kubernetes secret delivery is completely unwired — every chart consumes envSecretName: core-env but nothing (no External Secrets Operator, no CSI driver, no runbook job) creates it from AWS Secrets Manager
**SEV-HIGH · EFFORT-M · MEASURED · Wave 1 · confirmed**

**Evidence:** grep -rln 'external-secrets|ExternalSecret|secrets-store-csi' infra/ = ZERO (repo-wide, the pattern appears only in comments/docs: infra/terraform/modules/secrets/main.tf:4 'External-Secrets Operator pattern for injection into pods'; docs/runbooks/enable-prod-cron-pipeline.md:33 and docs/runbooks/enable-attribution-unlocks.md:22 both cite 'core-env secret (External Secrets ← AWS Secrets Manager)' as a prerequisite that nothing provisions). Consumers with no producer: infra/helm/core/values-prod.yaml:8 envSecretName: core-env; infra/helm/cronworkflows/values-prod.yaml:27 envSecretName: core-env (templates/spark-v4.yaml:112 secretRef comment: 'ICEBERG_REST_URI/Glue + AWS_* + NEO4J_* (mart dim reads)'); PLUS web-env, collector-env, stream-worker-env, pgbouncer-env (each values-prod.yaml:8) — every prod workload chart. infra/argocd/envs/prod/ has exactly 10 apps — no ESO or CSI-driver app. No stopgap: grep 'kubectl create secret' across docs/, infra/, .engineering-os = zero. infra/terraform/modules/secrets/main.tf creates only aws_secretsmanager_secret shells (values never in TF state) + IRSA-scoped read policies — no bridge into the cluster.

**Remediation:** Install External Secrets Operator (ArgoCD app) + an IRSA role with the existing per-service secrets policies, and add ExternalSecret manifests per namespace mapping the Secrets Manager entries → core-env (and collector/stream-worker equivalents). 2-day stopgap: a documented `kubectl create secret generic core-env --from-env-file` runbook step, flagged for replacement.

**Risk:** Stopgap manual secrets drift silently from Secrets Manager and bypass rotation; if used, timebox it and keep Secrets Manager as the source of truth.

**Verifier note:** Every cited evidence point checks out exactly, and the gap is unremediated on this branch. The only repo-wide mentions are aspirational comments and runbooks that list the core-env-via-External-Secrets bridge as a prerequisite someone else is assumed to have built. All prod charts consume *-env secrets via envSecretName, infra/argocd/envs/prod/ contains no ESO/CSI app, and there is no manual 'kubectl create secret' runbook step anywhere. The terraform secrets module only creates Secrets Manager shells + IRSA read policies — no in-cluster producer exists for any of the five consumed secrets. SEV-HIGH (go-live blocker, not active outage since prod EKS is not yet applied) is the correct severity.

---

#### AUD-COST-005 — GO-LIVE: Argo Workflows controller + CronWorkflow CRDs are installed by nothing (all Spark crons have no prod execution path), and no AppProject manifest exists for the project every Application references
**SEV-HIGH · EFFORT-M · MEASURED · Wave 1 · confirmed (headline narrowed by verifier — ArgoCD-install and Kafka bring-up ARE documented)**

**Evidence:** ArgoCD install IS documented: docs/runbooks/prod-m4-turn-on.md:79-81 (`helm install argocd argo/argo-cd -n argocd --create-namespace`), and Kafka bring-up IS documented (lines 84-88: apply infra/argocd/envs/prod/strimzi-kafka.yaml, sync, wait for kafka/brain-prod-kafka Ready) — the original evidence's infra/-only greps missed docs/runbooks. The REAL gap is Argo Workflows: repo-wide grep for `argo-workflows|workflow-controller` across *.sh/*.tf/*.yaml/*.md hits only historical audit docs — no runbook step, helm chart, terraform, or ArgoCD Application installs the workflow-controller or the argoproj.io/v1alpha1 CronWorkflow CRDs, yet prod-m4-turn-on.md:99 syncs the `cronworkflows` app (infra/helm/cronworkflows/templates/{cronworkflows,spark-bronze,spark-v4}.yaml emit CronWorkflow CRs into ns `argo`) and line 122 runs `argo submit -n argo --from cronworkflow/v4-silver` — the sync fails on an unknown CRD, so the Spark Bronze landing and Silver/Gold refresh crons have no prod execution path; prod-deploy.md §2's add-on table (which honestly flags Strimzi/Karpenter as to-be-created) omits Argo Workflows entirely, making this a silent gap. Also real: `grep -rn 'kind: AppProject'` = 0 repo-wide while all infra/argocd/envs/prod/*.yaml set spec.project: brain-prod (e.g. strimzi-kafka.yaml:30, core.yaml:13) and infra/argocd/app-of-apps.yaml sets project: brain — ArgoCD rejects sync of Applications referencing a nonexistent AppProject, and neither project is created anywhere in repo or runbooks.

**Remediation:** Add two bootstrap installs (helm or a documented one-time `helm install` runbook step): argo-cd into namespace argocd (already documented) and argo-workflows (workflow-controller + CRDs) into the namespace the CronWorkflows target; then create the brain-prod ArgoCD AppProject referenced by every Application (and brain for app-of-apps).

**Risk:** Low — standard cluster bootstrap. Ordering matters: ArgoCD → Strimzi operator (wave 0) → Kafka CR (wave 1) → app charts; the strimzi app's retry block already absorbs CRD races.

**Verifier note:** Headline is overstated and two of three legs are refuted, but a real go-live gap survives. REFUTED: (1) "nothing installs ArgoCD" — prod-m4-turn-on.md:79-81 documents the exact bootstrap the remediation proposes. (2) "collector→Kafka→Bronze has no standing-up mechanism (+1 severity)" — prod-m4-turn-on.md:84-88 applies strimzi-kafka.yaml and waits for Ready; the severity escalation is unjustified. STILL REAL: (a) nothing anywhere installs the Argo Workflows controller or CronWorkflow CRDs, yet the runbook syncs cronworkflows into ns `argo` and runs `argo submit` — the cronworkflows-prod sync fails on an unknown CRD and no Spark Bronze/Silver/Gold cron can run in prod; this gap is silent. (b) `kind: AppProject` = 0 repo-wide while every prod Application sets spec.project: brain-prod — ArgoCD refuses to sync. Downgraded to SEV-HIGH: still a prod go-live blocker for the entire Spark compute tier, but not "entire GitOps chain uninstallable", and both residual gaps surface immediately at bring-up with runbook-level fixes.

---

#### AUD-COST-006 — GO-LIVE: Neo4j — the identity system-of-record (ADR-0004) — has NO production deployment path at all (not in terraform, helm, or ArgoCD)
**SEV-CRITICAL · EFFORT-M · MEASURED · Wave 1 · confirmed**

**Evidence:** `grep -rln -i neo4j infra/` matches only CONSUMERS, never a deployment: infra/kafka/topics.yml:81 (identity bridge topic), infra/helm/cronworkflows/README.md, values.yaml:127/194-197/241-244 (identity-export + phone-guard crons "Need NEO4J_*"; "Neo4j is the identity SoR"), and templates/spark-v4.yaml:112 (NEO4J_* injected from envSecretName for mart dim reads). There is NO neo4j module in infra/terraform/modules/ (aurora/rds/elasticache/eks/secrets... exist; secrets module defines no NEO4J vars), NO infra/helm/neo4j chart, and NO neo4j app in infra/argocd/envs/prod/ (10 apps only). The sole Neo4j definition in the repo is docker-compose.yml:92-108 (neo4j:5.21-community, dev "core" profile, mem_limit 1500m). Prod dependency is hard: identity-export cron (Neo4j graph → silver_identity_link) must run before v4-silver per docs/ops/batch-scheduling.md:53, and stream-worker (identity resolution/journey stitch, ADR-0004 SoR) consumes NEO4J_* via envFrom secretRef (infra/helm/stream-worker/templates/deployment.yaml:42-43).

**Remediation:** Decide and provision the prod Neo4j before go-live: fastest is Neo4j AuraDB Professional (managed, ~$65-200/mo estimate depending on size) with the endpoint in the core-env secret; alternative is a Helm-deployed neo4j on EKS with an EBS gp3 PVC (community edition = no HA — acceptable only with documented backup/restore). Wire NEO4J_URI/USER/PASSWORD into the secrets module + core-env.

**Risk:** Managed Aura adds a vendor + egress latency from ap-south-1 (check region availability); self-hosted community edition is a single point of failure for identity resolution — either way document the backup story (identity graph is rebuildable from Silver but rebuild time must be known).

**Verifier note:** Confirmed: Neo4j (identity SoR per docs/adr/0004-neo4j-identity-sor.md) has no deployment definition in infra/terraform/modules, infra/helm (12 charts), or infra/argocd/envs/prod (10 apps). Prod workloads demonstrably require it: spark-v4.yaml:112 injects NEO4J_* from the env secret, identity-export + phone-guard crons need NEO4J_*, and stream-worker consumes the same secret via envFrom. The terraform secrets module doesn't even define NEO4J vars. Without Neo4j, identity-export → silver_identity_link → Silver order spine brain_id resolution → attribution all fail, so SEV-CRITICAL as a go-live gate is justified. One evidence inaccuracy corrected: grep -rln neo4j infra/ does match 4 files, but all are consumers/references, not deployments.

---

#### AUD-COST-007 — GO-LIVE: 30+ unfilled placeholders across every prod values file — ACCOUNT_ID IRSA ARNs (9 charts), REPLACE_WITH_AURORA_ENDPOINT, REPLACE_WITH_PROD_POSTGRES_HOST, REPLACE_WITH_PROMETHEUS_ADDRESS, REPLACE_WITH_ECR_REGISTRY/DIGEST
**SEV-MED · EFFORT-S · MEASURED · Wave 1 · confirmed (downgraded from HIGH by verifier)**

**Evidence:** grep -rn 'REPLACE_WITH|ACCOUNT_ID' infra → verified: infra/helm/iceberg-rest/values-prod.yaml:4 (REPLACE_WITH_AURORA_ENDPOINT) + :10 (ACCOUNT_ID IRSA roleArn); ACCOUNT_ID IRSA annotations in infra/helm/{core,web,collector,stream-worker}/values-prod.yaml:12, trino/values-prod.yaml:43, cronworkflows/values-prod.yaml:32; infra/helm/pgbouncer/values-prod.yaml:7 (REPLACE_WITH_PROD_POSTGRES_HOST); infra/argocd/envs/prod/karpenter.yaml:64 (ACCOUNT_ID); infra/argocd/rollouts/analysis-templates.yaml:25,49 + collector-rollout.yaml:28,48,59 (REPLACE_WITH_PROMETHEUS_ADDRESS / REPLACE_WITH_ECR_REGISTRY@REPLACE_WITH_DIGEST). CORRECTIONS: (a) REPLACE_WITH_ECR_REGISTRY/digest in the app charts are auto-overwritten by the prod-promote job in .github/workflows/main.yml — exclude from the unfilled-at-deploy set; the rollouts/ files are NOT touched by CD. (b) No automated prod deploy exists: prod ArgoCD apps have no automated syncPolicy and prod-promote requires 'production' Environment approval. (c) prod-apply.yml:13 documents placeholder fill as a manual prerequisite (comment only — no enforcement); no grep guard for REPLACE_WITH|ACCOUNT_ID in any workflow or tools/lint. Residual true gap: IRSA ACCOUNT_ID ARNs (7 prod values files), Aurora endpoint, pgbouncer prod host, Prometheus address, karpenter controller role — all manual-fill with zero CI enforcement.

**Remediation:** After the terraform apply (AUD-COST-001), run a single fill pass from `terraform output` (account id, Aurora endpoint, IRSA role ARNs, ECR registry, Prometheus address) — script it (yq) so it is repeatable, and add a CI guard that greps values-prod files for REPLACE_WITH|ACCOUNT_ID and fails the prod-promote job while any remain.

**Risk:** None for the guard; fill values are mechanical once terraform outputs exist.

**Verifier note:** Evidence VERIFIED at every cited location and NOT fixed on this branch (HEAD 5d5d1bee). No CI guard exists. HOWEVER, three material corrections weaken it to SEV-MED: (1) "CD would silently deploy" is wrong — every prod ArgoCD Application explicitly has NO automated syncPolicy and prod-promote sits behind the 'production' GitHub Environment approval (two manual gates); (2) the ECR registry/digest placeholders in the 4 app charts + cronworkflows are AUTO-FILLED by the prod-promote job; (3) prod is a not-yet-applied blueprint — the values genuinely cannot be filled until terraform apply produces them, so this is a documented pending state, and the genuine gap is only the missing automated guard. Failure would also be loud (CrashLoop on AWS auth at first manual sync), not silent data corruption.

---

#### AUD-COST-008 — GO-LIVE: Trino prod is configured for the WRONG AWS region — iceberg.s3.region: us-east-1 while every bucket, VPC and endpoint is ap-south-1
**SEV-HIGH · EFFORT-S · MEASURED · Wave 1 · confirmed**

**Evidence:** infra/helm/trino/values-prod.yaml:36 `region: us-east-1` (under `iceberg.s3:` block at line 33; `endpoint: ""` → real AWS S3 via IRSA), rendered into the Trino iceberg catalog at infra/helm/trino/templates/configmaps.yaml:68 (`s3.region={{ .Values.iceberg.s3.region }}`, fs.native-s3.enabled=true). Mismatches: infra/terraform/envs/prod/bootstrap.tf:20 provider region ap-south-1 (medallion bucket modules inherit it; currently commented, M4-gated) and infra/helm/iceberg-rest/values-prod.yaml:7 `s3Region: ap-south-1` (warehouse s3://brain-prod-bronze/). Deployment wiring: infra/argocd/envs/prod/trino.yaml deploys infra/helm/trino with valueFiles [values-prod.yaml]. SigV4 region mismatch → 400 AuthorizationHeaderMalformed on every S3 read; Trino is the sole serving engine, so all brain_serving.mv_* reads fail at go-live. Same us-east-1 default also in infra/helm/trino/values.yaml:72 (dev/MinIO — harmless there).

**Remediation:** Set iceberg.s3.region: ap-south-1 in infra/helm/trino/values-prod.yaml. **Risk:** None.

**Verifier note:** Confirmed unrefuted. Trino 455 native-s3 signs with the configured region and does not cross-region-redirect by default, so reads against ap-south-1 buckets would fail 400 AuthorizationHeaderMalformed — the stated failure mode is technically accurate. Not fixed by any recent commit. SEV-HIGH GO-LIVE is justified: prod is currently bootstrap-only (zero running resources), so no live outage today, but at go-live it deterministically breaks all mv_* serving reads through the sole serving engine. Only correction: evidence cited ~line 34; actual line is 36.

---

#### AUD-COST-009 — GO-LIVE: prod/staging EKS API endpoint is private-only but there is NO access path (no bastion, no VPN, no SSM, no client-VPN module) — after apply, nobody can run kubectl/helm/argocd bootstrap
**SEV-HIGH · EFFORT-M · MEASURED · Wave 1 · confirmed**

**Evidence:** infra/terraform/modules/eks/main.tf:94-96 (comment 'staging and prod always use private-only (public_endpoint = false)' + endpoint_public_access = var.public_endpoint, variable default false at :75-79); infra/terraform/envs/staging/main.tf:88 sets public_endpoint = false explicitly; docs/runbooks/prod-deploy.md:40 mandates public_endpoint = false for prod. No bastion/vpn/ssm/client-vpn module under infra/terraform/modules/ (inventory: _shared, aurora, eks, elasticache, irsa, kms, nat-instance, network, observability, oidc-github, rds, s3-audit, s3-iceberg, s3-iceberg-medallion, secrets, vpc-endpoints). Suggested SSM path is non-functional: modules/nat-instance/main.tf has no iam_instance_profile or IAM resources (SSM agent cannot register; README:101-102 only aspirationally references Session Manager), and modules/vpc-endpoints default interface_services = [sts, secretsmanager, ecr.api, ecr.dkr, logs] — no ssm/ssmmessages/ec2messages endpoints. CI cannot substitute: .github/workflows/main.yml and prod-apply.yml run on GitHub-hosted ubuntu-latest (no in-VPC self-hosted runner) and only commit helm values (GitOps pull); the one-time bootstrap in docs/runbooks/prod-deploy.md (§2 prerequisites kubectl/helm/argocd CLIs; §3 'kubectl apply -f infra/argocd/app-of-apps.yaml' + 'argocd app sync/wait' + kubectl verification) requires direct API access that no component provides.

**Remediation:** For the 2-day window: apply prod EKS with public_endpoint=true restricted via public_access_cidrs to your office/home IP, then flip to private-only after an SSM-based bastion (t4g.nano + SSM agent, ~$3-4/mo estimate) or AWS Client VPN (~$75+/mo estimate) is in place. Add the chosen access module to terraform.

**Risk:** Temporary public endpoint (CIDR-pinned + EKS RBAC) is a modest, standard bootstrap posture; document the flip-back date.

**Verifier note:** Finding confirmed. Every candidate access path refutes itself: the nat-instance README suggests SSM Session Manager but nat-instance/main.tf provisions NO iam_instance_profile/IAM resources so the instance can never register with SSM; vpc-endpoints default interface_services omit ssm/ssmmessages/ec2messages; all GitHub workflows run on ubuntu-latest (no self-hosted runner in-VPC). CD is GitOps-pull so steady-state is fine, but the one-time bootstrap requires operator-run kubectl/helm/argocd CLIs — unreachable against a private-only endpoint. SEV-HIGH stands: hard go-live blocker, but detected immediately at bootstrap and quickly remediable without data/security impact.

---

#### AUD-COST-010 — GO-LIVE: Karpenter (all Spot capacity + scale-to-zero for batch/Trino) exists only as helm intent — the controller IRSA role is in no terraform, and the eks/network modules never set the karpenter.sh/discovery tags the pools require
**SEV-HIGH · EFFORT-M · MEASURED · Wave 1 · confirmed**

**Evidence:** infra/helm/karpenter/values.yaml:22-24 (not 23-26): "The eks/network modules do NOT set this tag yet — the operator must add `karpenter.sh/discovery=<this value>` to the private subnets and the node SG"; infra/argocd/envs/prod/karpenter.yaml:64 controller SA annotation eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT_ID:role/brain-prod-karpenter-controller (literal ACCOUNT_ID placeholder; line 60 comment claims the role is "created in modules/eks/irsa" but no such path/resource exists — modules/irsa contains no karpenter role); `grep -rin karpenter infra/terraform` = 0 matches (controller IRSA role, iam:PassRole/instance-profile policy, and SQS interruption queue `brain-prod` referenced at karpenter.yaml:70 defined nowhere); modules/eks/main.tf:193-205 aws_eks_node_group.system instance_types=["t4g.medium"] is the ONLY terraform node group, and the Karpenter controller is itself pinned to it (karpenter.yaml:81-82 nodeSelector role: system). Corroborating: infra/helm/karpenter/README.md sections "Wiring the operator must do (NOT done by this chart)" and "IAM the operator must add to modules/eks/irsa" document the exact missing pieces without implementing them. Additional context: infra/terraform/envs/prod/bootstrap.tf:105-107 shows the prod eks module invocation itself still commented out.

**Remediation:** Add to prod terraform: karpenter controller IRSA role + node instance-profile policy (Karpenter v1 docs module), and karpenter.sh/discovery = brain-prod tags on private subnets (modules/network) and the node SG (modules/eks). Then the existing ArgoCD karpenter app + nodepools chart work as designed.

**Risk:** Spot-only pools for stream-worker carry interruption risk on the ingest path; the WhenEmpty consolidation policy + warm replica baseline mitigates but consider on-demand fallback (capacityType weights) for the streaming pool at go-live.

**Verifier note:** Every evidence element verified. The repo's own karpenter README explicitly confirms the missing IRSA role, PassRole/instance-profile perms, interruption queue, and discovery tags — the gap is documented but unimplemented, so Karpenter is helm intent only and no non-system capacity (Spark batch/Trino workers/stream-worker) would exist at go-live, and the all-Spot + scale-to-zero cost design never engages. SEV-HIGH is appropriate: hard go-live blocker for all workload capacity, but prod terraform is not yet applied and the ArgoCD app is manual-sync-gated with a README runbook, so it is discoverable pre-impact rather than a live outage.

---

#### AUD-COST-011 — GO-LIVE: no production database migration runner — 120 PG migrations have no execution vehicle against Aurora/RDS (locally run via pnpm scripts only)
**SEV-HIGH · EFFORT-S · MEASURED · Wave 1 · confirmed**

**Evidence:** `grep -rn migrate infra/helm` matches only a comment (infra/helm/cronworkflows/values.yaml:92, about Spark lag); no Job/hook template in infra/helm/core/templates (only _helpers.tpl/deployment/hpa/service/serviceaccount), no helm.sh/hook or ArgoCD PreSync anywhere in infra/helm or infra/argocd, and no migration CronWorkflow. There are 120 migrations (db/migrations/0001–0120), not 116. pnpm migrate:up appears only in CI test workflows (.github/workflows/pr.yml:61, integration.yml:90,164); the prod workflows (main.yml, prod-apply.yml, infra.yml) contain no migration step, and apps/core/Dockerfile + apps/stream-worker/Dockerfile have no migration entrypoint. Partial mitigant that does NOT close the gap: docs/runbooks/prod-m4-turn-on.md:139 has a GA-gate checklist bullet "Aurora reachable (private only); migrations applied (pnpm migrate against the prod DB URL)" — but it is a post-hoc Phase-7 verification item, while the runbook's Phase-3 deployment sequence (lines 98–100) syncs core/stream-worker via ArgoCD with no prior migration step, and it gives no mechanism to reach the private-only Aurora. Supporting the remediation: apps/core/Dockerfile does COPY . . with devDeps (--prod=false), so the brain-core image already contains db/migrations, scripts/migrate.mjs and node-pg-migrate and is directly usable as a helm pre-install/pre-upgrade Job image.

**Remediation:** Add a helm pre-install/pre-upgrade Job (core chart) that runs the migration entrypoint from the brain-core image against DATABASE_URL, gated by a helm value; or a documented one-time runbook step for go-live. Must run before first core/stream-worker rollout.

**Risk:** Pre-upgrade hooks add deploy-time coupling; keep migrations backward-compatible (already the repo norm — additive/nullable).

**Verifier note:** Verified: no production migration execution vehicle exists. The one near-miss — the prod-m4-turn-on.md:139 checklist bullet — does not refute it: it is a Phase-7 verification bullet placed AFTER the runbook's Phase-3 step that syncs core/stream-worker via ArgoCD, and Aurora is private-only with no documented access mechanism, so as written the first prod rollout boots against an unmigrated DB and crash-loops (stream-worker JDBC-reads PG at startup). Deterministic go-live blocker → SEV-HIGH stands.

---

#### AUD-COST-012 — Dual Iceberg catalog ambiguity in prod: terraform provisions Glue catalog databases while the runtime (Trino + Spark + iceberg-rest chart) uses a JDBC REST catalog backed by an Aurora database that nothing creates
**SEV-MED · EFFORT-M · MEASURED · Wave 1**

**Evidence:** infra/terraform/modules/s3-iceberg-medallion/main.tf:166-169 creates aws_glue_catalog_database (brain_silver/brain_gold) and modules/s3-iceberg does the same for Bronze; but infra/helm/trino/values-prod.yaml restUri: http://iceberg-rest.iceberg.svc... and infra/helm/iceberg-rest/values-prod.yaml:4-6 back the catalog on jdbcDatabase: iceberg_catalog @ Aurora — no terraform/migration/runbook creates the `iceberg_catalog` database or its schema on the Aurora cluster, and the Glue DBs would sit empty (paid-for but unused metadata path). Local dev's SQLite-file catalog (docker-compose iceberg-rest) does not carry over.

**Remediation:** Pick ONE catalog for prod (the REST/JDBC path is what all code uses — brain_{bronze,silver,gold}_local rest catalogs per CLAUDE.md): add a bootstrap step creating the iceberg_catalog database + owner role on Aurora (migration or terraform postgresql provider), and either delete the aws_glue_catalog_database resources or mark them explicitly as a dormant fallback in the module docs.

**Risk:** Removing Glue DBs is safe (nothing reads them); creating the catalog DB is additive.

---

#### AUD-COST-013 — Silver/Gold Iceberg maintenance (compaction + snapshot expiry) is not scheduled in prod, and NO tier has orphan-file cleanup — unbounded S3 growth on the medallion
**SEV-MED · EFFORT-S · MEASURED · Wave 3** · *(prod counterpart of AUD-PERF-004)*

**Evidence:** Only Bronze maintenance is cron-wired: infra/helm/cronworkflows/templates/spark-bronze.yaml:133 runs bronze_maintenance.py (values.yaml:70 daily 03:00). db/iceberg/spark/medallion_maintenance.py (Silver/Gold rewrite_data_files + expire_snapshots) appears in NO CronWorkflow template (`grep -rn medallion_maintenance infra/helm/cronworkflows/templates/` = 0), and `grep -n remove_orphan_files db/iceberg/spark/*.py` = 0 — failed/aborted Spark writes leave orphan data files that expire_snapshots never touches. The S3 lifecycle rules only trim noncurrent versions + multipart uploads (modules/s3-iceberg-medallion/main.tf:145-160). Silver/Gold are rewritten hourly (spark-v4 values.yaml:122-123) → snapshot + orphan accumulation compounds fast at hourly cadence.

**Remediation:** Add a v4-maintenance CronWorkflow to the cronworkflows chart invoking medallion_maintenance.py (weekly is fine), and add a guarded remove_orphan_files pass (older_than 7d, dry-run first) to both maintenance jobs.

**Risk:** remove_orphan_files can delete files of in-flight commits if the older_than window is too tight — keep >= 3 days and never run concurrently with active writes (schedule after the maintenance compaction slot).

---

#### AUD-COST-014 — No S3 storage-class transitions (Intelligent-Tiering) on the medallion buckets despite 24-month Bronze retention — all data sits in S3 Standard forever
**SEV-LOW · EFFORT-S · MEASURED · Wave 3**

**Evidence:** infra/terraform/modules/s3-iceberg-medallion/main.tf:145-160 and modules/s3-iceberg/main.tf:100+ lifecycle rules contain only noncurrent_version_expiration(30d) + abort_incomplete_multipart(7d) — `grep -n 'INTELLIGENT|intelligent|transition' both files` = 0 transitions. db/iceberg/bronze_spec.json:71 documents 24-month rolling Bronze retention: historical partitions are read only by backfill/replay, ideal Intelligent-Tiering candidates.

**Remediation:** Add an aws_s3_bucket_intelligent_tiering_configuration (or a lifecycle transition to INTELLIGENT_TIERING after 30d) on the data/ prefix of bronze/silver/gold buckets. Savings estimate: ~40-68% on storage for objects idle >30d; immaterial at launch, meaningful once Bronze reaches hundreds of GB.

**Risk:** IT monitoring fee $0.0025/1k objects — Iceberg's many small files can erode savings until compaction (AUD-COST-013) is running; ship after the maintenance crons.

---

#### AUD-COST-015 — Prod storage-retention posture is otherwise sound (record, not a defect) — but the Strimzi-over-MSK cost call is embedded, not documented as a decision
**SEV-LOW · EFFORT-S · MEASURED · Wave 5 (documentation)**

**Evidence:** infra/helm/strimzi-kafka/values-prod.yaml (retention.standardMs 604800000 / longMs 2592000000, storage 50Gi gp3 deleteClaim:false, defaultReplicationFactor 3, minInsyncReplicas 2) mirroring infra/kafka/topics.yml:14-67; modules/rds/main.tf:138,144 + modules/aurora/main.tf:198,203 backup_retention_period=35 + prod deletion_protection; modules/elasticache/main.tf:88 snapshot_retention_limit=7. Strimzi EBS ≈ $12-18/mo (150Gi gp3, estimate) + broker compute on Karpenter vs MSK 3×kafka.t3.small ≈ $150-250/mo (estimate) — the repo contains zero MSK terraform, so Strimzi is the de-facto decision without an ADR entry.

**Remediation:** One-paragraph ADR addendum recording Strimzi-over-MSK (cost rationale + the operational dependency on AUD-COST-005/010), so the go-live path is an explicit decision rather than an implicit one. No config change needed.

**Risk:** None — documentation only. Note self-managed Kafka makes broker ops (rebalance, upgrades) the team's pager burden; MSK remains the fallback if Strimzi ops prove heavy.

---

## 5. Remediation backlog by wave

### Wave 1 — OOM/config fixes + go-live-critical config (small, reversible, high leverage)

| ID | Action | Effort |
|---|---|---|
| AUD-INFRA-003 | Cap apicurio (768m + -Xmx512m + oom_score_adj) and pgbouncer (128m) | S |
| AUD-INFRA-004 | Durable named volume for the Bronze sink checkpoint | S |
| AUD-INFRA-005 | Redis `--maxmemory 192mb --maxmemory-policy volatile-lru` (after TTL-audit of writers) | S |
| AUD-INFRA-007 | Pin KAFKA_HEAP_OPTS | S |
| AUD-PERF-001 | Fix admission-gate URL matching (`routeOptions.url`) + guard `/batch` + regression tests | S |
| AUD-PERF-003 | Implement + schedule raw-PII row-TTL retention covering `brain_bronze.events` | M |
| AUD-ARCH-001 | BRONZE_SOURCE=events into .env.production.example + helm values; align defaults | S |
| AUD-COST-001..012 | Go-live sprint **in dependency order**: terraform apply → OIDC/ECR roles + repo repoint → ingress → secrets (ESO or documented stopgap) → ArgoCD + Argo Workflows + AppProjects → Neo4j provisioning → placeholder fill pass + CI guard → Trino region fix → EKS access path → Karpenter IRSA/tags/queue → migration runner → iceberg_catalog DB decision | L overall |

### Wave 2 — safe deletions & doc truth (zero runtime behavior change)

| ID | Action | Effort |
|---|---|---|
| AUD-INFRA-008 | Rewrite memory-budget doc + startup runbook to current topology | S |
| AUD-PERF-008 | Trino adapter: throw on poll-budget exhaustion, fetch timeout, DELETE nextUri | S |
| AUD-CODE-004 | Delete seed-silver-dev.mjs | S |
| AUD-CODE-005/006/007 | Delete unmounted webhook handlers + bespoke HMAC VOs + ConnectRazorpayCommand (one PR) | S |
| AUD-CODE-008 | Delete apps/web IA-orphan cluster (15 files + hooks + dep) | S |
| AUD-CODE-009 | Remove 4 dead deps; ignoreDependencies guard for dynamic-import AWS SDKs | S |
| AUD-CODE-010 | Delete/port 4 dormant StarRocks live-tests; drop mysql2 from metric-engine | S |
| AUD-CODE-013 | Fix knip.json globs → promote knip workflow to blocking once clean | S |
| AUD-CODE-016 | redpandaTopic rename, generated d.ts decision, packages/ui cleanup | S |
| AUD-CODE-020 | Delete packages/ui husk | S |

(AUD-PERF-008 sits in Wave 2 because it is a small, behavior-tightening change consistent with fail-safe doctrine — it converts silent-wrong-data into loud errors.)

### Wave 3 — measured performance (HYPOTHESIS items: run the verification step FIRST, then fix)

| ID | Action | Verify-first? |
|---|---|---|
| AUD-PERF-002 | Batch drainer produce + `UPDATE … WHERE id = ANY($1)` | Yes (k6 ingest, spool depth) |
| AUD-PERF-004 | Schedule medallion_maintenance locally (+ AUD-COST-013 for prod) | No (measured) |
| AUD-PERF-005 | Stamp event_name header in collector producer | Yes (k6 + parse counter) |
| AUD-PERF-006 | Drainer inFlight guard + FOR UPDATE SKIP LOCKED claim | Yes (duplicate-produce repro) |
| AUD-PERF-007 | SpoolRepository.insertMany multi-row INSERT for /batch | Yes (k6 p95 compare) |
| AUD-PERF-009 | Gated retryCounter.reset + eachBatch commits + debug-level success log | Yes (Redis DEL / OffsetCommit rates) |
| AUD-PERF-010 | ≤60s in-process TTL cache for install_token→brand | Yes (pg_stat_statements) |
| AUD-PERF-011 | Thread connector row through verify; TTL cache on getSecret | Yes (LocalStack call counts) |
| AUD-PERF-012 | raw_body::text passthrough in drainer | Yes (bench) |
| AUD-PERF-013 | Split snapshot TTL (3-7d) from 24-month data retention | No (measured) |
| AUD-PERF-014 | MERGE ON-clause partition alignment / sort-order compaction | Yes (batch-time vs table-size) |
| AUD-PERF-017 | Neo4j indexes (IDENTIFIES props, MergeEvent, MergeReview, lifecycle_state) | Yes (PROFILE) |
| AUD-INFRA-010 | Drop no-op --executor-memory; evaluate 5.5g transform caps | No |
| AUD-ARCH-003 | One-line TDZ fix in tools/data-quality + import test | No (measured) |
| AUD-CODE-002 | Port Bronze e2e helper to Trino; re-enable 8 suites; then drop mysql2 | No (measured) |
| AUD-COST-013/014 | Prod v4-maintenance CronWorkflow + orphan-file pass; Intelligent-Tiering after compaction | No |

### Wave 4 — structural

| ID | Action |
|---|---|
| AUD-INFRA-006 | flock guard on Spark job containers + loop pidfile |
| AUD-PERF-015 | Entity-incremental conversion for ~20 full-scan Silver jobs (after AUD-ARCH-008) |
| AUD-PERF-016 | Distribute gold_attribution_credit (brand-filter basis; applyInPandas) — parity-gated |
| AUD-PERF-018 | Multi-mart runner: N builds per SparkSession per tier |
| AUD-ARCH-008 | Widen 7 shadow *_normalize jobs to Stage-1 schema; re-run shadow parity |
| AUD-ARCH-009 | Extract CostInputReader port for recommendation detectors |
| AUD-ARCH-012 | Route journey-stitch reads through withTrinoBrand |
| AUD-ARCH-013 | Placeholder-count/sentinel-position CI assertion for Trino queries |
| AUD-CODE-003 | Wire (or delete with its queue path) the pending-window flush handler |
| AUD-CODE-011 | Barrel policy: repoint main.ts or delete dead barrels |
| AUD-CODE-014 | pnpm catalog for pg/zod/@types; isolated fastify 4→5 with k6 pass |
| AUD-CODE-018 | Type-aware ESLint slice (no-floating-promises et al.), per-package rollout |
| AUD-CODE-019 | apps/web extends base tsconfig; noUncheckedIndexedAccess true |

### Parked — needs-user-decision + deferred (do NOT execute unilaterally)

These touch the identity path / schema contracts / prior explicit product decisions — **escalate for a decision first**:

| ID | Decision needed | Why parked |
|---|---|---|
| AUD-ARCH-002 | Identity-bridge repoint: (a) post-gate source (batch from silver_collector_event / admitted-events topic) vs (b) interim R2/R3 replication in the consumer | Changes identity latency + replay semantics on the identity SoR path; consent-rejected Neo4j cleanup pass needed |
| AUD-ARCH-010 | ops.* RLS: FORCE-RLS + BYPASSRLS ETL role vs status quo | Misjudging the ETL role/GUC posture silently truncates identity/stitch projections → empty dashboards/attribution |
| AUD-ARCH-006 | Versioned journey_events mart: ratify the #338 de-scope (record ADR) or schedule the mart | Explicit product decision in #338; large always-growing mart if built |
| AUD-ARCH-007 | Hierarchical public ID: ratify BRN- flat (ADR) or introduce a v2 ref with dual-accept | Golden-locked in 2 languages, already user-facing; hierarchical form leaks tenant/date |
| AUD-ARCH-005 | Composite cross-source touchpoint merge: confirm whether #337's narrower flag was the accepted scope | Attribution-affecting pairing semantics |
| AUD-ARCH-004 | Identity projection read-contract → repoint consumers, retire flat projections | Revenue-ledger identity joins; each repoint needs 3-way reconcile |
| AUD-ARCH-011 | Wire erasure_raw_delete.py into RTBF orchestrator | Depends on Spark-invocation seam; must stay fail-closed. Note: its compensating retention control is AUD-PERF-003 (Wave 1) — wire retention first |
| AUD-CODE-012 | Delete identity-explainability leftovers only if not #284 deferral seams | Owner confirm |
| AUD-CODE-015 | Legacy Bronze sink deletion — gated on Phase-8 bake+D4 | Documented cutover gate |
| AUD-CODE-017 | e2e-gate.wf.js deletion | Possible out-of-graph orchestrator invocation |
| AUD-INFRA-009 | Host Node heap caps | HYPOTHESIS — measure RSS first |
| AUD-PERF-019 | gold_revenue_ledger incremental fold | Parked behind AUD-PERF-004/013; reconcile-oracle-gated |
| AUD-COST-015 | Strimzi-over-MSK ADR addendum | Documentation decision |

---

## 6. Verification plan per wave

**Wave 1:**
- Memory caps: `docker stats --no-stream` after one full refresh-loop pass — apicurio < 512m heap (`jcmd 1 GC.heap_info`), pgbouncer < 128m, no OOM-kills in `docker events`. Redis: `redis-cli INFO memory` during warm refresh; sample `--scan` keys for TTLs before enabling volatile-lru.
- Checkpoint durability: kill the sink container mid-stream, let the supervisor restart it, confirm in /tmp/bronze-sink.log that it resumes from checkpointed offsets (no 'earliest' full-scan of already-landed offsets).
- Admission gates: regression tests — tripped gate + `POST /batch` and `POST /collect?x=1` must 503/429; k6 confirms rate-limit accounting counts batch as N.
- PII retention: after a connector sync lands raw lanes, `SELECT count(*) FROM iceberg.brain_bronze.events WHERE connector<>'collector' AND (payload LIKE '%"email"%' OR payload LIKE '%card%')` trends to 0 beyond the TTL window; job visible in Argo/refresh-loop logs.
- BRONZE_SOURCE: log `process.env.BRONZE_SOURCE` in core; compare `max(ingested_at)` between `brain_bronze.collector_events` and `brain_bronze.events WHERE connector='collector'` via Trino.
- Go-live chain: staged `terraform plan/apply` per M4 order (plan errors fail cleanly); after each leg, the runbook's own phase checks (ArgoCD app sync status incl. cronworkflows CRD acceptance, `argo submit --from cronworkflow/v4-silver`, ExternalSecret → core-env materialized, `kubectl get ingress` + curl the collector hostname over TLS, Trino `SELECT 1` against iceberg catalog in ap-south-1, migration Job completes before core rollout).

**Wave 2:** `pnpm -r typecheck && pnpm -r build` + full test suite after each deletion PR; `pnpm --filter @brain/web build` + e2e demo specs for the IA cluster; knip report shrinks to near-zero → flip knip.yml to blocking. Trino adapter: unit test that an exhausted poll budget throws (not truncates) and issues DELETE nextUri.

**Wave 3:** Each HYPOTHESIS item runs its listed measurement first (k6 ingest/serving harness, pg_stat_statements, Redis MONITOR, kafka-ui lag, Spark UI batch metrics, Neo4j PROFILE); fix ships only with a before/after number. AUD-CODE-002: 8 re-enabled suites green against Trino (`BRONZE_SOURCE`-aware); AUD-PERF-004/013: `$files`/`$snapshots` counts drop after maintenance run and stay bounded across 10 refresh cycles; D-1/D-7 invariant tests extended for batch commits/produces.

**Wave 4:** Parity oracles are the gate: shadow-normalize `_p4_golden` parity (AUD-ARCH-008), attribution byte-identical credit rows (AUD-PERF-016), 3-way revenue reconcile (any identity-projection repoint), FULL_REFRESH=1 backfill check per entity-incremental conversion (AUD-PERF-015). flock guard: two parallel `ONESHOT=1 pnpm dev:v4-refresh` never show two transform containers in `docker ps`. Type-aware lint: per-package clean before enabling in CI.

**Parked:** Each escalation gets a one-page decision memo (options, risk, rollback) before any code; identity-path items additionally require the live quarantine repro (AUD-ARCH-002 verification step) and a Neo4j cleanup plan.

---

## 7. Appendix

### 7.1 Refuted findings

**R1 (infra-memory) — "Worst-case container-cap sum (~31.7GiB bounded + unbounded services) oversubscribes the 31.3GiB Docker VM; ~7.7GiB over the 24GB target" — REFUTED.**
The cited evidence is factually accurate (all mem_limits verified at cited lines: postgres 512m L36, neo4j 1500m L98, redis 256m L114, minio 5g L133, localstack 512m L201, kafka 2500m L240, iceberg-rest 512m L402, trino 7g L478 = 17.65GiB; Spark caps at tools/dev/dev-bronze-streaming.sh:74 and db/iceberg/spark/run-silver-orders.sh:36; docker info MemTotal 33599631360 = 31.3GiB; apicurio/pgbouncer unbounded), but the finding is REFUTED on its core claim for three reasons. (1) The "24GB target" does not exist anywhere in the repo — grep across docs/, tools/, compose, and audit/ finds no such budget. The repo's actual documented contract (docs/ops/local-memory-budget.md, "the OOM-prevention contract") mandates the Docker VM be >=32GB and explicitly accepts steady ~20.5GB + ~5GB per transform = ~25.5GB peak with ~6.5GB headroom. The only external target ever proposed was the prod-infra blueprint's, which was explicitly evaluated and REFUSED as unsafe — docker-compose.yml carries "CONFLICT REFUSED" comments at both trino (L474-476: "A 1g limit reproduces the serving-tier OOM-kill outage") and minio (L130). So "~7.7GiB over the 24GB target" measures against a fabricated baseline. (2) "Worst-case cap sum > VM total" mischaracterizes deliberate design as a defect: the budget doc states caps are per-container runaway protection set intentionally ABOVE steady usage ("they cap runaway, they don't throttle normal operation"), not simultaneous reservations. The theoretical overshoot is 0.36GiB and requires every container to peg its cap simultaneously — the finding itself concedes realistic usage "fits 31.3GiB", and its own contributor data admits trino measured 902.6MiB idle with refresh-peak numbers tagged HYPOTHESIS while the stack is down, undercutting the MEASURED claim tag. OOM ordering is also already engineered via oom_score_adj (trino -700, redis -300). (3) The proposed remediation (trino mem_limit 4g, minio 2g) would revert the just-merged permanent fix for the recurring Trino serving outage (fix/trino-bounded-heap-autorestart: 7g cap + MaxRAMPercentage 70 → ~4.9g heap; 4g cap gives ~2.8g heap, below the budget-verified need) — i.e., it would reintroduce the exact SEV-class outage the current config was measured to prevent. Minor evidence error: "all 35 run scripts" — 42 run-*.sh under db/iceberg/spark carry the SPARK_CONTAINER_MEMORY cap. Not already-fixed-on-branch: #342 is what ADDED the Spark caps the finding sums; nothing on this branch changes the compose limits. The only salvageable kernel is low-severity hygiene (captured in AUD-INFRA-003/-008/-010).

**R2 (cost-prod) — "DECISION-NEEDED before apply: RDS vs Aurora Serverless v2 (both modules built, neither applied) and fck-nat single-instance egress SPOF vs managed NAT" — REFUTED.**
The cited files/lines all exist as described, but the core claim ("DECISION-NEEDED before apply — neither decided") is false. docs/adr/0009-aurora-and-fck-nat.md (Status: Accepted 2026-06-30, commit 3a5646e "ADR-0009 — Aurora Serverless v2 + fck-nat (decisions + wiring)") already records BOTH decisions with rationale, cost figures matching the finding's own estimates, explicit SPOF risk acceptance for fck-nat (egress-only, replay-tolerant, no-event-loss preserved), documented graduation/revisit triggers, and one-flag reversibility (enable_nat_gateway=true). It explicitly retires modules/rds from the prod path and rejects per-AZ managed NAT for starter prod. bootstrap.tf's comments cite ADR-0009 as the CHOSEN path; the modules being commented out is deliberate M4 apply-gating (zero idle spend until live), not indecision. The finding's proposed remediation ("record the decision in an ADR-0009 addendum") is already satisfied — ADR-0009 IS the accepted decision record. The MEMORY.md "decisions still open" note is stale, superseded by the ADR commit on 2026-06-30. No open decision blocks the M4 apply.

### 7.2 Verified sound (no action, recorded to close the dimensions)

- **Trino serving tier config** — heap 70% of 7g limit (jvm.config InitialRAMPercentage=35/MaxRAMPercentage=70 + ExitOnOutOfMemoryError), mem_limit 7g / reservation 3g / restart:unless-stopped / oom_score_adj -700; image-default query memory limits ample for local data (no query.max-memory-per-node override → ~1.5g). Measured 902.6MiB/7GiB idle. No standalone action.
- **Neo4j 1500m pairing** — heap_max 512M + pagecache 256M = 768m fixed inside 1500m; heap+pagecache = 51% of limit, meets the ≤75% rule (docker-compose.yml:92-109, budget-doc-verified).
- **MinIO 5g cap** — justified by the budget doc (4.4g steady under refresh; "CONFLICT REFUSED" vs the blueprint's 256m); measured 2.204GiB two minutes after start. No material core-profile RAM reclaim remains beyond the apicurio cap — all core members are load-bearing (localstack = prod-local secrets, apicurio = collector schema validation, neo4j = identity SoR, iceberg-rest/minio/trino = serving spine). Optional: if a full refresh-loop peak samples < 3.5GiB, lower to 4g/GOMEMLIMIT 3500MiB; otherwise record the measurement and close.
- **Prod storage-retention posture** (record, not a defect) — Kafka 7d live/30d backfill per topic, PG backups 35d + deletion protection, ElastiCache snapshots 7d, Strimzi 3×50Gi gp3 RF=3/min-ISR=2. The one follow-up (Strimzi-vs-MSK ADR addendum) is tracked as AUD-COST-015.
- **Spark job memory hygiene** — mostly sound (35/35 run scripts with explicit 4g driver inside 7g caps, bounded streaming batches, AQE fleet-wide); the two minor inconsistencies are tracked as AUD-INFRA-010.
- **Dimension-level positives worth keeping on record:** tenancy seam fundamentally sound (all ~49 metric-engine serving reads carry exactly one ${BRAND_PREDICATE} sentinel, brand-leading Redis keys, server-trusted Kafka partition keys, brand-scoped Cypher; **no active cross-tenant leak found**); Node/Fastify tier architecturally disciplined (singleton clients, no sync crypto on request paths, paginated brand-scoped BFF reads); V4 data plane logically sound (idempotent MERGEs, AQE, entity-incremental spine, prunable Trino views); TS hygiene strong (strict + noUncheckedIndexedAccess for 30 projects, ~zero `any` in public interfaces, consistent error patterns); no orphaned workspace packages.

---

*End of report. Trace IDs AUD-INFRA-001..010, AUD-PERF-001..019, AUD-CODE-001..020, AUD-ARCH-001..013, AUD-COST-001..015 are stable — reference them in remediation branches/PRs (pattern already in use: `fix(AUD-INFRA-002): …`).*

---

## Stage B — Remediation Report (2026-07-02)

Stage B executed the register above on branch `audit/stage-b-remediation`: **60 commits** (59 `fix(AUD-…)` + 1 `docs(AUD-COST)` runbook) via a 9-agent remediation workflow in 6 parallel lanes. Coverage: **Wave 1 and Wave 2 complete**, every MEASURED Wave-3 item plus all Wave-3 HYPOTHESIS items whose verify-first step confirmed the defect, the three small Wave-4 items (AUD-INFRA-006, AUD-ARCH-012, AUD-ARCH-013), and the full AUD-COST-001..013 go-live sprint in dependency order (capped by the `docs/runbooks/GO-LIVE.md` runbook, `bd19fc4b`). **48 register findings closed + 8 new findings raised-and-fixed during remediation** (§B.2). Every commit carries its own verification evidence; the cross-cutting measured proofs are in §B.3.

### B.1 Remediation table

One row per register finding closed in Stage B (short shas; multi-commit findings list every commit). Evidence is the lane's verification line, condensed.

**AUD-INFRA**

| ID | Commit(s) | Verification evidence |
|---|---|---|
| AUD-INFRA-003 | `92d0d74b` | Unbounded state confirmed live pre-change (no heap flags, no mem_limit); apicurio capped 768m + `-Xmx512m` via `JAVA_OPTS_APPEND` (verified run-java.sh append order) + oom_score_adj -600; pgbouncer 128m; measured post-fix 174.5MiB/768MiB and 1.6MiB/128MiB |
| AUD-INFRA-004 | `f1d5c75a` | Durable named volume `brain-bronze-checkpoint` mounted at /checkpoint; `bronze_landing.py` env consumption + repair-path compatibility verified; kill/relaunch proof in §B.3 (backlog ~3s, rows unchanged 69,584) |
| AUD-INFRA-005 | `8d3ff4eb` | Pre-change TTL audit of EVERY Redis writer (cache PX, stampede-lock PX NX, dedup EX, OAuth-state EX NX, retry/rate-limit INCR+EXPIRE) justified volatile-lru over allkeys-lru; live-verified `maxmemory 192mb` / volatile-lru in the running container |
| AUD-INFRA-006 | `8a8d457e` | Shared `_spark_lock.sh` (mkdir lock — flock absent on macOS) sourced by all 41 batch run-*.sh + loop pidfile; behavioral test PASS: second acquirer queued behind live holder, re-entrant child skipped, dead-pid lock reclaimed, EXIT-trap release |
| AUD-INFRA-007 | `55b5b118` | Pinned the in-effect image default `-Xmx1G -Xms1G` (behavior-preserving, budget-verified 1G/2.5g pairing); also cleared `KAFKA_HEAP_OPTS=` in the healthcheck probe so the CLI JVM keeps its 256M default (side effect the register missed) |
| AUD-INFRA-008 | `fcf2aee3` | Budget doc + startup runbook rewritten to single-sink/kafka topology, all-containers-bounded table, ≥32GB VM math recomputed; every number greped from live compose/launcher files at commit time |

**AUD-PERF**

| ID | Commit(s) | Verification evidence |
|---|---|---|
| AUD-PERF-001 | `c3dd82a5` | Gates match `req.routeOptions.url` and cover {/collect, /v1/events, /batch}; /batch counts as N against the per-install_token bucket; 28/28 guard tests green incl. new HTTP-level bypass regressions (`fastify.inject` on `/collect?x=1` + tripped-gate /batch) |
| AUD-PERF-002 | `e024d44e` | Drainer produces ONE Kafka batch per tick; full collector suite 78/78 incl. live durability proof (dead-broker batch stays pending; live-broker batch drains); unit test asserts exactly one send per batch |
| AUD-PERF-003 | `0c226b26` | D4 row-TTL DELETE implemented (default 168h) across 10 legacy raw tables AND `brain_bronze.events` (`connector <> 'collector'` — collector lane never deleted), snapshot expiry follows the DELETE; live run RC=0; scheduled daily in the refresh loop (ran ok in 11s, §B.3) |
| AUD-PERF-004 | `2700d67e` | Maintenance wired into the refresh loop (daily guard-file cadence); live run RC=0: silver_collector_event 1,726 files/27.6MB → 950 (partition floor); also fixed two defects that made the job useless even if invoked (see §B.2 fixed-in-place notes) |
| AUD-PERF-005 | `a673f6ad` | Drainer producer stamps `event_name` (+`brand_id`) Kafka headers, additive with body-parse fallback; 15/15 producer tests incl. nested-decoy case; bridge-side header skip-fast confirmed pre-existing |
| AUD-PERF-006 | `05c4ea80` | `inTick` in-flight guard + transactional `FOR UPDATE SKIP LOCKED` claim (no schema change; crash releases locks with rows still pending); live-PG test: two concurrent claims disjoint, every row visible to exactly one claimer, rollback leaves rows pending |
| AUD-PERF-007 | `e024d44e` | /batch = ONE multi-row `INSERT … SELECT FROM unnest(…) RETURNING` (D-1 durable-before-ACK preserved, ids in input order); live /batch test proves single multi-row insert with per-event id mapping |
| AUD-PERF-008 | `8dedd585` | Poll-budget exhaustion with nextUri set now THROWS (no silent truncation); 30s `AbortSignal.timeout` on POST + every poll; every abandon path fires `DELETE nextUri`; 6 new adapter tests; metric-engine suite 341 tests green |
| AUD-PERF-009 | `87aa6c6e` | New `OffsetCommitBatcher` (100 msgs/5s, offsets committable only AFTER write/dedup/DLQ — D-7 at batch granularity, failed commit drops window replay-safe) wired into the 13-group hot lane; 8 new unit tests + DLQ suite green |
| AUD-PERF-010 | `4f582b2f` | TTL cache on `resolveBrandByInstallToken` (60s positive / 5s negative, 10k cap); fake-timer tests prove 1 PG round trip per TTL window, token isolation, malformed-token bypass |
| AUD-PERF-011 | `d29c5bd3` | 5-min fail-closed getSecret cache (successes only, never negative-cached) + duplicate connector-resolver query eliminated via per-request reuse (brand_id authority MT-1 unchanged); 13/13 pipeline integration tests green |
| AUD-PERF-012 | `0c35fa46` | Drainer sends `raw_body::text` verbatim (−2 parses −2 stringifies/event); id extraction moved to guarded SQL projections (`jsonb_typeof` CASE, type-behavior preserved); unit test asserts byte-for-byte verbatim send; suite 77/77 incl. live PG+Kafka drain |
| AUD-PERF-013 | `f73851bc` | `SNAPSHOT_TTL_MS` (7d default) split from 24-month DATA retention in both maintenance jobs + run scripts; live proof: silver_collector_event 21 → 1 snapshots with current state intact (950 files) |
| AUD-PERF-017 | `fff81f01` | 6 idempotent indexes added to `Neo4jIdentityRepository.bootstrap()` (IDENTIFIES created_at/is_active watermark predicates + MergeEvent/MergeReview composites); applied live — `SHOW INDEXES` lists all six, re-run is a no-op |

**AUD-CODE**

| ID | Commit(s) | Verification evidence |
|---|---|---|
| AUD-CODE-002 | `7a94d1be` | e2e helper rewritten mysql2/StarRocks(:9030) → Trino REST adapter, BRONZE_SOURCE-aware (events/legacy); ALL 8 previously-dead suites executed GREEN live (bronze.e2e 4/4, ingest-hardening 12/12, backfill 28/28, live-connector 15/15, pipeline-wire 1/1 full POST→spool→Kafka→Spark→Iceberg→Trino, live-order + shopflo + gokwik 6/6) |
| AUD-CODE-004 | `445dabab` | Reference sweep: zero refs from package.json/CI/tools; db/starrocks contains only teardown/ |
| AUD-CODE-005 | `3ff80823` | Handlers imported only by their own tests; production mounts only `registerAllWebhookRoutes` (live WebhookPipeline untouched); core typecheck clean |
| AUD-CODE-006 | `431a878c` | Byte-compat pins converted to fixed golden HMAC digests preserving the cutover-equivalence proof; HmacConfig + ShopifyHmac suites 14/14 green |
| AUD-CODE-007 | `8ca693cd` | Zero importers (grep: comment refs + independent parity pin only); the two "Clone of" doc comments repointed; core typecheck clean |
| AUD-CODE-008 | `9c2d3651` | 15-file IA-orphan cluster + 7 dead hooks + @radix-ui/react-separator removed; per-file importer greps all zero; redirect page.tsx deep-link contract kept; @brain/web typecheck clean |
| AUD-CODE-009 | `3c7a1771` | mysql2 + @types/argon2 (core), pg + @types/pg (attribution-writer) removed; zero non-comment imports confirmed; dynamic-import AWS SDKs preserved with knip guard (landed with CODE-013); both packages typecheck clean |
| AUD-CODE-010 | `d724a340` | 4 dormant StarRocks live-tests deleted, mysql2 dropped from metric-engine (they were its last importers); non-live unit suite 348/348 green; Trino live-harness gap for 2 metrics noted in commit (§B.2 observations) |
| AUD-CODE-013 | `5903fce1` | Globs repointed (web src/→app/), stream-worker CLI/cron entrypoints added, ignoreDependencies guards; knip@5 now runs without config error, dependency findings = zero (config also converted to knip.jsonc — the `//` key had been silently erroring every CI run) |
| AUD-CODE-016 | `61fc3d15` | redpandaTopic→kafkaTopic (tool-internal, 2 sites); zero-consumer generated d.ts + its codegen path deleted; contracts codegen re-run green; A/B stash test proved byte-identical pre-existing tsc error (ARCH-003, fixed separately) |
| AUD-CODE-020 | `61fc3d15` | Untracked packages/ui husk `rm -rf`'d (no repo diff possible; recorded in the commit message) |

**AUD-ARCH**

| ID | Commit(s) | Verification evidence |
|---|---|---|
| AUD-ARCH-001 | `75f463a7` | `BRONZE_SOURCE=events` added to .env.production.example + core/stream-worker helm values (grep confirmed absent from all three); `helm template` renders it into both Deployments; 'legacy' stays the documented rollback value |
| AUD-ARCH-003 | `ba64721f` | TDZ self-reference fixed to the intended `brain_bronze.collector_events` literal; new import test green under BRONZE_SOURCE unset/legacy/events (11/11) — previously ReferenceError at import |
| AUD-ARCH-012 | `7d09d947` | Both journey-stitch Trino reads now run inside `withTrinoBrand` with the `${BRAND_PREDICATE}` sentinel LAST (dropping the predicate throws fail-closed); live tests 7/7 green (stitched=1, ambiguousSkipped=1, errors=0) |
| AUD-ARCH-013 | `a87bb22c` | `substituteParams` throws on BOTH mismatch directions; new static sentinel-last test scans all non-test .ts in metric-engine + core + stream-worker (corpus sanity >100 files / >20 sentinel files); metric-engine 348 tests green |

**AUD-COST** (go-live sprint; runbook `bd19fc4b`)

| ID | Commit(s) | Verification evidence |
|---|---|---|
| AUD-COST-001 | `9742dbe5` | envs/prod un-gated to the full applyable ADR-0009 M4 module set (network + fck-nat + endpoints, EKS, Aurora SLv2, ElastiCache, SM, S3 medallion, IRSA); `terraform fmt -check` + `init -backend=false` + `validate` Success |
| AUD-COST-002 | `909ef5fa` `001b3565` `2ac00068` | Terraform: OIDC trust → Rishabhporwal/Brain-V4@master (all 3 envs) + ECR-push/prod-apply roles, validate Success. GitOps: all 16 ArgoCD Applications repointed off the 404 repo, 27 YAML files parse. CD: exact role-ARN/var wiring documented in main.yml + latent CD-blocking cosign digest bug fixed (§B.2 notes) |
| AUD-COST-003 | `5a89001f` | ALB controller 1.10.1 + cert-manager v1.16.2 + external-dns 1.15.0 ArgoCD apps + Ingresses for collector/web/core; `helm template` with values-prod renders the Ingress (group brain-prod, correct healthcheck paths), defaults render none |
| AUD-COST-004 | `d8b6413c` | ESO 0.10.7 + ClusterSecretStore (SecretsManager @ ap-south-1 via IRSA, no static keys) + one ExternalSecret per consumed envSecretName; `helm template` renders 1 store + 8 ExternalSecrets + namespaces |
| AUD-COST-005 | `66835f84` | Bootstrap chain: pinned argo-cd 7.7.11 install.sh → AppProjects (kind was 0 repo-wide) → env root apps; Argo Workflows controller + CronWorkflow CRDs per env (sync-wave -2); `bash -n` clean, all YAML parses, AppProject sourceRepos cover every upstream registry |
| AUD-COST-006 | `41074294` | Neo4j (identity SoR) multi-source ArgoCD app on official chart 5.26.0, ClusterIP-only, gp3 50Gi, fixed 2g heap/1g pagecache in 4Gi pod, ESO-delivered auth; `helm template` of the REAL upstream chart renders green (initial render caught the ArgoCD `lookup` failure → disableLookups fix) |
| AUD-COST-007 | `153daf70` `4b697ef0` | Naming half: all 12 IRSA annotations aligned to the terraform `project-environment-name` convention + canonical PLACEHOLDERS.md; 12 chart/values renders green. Guard half: `prod-placeholder-guard.sh` renders every chart with values-prod (PR allowlist mode + strict prod-promote gate); --selftest green, strict mode correctly fails listing all 25 documented occurrences |
| AUD-COST-008 | `93363953` (helm half) | Helm: `iceberg.s3.region` us-east-1 → ap-south-1 (SigV4 mismatch would 400 every S3 read through the sole serving engine); `helm template` renders ap-south-1. Terraform half SKIPPED — see skipped table |
| AUD-COST-009 | `91927224` | `public_access_cidrs` (default [] = private-only, behavior-preserving) pins endpoint public access to an exact operator allowlist; wired to envs/prod + tfvars.example; validate Success all roots |
| AUD-COST-010 | `6ec8ae7e` | NEW modules/karpenter: controller IRSA role (NN-3 kube-system/karpenter, matching the ArgoCD SA annotation), v1 controller policy, interruption SQS + EventBridge rules, karpenter.sh/discovery tags; validate Success |
| AUD-COST-011 | `57796aa2` | PreSync/pre-upgrade hook Job runs the repo's exact `pnpm migrate:up` from the core image (image verified to carry db/migrations + node-pg-migrate); renders with values-prod, absent with defaults |
| AUD-COST-012 | `f6c211ad` | Dual-catalog ambiguity resolved the one-catalog way the runtime uses (REST/JDBC on Aurora): `aws_glue_catalog_database` removed from both s3-iceberg modules; grep zero non-comment refs; validate Success |
| AUD-COST-013 | `321f8735` | Weekly v4-maintenance CronWorkflow (compaction + 7d snapshot expiry + GUARDED orphan sweep, Forbid concurrency); `helm template` renders all 15 CronWorkflows incl. v4-maintenance with the ORPHAN_* env |

**Skipped / partial (with reasons)**

| ID | Status | Reason |
|---|---|---|
| AUD-COST-008 (terraform half) | Nothing-to-fix | Grep across all of infra/terraform (*.tf, *.tfvars, *.md) = zero wrong-region references; every region/AZ reference already ap-south-1. The sole defect was the helm value, fixed in `93363953` |
| AUD-INFRA-010 | OPEN (deliberately skipped) | The only `--executor-memory` occurrence lives in `tools/dev/dev-bronze-streaming.sh` (confirmed a no-op under `local[*]` per its own comment), a file owned by a different lane during the parallel run — the one-line deletion + the 5.5g transform-cap evaluation remain a trivial follow-up |

**Not executed in Stage B** (unchanged from the register; see §5): remaining Wave-3 verify-first items AUD-PERF-014 and AUD-COST-014; Wave-4 structural items AUD-PERF-015/016/018, AUD-ARCH-008/009, AUD-CODE-003/011/014/018/019; and everything in the Parked table (§B.4).

### B.2 New findings raised during remediation

Eight NEW findings surfaced by the lanes' ground-truth verification (mostly at the terraform↔helm↔Spark seams the go-live sprint exercised for the first time). All were assigned IDs continuing the register scheme and **fixed in follow-up commits on the same branch**:

| ID | Finding | Fixed in |
|---|---|---|
| AUD-COST-016 | Iceberg warehouse-layout contradiction: iceberg-rest pointed Silver/Gold namespaces under the Bronze bucket while terraform provisions per-tier buckets — AND the Bronze bucket carried COMPLIANCE-mode 7-yr Object Lock, which would make Iceberg MERGE/compaction and crypto-shred/erasure (DPDP/GDPR) physically impossible. Single warehouse layout fixed + Object Lock removed from the medallion data bucket (compliance conflict with the erasure obligation) | `ed1d5eed` |
| AUD-COST-017 | Six IRSA roles referenced by manifests existed in no terraform (brain-prod-{web,trino,iceberg-rest,external-secrets,aws-load-balancer-controller,external-dns}) and the secrets module created none of the 7 `brain/prod/k8s/*` shells the ESO chart reads (nor the ESO read policy) | `2d0aa930` |
| AUD-COST-018 | Neo4j's PVC had no provisioner (no EBS CSI addon, no gp3 StorageClass) and every Karpenter pool was Spot — the single-instance identity SoR would take interruption bounces. EBS CSI addon + gp3 StorageClass + on-demand NodePool added | `03c0a707` |
| AUD-COST-019 | pgbouncer had a chart + values-prod but NO ArgoCD Application (core-env's DATABASE_URL points at pgbouncer:6432 — nothing deployed it); Application authored + host FQDN fixed | `ac8a08cd` |
| AUD-COST-020 | `medallion_maintenance.py` hardcoded MinIO-style S3A credentials (access.key 'brain', endpoint minio:9000) — the prod orphan-files pass would fail under IRSA where no static keys exist; now IRSA-safe | `f0c8c3a8` |
| AUD-COST-021 | tf-validate CI matrix missed 5 modules incl. the new karpenter (never validated in CI); prod-apply.yml carried a false-prerequisite comment about where the apply role comes from | `d09af6e0` |
| AUD-COST-022 | `iceberg_base.py` + 3 bronze jobs unconditionally set static-key S3A config — now fall back to the IRSA/S3 default provider chain when no S3 endpoint is set | `dfcdfbaf` |
| AUD-CODE-021 | Three pre-existing stale test files (surfaced by the full-workspace test pass, §B.3): audit-checkpoint test's fake pool predated the RLS `audit_reader` session shape; ask-brain reproducibility test's fake serving pool was still StarRocks/mysql2-shaped; capi currency test pinned JPY as unmodelable when JPY is now MODELED (0-decimal). All three were stale tests, NOT product bugs — the compliance guards they exercise were verified intact; the capi guard was re-pinned on a truly unmodelable code | `e67b9658` `1774f748` `3352d3bb` |

**Fixed-in-place discoveries** (folded into their parent commits, recorded for the audit trail): `run-medallion-maintenance.sh` exported `MAINT_NAMESPACES=""`, making the maintenance job a SILENT NO-OP even when manually invoked — worse than the register's "unscheduled" (fixed in `2700d67e`); `bronze_raw_retention.py`'s pre-existing `expire_snapshots` CALL used a function expression the Iceberg CALL parser rejects — the job would have failed on every table had it ever been scheduled (fixed in `0c226b26`); the erase-mode "expire pre-deletion snapshots" step was silently a no-op in BOTH maintenance jobs — crypto-shredded rows stayed time-travel-readable for up to 2 years (fixed via ttl_ms=0 in `f73851bc`; flagged for a compliance-lane re-review of past erasures); the knip CI workflow had been silently erroring on every run (knip@5 rejects the `//` comment key; masked by continue-on-error — fixed in `5903fce1`); pipeline-wire.e2e had a second latent dead-path beyond the StarRocks probe (collector subprocess produced to the dev topic prefix no sink consumes — fixed in `7a94d1be`); a CD-breaking cosign bug in main.yml referenced a step output that was never set — every build leg would have failed on the first real CD run (fixed in `2ac00068`); AUD-PERF-011's register risk note "secret_ref changes on rotation so a TTL cache is naturally coherent" was REFUTED on the ground (`AwsSecretsManager.storeSecret` deliberately preserves the ARN on reconnect → up to one 5-min TTL of HMAC 401s after same-ARN rotation; providers retry, no event loss; documented in code in `d29c5bd3`). Remaining lane observations that are follow-ups, not defects fixed here: `mcp/tools.json` stale vs its Zod source (owner should re-run codegen); several apps/web e2e specs asserted testids with no live emitter even before CODE-008; `rewrite_data_files` min-input-files can never fire below the bucket-partition floor (dev bucket-count reduction still open); a benign negative-setTimeout warning in stream-worker e2e runs.

### B.3 Verification evidence (MEASURED, 2026-07-02)

- **Memory before/after:** steady-state in-docker footprint was 12+ GiB with unbounded apicurio/pgbouncer and the Bronze sink at 5.57GiB → **9.3 GiB total, all containers bounded**: apicurio 174.5MiB/768MiB, pgbouncer 1.6MiB/128MiB, redis `maxmemory 192mb` volatile-lru live-verified, kafka heap pinned 1G inside 2.441GiB, bronze sink 1.32GiB/7GiB.
- **AUD-INFRA-004 checkpoint durability proof:** sink killed (`docker rm -f`) → supervisor relaunch → backlog phase completed in ~3s with the Bronze row count UNCHANGED at 69,584 (resume from committed offsets). Before the fix, the same restart re-drained the entire topic history.
- **Full ONESHOT v4 refresh cycle green:** 21 Silver ok / 13 Gold ok / 0 failures / all Trino views applied; bronze-raw-retention (AUD-PERF-003) ok in 11s and medallion-maintenance (AUD-PERF-004) ok in 43s inside the loop; cycle 1177s.
- **Workspace:** turbo typecheck 57/57 green; turbo build 29/29 green; `pnpm test` (with DATABASE_URL/KAFKA_BROKERS) fully green incl. @brain/core 74 files/588 tests and collector 62/62; the 8 previously-dead Bronze e2e suites now run green against Trino (AUD-CODE-002).
- **Smoke:** collector `POST /collect` 200 through the new admission gates; core /health 200; web / 307; Trino `mv_gold_revenue_ledger` count = 19,846.

### B.4 Remaining PARKED / manual items

Unchanged from the Stage A Parked table (§5) — these still require a user decision before any code: ops.* RLS posture (AUD-ARCH-010), identity-bridge repoint (AUD-ARCH-002), versioned journey_events mart (AUD-ARCH-006), hierarchical public-ID format (AUD-ARCH-007), composite cross-source touchpoint dedup (AUD-ARCH-005), three-projection identity consolidation (AUD-ARCH-004), and RTBF raw-purge wiring (AUD-ARCH-011) — plus the rest of the Parked rows (AUD-CODE-012/015/017, AUD-INFRA-009, AUD-PERF-019, AUD-COST-015).

The go-live steps that are inherently manual (terraform apply against the real account, placeholder fill, DNS/ACM, ESO secret seeding, first ArgoCD bootstrap) are scripted in dependency order with per-step verification and rollback notes in **`docs/runbooks/GO-LIVE.md`** (`bd19fc4b`) — the placeholder-guard CI (`4b697ef0`) fails the prod-promote lane until the fill pass is done.

---

*End of Stage B report. New trace IDs AUD-COST-016..022 and AUD-CODE-021 extend the stable register.*

