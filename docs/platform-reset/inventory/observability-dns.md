# Observability & DNS — Cloud Inventory

**Domain:** Observability & DNS
**Account:** 380254378136 (PAID PRODUCTION)
**Primary region:** ap-south-1 · **Secondary sweep:** us-east-1 (global services)
**Collected:** 2026-07-14 · **Method:** read-only AWS CLI (describe/list/get only)
**Scope:** CloudWatch Logs, CloudWatch Alarms/Dashboards, EventBridge (rules + buses + scheduler), SNS, Route 53, ACM, CloudFront, Synthetics, X-Ray.

> All cost figures are ESTIMATES with stated assumptions. This domain is dominated by **CloudWatch Logs ingestion + storage** (EKS control-plane logs). No CloudFront distributions exist. Route 53 records are `external-dns`-managed. The design is lean and sound — no dead observability sprawl beyond one stray `/aws/lambda/test` log group.

---

## 1. Summary Table

| # | Resource | Type | Region | Brain? | Key config | Est. $/mo |
|---|----------|------|--------|--------|-----------|-----------|
| 1 | `/aws/eks/brain-prod/cluster` | CloudWatch Log Group | ap-south-1 | yes | 30-day retention, ~2.32 GB stored | ~$1.16 storage + variable ingest (~$5–30) |
| 2 | `/aws/rds/cluster/brain-prod-postgres/postgresql` | CloudWatch Log Group | ap-south-1 | yes | 30-day retention, ~16.9 MB stored | ~$0.01 + minor ingest |
| 3 | `/aws/lambda/test` | CloudWatch Log Group | ap-south-1 | **stray/orphan** | NEVER_EXPIRE, 0 bytes | ~$0.00 |
| 4 | `brain-prod-aurora-acu-saturation` | CloudWatch Alarm | ap-south-1 | yes | AWS/RDS ACUUtilization, no actions | $0.10 |
| 5 | `brain-prod-nat-instance-check-reboot` | CloudWatch Alarm | ap-south-1 | yes | EC2 StatusCheckFailed_Instance → auto-reboot | $0.10 |
| 6 | `brain-prod-nat-system-check-recover` | CloudWatch Alarm | ap-south-1 | yes | EC2 StatusCheckFailed_System → auto-recover | $0.10 |
| 7 | `brain-prod-redis-evictions-001` | CloudWatch Alarm | ap-south-1 | yes | ElastiCache Evictions, no actions | $0.10 |
| 8 | `brain-prod-redis-memory-001` | CloudWatch Alarm | ap-south-1 | yes | ElastiCache DatabaseMemoryUsagePercentage, no actions | $0.10 |
| 9 | `AutoScalingManagedRule` | EventBridge Rule (default bus) | ap-south-1 | AWS-managed | ASG lifecycle, no schedule | $0.00 |
| 10 | `brain-prod-karpenter-instance-state-change` | EventBridge Rule | ap-south-1 | yes | → SQS `brain-prod` (Karpenter interruption) | $0.00 |
| 11 | `brain-prod-karpenter-rebalance` | EventBridge Rule | ap-south-1 | yes | → SQS `brain-prod` | $0.00 |
| 12 | `brain-prod-karpenter-scheduled-change` | EventBridge Rule | ap-south-1 | yes | → SQS `brain-prod` | $0.00 |
| 13 | `brain-prod-karpenter-spot-interruption` | EventBridge Rule | ap-south-1 | yes | → SQS `brain-prod` | $0.00 |
| 14 | `default` event bus | EventBridge Bus | ap-south-1 | AWS-default | Only bus; free tier for AWS-source events | $0.00 |
| 15 | `brain-ses-notifications` | SNS Topic | ap-south-1 | yes | 1 confirmed email sub (rishabhporwal95@gmail.com) | ~$0.00 |
| 16 | `brain.pipadacapital.com` | Route 53 Public Hosted Zone | global | yes | 20 record sets, external-dns managed | $0.50 + queries |
| 17 | `brain.pipadacapital.com` (SAN) cert | ACM Certificate | ap-south-1 | yes | ISSUED, **InUse=true**, renew-eligible, exp 2027-01-25 | $0.00 |
| 18 | `px.brain.pipadacapital.com` (SAN) cert | ACM Certificate | ap-south-1 | yes | ISSUED, **InUse=false**, renew-INELIGIBLE, exp 2027-01-23 | $0.00 |
| — | CloudFront | Distribution | global | — | **NONE (0 distributions)** | $0.00 |
| — | CloudWatch Dashboards | Dashboard | ap-south-1 | — | **NONE** | $0.00 |
| — | EventBridge Scheduler | Schedule | ap-south-1 | — | **NONE** | $0.00 |
| — | Synthetics Canaries | Canary | ap-south-1 | — | **NONE** | $0.00 |
| — | X-Ray | Group | ap-south-1 | AWS-default | Only `Default` group, insights disabled | $0.00 |
| — | ACM (us-east-1) | Certificate | us-east-1 | — | **NONE** (no CloudFront certs) | $0.00 |

