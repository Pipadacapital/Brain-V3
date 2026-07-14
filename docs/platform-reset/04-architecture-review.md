# 04 — Architecture Review (AWS Well-Architected)

**Scope:** the EXISTING Brain prod infrastructure design as committed — `infra/terraform`
(modules + `envs/prod`), `infra/helm/*`, `infra/argocd/envs/prod/*`, and ADRs under
`docs/adr`. **Method:** read-only, evidence-based, per AWS Well-Architected Framework
(WAF) pillars. **Account:** 380254378136 (paid prod), `ap-south-1`,
`brain.pipadacapital.com`.

**Verdict up front:** this is a genuinely well-engineered, cost-conscious platform.
The cost-optimization and (most of) the security posture are strong and *deliberate* —
most tradeoffs are documented in ADRs with named graduation triggers. The material
gaps are concentrated in **Reliability** (single points of failure held together by
"rebuildable / replay-tolerant" arguments) and **Operational Excellence** (alerting is
email-only with no paging, and the account has no detective-control baseline —
CloudTrail/GuardDuty/Config/SecurityHub are absent). None of this is invented debt; the
design owners have consciously chosen most of these tradeoffs for a starter-scale,
credit-funded go-live. This review flags where those choices become risks as real
paying traffic arrives.

---

## Well-Architected — how the design scores (directional)

| Pillar | Standing | One-line |
|---|---|---|
| Operational Excellence | **Needs work** | GitOps + IaC are excellent; but alerting is email-only (no SNS/paging), and the observability module is not even wired into prod. |
| Security | **Strong, with gaps** | IRSA least-privilege, KMS-everywhere, private EKS API, TLS-only buckets — but no CloudTrail/GuardDuty/Config, no app-secret rotation, wide-open intra-SG rules. |
| Reliability | **Weakest pillar** | Single fck-nat, single Aurora writer, single Neo4j (Community), single Kafka-Connect, single-AZ Redis — each defended, but concentrated SPOFs. |
| Performance Efficiency | **Sound** | Karpenter Spot + KEDA + Serverless v2 + right-sized pools; Spark-in-local-mode is the one known mismatch (pilot underway). |
| Cost Optimization | **Excellent** | Spot, Serverless v2, fck-nat, trimmed VPC endpoints, Intelligent-Tiering, EKS extended-support fee eliminated, dual budget tripwires. |
| Sustainability | **Good (implicit)** | Graviton (arm64) everywhere, Spot bin-packing, scale-to-need — sustainability falls out of the cost posture. |

---

## Operational Excellence

| # | Finding | Evidence | Severity | Recommendation |
|---|---|---|---|---|
| OE-1 | **No paging / actionable alerting.** Every CloudWatch alarm in the repo is either an EC2 built-in auto-action (recover/reboot) or explicitly `alarm_actions`-less ("alerts-only account"). Aurora ACU-saturation, Redis, and the composite EKS-unhealthy alarms have **no SNS topic and no PagerDuty/Slack sink** — they are dashboard tripwires nobody is paged on. | `modules/aurora/main.tf` L84-98/L259-280 (no `alarm_actions`); `modules/nat-instance/main.tf` L246-295 (only `ec2:recover`/`ec2:reboot`); `grep aws_sns_topic infra/terraform` → **none**. | **High** | Add one SNS topic (email + chat webhook) and wire it into the existing composite EKS-unhealthy, Aurora ACU, and NAT status alarms. Cheap, high-leverage: today an outage is discovered by a human noticing, not by a page. |
| OE-2 | **`module.observability` is NOT invoked in prod.** The module exists (per-service CloudWatch log groups + the "one composite EKS-unhealthy alarm") but the prod root never calls it. Prod app logs rely on OTel→Grafana Cloud; the composite alarm and its child alarms are **not applied in prod**. | `grep '^module "' envs/prod/bootstrap.tf` (30 modules, no `observability`); `modules/observability/main.tf` L136 `eks_unhealthy` composite alarm. | **Medium** | Either wire `module.observability` into `envs/prod`, or explicitly document (ADR) that Grafana-Cloud-managed alerting fully replaces it — and then ensure the EKS-unhealthy signal exists *somewhere* that pages. Right now the intended safety-net alarm is dead code in prod. |
| OE-3 | **Broker/Trino/Neo4j/DB sizing lives in prose comments, not runbooks/SLOs.** Extensive, high-quality inline reasoning (e.g. the Kafka on-demand pin incident) is embedded in YAML/TF comments. Good for the next reader, but there is no machine-checked SLO or capacity budget that fails when reality drifts. | `strimzi-kafka/values-prod.yaml` L35-70; `neo4j/values-prod.yaml` L38-47; `aurora/main.tf` L84-98. | **Low** | Promote the "graduation triggers" already written in comments into Prometheus/Grafana SLO rules + alerts (identity-lag, ACU 80%, Trino OOM), so the tripwires page instead of being read. |
| OE-4 | **Reliance on manual go-live fill-passes.** Many resources are provisioned then hand-filled into helm values / ArgoCD annotations (`docs/runbooks/prod-m4-turn-on.md`). Drift between TF outputs and helm placeholders is a manual reconciliation, not enforced. | `envs/prod/bootstrap.tf` L776-838 (outputs → placeholders); `helm/PLACEHOLDERS.md`. | **Low** | Where feasible, source IRSA ARNs / bucket names into helm via a generated values file or external-secrets, closing the manual-fill gap. |

