# Phase 1 — Architecture Audit: Gaps Register & Remediation Backlog

**Date:** 2026-07-11 (supersedes the live-state facts in `00-discovery.md` §4.3, which was snapshotted mid-go-live on 2026-07-10)
**Scope:** Reference-architecture invariants (§1 of the audit brief) verified in code by 7 parallel deep-read agents, plus the user-added scope: **deployed application autoscaling, robustness, and cost** verified live against the `brain-prod` EKS cluster and IaC.
**Evidence tags:** MEASURED = verified in code or live system today. HYPOTHESIS = inferred, needs verification.

---

## 0. Live production snapshot (2026-07-11, refreshed)

All workloads are now deployed and public endpoints are serving:

- **Running:** collector×3, core×3, web×2, stream-worker×3, Strimzi Kafka (3 brokers, KRaft), kafka-connect×1, iceberg-rest×1 (custom JDBC image — fixed), neo4j×1 (on-demand node, PVC bound), trino coordinator+1 worker, pgbouncer×2, kube-prometheus-stack (Prometheus/Grafana/Alertmanager), full platform layer (ArgoCD 24 apps, Karpenter 4 pools with streaming/ondemand/trino nodes provisioned, KEDA, ESO, ALB controller, cert-manager, external-dns, Argo Workflows).
- **Endpoints (MEASURED):** `https://api.brain.pipadacapital.com/health` → 200 `{"status":"ok"}`; `px.../healthz` → 200; `app...` → 200; `brain...` → 200. TLS terminates at the ALB.
- **Not working (details below):** Metrics API (→ autoscaling dead), medallion Silver/Gold/serving (never initialized), scheduled pipeline (no CronWorkflows), 5 ArgoCD apps OutOfSync.

---

## 1. CRITICAL findings (production is serving but not functional as a data platform)

