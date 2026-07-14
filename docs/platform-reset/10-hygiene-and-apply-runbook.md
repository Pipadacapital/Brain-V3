# 10 — Hygiene Deletes + Additive-TF Apply Runbook

**Author:** Engineering Program Lead · **Date:** 2026-07-14
**Account:** 380254378136 (PAID PRODUCTION) · **Region:** ap-south-1 · **Domain:** brain.pipadacapital.com
**Status:** RUNBOOK — to be executed **by the repo owner during the `release → master` promotion**, NOT now.
**Relates to:** ADR-0001…0005 (Accepted 2026-07-14), `06-redesign-proposal.md`, `07-cost-optimization.md`,
`02-destruction-plan.md` (SHELVED — this is the additive counterpart), `inventory/*.md`.

> **Ground rules (carry over from the program).** SELECTIVE REBUILD is ratified; nothing is torn down.
> Every step below is **additive or a low-risk orphan delete**, **reversible**, and **auditable**. The
> owner runs Part A (CLI hygiene) and Part B (`terraform apply`) **manually**, in order, during the
> owner-only `release → master` promotion — the same merge that fires `deploy.yml` + the infra TF lane.
> Do **not** run any of this from a feature branch or from CI. Confirm each precondition before acting.

---

## Part A — Low-risk hygiene CLI deletes (orphans; ~$0/mo but they linger and clutter)

These five items are **orphaned/stray** in the live inventory (`02-destruction-plan.md`,
`inventory/observability-dns.md` §18/§3, `inventory/databases-backups.md` §9). None is attached to a
live workload; each is safe to delete **at any time** with no dependency ordering between them. They are
**not** Terraform-managed (TF never created them), so they must be removed by an explicit CLI call — a
`terraform apply` will neither create nor delete them.

> **Pre-flight (once):** `aws sts get-caller-identity` → confirm account `380254378136`; export
> `AWS_REGION=ap-south-1`. Do a **dry read** before each delete (the `describe`/`list` shown) and eyeball
> the identifiers. All deletes are `~$0/mo` — the value is hygiene + a smaller attack/confusion surface,
> not cost.

### A1 — Orphaned `px` ACM certificate (inventory item #18, `InUse=false`)

- **What:** `px.brain.pipadacapital.com` (+SAN app/api) cert,
  ARN `arn:aws:acm:ap-south-1:380254378136:certificate/5247056b-bbaf-4041-8c97-84e190c8d818` —
  `ISSUED · InUse=false · RenewalEligibility=INELIGIBLE`, superseded by the live cert #17.
- **Guard:** confirm it is NOT the ALB's cert. `InUse` MUST be `false`.
  ```
  aws acm describe-certificate \
    --certificate-arn arn:aws:acm:ap-south-1:380254378136:certificate/5247056b-bbaf-4041-8c97-84e190c8d818 \
    --query 'Certificate.{InUse:InUse,Domain:DomainName,Status:Status}'
  # expect: InUse=false
  aws acm delete-certificate \
    --certificate-arn arn:aws:acm:ap-south-1:380254378136:certificate/5247056b-bbaf-4041-8c97-84e190c8d818
  ```
- **Do NOT** touch cert #17 (`InUse=true`, bound to the ALB) — ACM blocks deleting an in-use cert, and
  removing the zone's ACM-validation CNAMEs would break #17's auto-renewal.

### A2 — Orphan IAM policy `brain-prod-otel-collector-secrets` (Attachments = 0)

- **What:** a customer-managed policy with zero attachments (`02-destruction-plan.md` §IAM).
- **Guard:** confirm `AttachmentCount == 0` before deleting.
  ```
  POLICY_ARN=arn:aws:iam::380254378136:policy/brain-prod-otel-collector-secrets
  aws iam get-policy --policy-arn "$POLICY_ARN" --query 'Policy.AttachmentCount'   # expect: 0
  # delete non-default versions first if any, then the policy:
  aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
    --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text \
    | tr '\t' '\n' | while read -r v; do [ -n "$v" ] && aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$v"; done
  aws iam delete-policy --policy-arn "$POLICY_ARN"
  ```