**Already good (OE):** ArgoCD app-of-apps with `automated { prune + selfHeal }` and
ServerSideApply (`argocd/envs/prod/core.yaml`) — true GitOps, prod self-heals on merge.
CI/CD gated to the `release → master` promotion with OIDC + a `production` environment
approval gate (`oidc-github` module, `create_cicd_roles`). ECR immutable + scan-on-push
+ lifecycle everywhere. Dual budget tripwires including a clever credit-depletion
tripwire (`bootstrap.tf` L682-706).

---

## Security

| # | Finding | Evidence | Severity | Recommendation |
|---|---|---|---|---|
| SEC-1 | **No account detective-control baseline.** No CloudTrail, GuardDuty, AWS Config, Security Hub, or WAF anywhere in the IaC. For a paid prod account holding PII (identity graph, connector OAuth tokens), there is no tamper-evident API audit trail, no threat detection, and no config-drift detection at the AWS-account layer. | `grep -r 'cloudtrail\|guardduty\|aws_config\|securityhub\|wafv2' infra/terraform` → **none**. | **High** | Add at minimum org/account CloudTrail (→ the WORM audit bucket already exists) + GuardDuty (ap-south-1, ~single-digit $/mo at this scale). Config/SecurityHub can follow. This is the biggest *security* gap — the platform-level audit CMK/bucket exist but nothing is feeding them the AWS control-plane trail. |
| SEC-2 | **App/JWT/connector secrets have no rotation.** Aurora master password rotates via Secrets Manager (`manage_master_user_password`), but the app boot secrets (`JWT_SIGNING_SECRET`, `COOKIE_SECRET`, `META_APP_SECRET`, connector OAuth) are static shells with no rotation lambda/schedule. `grep rotation modules/secrets` → none. | `modules/secrets/main.tf` (no rotation); `bootstrap.tf` L788-808 (boot-secret shells). | **Medium** | Add scheduled rotation (or at least a documented manual rotation SLA) for JWT/cookie signing secrets and connector app-secrets. The MEMORY notes password rotation is already a known pending item — formalize it. |
| SEC-3 | **Over-broad intra-VPC security-group rules.** The EKS nodes SG allows all-protocol ingress `self` and from the cluster SG (expected for k8s), but the NAT instance SG ingresses **all protocols from the entire VPC CIDR**, and RDS/Redis/Aurora egress is `0.0.0.0/0` all-protocol. Blast radius of a compromised pod is the whole VPC + open egress. | `nat-instance/main.tf` L169-183 (VPC-wide all-proto ingress + `0.0.0.0/0` egress); `network/main.tf` L253-259, L284-289; `aurora/main.tf` L152-158. | **Medium** | Egress from data-tier SGs should be scoped (or replaced by NetworkPolicies, which do exist in `helm/network-policies`). Confirm the `network-policies` chart actually constrains pod egress; if so, note it — the SG-level openness is then defence-in-depth rather than the only control. |
| SEC-4 | **KMS key policies delegate fully to `kms:*` account root.** Every CMK (root/audit/connector) uses a single `AllowAccountRoot` statement with `kms:*`. Least-privilege is then enforced only via IAM identity policies. Correct and common, but there is no key-policy-level separation between the audit CMK and everyday roles — a broad IAM grant could reach the audit key. | `modules/kms/main.tf` L105-116 (shared `root_kms_policy` reused for root+audit+connector). | **Low** | Give the audit CMK its own key policy that does **not** blanket-delegate, so the tamper-evidence of the audit trail cannot be undone by an ordinary IAM policy mistake. |
| SEC-5 | **fck-nat / EKS nodes on IMDSv2 with hop-limit 2.** System-node launch template sets `http_put_response_hop_limit = 2` (to let non-IRSA pods reach IMDS). This slightly widens SSRF-to-credential exposure vs hop-limit 1, and is a documented rack-awareness workaround. | `modules/eks/main.tf` L293-297; commit history (Kafka rack-awareness hop-limit 1→2). | **Low** | Acceptable given the Kafka AZ self-resolution need; revisit whether the AZ can instead be injected via the Kubernetes downward API / node label so IMDS hop-limit can return to 1. |

