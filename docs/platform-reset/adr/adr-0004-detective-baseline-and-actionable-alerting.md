# ADR-0004 — Account detective-control baseline (CloudTrail + GuardDuty) and actionable SNS alerting

**Status:** Accepted (owner-ratified 2026-07-14)
**Date:** 2026-07-14
**Deciders:** Engineering Program Lead, Security owner (owner sign-off required)
**Relates to:** ADR-0001, `04-architecture-review.md` (OE-1/OE-2, SEC-1/SEC-2/SEC-4), `06-redesign-proposal.md` §2.11

## Context

The Well-Architected review (`04`) identifies the two weakest pillars as **Operational Excellence**
and a **Security** gap, and both are *wiring* problems, not architecture problems:

- **OE-1 — nothing pages anyone.** Every CloudWatch alarm in the repo is either an EC2 built-in
  auto-action (recover/reboot) or explicitly `alarm_actions`-less. Aurora ACU-saturation, Redis, and
  the composite EKS-unhealthy alarms have **no SNS topic and no chat/paging sink** — an outage is
  discovered by a human noticing, not by a page. `grep aws_sns_topic infra/terraform` → none.
- **OE-2 — `module.observability` is not invoked in prod.** The intended composite EKS-unhealthy
  safety-net alarm is dead code in prod; app alerting relies implicitly on OTel→Grafana Cloud with
  no confirmed paging path.
- **SEC-1 — no account detective baseline.** No CloudTrail, GuardDuty, Config, Security Hub, or WAF
  anywhere in the IaC. For a **paid prod account holding PII** (identity graph, connector OAuth
  tokens) there is no tamper-evident API audit trail and no threat detection — while a WORM audit
  bucket + audit CMK already exist with nothing feeding them the control-plane trail.
- **SEC-4 — the audit CMK blanket-delegates `kms:*` to account root**, so an ordinary IAM mistake
  could reach the tamper-evidence key.

These are the highest-ROI, lowest-cost fixes in the whole program (single-digit $/mo), and — per
ADR-0001 — you cannot "rebuild" your way to a paging alarm; you wire one.

## Decision

**Add the detective baseline and actionable alerting as net-new, additive Terraform. No rebuild.**

1. **CloudTrail → existing WORM audit bucket.** Enable an account (or org) CloudTrail, multi-region,
   log-file-validation on, delivering to the existing `brain-audit-prod` S3 bucket (Object Lock
   COMPLIANCE, 7yr). This finally feeds the immutable audit store the AWS control-plane trail it was
   built for.
2. **GuardDuty** enabled in ap-south-1 (single-digit $/mo at this scale). Config + Security Hub
   follow as a fast-follow, not a blocker.
3. **One SNS topic → email + chat webhook**, wired into the **existing** Aurora-ACU, NAT-status,
   Redis, and a **composite EKS-unhealthy** alarm. Promote the inline "graduation trigger" comments
   (identity-lag, ACU 80%, Trino-OOM) into **paging** Prometheus/Grafana SLO rules.
4. **Resolve OE-2 explicitly:** either wire `module.observability` into `envs/prod`, **or** ADR-record
   that Grafana-Cloud alerting fully replaces it — and prove the EKS-unhealthy signal pages somewhere.
   No "dead safety-net alarm in prod" state is acceptable.
5. **Audit-CMK isolation (SEC-4):** give the audit CMK its **own** key policy that does not blanket-
   delegate `kms:*` to account root, so the audit trail's tamper-evidence cannot be undone by an
   everyday IAM grant.
6. **Secret rotation (SEC-2):** add scheduled rotation (or a documented rotation SLA) for
   JWT/cookie signing and connector app-secrets. Aurora master already rotates; these are static
   shells today.

## Alternatives Considered

- **Rely on OTel→Grafana Cloud alone for alerting.** Acceptable *only if* ADR-documented and proven
  to page; today the intended composite alarm is not applied in prod at all (OE-2). Chosen path
  requires an explicit page path either way.
- **Defer the detective baseline until "more traffic."** Rejected: this is a paid, PII-holding prod
  account today; a tamper-evident trail and threat detection are table stakes, and the cost is
  single-digit $/mo.
- **Third-party APM/SIEM (Datadog, etc.) for the baseline.** Rejected on cost at this stage;
  CloudTrail + GuardDuty into existing AWS-native + Grafana surfaces is sufficient and cheap.
- **Broad KMS key-policy left as-is.** Rejected for the audit CMK specifically (SEC-4); the everyday
  CMKs may keep the common `AllowAccountRoot` pattern.

## Consequences

- **Positive:** the platform now **pages** on the alarms that today fire into the void, and is
  **audited** (tamper-evident CloudTrail into WORM storage) and **threat-monitored** (GuardDuty).
  The single biggest architectural risk in `04` — concentrated SPOFs whose failure pages no one — is
  materially reduced by making failures *loud*.
- **Positive:** audit-key tamper-evidence is hardened; app secrets gain a rotation story.
- **Negative / accepted:** more alarms introduce some noise; thresholds are tuned from the inline
  evidence already written in the manifests. CloudTrail + GuardDuty add single-digit $/mo (within
  the FinOps budget guardrails in `07`).
- **Dependency:** the audit bucket + audit CMK are on the "keep" list and must survive any future
  teardown (they are immutable for 7 years regardless).

## Rollback

All resources are additive Terraform: `terraform destroy -target` the SNS topic, CloudTrail,
GuardDuty detector, and rotation schedules, or `git revert` the PR (ArgoCD/TF reconcile). Disabling
them returns the account to its prior (un-paged, un-audited) state with no data impact — though
disabling CloudTrail/GuardDuty on a paid PII account is explicitly discouraged. The audit-CMK policy
change is a policy revert. No destructive dependency.