### A3 — Manual ElastiCache snapshot `brain-prod-redis-pre-valkey`

- **What:** a pre-Valkey-migration safety copy of the old Redis 7.1.0 engine (~6 MB). A **manual**
  snapshot: it does NOT auto-expire and bills (trivially) forever until removed.
- **Guard:** Valkey MUST be confirmed healthy first (this is the rollback copy).
  ```
  aws elasticache describe-snapshots --snapshot-name brain-prod-redis-pre-valkey \
    --query 'Snapshots[].{Name:SnapshotName,Status:SnapshotStatus,Src:CacheClusterId}'
  aws elasticache delete-snapshot --snapshot-name brain-prod-redis-pre-valkey
  ```

### A4 — Stray `/aws/lambda/test` CloudWatch log group (NEVER_EXPIRE, 0 B, non-Brain)

- **What:** an empty stray log group set to never expire (`inventory/observability-dns.md` §3). Not Brain.
  ```
  aws logs describe-log-groups --log-group-name-prefix /aws/lambda/test \
    --query 'logGroups[].{Name:logGroupName,Bytes:storedBytes,Retention:retentionInDays}'
  aws logs delete-log-group --log-group-name /aws/lambda/test
  ```

### A5 — Stray IAM role `test-role-olkagc08` (non-Brain console leftover)

- **What:** a console leftover with an attached `AWSLambdaBasicExecutionRole-…` managed policy
  (`02-destruction-plan.md` §IAM). Outside the Brain graph.
- **Guard:** confirm it is NOT referenced by any Brain trust relationship / instance profile first.
  ```
  aws iam get-role --role-name test-role-olkagc08 --query 'Role.{Created:CreateDate,Trust:AssumeRolePolicyDocument}'
  # detach managed policies, delete inline policies + instance profiles, then the role:
  aws iam list-attached-role-policies --role-name test-role-olkagc08 --query 'AttachedPolicies[].PolicyArn' --output text \
    | tr '\t' '\n' | while read -r p; do [ -n "$p" ] && aws iam detach-role-policy --role-name test-role-olkagc08 --policy-arn "$p"; done
  aws iam list-role-policies --role-name test-role-olkagc08 --query 'PolicyNames' --output text \
    | tr '\t' '\n' | while read -r n; do [ -n "$n" ] && aws iam delete-role-policy --role-name test-role-olkagc08 --policy-name "$n"; done
  aws iam delete-role --role-name test-role-olkagc08
  ```

> **NOT in scope here (leave alone):** the default VPC `vpc-09eccb21d72404ce4` (account hygiene, not
> Brain), the 12 `AWSServiceRoleFor*` roles (AWS clears them), and the live cert #17 / any in-use
> resource. Do not delete the tfstate bucket, lock table, or state CMK while IaC is live.

---

## Part B — Ordered `terraform apply` for the new additive TF (Lane 1)

The additive Terraform from the platform-reset program wires the operational gaps ADR-0004/0005 flagged
**without a rebuild**: an account **security baseline** (CloudTrail → WORM audit bucket + GuardDuty), an
**alerting** path (one SNS topic → email + chat) attached to the alarms that today page no one, and the
**observability** module (the composite EKS-unhealthy safety-net alarm) which exists but is not yet wired
into `envs/prod`. Modules live under `infra/terraform/modules/{security-baseline,alerting,observability}`;
they are called from `infra/terraform/envs/prod` and reviewed via the promotion PR like any other IaC.

> **Preconditions.** All Lane guards are green on the promotion PR (including `cost-guard` and
> `v4-naming-guard`). You have the tfstate backend (`brain-tfstate-prod` S3 + `brain-tfstate-lock-prod`
> DynamoDB + state CMK) and are authenticated to account `380254378136`. **Never** run `terraform
> destroy` on this account (ADR-0001). Apply from `infra/terraform/envs/prod`.