| ID | Finding | Severity | Effort | Evidence | Tag |
|---|---|---|---|---|---|
| AUD-LIVE-1 | **Autoscaling is non-functional cluster-wide: metrics-server is not installed.** All 5 HPAs (collector 3–24, core 3–12, web 2–6, stream-worker 3–48, trino-worker KEDA 1–3) report `cpu: <unknown>`; `kubectl top` → "Metrics API not available"; no metrics-server/prometheus-adapter deployment exists (only KEDA's external-metrics APIService, which does not serve resource metrics). Every workload is pinned at min replicas; a traffic spike cannot scale anything. Directly violates the "auto scalable" requirement. Fix: deploy metrics-server (EKS addon or Helm chart under ArgoCD). | CRITICAL | S | `kubectl get hpa -A` (all `<unknown>`); `kubectl get apiservice` (no `v1beta1.metrics.k8s.io`) | MEASURED |
| AUD-LIVE-2 | **The medallion does not exist in prod.** The Iceberg catalog contains only `brain_bronze` — no `brain_silver`, `brain_gold`, `brain_serving` namespaces, no marts, no Trino views. Every analytics/BFF read (`brain_serving.mv_*`) will fail or return nothing; dashboards are empty shells. The Silver/Gold provisioning + first refresh (Phase 1 → Phase 2) and `run-trino-views.sh` have never run against prod. | CRITICAL | M | `SHOW SCHEMAS IN iceberg` on prod Trino → `brain_bronze`, `information_schema` only | MEASURED |
| AUD-LIVE-3 | **The Spark pipeline is not scheduled.** `kubectl get cronworkflows -A` → none; ArgoCD `cronworkflows-prod` sync status Unknown. Identity-export, Silver, stitch, Gold, maintenance, and token-refresh crons are all absent — even after AUD-LIVE-2 is fixed, data would go stale immediately. | CRITICAL | S–M | `kubectl get cronworkflows -A`; ArgoCD app list | MEASURED |
| AUD-LIVE-4 | **Bronze landing unverified.** kafka-connect pod runs and a `kafka-connect-reregister` job Completed, but connector/task status could not be read (exec into the pod was not permitted this session). With no Prometheus JMX scrape confirmed for Connect, task failures would currently be silent. Verify the 10 sink connectors are RUNNING and events actually land in `brain_bronze.*_connect`. | CRITICAL (until verified) | S | pods in `kafka` ns; verification pending | HYPOTHESIS |

---

## 2. HIGH findings

| ID | Finding | Severity | Effort | Evidence | Tag |
|---|---|---|---|---|---|
| AUD-OPS-001 | **No PodDisruptionBudgets on any app workload** (only Strimzi's broker PDB exists). Node drains / Spot interruptions / Karpenter consolidation can evict all replicas of a tier simultaneously. Add PDB minAvailable=1 (stateless tiers) as chart templates. | HIGH | M | `kubectl get pdb -A`; zero PDB templates in `infra/helm/*/templates` | MEASURED |
| AUD-OPS-002 | **No topologySpreadConstraints / anti-affinity** on stateless tiers — replicas can co-locate on one node/AZ; a single node loss can take a whole tier down (compounded by AUD-OPS-001). | HIGH | S | helm templates (grep: none) | MEASURED |
| AUD-LIVE-5 | **ArgoCD drift:** `kube-prometheus-stack-prod` (revision `<none>`), `neo4j-prod` (`<none>`), `strimzi-kafka-prod`, `external-secrets-config-prod`, `aws-load-balancer-controller-prod` are OutOfSync — cluster state was hand-applied or diverges from git. GitOps guarantee (reproducible cluster) is broken until synced/reconciled. | HIGH | S–M | `kubectl get applications -n argocd` | MEASURED |
| AUD-SEC-1 | **EKS API endpoint open to 0.0.0.0/0** (uncommitted `envs/prod/terraform.tfvars` change, temporary go-live measure). Revert to pinned CIDR/bastion/SSM path and commit the decision. | HIGH | S | `git status` + tfvars diff | MEASURED |
| AUD-JE-34/35 | **Journey explainability gap (spec B.3):** `matched_via` is computed and stored in `journey_events` (gold_journey_events.py:151) but the timeline and trace APIs deliberately return `matched_via: null` ("B.1 gap — honest null until stitch-provenance lands", get-customer-journey.ts:103). Data exists; BFF serialization pending. | HIGH | M | apps/core `get-customer-journey.ts:103`, `get-journey-trace.ts` | MEASURED |
| AUD-SEC-2 | **iceberg-rest logs its full JDBC properties including the plaintext catalog password at startup** (upstream fixture behavior; visible in pod logs to anyone with `kubectl logs`). Mitigate via log filtering in the custom image or accept + restrict log access; rotate the logged credential. | HIGH | S | pod logs, 2026-07-10 crash-loop capture | MEASURED |

---

## 3. MEDIUM findings

| ID | Finding | Effort | Evidence | Tag |
|---|---|---|---|---|
| AUD-ID-10 | `probabilistic_quarantine_guard_test.py` (the Q1–Q5 quarantine enforcement guard) is **not wired into CI** — runs standalone only. A refactor leaking probabilistic identity into attribution would merge undetected. Add to `pr.yml` (it's a fast static grep test). | S | no invocation in `.github/workflows/` | MEASURED |
| AUD-OPS-003 | No liveness/readiness probes on kafka-connect, iceberg-rest, pgbouncer — broken replicas stay in Service rotation until eviction. | S | helm templates | MEASURED |
| AUD-OPS-004 | No `terminationGracePeriodSeconds`/`preStop` hooks anywhere — hard stops on eviction (in-flight requests dropped; consumer rebalances abrupt). Matters more because everything stateless rides Spot. | M | helm templates | MEASURED |
| AUD-TP-22 | **RTBF does not bust Redis caches** — erasure chain covers PG contact_pii, Neo4j, Iceberg Bronze payload-path, keyring shred, but cached metrics/journeys expire only by TTL (5m–1h). Document or wire an erasure → cache-invalidate signal. | M | erasure orchestrator chain (no cache step) | MEASURED |
| AUD-TP-23 | **Kafka message retention vs RTBF SLA undocumented** — RTBF doesn't purge broker logs (acceptable if retention < erasure SLA). Prod topic retention is 7d; document Kafka as transient transport in the RTBF policy. | S | strimzi values (7d), RTBF chain | MEASURED |
| AUD-SL-10 | Semantic-layer **pre-aggregation DDL is compiled but never materialized** — no Spark job/cron runs `preaggRefreshSql`; interactive grains fall back to base-view scans (fine at current volume, a latency/cost cliff at 100 brands / 1M events/day). | M | semantic-metrics compiler emits DDL; no consumer job | MEASURED |
| AUD-SL-11 | List endpoints use LIMIT (max 200) without keyset cursors in metric-engine paths (customer-orders etc.); the earlier keyset work covered mv_gold_customer_list/journey_timeline only. | M | packages/metric-engine/src/customer-orders.ts | MEASURED |
| AUD-OBS-1 | Freshness exporter (Gold mart staleness SLAs) **not deployed to prod**; the freshness alert rules will report `absent()` at best. K8s manifest exists (`infra/observe/k8s/freshness-exporter.yaml`). | S | monitoring ns pod list | MEASURED |
| AUD-OBS-2 | Observability audit F-items still open: unstructured `console.*` logging without correlation-ID binding; no error-tracking backend wired; OTel Grafana-Cloud/Tempo export disabled in prod. Alertmanager receivers (Slack/PagerDuty) need secret values verified. | M–L | docs/audit/11-observability.md; infra/observe/otel-collector.yml | MEASURED |
| AUD-OPS-006 | Trino coordinator+worker co-located on one **Spot** node — a reclaim takes serving down entirely (~30–120s). Accepted cost trade-off; consider pinning the coordinator to the on-demand pool once budget allows. | S | trino values-prod; live node list | MEASURED |
| AUD-OPS-010/011 | kafka-connect and iceberg-rest are single-replica SPOFs (idempotent/stateless recovery — freshness delay, not data loss). Add Connect task-failure alert (rule exists; needs JMX scrape live) and consider 2 replicas for iceberg-rest later. | S | values-prod files | MEASURED |
| AUD-COST-1 | **Cost telemetry inconclusive:** Cost Explorer shows ~$0 for 2026-07-04→10 despite 4 days of an 8-node cluster + Aurora + Redis — billing lag or credits. Re-check in 48h; verify the $500/mo budget alert wiring against actual spend. Rough steady-state estimate from current topology: 3× t4g.medium on-demand (system) + 1× t4g.xlarge on-demand (neo4j) + 3–4 t4g Spot + Aurora 0.5–2 ACU + cache.t4g.micro + ALB + NAT-instance ≈ $260–380/mo — within budget but leaves little headroom if HPAs (once fixed) scale out. | S | `aws ce get-cost-and-usage` output | MEASURED (data), HYPOTHESIS (estimate) |
| AUD-COST-2 | Request over-provisioning on collector (250m req vs light idle load) and core (500m) skews HPA math and reserves ~1 extra node of headroom. Profile after metrics-server lands, then right-size. | M | helm values; needs `kubectl top` post-fix | HYPOTHESIS |

---

## 4. Invariant compliance summary (code-level, per domain)

| Domain | Result | Notable evidence |
|---|---|---|
| **Bronze + Silver** | **27/27 PASS.** Connect append-only ×10 configs; NO brain_id in any canonical Silver event table (identity-bridge tables sanctioned); event_category + silver_version present incl. all 7 shadow normalize jobs (the old "10-col shadow" memory is stale — resolved); 3-stage quarantine (schema/dq/business) + separate consent-rejected ledger, replayable; MERGE idempotency with payload-diff guard + watermark overlap; Bronze retention D4. | `_silver_technical.py`, `silver_collector_event.py:335,344` |
| **Identity** | **24/25 PASS**, 1 gap (AUD-ID-10 CI wiring). Bi-temporal map append-per-mutation; 5-layer probabilistic quarantine (flag OFF, 0.95 floor, single writer, tagged consumer view, golden zero-check); stitch v2 multi-key unambiguous-only + `ops.stitch_conflict_review` (migration 0123); attribution provably deterministic-only; merge AND unmerge reversion wired; real-time touchpoint cache (A.4) present, flag-gated. | `silver_identity_map.py:201-245`, `journey-stitch-from-identity.ts:143-154` |
| **Journey engine (Wave B)** | **36/40 PASS**, 2 gaps (matched_via serialization — AUD-JE-34/35), 1 partial. Versioned ledger (data_version/is_current, flip-before-insert crash-safe), reversion + un-reversion, all three APIs (timeline/trace/compare) + batch replay with as-of identity, `mv_journey_events_current`, X-Journey-Version header, brand from session. | `gold_journey_events_reversion.py:213-235`, `journey-api.routes.ts` |
| **Measurement + Money (Wave C)** | **60/60 PASS.** gold_measurement_{costs,fees,settlements,refunds,inventory} + order_economics with CM1/CM2/CM3; money is bigint minor-units + currency_code sibling everywhere (contract-tested); BHD/KWD/OMR exponent-3 tested with zero-leak golden orders; largest-remainder allocation exact incl. negative totals (RTO); attribution float confined to 1e8-quantized weights; recognition ledger signs correct; parity oracle non-tautological with red-proof. | `packages/money/src/index.ts:33-41`, `_order_economics_test.py` |
| **Semantic layer + Serving (Wave D)** | **PASS** with 2 partials (pre-agg materialization AUD-SL-10, keyset AUD-SL-11). 22 YAML metrics, deterministic compiler, snapshot-pinned, catalog API + MCP tool defs; `${BRAND_PREDICATE}` fail-closed seam + mutation test; serving reads only `brain_serving.mv_*` (60 thin views, idempotent apply); Redis cache brand-first keys, 2-layer stampede guard, dual-topic invalidation consumer with flag-namespace exemption; v4-naming-guard blocks regressions. | `trino-deps.ts:120-145`, `AnalyticsCacheInvalidateConsumer.ts` |
| **Tenancy + Privacy + Idempotency** | **16/19 PASS**, 2 partial (AUD-TP-22/23 above). 80 RLS policies + negative-control isolation-fuzz in CI across PG/Redis/Kafka/Neo4j/Trino; brand from principal everywhere incl. 9 read-only MCP tools (write-tool count asserted 0 in CI); per-subject crypto-shred + 6-step RTBF incl. Bronze payload-path deletes; double-run of the refresh loop is structurally idempotent (MERGE semantics). | `0114_subject_crypto_shred.sql`, `tools/isolation-fuzz` |
| **Waves E–I scaffolds** | **19/19 PASS.** All contracts typed; 7 scaffold flags DEFAULT OFF, fail-closed (`isKnownFlag` → disabled); every runtime path is a NotImplemented-throw or 404/501; auto-execution mode unreachable; nothing accidentally live. | `platform-flags/src/registry.ts:103-185` |
| **Deployment ops (IaC review)** | HPA/KEDA design correct on paper (mins/maxes sane, stream-worker ceiling ≤ partitions, collector spike-reactive) — **but see AUD-LIVE-1**; Spot strategy sound (WhenEmpty for streaming, aggressive reclaim for batch/trino, on-demand tainted pool for Neo4j); Graviton everywhere; Prometheus 2d + Thanos S3. Gaps: PDB/spread/probes/grace (§2–3). | `infra/helm/karpenter/values.yaml:56-117` |

---

## 5. Remediation backlog (proposed waves — awaiting approval)

**Wave 1 — Make prod actually functional (CRITICAL, ~1–2 days)**
1. Install **metrics-server** (ArgoCD app or EKS addon) → verify HPAs report real utilization (AUD-LIVE-1).
2. **Initialize the medallion**: provision `brain_silver`/`brain_gold`/`brain_serving` namespaces, run the Phase-1+2 refresh once (identity-export → silver → stitch → gold), apply Trino views (AUD-LIVE-2).
3. **Deploy CronWorkflows** (sync `cronworkflows-prod`) so the pipeline stays fresh (AUD-LIVE-3).
4. **Verify Bronze landing**: Connect connector/task status + row counts in `brain_bronze.collector_events_connect` after a test pixel event (AUD-LIVE-4).
5. **Sync the 5 OutOfSync ArgoCD apps** (reconcile drift; investigate why kube-prometheus-stack/neo4j report no revision) (AUD-LIVE-5).

**Wave 2 — Robustness & security hardening (HIGH, ~2–3 days)**
6. PDBs + topologySpreadConstraints for all stateless tiers; broker spread check (AUD-OPS-001/002).
7. Readiness/liveness probes for kafka-connect, iceberg-rest, pgbouncer; terminationGracePeriod + preStop drains (AUD-OPS-003/004).
8. Lock EKS API back down (pinned CIDR or SSM) and commit tfvars intentionally (AUD-SEC-1).
9. iceberg-rest: stop logging the JDBC password; rotate the exposed credential (AUD-SEC-2).
10. Wire `probabilistic_quarantine_guard_test.py` into `pr.yml` (AUD-ID-10).
11. Deploy freshness exporter + confirm Alertmanager Slack/PagerDuty secrets fire a test alert (AUD-OBS-1/2).

**Wave 3 — Spec completeness (MEDIUM)**
12. Surface `matched_via` on journey timeline/trace (B.1 stitch-provenance serialization) (AUD-JE-34/35).
13. RTBF → cache-invalidate signal (or documented TTL policy); Kafka-retention RTBF policy doc (AUD-TP-22/23).
14. Pre-agg materialization cron + keyset pagination on remaining list endpoints (AUD-SL-10/11).

**Wave 4 — Cost & tuning (after 1 week of real metrics)**
15. Re-pull Cost Explorer; validate $500/mo budget alert wiring; right-size requests from live `kubectl top` data; revisit Trino coordinator placement (AUD-COST-1/2, AUD-OPS-006).

---

*Phases 2 (implementation deep-dive: tests/coverage/golden/perf) and 4 (operational readiness: backups/DR/runbook drills) remain per the original protocol; several of their inputs (e.g., golden re-run determinism, Neo4j/Redis backup verification, 10× load test) are queued but not executed in this round.*