**Already good (SEC):** IRSA per-workload with `StringEquals` `sub`+`aud` trust (no
wildcard SA trust) across ~15 roles; S3 buckets are all public-access-blocked +
SSE-KMS + TLS-only + deny-unencrypted-puts (`s3-iceberg/main.tf` L409-457); IAM S3
policies scope to medallion **namespace prefixes** with explicit `Deny` on bucket root;
private-only EKS API endpoint (`eks_public_access_cidrs = []`) reached via SSM tunnel —
eliminates the ISP-IP-rotation lockout class entirely; external-dns scoped to the Brain
hosted zone (not `hostedzone/*`); Neo4j is ClusterIP-only (never a LoadBalancer);
SES send scoped to a verified identity; Karpenter interruption queue is SSE + deny-non-TLS.

---

## Reliability

| # | Finding | Evidence | Severity | Recommendation |
|---|---|---|---|---|
| REL-1 | **Single Aurora writer, no reader instance.** `instance_count` defaults to 1 and prod does not override it → one `db.serverless` writer. Aurora's storage is multi-AZ and auto-heals, but a writer-instance failure means a failover-restart of the sole instance with no standby reader to absorb reads. | `modules/aurora/main.tf` L78-82, L231-250; `bootstrap.tf` L203-216 (no `instance_count`). | **Medium** | Aurora storage HA covers the durable case; but for the operational store on the revenue path, add a second `db.serverless` reader instance at T1 (the ADR-0009 graduation trigger). Pay-per-use, so idle cost is bounded. |
| REL-2 | **Single fck-nat = single egress SPOF.** All private-subnet egress (connector polls, OAuth refresh, LLM calls) rides one `t4g.nano` in one AZ. Auto-recover/reboot alarms mitigate host/OS failure but **not an AZ loss** — an AZ outage stops all egress until manual intervention. | `modules/nat-instance/main.tf` L1-11 (SINGLE-AZ banner), L246-295 (recover/reboot only); ADR-0009 §Decision 2. | **Medium** | Consciously accepted and reversible in one flag (`enable_nat_gateway = true`). Keep the ADR-0009 graduation trigger visible: flip to per-AZ managed NAT when egress becomes revenue-critical. Fine at T0; a real risk once paying brands depend on real-time freshness. |
| REL-3 | **Neo4j identity SoR is a single Community node (no clustering possible).** Community edition cannot cluster; identity is a single writer with a ~109 events/s ceiling. Recovery story = rebuild from Silver + PG audit + PVC survives pod loss. But pod/node loss = an identity write outage window, and the throughput ceiling is architectural. | `neo4j/values-prod.yaml` L6-18; `technology-cost-analysis-2026-07.md` §3.8. | **Medium** | Pinned to on-demand (good — off Spot) and backed up (DLM EBS snapshots + nightly dump, `modules/neo4j-backup`). Accept at T0/T1 with the identity-lag tripwire; the Enterprise-vs-Neptune decision is correctly deferred to T2. Ensure the "rebuild from Silver" path is actually rehearsed, not just asserted. |
| REL-4 | **Single Kafka Connect replica = sole Bronze-landing writer.** `replicas: 1`. It is the only writer landing the collector + 9 raw lanes to Iceberg Bronze. A Connect pod outage stalls Bronze landing (Kafka retains, so no loss — but freshness stops). | `helm/kafka-connect/values-prod.yaml` L8. | **Low–Medium** | "No event loss" is preserved (Kafka is the buffer, at-least-once). But landing *latency* has a SPOF. Consider 2 replicas or a KEDA-backed restart SLO; at minimum alert on Connect task-death (the AUD-W1-001 IRSA outage showed how silent this can be). |
| REL-5 | **Single-AZ, single-node Redis (Valkey).** `num_cache_nodes = 1` → `automatic_failover`/`multi_az` degrade to false. Defended: it's a rebuildable serving cache (Trino is SoT). A cache loss = a cold-cache latency spike + Trino load surge, not data loss. | `bootstrap.tf` L564-581; `modules/elasticache/main.tf` L137-150 (snapshots kept, 7d). | **Low** | Acceptable for a cache. Watch that a cold-cache event doesn't cascade into Trino OOM (Trino has an OOM history) — the SETNX stampede lock in the app layer is the right mitigation; confirm it's active in prod. |
| REL-6 | **Kafka brokers pinned to on-demand after 3× Spot quorum loss — good, but a 3-broker/minISR-2 quorum still tolerates only one broker loss.** With required anti-affinity across 3 on-demand nodes this is sound; but there is no cross-AZ spread guarantee visible in the CR (topologyKey is `hostname`, not `zone`). | `strimzi-kafka/values-prod.yaml` L45-70 (hostname anti-affinity, on-demand pin). | **Low** | Add `topology.kubernetes.io/zone` spread so the 3 brokers land in 3 AZs — otherwise an AZ loss could take 2 brokers and break quorum despite the on-demand pin. |
| REL-7 | **No disaster-recovery region active.** S3 CRR to ap-south-2 is coded and gated but `enable_cross_region_replication = false`. The warehouse (system of record) has no live off-region copy today; only in-region S3 durability + versioning. | `terraform.tfvars` L38-48; `bootstrap.tf` L749-774. | **Low–Medium** | Correctly deferred as a cost+residency decision (ADR-0011). For a paid prod SoR, schedule enabling CRR once the residency sign-off is done; it's single-digit $/mo and the machinery is ready. |

