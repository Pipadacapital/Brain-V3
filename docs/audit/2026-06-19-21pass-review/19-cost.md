# Pass 19: Cost Architecture Audit (cost)

**Date:** 2026-06-19
**Board:** Cost Architecture
**Focus:** Cloud cost model at 100/500/1k/5k/10k brands; storage trajectory; compute per tenant; egress; model-call cost routing; idle resources; optimization opportunities.

---

## Board Verdict

The cost architecture is structurally sound at Sprint-0/M0 scale — idle staging compute is zeroed, ECR lifecycle policies clean up images, Redpanda Cloud dedicated provisioning is deferred until the module is actually wired into an environment. However, six concrete cost defects are present in the checked-in config. The most expensive is a 104x Redpanda live-lane storage overrun baked into the Terraform module (730-day retention when the live lane needs 7 days and Bronze S3 is the SoR). Second: the NLQ resolver defaults to the frontier model `claude-opus-4-8` (Opus) for a schema-constrained task that the architecture spec explicitly assigns to the "small" tier (Haiku/GPT-mini); this is a direct cost-routing-paradigm breach. Third: the Bronze S3 bucket carries both COMPLIANCE-mode 7-year Object Lock AND a lifecycle expiration at 730 days — COMPLIANCE mode silently blocks all S3 lifecycle deletions, so Bronze data persists for 7 years not 24 months (3.5x S3 storage cost). Fourth: all AWS-service traffic (S3, ECR, KMS, Glue) routes through NAT gateways because no VPC interface/gateway endpoints are provisioned, despite being explicitly required by the architecture doc to avoid NAT charges. Fifth: no per-brand LLM spend cap exists in code or config. Sixth: the Terraform Redpanda module and the authoritative `topics.yml` declare mismatched topic names, meaning the provisioned topics will not match what the stream-worker code uses when the module is activated.

**Severity counts:** Critical: 1 | High: 2 | Medium: 2 | Low: 1

---

## Finding COST-1

**Title:** Redpanda live-lane topic provisioned with 730-day retention (104x overrun vs topics.yml 7-day spec)
**Severity:** Critical
**Category:** Storage — Redpanda Cloud cost
**Priority:** P0
**evidenceRef:**
- `infra/terraform/modules/redpanda/main.tf:89-91` — `"retention.ms" = tostring(730 * 24 * 60 * 60 * 1000)` (63,072,000,000 ms = 730 days) on the live collector topic.
- `infra/redpanda/topics.yml:14` — `retention.ms: "604800000"` = 7 days for the live lane.
- Discrepancy ratio: 730 / 7 = 104.3x more Redpanda storage than designed.

**Impact:** At scale, Redpanda Cloud charges per GB stored. The live lane is the highest-throughput topic (all pixel/collector events). Retaining 24 months of streaming events in Redpanda rather than the designed 7 days inflates Redpanda storage by ~104x. On a `tier-3-aws-v2-arm` cluster at 10k brands with significant event volume, this can add tens of thousands of dollars per month in unnecessary Redpanda storage. Bronze S3 (Iceberg) is already the 24-month system of record; Redpanda live retention need only cover the lag window for the stream-worker consumer group to catch up.

**Root Cause:** The Terraform module comment states "24-month retention aligned with Bronze SoR (I-E02)" — the Bronze Iceberg retention policy was copy-pasted to the Redpanda topic without recognizing that Redpanda is the transient transport layer, not the SoR. `topics.yml` (the declared source of truth for topic config) correctly sets 7 days.

**Fix:** Change `"retention.ms"` for `redpanda_topic.collector_event_live` to `tostring(7 * 24 * 60 * 60 * 1000)` (604,800,000) matching `topics.yml:14`. Separately, backfill topic may retain 30 days (matches topics.yml:25). DLQ is already correct at 90 days. Add a CI check that derives topic retention values from `topics.yml` rather than duplicating them.

**Tenant Impact:** All tenants (single shared Redpanda cluster); affects platform-wide OpEx from first production deploy.

**Detection:** Billing alert on Redpanda Cloud dashboard storage growth. Alternatively, compare `rpk topic describe {env}.collector.event.v1 | grep retention` against `topics.yml` in a CI gate.

---

## Finding COST-2

