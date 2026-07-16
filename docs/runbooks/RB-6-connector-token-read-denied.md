# RB-6 — stream-worker can't read connector OAuth tokens (backfill/sync `RECONNECT_REQUIRED`)

**Severity:** connector **backfill + scheduled sync** blocked (historical pulls). Live **webhooks are
unaffected** (HMAC-verified, no token fetch) — orders/spend keep flowing, so this is easy to miss.

**First observed:** 2026-07-16, `sungandh-lok` Shopify connector on brand `8a431f62`.

---

## Symptom

- UI (Settings → Connectors): connector shows **Healthy** but "Sync failed / **Connection expired** /
  Please reconnect this connector before syncing."
- `backfill_job` rows go `queued → running → failed`, `records_processed = 0`,
  `failure_reason = RESOURCE_BACKFILL_FAILED`.
- stream-worker logs:
  ```
  [AwsSecretsManager] Failed to fetch Shopify token: User: arn:aws:sts::<acct>:assumed-role/
  brain-prod-stream-worker/... is not authorized to perform: secretsmanager:GetSecretValue on
  resource: arn:aws:secretsmanager:...:secret:brain/connector/<provider>/<brand>/<host>-XXXXXX
  ...token not found (RECONNECT_REQUIRED)
  ```

## The trap (why "reconnect" does NOT fix it)

The runtime error says `secretsmanager:GetSecretValue`, but the real denial is usually **`kms:Decrypt`**
(GetSecretValue on a KMS-encrypted secret needs decrypt on the connector CMK). And **reconnecting only
re-writes the secret via `core`** (whose IAM works — it created it). The failure is `stream-worker`
*reading* it, so a reconnect changes nothing.

## Confirm it's this (not a genuinely missing/deleted secret)

```bash
# tunnel up: tools/ops/eks-ssm-tunnel.sh   (context brain-prod-ssm)
SECRET_NAME='brain/connector/shopify/<brand>/<host>'   # NAME only (no ARN 6-char suffix)
ROLE=arn:aws:iam::<acct>:role/brain-prod-stream-worker
KEY=$(aws kms describe-key --key-id alias/brain-connector-secrets-prod --query KeyMetadata.KeyId --output text)

# 1. secret exists + which CMK encrypts it (do NOT print the value):
aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query '{arn:ARN,kms:KmsKeyId}'
# 2. no restrictive resource policy on the secret:
aws secretsmanager get-resource-policy --secret-id "$SECRET_NAME" --query ResourcePolicy   # expect: None
# 3. IAM simulator — the discriminator:
aws iam simulate-principal-policy --policy-source-arn "$ROLE" \
  --action-names secretsmanager:GetSecretValue --resource-arns "<full-secret-ARN>" \
  --query 'EvaluationResults[].EvalDecision'                                            # expect: allowed
aws iam simulate-principal-policy --policy-source-arn "$ROLE" \
  --action-names kms:Decrypt --resource-arns "arn:aws:kms:<region>:<acct>:key/$KEY" \
  --query 'EvaluationResults[].EvalDecision'                                            # expect: allowed
```

If the secret **exists**, has **no resource policy**, and the simulator says **allowed for both** — yet
runtime denies — you are in the **RB-6 anomaly**: the simulator cannot see the two remaining causes.

## Root cause (one of two — the simulator evaluates neither)

1. **Org SCP** — a Service Control Policy on the account/OU denying `secretsmanager:*` or `kms:Decrypt`
   for this role. `simulate-principal-policy` does **not** apply SCPs.
2. **Stale IAM state** — the `brain-prod-stream-worker-connector-secrets` policy (AUD-PROD-004) was
   (re)created in a `terraform apply` today; the runtime authorization was still denying while the
   simulator read the new state. (A read that worked earlier then broke mid-day points here.)

## Fix

### A. Rule out / clear an SCP (2 min, console)
- Organizations → account `<acct>` → **Service control policies**. Look for a policy Deny-ing
  `secretsmanager:GetSecretValue` / `kms:Decrypt` (or a broad Deny not exempting this role).
- If present, add `arn:aws:iam::<acct>:role/brain-prod-stream-worker` to the exemption / allow it.

### B. Reconcile IAM (if no SCP)
```bash
cd infra/terraform/envs/prod
terraform plan  -target=module.secrets -target=module.irsa
terraform apply -target=module.secrets -target=module.irsa   # ensure connector_kms_key_arn is set
# then bounce the workers so they take fresh STS sessions:
kubectl --context brain-prod-ssm rollout restart deploy/stream-worker -n stream-worker
```
Verify the connector CMK IAM policy is attached AND the connector CMK **key policy** delegates to IAM
(has the `AllowAccountRoot` `Principal: :root / kms:*` statement — it did on 2026-07-16, so IAM grants
suffice; no key grant needed).

### C. Confirm resolved
```bash
# no more token-fetch denials in the last few minutes:
kubectl --context brain-prod-ssm logs -n stream-worker -l app=stream-worker --since=5m \
  | grep -E "Failed to fetch|not authorized|RECONNECT" | tail
# the queued backfill drains (records_processed climbs), job → completed/partial.
```

## Prereqs the go-live must NOT skip (this incident's siblings — AUD-PROD-004 fill pass)

Both were missing on 2026-07-16 and silently broke the connector runtime:

- **`KMS_KEY_ID`** must be present in the `brain/prod/k8s/stream-worker-env` Secrets Manager blob
  (= `alias/brain-connector-secrets-prod`, the same value core uses). Without it the claimer throws
  `[worker-secrets] KMS_KEY_ID env var required in production` before it even reaches AWS.
- The **`brain-prod-stream-worker-connector-secrets`** IAM policy (GetSecretValue on
  `brain/connector/*` + Decrypt on the connector CMK) must be attached to the role.

## Related process gap (fix separately)

Prod DB **migrations do not auto-apply** (`migrations.enabled=false` in `core/values-prod.yaml` by
design — owner-only DDL). Any migration rides in git until someone runs `pnpm migrate:up` as the Aurora
master user. On 2026-07-16 nothing since ~baseline had been applied (0132/0134/0135 all pending),
breaking the dashboard `22P02` fix and the pixel gate. **Add a manual "apply prod migrations" step to the
promotion checklist**, or a gated CI lane that runs it with the master secret.