**Already good (REL):** Aurora backup retention **35 days** + deletion protection +
final snapshot (`aurora/main.tf` L214-219); Neo4j has real backups (DLM + nightly dump,
which the audit found was previously zero); Karpenter interruption handling (SQS +
4 EventBridge event classes) drains Spot gracefully; stateful brokers pinned off Spot
onto on-demand with PDB `minAvailable=2` + required anti-affinity; the whole ingest
path is replay-tolerant by design (Bronze = SoR, at-least-once, idempotent per
ADR-0012). The reliability *reasoning* is unusually mature — every SPOF has a written
recovery story.

---

## Performance Efficiency

| # | Finding | Evidence | Severity | Recommendation |
|---|---|---|---|---|
| PE-1 | **Spark runs in `local[*]` single-node mode** — paying cluster-grade JVM/shuffle overhead for a single-process, small-data (millions of rows) transform. This is the root of the recurring Spark-OOM incident class. | `technology-cost-analysis-2026-07.md` §3.4; MEMORY (Spark→DuckDB migration PR #148 merged, additive). | **Medium** | The DuckDB transform pilot is already the identified fix and is partially landed. Complete the cutover per the migration plan; it removes the OOM class and cuts batch cost. Highest-upside performance move. |
| PE-2 | **Trino is the sole serving engine with an OOM history; KEDA baseline is 1 warm worker.** Correctly *not* over-provisioned, but a cache-miss burst hits a single warm worker before KEDA scales, and Trino has OOM'd under refresh before. | `helm/trino/values-prod.yaml` L34-54; `technology-cost-analysis-2026-07.md` §3.5. | **Low** | Bounded heap + restart-on-OOM are already in place (per MEMORY). Keep the KEDA burst ceiling; only cut `maxReplicas` on measured hit-rate evidence, as the cost doc argues. |

**Already good (PE):** Graviton (arm64) t4g everywhere; Karpenter Spot pools with
consolidation + dedicated pools (streaming/trino/ondemand) so workloads land on the
cheapest fitting node; KEDA lag-based Trino scaling; Aurora Serverless v2 ACU
autoscaling for the bursty OLTP profile; EBS gp3 (not gp2) on the AL2023 nodes;
S3 Intelligent-Tiering on the warehouse. Sizing is evidence-driven (e.g. Neo4j cpu
2→3 to use headroom it already pays for).

---

## Cost Optimization

| # | Finding | Evidence | Severity | Recommendation |
|---|---|---|---|---|
| CO-1 | **On-demand Kafka broker pin (+~$100/mo) and on-demand Neo4j/Trino-coordinator** are the largest avoidable-looking lines — but each is a *deliberate reliability buy*, not waste. | `strimzi-kafka/values-prod.yaml` L39-70; `technology-cost-analysis-2026-07.md` §2, §3.1. | **Info** | Do **not** re-Spot the brokers (documented 3× quorum-loss). These are correctly-priced reliability decisions. No action. |
| CO-2 | **Config-level cost levers are essentially exhausted.** EKS extended-support fee (~$360/mo) eliminated, Valkey swap done, Intelligent-Tiering live, VPC endpoints trimmed to 2, single-node cache, single Aurora writer. | `terraform.tfvars` L55-65; `bootstrap.tf` L142-151, L564-581; cost doc §4. | **Info** | The remaining gains are structural (DuckDB transform swap), not tuning. Cost posture is excellent. |

**Already good (COST):** the entire cost story is a highlight — see §"What's already
good" below.

---

## Sustainability

| # | Finding | Evidence | Severity | Recommendation |
|---|---|---|---|---|
| SU-1 | Sustainability is implicitly strong via Graviton + Spot + scale-to-need, but not explicitly measured. | arm64 across nodes; Karpenter consolidation. | **Low** | No action needed at this scale; the cost posture *is* the sustainability posture here. |

---

## What's already good (do NOT "fix" these)

- **Cost optimization is genuinely excellent and deliberate.** Karpenter Spot pools +
  consolidation, Aurora Serverless v2 (0.5–2 ACU pay-per-use for a bursty OLTP
  workload), fck-nat single instance instead of per-AZ managed NAT (ADR-0009,
  ~$60–95/mo saved), VPC interface endpoints trimmed to just `ecr.api`/`ecr.dkr` in one
  subnet (S3 layer pulls via the free gateway endpoint), S3 Intelligent-Tiering,
  Valkey over Redis (−20%), EKS extended-support fee eliminated (1.33/AL2023/STANDARD),
  and a clever dual budget setup (real-usage budget + a credit-depletion tripwire that
  fires the moment promotional credits stop covering the bill).
- **Security fundamentals are solid.** Per-workload IRSA with tight `sub`+`aud` trust,
  KMS-everywhere (root/audit/connector CMKs with rotation enabled), private-only EKS API
  reached via SSM tunnel (no public endpoint, no ISP-IP lockout), all S3 buckets
  public-blocked + SSE-KMS + TLS-only + namespace-prefix-scoped IAM with explicit
  bucket-root denies, external-dns scoped to the Brain zone, Neo4j ClusterIP-only.
- **GitOps + IaC discipline.** ArgoCD app-of-apps with prune+selfHeal+ServerSideApply,
  OIDC CI/CD with a `production` approval gate, immutable+scanned ECR with lifecycle,
  everything modularized and reversible-by-a-flag (fck-nat, CRR, EKS support type).
- **Reliability *reasoning* is mature.** Every SPOF has a written recovery story and a
  named graduation trigger (ADR-0009/0004/0011). Real backups exist for Aurora (35d)
  and Neo4j (DLM + nightly dump). The ingest path is replay-tolerant by design (Bronze
  = SoR, at-least-once, idempotent — ADR-0012), so "no event loss" survives most of the
  SPOFs above as *latency* impact, not *data-loss* impact.
- **Right-sizing is evidence-driven**, not guessed — sizing changes cite Prometheus
  measurements and incident post-mortems inline.

---

## Top 10 prioritized improvement opportunities

1. **Add an account detective-control baseline: CloudTrail + GuardDuty** (SEC-1). Highest
   security ROI; a paid PII-holding prod account currently has no tamper-evident API
   trail or threat detection. Feed CloudTrail into the WORM audit bucket that already
   exists. (Low effort, single-digit $/mo.)
2. **Wire actionable alerting: one SNS topic → email + chat, attached to the existing
   alarms** (OE-1). Today no alarm pages anyone. Wire it into the Aurora ACU, NAT
   status, and composite EKS-unhealthy alarms. (Low effort, high leverage.)
3. **Wire `module.observability` into prod — or ADR-document its Grafana-Cloud
   replacement** (OE-2). The intended composite EKS-unhealthy safety-net alarm is not
   applied in prod at all.
4. **Complete the DuckDB transform cutover** (PE-1). Removes the recurring Spark-OOM
   incident class and cuts batch cost — the one real performance mismatch, and the
   migration is already partially landed.
5. **Add a second Aurora `db.serverless` reader instance at T1** (REL-1). Pay-per-use,
   bounded idle cost, removes the sole-writer restart window on the revenue-path DB.
6. **Spread Kafka brokers across AZs (`topology…/zone`), not just hosts** (REL-6). Cheap
   CR change that prevents an AZ loss from taking 2 of 3 brokers and breaking quorum
   despite the on-demand pin.
7. **Introduce secret rotation for JWT/cookie/connector app-secrets** (SEC-2), or a
   documented rotation SLA. Aurora already rotates; app secrets are static.
8. **Enable S3 CRR for the warehouse SoR once residency sign-off lands** (REL-7). The
   machinery is coded and gated; the system of record has no off-region copy today.
9. **Scope data-tier SG egress / confirm NetworkPolicies constrain pod egress** (SEC-3).
   Reduce the blast radius of a compromised pod from "the whole VPC + open internet."
10. **Promote the inline "graduation trigger" comments into machine-checked SLO alerts**
    (OE-3): identity-lag → Neo4j Enterprise trigger; ACU 80% → capacity bump; Trino OOM
    → serving-degradation. Make the tripwires page, not just document.

---

### Single biggest architectural risk

**Concentrated single-writer / single-instance SPOFs on the revenue-critical
control-plane paths — the single fck-nat egress, the single Aurora writer, the single
Neo4j identity SoR, and the single Kafka-Connect landing writer — combined with an
alerting posture that pages no one.** Individually each SPOF is defensible (documented
recovery, replay-tolerant ingest) and correctly cost-justified at starter scale. The
compounding risk is that when one of them fails, **nothing is paged** (OE-1) and, for
identity/egress, **recovery is manual and the "rebuild" path is asserted but unrehearsed**
(REL-2/REL-3). The data-loss blast radius is well-contained by the Bronze-is-SoR /
at-least-once design; the *availability and freshness* blast radius is not. As
promotional credits deplete and real paying brands arrive expecting real-time freshness,
these accepted-at-T0 tradeoffs become genuine SLA risks — so the priority is not to
eliminate the SPOFs today (cost-justified) but to (a) make their failure *loud* and
*paged*, and (b) *rehearse* the identity/egress recovery before it is needed in anger.