**Title:** NLQ resolver defaults to frontier model `claude-opus-4-8` instead of architecture-mandated small tier (Haiku)
**Severity:** High
**Category:** Model-call cost routing
**Priority:** P1
**evidenceRef:**
- `packages/ai-gateway-client/src/client.ts:31` — `export const DEFAULT_RESOLVER_MODEL = 'claude-opus-4-8';`
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:2217` — "Metric resolution (question→metric_id+filters+grain+range) | small | Haiku / GPT-mini / Gemini Flash"
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:2223` — "Cost relationship enforced (deterministic ≫ statistical ≫ small ≫ frontier, ~1:100:1k:10k)"

**Impact:** Opus (~$15/M output tokens) costs approximately 60–75x more per call than Haiku (~$0.25/M output tokens). At 100 brands each making 50 NLQ queries/day, this gap is ~$22/day vs $0.37/day — roughly $650/month vs $11/month. At 10k brands the exposure becomes ~$65k/month vs ~$1.1k/month. The resolver output is capped at 256 tokens (schema-constrained selection only), which limits exposure per call but amplifies the per-call waste since Opus input is also priced ~60x higher than Haiku.

**Root Cause:** Likely set to Opus during initial development for reliability and not downgraded before the PR landed. The architecture spec (§N.2) is unambiguous that metric resolution is a "small" tier task with Haiku as the eligible pool. No prompt-registry eval gate has been run to pin a cheaper model.

**Fix:** Change `DEFAULT_RESOLVER_MODEL` to `'claude-haiku-3-5'` (or the equivalent Haiku model ID as served by the LiteLLM gateway). Run the eval gate from §N.5 (Resolution, Injection) against the Haiku model before shipping; per the spec, only a model that passes the gate at the pinned prompt hash may serve this task. The client already supports model injection via `ResolverClientConfig.model`, so the change is isolated to the constant.

**Tenant Impact:** Platform-wide; every NLQ call across all brands hits this overspend from Phase 8 activation.

**Detection:** `gen_ai.request.model` OTel span attribute (when implemented) will show Opus on all resolver calls. Until spans land, grep CI for `DEFAULT_RESOLVER_MODEL` drift.

---

## Finding COST-3

**Title:** S3 Bronze bucket has COMPLIANCE 7-year Object Lock AND 730-day lifecycle expiration — COMPLIANCE mode silently blocks lifecycle deletion, storing data 3.5x longer than designed
**Severity:** High
**Category:** Storage — S3 cost
**Priority:** P1
**evidenceRef:**
- `infra/terraform/modules/s3-iceberg/main.tf:63-70` — `aws_s3_bucket_object_lock_configuration.bronze`: `mode = "COMPLIANCE"`, `years = 7`.
- `infra/terraform/modules/s3-iceberg/main.tf:100-115` — `aws_s3_bucket_lifecycle_configuration.bronze`: `expiration { days = 730 }` and `noncurrent_version_expiration { noncurrent_days = 90 }`.
- `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md:92` — "Bronze (raw events) | 24 months".
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:1807` — COMPLIANCE 7yr is declared for the AUDIT WORM bucket, labeled "7y placeholder"; no requirement for Bronze.

**Impact:** In COMPLIANCE mode, S3 absolutely refuses to delete any object (current or noncurrent) until the 7-year lock expires, regardless of lifecycle rules. Both the `expiration { days = 730 }` and `noncurrent_version_expiration { noncurrent_days = 90 }` rules will be silently no-ops for all locked objects. Every brand's event data is stored for 7 years at S3 STANDARD pricing (~$0.023/GB-month) rather than the designed 24 months. At 10k brands with 1 GB/brand/month of Bronze events, the excess storage cost is approximately (7×12 − 24) × 10k × 1 GB × $0.023 = (84−24) × 10k × $0.023 = ~$13,800/month in excess S3 charges by month 84.

**Root Cause:** The `s3-iceberg` module comments reference "NN-4: Object Lock COMPLIANCE mode, 7-year retention" — but NN-4 as described in the architecture doc (§F.1.2, line 1807, 1946) applies to the **audit WORM bucket** (`s3-audit`), not the Bronze data bucket. The COMPLIANCE lock was copy-applied to both buckets without recognizing that Bronze's 24-month retention requires GOVERNANCE mode (or no Object Lock), not COMPLIANCE.

**Fix:** For the Bronze bucket (`s3-iceberg`): remove the 7-year COMPLIANCE Object Lock (or downgrade to GOVERNANCE mode with `days = 730` if legal review requires it). The lifecycle rules (`expiration { days = 730 }`) are correct for Bronze. Keep COMPLIANCE 7yr on the audit bucket only (`s3-audit`). Note: Object Lock in COMPLIANCE mode cannot be removed once set at bucket creation — this must be addressed before any Bronze bucket is created in staging/prod.

**Tenant Impact:** All tenants sharing the Bronze bucket; affect scales linearly with event volume and brand count.

**Detection:** AWS Cost Explorer — S3 STANDARD storage tier growth; compare bucket size against 24-month expected data volume. Also: manually verify `aws s3api get-object-lock-configuration --bucket brain-bronze-...`.

---

## Finding COST-4

**Title:** No VPC interface/gateway endpoints provisioned — S3, ECR, KMS, Glue, SecretsManager traffic routes through NAT gateways, generating billable NAT data-processing charges
**Severity:** Medium
**Category:** Egress / NAT cost
**Priority:** P2
**evidenceRef:**
- `infra/terraform/modules/network/main.tf:129-140` — only `aws_nat_gateway` resources; no `aws_vpc_endpoint` resource anywhere in the network module.
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:1901` — "EKS reaches AWS via VPC endpoints (S3/DynamoDB gateway; ECR/STS/Secrets Manager/KMS/CloudWatch/Glue interface) so collector↔KMS/S3 never traverses NAT or the public internet."
- Confirmed: `grep -r aws_vpc_endpoint infra/terraform/` returns zero results.

