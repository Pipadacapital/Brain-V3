# PLAYBOOK — deploy

> Owner: Platform/SRE. See `engineering-os-blueprint/07-operations-and-reliability.md §1`.
> Sources: doc 04 §14.3/§16/§18.6/§20 · doc 10 §13 · doc 11 §11/§15.
> Last updated: 2026-06-15.

---

## Strategy

### Rollout

Phase 1 deploy posture is **ArgoCD GitOps with manual gates** (doc 04 §16; doc 10 §13; doc 11 §15).
Progressive-delivery/canary is explicitly **deferred to Phase 4** (autonomy milestone), not before (doc 04 §18.6/§20).

Flow for every service change:

1. GitHub Actions CI runs on push to `main` (trunk-based; short-lived feature branches, PR-gated).
2. `turbo --affected` computes the build/test/scan matrix — **only changed services and their transitive dependents are built and pushed** (doc 10 §13).
3. Affected images are built, scanned, and pushed to ECR with an **immutable content-addressed digest** (SHA256 tag; the mutable `:latest` tag is never used in the GitOps manifests).
4. CI bumps the image digest in the GitOps manifest for each affected service in `infra/k8s/<service>/overlays/staging/`.
5. **ArgoCD auto-syncs to staging** (STAGING account — hard-blast-radius-separated AWS account; doc 04 §14.3).
6. **MANUAL smoke gate** executes (see Smoke Gate below). A human must approve before prod promotion.
7. On approval, the manifest digest is promoted to `infra/k8s/<service>/overlays/production/`.
8. **ArgoCD auto-syncs to prod** (PROD account).
9. Bake window monitoring begins (see Bake Window below).
10. Auto-rollback fires if health probes fail (see Auto-Rollback below).

OIDC-federated short-lived credentials are used for all GitHub Actions AWS calls — **no static long-lived keys** (doc 10 §13).

### Feature flags

All high-risk changes ship behind a **per-brand operational feature flag** from `packages/feature-flags` (doc 04 §16; doc 04 §20).

**Canonical flag families (doc 12 §7, documented):** `connector.<type>.enabled`, `recommendation.<detector>.enabled`, `ai.<capability>.enabled`, `beta.<feature>`, plus per-brand `brand.<brand_id>.*` kill switches. Audited; **not** a targeting engine.

| Flag class | Scope | Purpose |
|---|---|---|
| Per-brand kill switch | single brand | instant off for a brand experiencing a data issue; survives a pod restart |
| Release gate flag | brand subset | new surface/module ships dark to an opt-in list before general rollout |
| Auto-execute kill switch | per-brand | kill agentic execution for one brand without a redeploy (Phase 4 surface, reserved) |

**Latency target for a flag-off to take effect: ≤ 60 seconds** from flag write to all pods honoring the new value — confirmed by doc 12 §7/§10 (rollback = ArgoCD revert + feature-flag-off per brand, 60s). **Release ownership: VP Eng owns the prod-promotion gate** (doc 12 §7).

Changes that **require a feature flag** before merge to `main`:
- Any new Analytics API endpoint or metric definition.
- Any change to RLS policy or the data-quality gating table.
- Any change to the metric registry (a registry bump is a breaking dual-store change — CI parity gate blocks on drift, but flag provides a live circuit breaker).
- Any new AI prompt template or NLQ resolution path (these also require the eval gates to pass; doc 04 §11.4).
- Any recommendation detector going live for the first time.
- Any billing calculation change.

Changes that do NOT require a feature flag (they still require all CI gates):
- Refactors within a single module with no API/event/DB schema change.
- Observability-only changes (log field additions, dashboard updates).
- Infrastructure-only changes (IaC, Karpenter, HPA thresholds).

### Artifact promotion

**Build-once, promote the same immutable digest across environments.** (doc 10 §13; devops-aws skill §Selective deployment.)

- CI builds each affected service image once, tagged `<service>:<git-sha>` and `<service>:<content-hash-digest>`.
- The ECR repository is configured with **immutable tags** — a tag cannot be overwritten after push.
- The GitOps manifest in `infra/k8s/<service>/overlays/staging/` references the digest.
- On manual prod promotion, the **same digest** is written into `infra/k8s/<service>/overlays/production/` — no rebuild, no re-scan. The artifact that ran in staging is exactly what runs in prod.
- The `revisionHistoryLimit` on each ArgoCD Application is set to **10** to retain rollback history.