**Resource counts:** 3 Log Groups · 5 Alarms · 5 EventBridge Rules (+1 default bus) · 1 SNS Topic (1 sub) · 1 Route 53 Zone (20 records) · 2 ACM Certs · 0 CloudFront · 0 Dashboards · 0 Scheduler · 0 Canaries · 1 X-Ray Default group.

---

## 2. Per-Resource Detail

### CloudWatch Logs (ap-south-1)

**1. `/aws/eks/brain-prod/cluster`**
- ARN: `arn:aws:logs:ap-south-1:380254378136:log-group:/aws/eks/brain-prod/cluster:*`
- Retention: **30 days** · Stored: **2,320,329,411 bytes (~2.32 GB)**
- Brain-related: yes (EKS control-plane logs for `brain-prod` cluster).
- Dependency: EKS cluster control-plane logging config. Deleting the group does not delete the cluster; EKS recreates it on next log emission if control-plane logging stays enabled.
- Cost: Storage ~$0.03/GB-mo ⇒ ~$0.07/mo for stored bytes; but **ingestion is the real driver** at $0.50/GB (ap-south-1). At ~2.3 GB steady-state over 30 days the ingest+storage blend is roughly **$5–30/mo** depending on control-plane verbosity (API server / audit / authenticator logs). Assumption: moderate control-plane log volume.

**2. `/aws/rds/cluster/brain-prod-postgres/postgresql`**
- ARN: `arn:aws:logs:ap-south-1:380254378136:log-group:/aws/rds/cluster/brain-prod-postgres/postgresql:*`
- Retention: **30 days** · Stored: **16,907,530 bytes (~16.1 MB)**
- Brain-related: yes (Aurora PostgreSQL `brain-prod-postgres` engine logs).
- Dependency: Aurora cluster log export config. Recreated by RDS if PG log export remains on.
- Cost: negligible — **~$0.01/mo** storage + minor ingest.

**3. `/aws/lambda/test`** — STRAY
- ARN: `arn:aws:logs:ap-south-1:380254378136:log-group:/aws/lambda/test:*`
- Retention: **NEVER_EXPIRE** · Stored: **0 bytes**
- Brain-related: **No** — appears to be a leftover test group (no `brain`/`prod` in name, no backing Lambda observed in this sweep). Zero bytes, but NEVER_EXPIRE is a minor hygiene flag.
- Cost: **~$0.00/mo**.

> No log groups or metric-filter/subscription-based cross-account exports observed. No CloudWatch Logs Insights saved queries surfaced in this scope.

### CloudWatch Alarms (ap-south-1) — all in `OK` state at collection

**4. `brain-prod-aurora-acu-saturation`** — AWS/RDS `ACUUtilization`. No alarm actions wired (notify-less; likely dashboards/manual). ARN `...alarm:brain-prod-aurora-acu-saturation`.
**5. `brain-prod-nat-instance-check-reboot`** — AWS/EC2 `StatusCheckFailed_Instance` → action `arn:aws:automate:ap-south-1:ec2:reboot` (self-healing NAT instance / fck-nat).
**6. `brain-prod-nat-system-check-recover`** — AWS/EC2 `StatusCheckFailed_System` → action `arn:aws:automate:ap-south-1:ec2:recover`.
**7. `brain-prod-redis-evictions-001`** — AWS/ElastiCache `Evictions`. No actions.
**8. `brain-prod-redis-memory-001`** — AWS/ElastiCache `DatabaseMemoryUsagePercentage`. No actions.
- Cost: standard metric alarms **$0.10/alarm-mo** ⇒ **$0.50/mo** total. Note alarms 5 & 6 use EC2-native `automate:` actions (free, no SNS). No composite alarms exist.