**Impact:** Every S3 write (stream-worker → Bronze), S3 read (analytics read path), ECR image pull (all EKS deployments), KMS decrypt/encrypt, Glue API call, and Secrets Manager fetch incurs NAT gateway data-processing charges ($0.045/GB processed). At 10k brands with significant event ingest, S3 writes alone (collector → Bronze) can easily reach hundreds of GB/day. S3 gateway endpoints are free; other interface endpoints cost ~$0.01/AZ-hour (~$21/month/endpoint for 3 AZs) but eliminate NAT charges at any meaningful throughput. The architecture doc explicitly requires these endpoints; they are absent from all terraform environments.

**Root Cause:** The network module was built without the VPC endpoint resources. The requirement is documented but not implemented.

**Fix:** Add to `infra/terraform/modules/network/main.tf`:
1. `aws_vpc_endpoint` of type `Gateway` for `com.amazonaws.ap-south-1.s3` and `com.amazonaws.ap-south-1.dynamodb` (free, zero-data-processing cost).
2. `aws_vpc_endpoint` of type `Interface` for `ecr.api`, `ecr.dkr`, `secretsmanager`, `kms`, `glue`, `logs`, `sts` — assigned to private subnets.
Associate the S3/DynamoDB gateway endpoints with the private route tables.

**Tenant Impact:** Platform-wide; every service that calls S3, ECR, KMS, or Secrets Manager pays per GB through NAT until fixed.

**Detection:** AWS Cost Explorer → NAT gateway data-processing line item growing proportionally with event throughput.

---

## Finding COST-5