### B0 — Plan first, always
```
terraform -chdir=infra/terraform/envs/prod init -input=false
terraform -chdir=infra/terraform/envs/prod plan -input=false -out=reset-additive.plan
```
Review the plan. It MUST be **create-only / update-in-place** for the new modules and MUST NOT show a
destroy/replace of EKS, Aurora, ElastiCache, Kafka, the network/fck-nat, the VPC endpoints, the KMS
CMKs, the tfstate backend, or any S3 medallion/audit bucket. If a destroy/replace of a banked-win
resource appears, **STOP** and reconcile — that is a regression, not this runbook.

### B1 — Security baseline (ADR-0004: CloudTrail + GuardDuty)
```
terraform -chdir=infra/terraform/envs/prod apply -input=false -target=module.security_baseline reset-additive.plan
```
- CloudTrail: multi-region, log-file validation ON, delivering into the existing **WORM audit** S3
  bucket under the audit CMK. GuardDuty: detector enabled in ap-south-1.
- **Verify:** `aws cloudtrail get-trail-status --name <trail>` shows `IsLogging=true`;
  `aws guardduty list-detectors` returns one enabled detector.
- **Rollback:** `git revert` the module call (TF reconcile) — but disabling CloudTrail/GuardDuty on a
  paid PII account is explicitly discouraged (ADR-0004 Consequences).

### B2 — Alerting (ADR-0004: one SNS topic → email + chat)
```
terraform -chdir=infra/terraform/envs/prod apply -input=false -target=module.alerting reset-additive.plan
```
- One SNS topic with an email subscription + chat webhook; existing CloudWatch alarms (and B3's
  composite EKS-unhealthy alarm) route to it so they page a human.
- **Verify:** confirm the email/chat subscription is `Confirmed`; fire a test via
  `aws sns publish --topic-arn <arn> --message "brain-prod alerting test"` and confirm receipt.
- **Rollback:** `git revert` the module call; alarms simply return to their prior (silent) state.

### B3 — Observability wiring (ADR-0004 OE-2: wire `module.observability` into prod)
```
terraform -chdir=infra/terraform/envs/prod apply -input=false -target=module.observability reset-additive.plan
```
- Wires the composite EKS-unhealthy safety-net alarm (dead code in prod until now) and points it at the
  B2 SNS topic. This closes OE-2 by wiring, not rebuild.
- **Verify:** the composite alarm exists and is in `OK`; confirm it publishes to the SNS topic.
- **Rollback:** `git revert` the `envs/prod` wiring; the alarm returns to unwired (as today).

### B4 — Full apply (converge)
```
terraform -chdir=infra/terraform/envs/prod apply -input=false reset-additive.plan
```
Applies any remaining plan diff. Re-run `plan` afterward and confirm **no drift** (empty plan).

> **DR / residency (ADR-0005) note.** S3 cross-region replication stays **gated**
> (`enable_cross_region_replication = false` in `terraform.tfvars`) — it ADDS cost and is a residency
> decision. Enable it deliberately in a **separate** owner-approved apply (the `prod-apply.yml`
> `production` environment gate), never as a rider on this hardening apply.

---

## Post-run checklist

- [ ] Part A: all five orphans deleted; a re-list returns empty. cert #17 + Valkey untouched and healthy.
- [ ] Part B: `terraform plan` is clean (no drift); no banked-win resource was replaced/destroyed.
- [ ] CloudTrail `IsLogging=true` into the WORM audit bucket; GuardDuty detector enabled.
- [ ] SNS alerting subscription `Confirmed`; a test publish was received; the EKS-unhealthy alarm routes to it.
- [ ] `cost-guard` still green (fck-nat, Aurora 0.5-ACU floor, EKS STANDARD/≥1.33, Kafka rack-awareness).
- [ ] CRR remains gated (`enable_cross_region_replication = false`) unless separately approved.