### EventBridge (ap-south-1)

**9. `AutoScalingManagedRule`** — AWS-managed EC2 Auto Scaling lifecycle rule on the default bus. Not Brain-authored.
**10–13. `brain-prod-karpenter-{instance-state-change,rebalance,scheduled-change,spot-interruption}`** — All ENABLED, no schedule (event-pattern driven), **all target the same SQS queue** `arn:aws:sqs:ap-south-1:380254378136:brain-prod` (Karpenter interruption queue, target id `KarpenterInterruptionQueue`). These feed Karpenter Spot-interruption / rebalance handling — core to the Spot cost strategy.
**14. `default` event bus** — only bus; AWS-source events are free.
- Cost: AWS-service-sourced events are free on the default bus ⇒ **~$0.00/mo**.
- **EventBridge Scheduler: NONE.**

### SNS (ap-south-1)

**15. `brain-ses-notifications`**
- ARN: `arn:aws:sns:ap-south-1:380254378136:brain-ses-notifications`
- Subscriptions: **1 confirmed** — Protocol `email`, endpoint `rishabhporwal95@gmail.com` (`SubscriptionsConfirmed=1`).
- Purpose: SES bounce/complaint/delivery notifications (matches the SES DKIM CNAMEs in the zone).
- Cost: first 1,000 email notifications/mo free ⇒ **~$0.00/mo**. No topic in us-east-1.

### Route 53 (global)

**16. Hosted Zone `brain.pipadacapital.com.`**
- Id: `/hostedzone/Z00011362R9ERGL7EC2J9` · Public · Comment: "Brain prod subdomain - external-dns managed" · **20 record sets**.
- Record inventory:
  - Apex/app/api/px **A-ALIAS** → shared ALB `k8s-brainprod-09e4b2bc81-1673389781.ap-south-1.elb.amazonaws.com.` (all four hostnames point at the SAME AWS Load Balancer Controller ALB).
  - `external-dns` **TXT** ownership/heritage records (`external-dns/owner=brain-prod`) for web/core/collector ingresses, incl. `cname-*` registry TXTs.
  - **3× ACM DNS-validation CNAMEs** (`_...acm-validations.aws.`) for apex/api/app/px cert.
  - **3× SES DKIM CNAMEs** (`*._domainkey → *.dkim.amazonses.com`).
  - NS + SOA (AWS-assigned nameservers `ns-1425/875/1718/481`).
- Dependency: DNS records are reconciled by the in-cluster `external-dns` controller (owner TXT `brain-prod`). ALIAS targets depend on the ALB, which depends on the AWS Load Balancer Controller + ingress objects in EKS.
- Cost: **$0.50/mo** per hosted zone + query volume (typically <$0.10/mo at this scale). Assumption: low query volume.

### ACM (ap-south-1) — no us-east-1 certs