**Title:** No per-brand LLM spend cap or budget counter implemented despite architecture §N.3 mandate
**Severity:** Medium
**Category:** Model-call cost routing
**Priority:** P2
**evidenceRef:**
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:2225-2226` — "Redis: `ratelimit:{brand_id}:{window}` (token bucket) + `budget:{brand_id}:{period}` (spend counter); atomic Lua check-and-reserve ... **Exhaustion:** NLQ/narration → deterministic number + `narration_status:"unavailable_budget"`"
- `packages/ai-gateway-client/src/client.ts:70-102` — `ResolverClient.resolve()` makes uncapped model calls with a single transport-level retry; no budget check or brand-scoped rate limit before the model call.
- Search for `budget.*brand\|ratelimit.*brand` in `apps/` returns zero hits.
- `packages/observability/src/index.ts:7` — gen_ai spans are "reserved for Phase 3+; no-op in Sprint 0" — so there is no cost metering per brand even for observability.

**Impact:** A single brand can generate unbounded LLM spend if its users issue many NLQ queries in a billing period. At 10k brands with uncapped access, a viral usage spike or a bad actor can cause LLM spend to exceed revenue margin for that brand without any circuit breaker. The architecture spec explicitly defined the exhaustion behavior (deterministic fallback + typed error) to prevent this; it is absent.

**Root Cause:** Per-brand budget tracking is a Phase 3+ (M-series) feature. The client is Sprint-0 and does not yet wire the Redis budget counter. This is expected at this phase but must be tracked as a P2 before AI features go live.

**Fix:** Before Phase 8 (NLQ) activates in production:
1. Add `budget:{brand_id}:{YYYY-MM}` Redis counter with atomic Lua increment-and-check.
2. Wire the check in `ResolverClient.resolve()` before the transport call; if exceeded, return `{ kind: 'refusal', reason: 'budget_exhausted' }`.
3. Expose `brain.cost_minor` via the `gen_ai.*` OTel span (already typed in `GenAiSpanContext` but not called from the client).
4. Add per-brand budget alert in Grafana (AI cost dashboard, §N.8).

**Tenant Impact:** Single-tenant: a whale brand can over-consume without limit. Multi-tenant risk if the gateway's total quota is exhausted by one brand.

**Detection:** Anthropic/LiteLLM spend dashboard — a single brand's token count spiking. Without the counter, this is invisible until the invoice arrives.

---

## Finding COST-6

**Title:** Terraform Redpanda topic names diverge from `topics.yml` authority and stream-worker code — provisioned topics will not match runtime consumers
**Severity:** Low
**Category:** Infrastructure drift (Redpanda cost correctness)
**Priority:** P3
**evidenceRef:**
- `infra/terraform/modules/redpanda/main.tf:99` — provisions `${var.environment}.collector.event.backfill.v1`.
- `infra/redpanda/topics.yml:21` and `apps/stream-worker/src/main.ts:91` — expect `{env}.collector.order.backfill.v1` (the ORDER backfill lane).
- `infra/terraform/modules/redpanda/main.tf:112` — provisions `${var.environment}.collector.dlq.v1`.
- `infra/redpanda/topics.yml:52` and `apps/stream-worker/src/infrastructure/kafka/DlqProducer.ts:9` — expect `{env}.collector.event.v1.dlq`.
- `infra/redpanda/topics.yml` lists 6 topics; terraform module declares only 3 topics (missing: `{env}.collector.order.backfill.v1`, `{env}.collector.order.backfill.v1.dlq`, `{env}.collector.event.v1.quarantine`).
- `docker-compose.yml:171-180` (the local dev reference) creates `dev.collector.event.v1`, `dev.collector.event.v1.backfill`, `dev.collector.event.v1.dlq`, `dev.collector.event.v1.quarantine` — matching `topics.yml` but not terraform.

**Impact:** When the Redpanda Terraform module is activated in a real environment (staging/prod activation), the provisioned topics will have wrong names: the stream-worker backfill consumer will fail to find `{env}.collector.order.backfill.v1` and the DLQ producer will write to `{env}.collector.event.v1.dlq` but only `{env}.collector.dlq.v1` will exist. This causes both the order-backfill pipeline and DLQ routing to silently fail. The misnamed topics will also accumulate storage costs without serving any consumers, adding idle Redpanda storage cost.

**Root Cause:** The Terraform module was authored independently from `topics.yml` without a diff check. The Redpanda topic naming convention changed (from `event.backfill.v1` to `order.backfill.v1` for the order lane) without updating the module.

**Fix:** Align terraform topic resources to `topics.yml` as the single source of truth:
1. Rename the backfill resource to `{var.environment}.collector.order.backfill.v1`.
2. Rename the DLQ resource to `{var.environment}.collector.event.v1.dlq`.
3. Add missing topics: `{env}.collector.order.backfill.v1.dlq` and `{env}.collector.event.v1.quarantine`.
4. Add a CI test that compares terraform topic names against `topics.yml` (e.g., extract names from both, diff in `pre-commit` or `test:contract`).

**Tenant Impact:** Platform-wide; all tenants' events affected by backfill and DLQ routing failures.

**Detection:** Stream-worker startup logs "UnknownTopicOrPartition" errors; Redpanda topic list shows unsubscribed topics accumulating messages.