---

## Staging Smoke Gate (manual — required before prod promotion)

The following checks must pass and be **captured in the staging smoke record** before a human approves prod promotion:

| Check | Pass criterion | How verified |
|---|---|---|
| Real-network smoke | all health probe endpoints (`/health/live`, `/health/ready`) return 2xx across all affected pods | ArgoCD sync status + `kubectl get pods -n <ns>` |
| Metric parity | the parity oracle (CI golden-fixture gate) is green; the runtime convergence monitor (hourly Argo job) shows no drift vs last run | Grafana Cloud dashboard: `brain.parity_oracle.status = green`; convergence monitor job log |
| Isolation negative test | brand-A request cannot read brand-B data at API/DB/StarRocks/MCP layers | CI isolation fuzzer passes in the staging run; a manual canary request with wrong `X-Brand-Id` returns 403/empty |
| Trace pipeline healthy | OTel spans from affected services are visible in Grafana Tempo with correct `brand_id` + `request_id` propagation | Grafana Tempo: a synthetic request shows end-to-end trace stitching across all touched deployables |
| Collector accept+ack | staging collector accepts a synthetic pixel event and the event appears in Bronze within the freshness SLO | Grafana Cloud: `brain.collector.accept_ack_rate` ≥ 99.95% over the smoke window |
| DLQ depth | no unexpected DLQ growth during the smoke window | Grafana Cloud: `brain.kafka.dlq_depth` per domain is stable |
| No hot/finalized boundary breach | the finalized-only policy asserted: a guarded endpoint refuses a request with `recognition_label=provisional` | CI gate runs in staging; manual negative test on the Analytics API |

> ASSUMPTION: The specific Grafana metric names (e.g. `brain.parity_oracle.status`, `brain.collector.accept_ack_rate`) are illustrative placeholders. The canonical metric names are defined in the metric registry (`packages/metric-engine`). These must be aligned with the Platform/SRE at Sprint 0.

---

## Bake Window

**Duration: 30 minutes post-prod sync for standard deploys; 2 hours for any change touching the billing module, ledger schema, or metric registry.**

> ASSUMPTION: The 30-minute standard bake window and 2-hour extended window are set here by Platform/SRE judgment. The source docs define SLO thresholds and auto-rollback triggers but do not specify a numeric bake window duration. These durations are calibrated to the 5-minute evaluation windows on the auto-rollback signals (see below).

Watched signals during the bake window (monitored continuously in Grafana Cloud):

| Signal | Threshold that triggers escalation |
|---|---|
| Collector accept+ack rate | drops below 99.95% sustained for 5 minutes |
| Analytics API / product surface error rate (5xx) | exceeds 1% over 5 minutes |
| Analytics API p95 latency | exceeds 2 seconds for 5 minutes |
| Kafka live-lane consumer lag (p95 per consumer group) | exceeds threshold (see SLO dashboard) for 5 minutes |
| Parity / reconciliation convergence | runtime convergence monitor shows drift vs Bronze recompute (keyed correctness signal) |
| Isolation leak count | non-zero (any cross-brand data visible to the wrong brand) — immediate SEV1 |
| OTel trace pipeline | trace pipeline loses spans (collector ACK not matched by Tempo ingestion) |
| StarRocks serving freshness | `max(ingested_at)` on a freshness-critical Silver/Gold table lags > 30 minutes |

**Key product correctness signal:** the parity/reconciliation monitor comparing StarRocks Gold numbers to the Bronze Iceberg recompute is the single most important signal during any bake window touching the data path. A deviation here is treated as a deployment failure regardless of HTTP-level health.

---

## Auto-Rollback

### Trigger thresholds

Auto-rollback fires when **any of the following conditions hold for the specified duration** post-sync, during the bake window:

| Signal | Threshold | Window |
|---|---|---|
| Collector accept+ack rate | < 99.95% | 5 consecutive minutes |
| Product surface (Analytics API) error rate | > 1% | 5 consecutive minutes |
| Analytics API p95 latency | > 2 seconds | 5 consecutive minutes |
| K8s health probe (liveness or readiness) | failing 2 consecutive probes on any affected pod | per probe interval |
| Cross-brand isolation breach (isolation count > 0) | immediate | 0 tolerance — single occurrence |

> ASSUMPTION: The "5 consecutive minutes" evaluation window and "2 consecutive failing probes" threshold are set by Platform/SRE judgment calibrated to Grafana Cloud alerting. The source docs specify the SLO targets (99.95% collector, 99.9% product) and state "auto-rollback on K8s health-probe failure" (doc 10 §13; doc 04 §16) but do not specify the exact evaluation window or probe count. These are standard industry defaults.

### Rollback mechanism

- **Primary mechanism:** ArgoCD revision history rollback. ArgoCD reverts the affected Application(s) to the previous GitOps revision (the last healthy `revisionHistoryLimit` entry). `revisionHistoryLimit` is set to 10 on all Applications.
- **Kill switch:** per-brand feature flag off (latency ≤ 60 seconds) — used when only a subset of brands is affected and a full rollback would revert unrelated progress.
- **DB migrations:** all schema migrations use `node-pg-migrate` in a **forward-only, backward-compatible** mode during Phase 1. Every migration must be **additive** (add column, add table, add index) — never drop or rename in the same migration. The previous version of the service must be able to run against the new schema (zero-downtime migration requirement). A migration that is not backward-compatible requires a two-step release: (1) deploy the additive migration, bake, (2) then deploy the code that uses the new column. Rollback of the application code is always safe; migration rollback is only executed manually after a confirmed data correctness incident.
- **Connector pause:** if a rollback is triggered during an active backfill job, the backfill consumer group is paused before the ArgoCD rollback to prevent duplicate processing from the replayed partition offset.

### Post-rollback

1. ArgoCD auto-rollback completion triggers a **SEV2 incident** (or SEV1 if isolation is involved) — see PLAYBOOK-incident.md.
2. The Platform/SRE on-call is paged immediately.
3. A `deployment-report` entry is created in `.engineering-os/knowledge-base/` documenting the rollback, the triggering signal values, and the reversibility recipe.
4. The deploy branch is locked until the incident is triaged.
5. A blameless postmortem is opened within 48 hours (see PLAYBOOK-incident.md).

> ASSUMPTION: The 48-hour postmortem window for a rollback-triggered incident is set here. Source docs require blameless postmortems but do not specify a numeric SLA for rollback-triggered incidents specifically (the incident postmortem window is specified in PLAYBOOK-incident.md).

---

## Release Channels

### Services (collector, stream-worker, core monolith)

Channel: **ArgoCD GitOps (staging auto-sync → manual smoke gate → manual prod promotion).**

Immutable ECR digest; per-service ArgoCD Application; `turbo --affected` build matrix; no deploy of unchanged services. Each service has its own `infra/k8s/<service>/` tree with `base/` + `overlays/{staging,production}/` + `argocd-app.yaml`.

### Web (Next.js)

Channel: **same ArgoCD GitOps pipeline** as services. The `web` app is a separate affected-set target. Deployed as a container to EKS behind CloudFront + WAF; no separate CDN-push step in Phase 1.

### Scheduled jobs (Argo Workflows)

Channel: **ArgoCD GitOps** for the Workflow templates. Job triggers (cron + event-driven) are declared as `WorkflowTemplate` resources under `infra/k8s/jobs/`. A change to a job template goes through the same staging → manual gate → prod promotion flow.

### Which changes require additional review gates (beyond standard CI)

| Change type | Additional gate required |
|---|---|
| RLS policy change | Isolation negative-test re-run on the changed policy in staging + manual sign-off from Architect |
| Metric registry entry (new or modified metric definition) | Parity oracle must pass with the new definition against golden fixtures; metric registry change ships behind a feature flag |
| AI prompt template change | NLQ resolution eval golden-set + injection golden-set + narration-faithfulness eval must all pass (doc 04 §11.4); ships behind a feature flag |
| Recommendation detector (new or changed threshold) | Detector precision check on staging data; ships behind a per-brand flag; goes to beta brands before GA brands |
| DB migration affecting a billing or ledger table | Extended 2-hour bake window; explicit VP Eng sign-off required before prod promotion |
| Audit ledger schema change | Architect + Security sign-off required; the hash-chain invariant must be verified post-deploy |
| Apicurio schema change (event schema) | `buf breaking` + FULL_TRANSITIVE compatibility gate must pass in CI; breaking change → new `.v{n+1}` with dual-write |