**17. `brain.pipadacapital.com` (+SAN app/api/px)** — `arn:.../certificate/684f6184-f357-46ca-8ef9-3be62239c220` · **ISSUED · InUse=true** · RSA-2048 · RenewalEligibility=**ELIGIBLE** · NotAfter **2027-01-25**. This is the **live cert bound to the ALB/ingress**.
**18. `px.brain.pipadacapital.com` (+SAN app/api)** — `arn:.../certificate/5247056b-bbaf-4041-8c97-84e190c8d818` · **ISSUED · InUse=false** · RSA-2048 · RenewalEligibility=**INELIGIBLE** · NotAfter **2027-01-23**. **Superseded/orphaned** — a superset cert (#17) replaced it; not attached to any listener.
- Cost: public ACM certs are **free**. No CloudFront (us-east-1) certs exist.

### Not present (verified empty)
- **CloudFront:** 0 distributions (`DistributionList.Quantity = None`). No CDN layer — ALB fronts everything.
- **CloudWatch Dashboards:** 0.
- **EventBridge Scheduler:** 0 schedules.
- **Synthetics Canaries:** 0.
- **X-Ray:** only the AWS-default `Default` group, insights disabled — no active tracing config.
- **us-east-1:** no log groups, no alarms, no SNS topics, no ACM certs.

---

## 3. Destruction Considerations (documentation only — nothing deleted)

**Ordering & dependency notes for tearing down THIS domain:**

1. **DNS records are owned by `external-dns`, not by hand.** The apex/app/api/px A-ALIAS + TXT records are reconciled from in-cluster ingress objects (owner TXT `brain-prod`). If you delete records directly while the `external-dns` controller is still running in EKS, it will **recreate them**. Correct order: scale down / remove the `external-dns` deployment (and/or the ingresses) FIRST, then delete records, then the hosted zone last. The 3 ACM-validation CNAMEs and 3 SES DKIM CNAMEs are NOT external-dns-managed — they must be removed manually (or with the cert/SES identity) before the zone can be cleanly emptied.

2. **The live ACM cert (#17, InUse=true) is bound to the ALB — do not delete it before the ALB/listener is gone.** ACM blocks deletion of an in-use certificate. Sequence: delete the ingress → AWS Load Balancer Controller removes the ALB + listener → cert becomes not-in-use → then the cert can be deleted. The orphaned cert (#18, InUse=false) can be deleted at any time with no impact. Removing the zone's ACM-validation CNAMEs before renewal will break future auto-renewal of #17 (it is Eligible/managed renewal).

3. **The 4 Karpenter EventBridge rules all target one SQS queue (`brain-prod`) and are load-bearing for the Spot strategy.** They belong to the compute/Karpenter domain, not truly to observability — deleting them mid-operation degrades Spot-interruption handling (nodes may be reclaimed without graceful drain). Tear these down together with Karpenter itself, after workloads are drained, and remove the rules before/with the SQS queue to avoid dead-letter noise. `AutoScalingManagedRule` is AWS-managed and regenerates.

**Additional caveats:**
- **Log groups auto-recreate.** `/aws/eks/brain-prod/cluster` and `/aws/rds/.../postgresql` will be recreated by EKS/RDS if control-plane / PG log export remains enabled. Disable log export on the source (EKS logging config / RDS parameter) BEFORE deleting the group, else it reappears. `/aws/lambda/test` is a safe, zero-byte orphan (NEVER_EXPIRE) removable now.
- **Alarms 5 & 6 use `ec2:reboot`/`ec2:recover` automate actions** on the NAT instance — deleting them removes NAT self-healing. Low blast radius but note it. All 5 alarms are cheap and destroy-independent.
- **SNS topic `brain-ses-notifications`** is tied to SES event notifications and the DKIM setup; deleting it stops bounce/complaint delivery. The single email subscription is confirmed to the account owner.
- **Protections found:** none of these observability/DNS resources carry deletion-protection, final-snapshot, or backup/retention locks (those live in the data/compute domains). CloudWatch Logs retention is time-based only (30d on the two real groups; NEVER_EXPIRE on the stray). No resource here blocks a reset via a hard protection flag.

---

## 4. Total Estimated Monthly Cost — Observability & DNS Domain

| Category | Est. $/mo |
|----------|-----------|
| CloudWatch Logs (EKS ingest+storage, dominant) | ~$5–30 |
| CloudWatch Logs (RDS + stray) | ~$0.01 |
| CloudWatch Alarms (5 × $0.10) | $0.50 |
| EventBridge (AWS-source, default bus) | ~$0.00 |
| SNS (within free tier) | ~$0.00 |
| Route 53 (1 zone + low query) | ~$0.55 |
| ACM (public certs) | $0.00 |
| CloudFront / Dashboards / Scheduler / Synthetics / X-Ray | $0.00 |
| **Domain total** | **≈ $6–31 / mo (point estimate ~$8–12)** |

**Assumptions:** CloudWatch Logs ap-south-1 pricing $0.50/GB ingest + ~$0.03/GB-mo storage; EKS control-plane log volume moderate (largest single unknown — a chatty audit log could push the domain toward the high end). Route 53 query volume low. All SNS/EventBridge usage within free tier. This domain is **cost-light**; the only material lever is trimming EKS control-plane log verbosity or shortening the 30-day retention on `/aws/eks/brain-prod/cluster`.