---

## Go/No-Go Gate Ladder

Source: doc 11 §11 (required evidence, metrics, and sign-offs).

| Gate | Required evidence | Required metrics | Sign-off |
|---|---|---|---|
| **Sprint 0 exit** | Pixel event flows from collector to Bronze in CI behind RLS; contracts generate from Zod | CI green; RLS on; event in Bronze | VP Eng + Platform/SRE |
| **M1 exit (Internal Alpha, ~W8)** | Reconciling realized-revenue number on screen; isolation test passes; parity oracle green on spine metrics | Parity oracle green; isolation 0 leaks; collector accept+ack ≥ 99.95% in staging | CTO + Principal Architect |
| **M2 exit (Design Partner, ~W12)** | Bill reproducible from ledger; CM2 with confidence; Razorpay settlement ingested; sealed snapshot scaffold passes | Snapshot reproducible; True CM2 rendered; DQ grades gate behavior | VP Eng + VP Product |
| **M3 exit (Billing live / First Paying Customer, ~W16)** | Attribution reconciles to order ledger net RTO/refund within tolerance (spec §15); Morning Brief renders with evidence; inspectable bill + GST invoice | Reconciliation ≤ tolerance; Morning Brief renders | CTO + VP Product |
| **M4 exit (First Recommendation, ~W19-20)** | Real-data recommendation with impact + confidence + evidence in the Decision Log; detector precision ≥ threshold | Detector precision ≥ threshold on design-partner data | CTO + VP Product |
| **Beta exit (~W20)** | ~10 brands onboarded; DR drill passed; security review passed; isolation fuzz at scale passed | SLOs met (99.9% product / 99.95% collector); DR drill RTO/RPO within targets | CTO + VP Eng |
| **GA exit (~W24)** | Full Phase-1 checklist (doc 10 §14); load tested at festival EPS; on-call + status page + runbooks live | All SLOs + load test + isolation at scale | CTO (final) |

---

## Disaster Recovery Summary

Source: doc 10 §13; doc 04 §14.5.

| Component | Mechanism | RPO | RTO |
|---|---|---|---|
| RDS Postgres | Multi-AZ + PITR (automated) + 35-day snapshots | ≤ 5 minutes | < 30 minutes (PITR restore to point) |
| Bronze / Iceberg (S3) | S3 versioning + Iceberg snapshots; immutable 24-month Bronze | 0 (append-only; no data loss) | Minutes (S3 is the SoR) |
| StarRocks | Rebuild from Bronze via `starrocks-rebuild` Argo workflow | 0 (Bronze is the source) | 2–4 hours |
| ElastiCache Redis | Multi-AZ; rebuild from Postgres on cold start | Acceptable (cache; stateless rebuild) | < 15 minutes |
| EKS cluster | ArgoCD GitOps declarative recovery; Karpenter node provisioning | 0 (manifests in Git) | ≤ 30 minutes |
| Collector spool | Durable disk WAL; spool replay after Redpanda recovery | < 5 minutes of un-acked events at most | Minutes (drain resumes on recovery) |
| Brand KMS keyrings | Quarterly `brand_keyring` restore drill into isolated account (doc 10 §13) | — | Verified quarterly |

**Quarterly DR drill obligations:**
1. RDS PITR restore into scratch instance; confirm recovery point within RPO; confirm data delta.
2. StarRocks `BACKUP`/`RESTORE` from S3 into scratch cluster; recompute canonical metrics on restored data; assert parity against prod within tolerance.
3. `brand_keyring` restore drill: restore per-brand DEKs into an isolated account/namespace; confirm crypto-shred and re-identification paths behave correctly.
4. Document measured wall-clock RTO/RPO + any gaps in the runbook after each drill.
