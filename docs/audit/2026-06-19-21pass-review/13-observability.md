# Pass 13: Observability Audit (observability)

## Board Verdict

The observability layer is structurally present but functionally incomplete for production readiness. The `@brain/observability` package has correct PII-redaction logic and a clean interface, but the entire OTel SDK wire — spans, meters, and log exporter — is a no-op stub (comment: "wired in M1"). The direct result is that **no traces, no metrics, and no structured logs are exported from any app today**: the production Grafana Cloud OTLP exporter block is commented out in `infra/observe/otel-collector.yml`, no Prometheus metrics endpoints exist in any app (ports 9091/9092 are scraped but nothing listens), the alert rules specified in doc-04 §I.3 exist only as pseudocode in a markdown file, and zero dashboard JSON files are provisioned. The most critical production blind spot is the SLO `CollectorErrorBudgetFastBurn` alert: the two counters it depends on (`collector_acks_total`, `collector_requests_total`) are never emitted by the collector. The AI path (`ai-gateway-client`) produces zero `gen_ai.*` OTel spans and does not read token usage from the model response, making AI cost attribution and the `NlqFalseBindNonZero` alert impossible. The stream-worker, the highest-throughput service, uses 221 bare `console.*` calls with no structured JSON and no OTel integration, making log-based alerting unreliable and trace correlation across the Kafka boundary impossible.

**Severity counts:** Critical: 1, High: 3, Medium: 3, Low: 1

---

## Finding OBS-1

**Title:** SLO fast-burn alert metrics `collector_acks_total` / `collector_requests_total` are never emitted — the core collector SLO has no alerting

**Severity:** Critical
**Priority:** P0
**Category:** SLO Monitoring / Alerting
**tenantImpact:** Platform-wide (all tenants); collector SLO covers all event ingest regardless of brand

**evidenceRef:**
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:1859-1862` — `CollectorErrorBudgetFastBurn` alert defined with `expr: (1 - (sum(rate(collector_acks_total{code="ack"}[1h])) / sum(rate(collector_requests_total[1h])))) > (14.4 * 0.0005)`
- `apps/collector/src/interfaces/rest/collect.route.ts:1-54` — POST /collect handler returns 200 with no counter increment
- `apps/collector/src/application/accept-event.usecase.ts:1-34` — AcceptEventUseCase emits no metrics
- `infra/observe/prometheus.yml:1-17` — Prometheus scrapes `host.docker.internal:9091` but no app code listens on port 9091

**impact:** The SLO is contractually 99.95% accept+ack. There is no alert that will fire when the collector drops below that threshold. An outage that burns the 21.6 min/month budget will go undetected until a customer reports missing data. The paged IC response path defined in doc-04 §L.2 cannot be triggered.

**rootCause:** The alert expression was authored in the architecture doc (§I.3) but the metric emission code was never written alongside the collector route. There is no `prom-client` dependency, no `/metrics` endpoint, and no `incrementCounter` call in `collect.route.ts` or `accept-event.usecase.ts`.

**fix:** Add `incrementCounter('collector_requests_total', { brand_id }, 1)` in `collect.route.ts` before the spool insert, and `incrementCounter('collector_acks_total', { code: 'ack', brand_id }, 1)` after the 200 reply. Wire a Prometheus `/metrics` endpoint (via `prom-client`) on port 9091. Promote the §I.3 alert YAML to a `infra/observe/prometheus-rules.yml` file and reference it from `prometheus.yml` via `rule_files:`.

**detection:** Currently undetectable. After fix: `CollectorErrorBudgetFastBurn` Prometheus alert, p95 latency gauge.

---

## Finding OBS-2

**Title:** All OTel spans and counters are no-op stubs — zero telemetry is exported from any service in production

**Severity:** High
**Priority:** P1
**Category:** Distributed Tracing / Metrics Export
**tenantImpact:** All tenants; no per-brand observability, no cross-service trace correlation

**evidenceRef:**
- `packages/observability/src/index.ts:45-93` — `StubSpan.end()` is a no-op: `// No-op in stub; real OTel SDK will flush to the OTLP exporter.`
- `packages/observability/src/index.ts:161-169` — `defaultCounterSink` emits `console.info('[metric] ...')` only; no OTel meter
- `packages/observability/package.json:1-14` — zero `@opentelemetry/*` dependencies
- `infra/observe/otel-collector.yml:98-104` — Grafana Cloud OTLP exporter is entirely commented out
- `infra/observe/otel-collector.yml:109-122` — Traces pipeline exports only to `debug` (local dev); no production exporter in the `traces:` pipeline

**impact:** No distributed traces reach Grafana Cloud or any observability backend. The SLI table in doc-04 §I.2 (Collector accept+ack, Surfaces availability, data freshness, Redpanda lag) cannot be computed because there are no time-series signals. Incident response is blind: engineers must rely on pod logs parsed by hand.

**rootCause:** The package comment is explicit: "avoids importing @opentelemetry/* directly in Sprint 0 to keep zero external deps … wired to the real OTel SDK in M1." M1 has shipped (per commit history) but the real SDK wire was not completed.

**fix:** (1) Add `@opentelemetry/sdk-node`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/api`, `@opentelemetry/exporter-trace-otlp-http` to `packages/observability/package.json`. (2) Replace `StubSpan` with a real `TracerProvider`+`Tracer` backed OTel span. (3) Replace `defaultCounterSink` with an `@opentelemetry/sdk-metrics` `MeterProvider` counter. (4) Uncomment and populate the `otlphttp/grafana` exporter block in `infra/observe/otel-collector.yml` and wire all three pipelines (traces/metrics/logs) to it.

**detection:** Currently: no signal. After fix: OTel health-check endpoint (`/healthz/otel`), OTLP export errors visible in collector debug logs.

---

## Finding OBS-3

**Title:** AI gateway calls (`ai-gateway-client`) emit zero `gen_ai.*` OTel spans and do not capture token usage — AI cost, latency, and false-bind-rate dashboards are unimplementable

**Severity:** High
**Priority:** P1
**Category:** AI Observability / gen_ai spans
**tenantImpact:** All tenants using the NLQ/Ask Brain feature (AI cost attribution is per-brand)

**evidenceRef:**
- `packages/ai-gateway-client/src/client.ts:111-142` — `fetchTransport` parses `body.choices?.[0]?.message?.content` only; `body.usage` (input_tokens/output_tokens/total_tokens) is never read
- `packages/ai-gateway-client/src/client.ts:80-102` — `ResolverClient.resolve()` has no span creation, no `startGenAiSpan` call
- `packages/observability/src/index.ts:117-133` — `startGenAiSpan` exists with `gen_ai.request.model`, `gen_ai.effort_tier` but is never called from `ai-gateway-client` or `apps/core/src/modules/ai/`
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:2253` — requires `gen_ai.*` spans with `usage.input/output_tokens`, `brain.cost_minor`, `brain.prompt_template_hash`, `brain.routing.fallback_depth`, `brain.brand_id` on every model call
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:1879-1882` — `NlqFalseBindNonZero` alert requires `nlq_false_bind_total` counter; never emitted

**impact:** AI spend per brand cannot be metered or billed back. Token consumption is invisible. The `NlqFalseBindNonZero` alert (P-page severity per doc §I.3) can never fire. If the model starts producing false bindings (an adversarial injection risk at §I-S08), the only detection is a manual audit of `ai_provenance` rows.

**rootCause:** The `startGenAiSpan` helper was written as a "Phase 3+ reserved" stub in `packages/observability/src/index.ts:127-134`. The `ai-gateway-client` was built in the same sprint without the wire-in.

**fix:** In `packages/ai-gateway-client/src/client.ts` `fetchTransport`: (1) Parse `body.usage` and surface `input_tokens`, `output_tokens`. (2) In `ResolverClient.resolve()`, call `startGenAiSpan('resolver.call', { model, effortTier: 'frontier', ... })` wrapping the transport call. (3) Set `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `brain.cost_minor` on the span. (4) Add `incrementCounter('nlq_false_bind_total', { brand_id, metric_id })` in `resolve-question.ts` when the post-gateway registry re-validation collapses a model binding to a refusal.

**detection:** Currently: silent. After fix: `NlqFalseBindNonZero` Prometheus alert fires on any false bind; Grafana AI-cost dashboard becomes computable.

---

## Finding OBS-4

**Title:** Stream-worker uses 221 bare `console.*` calls with no structured JSON logging — Kafka-boundary trace correlation is broken and log-based alerts are unreliable

**Severity:** High
**Priority:** P1
**Category:** Structured Logging / Trace Correlation
**tenantImpact:** All tenants; stream-worker processes every event for every brand

**evidenceRef:**
- `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts:80,99,121,129,147,151` — DLQ, quarantine, dedup, write-error paths all use `console.info` / `console.error` with interpolated strings
- `apps/stream-worker/src/main.ts:249,278,300,306,338,345-407` — all startup, lifecycle, and consumer-start messages use `console.info`
- `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts:55-161` — `message.headers` is never read: the `correlation_id` header written by the collector's Kafka producer (`apps/collector/src/infrastructure/kafka-producer.ts:87`) is silently dropped on the consumer side; no trace context is propagated across the Kafka boundary
- `apps/collector/src/main.ts:127` — `logger: false` on the Fastify instance disables the structured pino logger entirely in the collector

**impact:** Log lines like `[stream-worker] written brand=xxx event=yyy partition=0 offset=5` are plain strings. In production (CloudWatch Logs Insights, Loki), JSON log queries (`{ .brand_id = "xxx" }`) return nothing. The `correlation_id` emitted by the collector is lost at the Kafka boundary; a dropped event cannot be traced from pixel hit → spool → Kafka → Bronze. Alert rules that rely on log-based metric filters (the CloudWatch metric filter in `infra/terraform/modules/observability/main.tf:79-90` patterns against JSON keys) will mis-fire or never fire for stream-worker events.

**rootCause:** Stream-worker has no structured logger dependency. The collector explicitly sets `logger: false` on its Fastify instance to suppress pino. No decision was made to adopt a log serializer for non-Fastify processes.

**fix:** (1) Add `pino` as a stream-worker dependency; replace all `console.info/error/warn` calls with `logger.info/error/warn({ brand_id, event_id, correlation_id, partition, offset }, 'message')`. (2) In `CollectorEventConsumer.eachMessage`, read `message.headers['correlation_id']?.toString()` and propagate it through `processEvent` and every log call. (3) In `apps/collector/src/main.ts`, change `logger: false` to `logger: { level: 'info' }` to restore pino's structured output on Fastify routes.

**detection:** Currently: missing JSON keys cause silent Loki/CloudWatch query gaps. After fix: log-based metric filters on structured fields work; Loki label queries return results.

---

## Finding OBS-5

**Title:** OTel collector PII redaction processor missing `metric_statements` — metrics with PII-bearing label names pass through unredacted (defense-in-depth layer 2 is incomplete)

**Severity:** Medium
**Priority:** P2
**Category:** PII Redaction / Defense in Depth
**tenantImpact:** Any tenant whose events generate metrics with PII-keyed labels (e.g. `collector_dedup_conflict_total{brand_id, event_name, ...}` where a mislabeled metric includes email)

**evidenceRef:**
- `infra/observe/otel-collector.yml:28-59` — `transform/redact_pii` defines `trace_statements` (span attributes) and `log_statements` (log record attributes) but has **no `metric_statements` block**
- `infra/observe/otel-collector.yml:114-117` — the metrics pipeline (`metrics:`) runs through `transform/redact_pii` but the processor only redacts traces and logs
- `packages/observability/src/redact.ts:22-88` — SDK layer 1 PII guard is correct; `packages/observability/src/index.ts:7` states "Layer 2 (OTel collector) … Config is in infra/observability" — but metric_statements are absent
- `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts:109-113` — `incrementCounter('collector_dedup_conflict_total', { brand_id, layer, event_name })` emits metric labels; if future callers add a PII-bearing label, the collector layer will not catch it

**impact:** The NN-6 two-layer PII redaction guarantee is broken at the metric label level. A future developer adding a misnamed label (e.g. `user_email`) to a counter would have the value flow through to Grafana Cloud unredacted, violating the DPDP and GDPR-adjacent commitments in doc-04 §NN-6.

**rootCause:** The OTel Collector transform processor was configured for spans and logs but the author did not add a `metric_statements:` context block. The `error_mode: ignore` setting further means a misconfigured OTTL statement would fail silently rather than alerting.

**fix:** Add to `infra/observe/otel-collector.yml` under `transform/redact_pii`:
```yaml
metric_statements:
  - context: datapoint
    statements:
      - delete_matching_keys(attributes, ".*email.*")
      - delete_matching_keys(attributes, ".*phone.*")
      - delete_matching_keys(attributes, ".*pan_.*")
      - delete_matching_keys(attributes, ".*card_.*")
```
Also change `error_mode: ignore` to `error_mode: propagate` so mis-authored OTTL fails loudly.

**detection:** Currently: silent. After fix: metric label PII exposure would be blocked before Grafana Cloud ingestion.

---

## Finding OBS-6

**Title:** Collector spool backlog has no metric or alert — a Redpanda outage causing spool growth is invisible until the DB fills

**Severity:** Medium
**Priority:** P2
**Category:** Metrics Coverage / SLO Blind Spot
**tenantImpact:** All tenants; collector_spool growth during Redpanda outage affects all brands equally

**evidenceRef:**
- `apps/collector/src/application/drain-events.usecase.ts:25-52` — `DrainEventsUseCase.execute()` polls pending rows and returns the count drained, but does not emit a gauge of remaining pending rows
- `apps/collector/src/interfaces/jobs/drainer.ts:59-70` — `tick()` calls `drainUseCase.execute()` and logs the count drained via `console.info` but emits no metric
- `infra/observe/prometheus.yml:1-17` — no `collector_spool_pending_total` or `collector_spool_age_seconds` targets
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:1845` — SLO definition references "21.6 min/mo error budget" but does not specify a spool backlog SLO; however the architectural intent (D-1 durability guarantee) requires knowing when the buffer is growing

**impact:** During a Redpanda outage the spool grows silently. With a default batch of 100 rows every 1s, the Postgres `collector_spool` table can accumulate millions of rows without any alert. The DBA or on-call will only notice when disk space or query latency degrades. The doc-04 §D-1 guarantee ("every event is ACK'd and spooled") is met, but recovery SLA is unknowable.

**rootCause:** The drainer loop was built for correctness (D-1) without an observability layer on the backlog depth. No `incrementCounter` or gauge is wired in `DrainEventsUseCase`.

**fix:** In `DrainEventsUseCase.execute()`, after `pollPending`, emit `incrementCounter('collector_spool_backlog', { status: 'pending' }, pending.length)` (or use a gauge when OTel meter is wired). Add a `spool_pending_high` alert rule in the Prometheus rule file: fire when backlog > 10,000 for > 5 minutes.

**detection:** Currently: DB table size monitoring only (CloudWatch). After fix: Prometheus gauge + alert on backlog threshold.

---

## Finding OBS-7

**Title:** Prometheus alert rules from doc-04 §I.3 exist only in a markdown file — no deployed rule file exists in the repo

**Severity:** Medium
**Priority:** P2
**Category:** Alerting / SLO Enforcement
**tenantImpact:** Platform-wide; all six named alerts are absent from the deployment

**evidenceRef:**
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:1854-1883` — Six alert rules defined in a fenced YAML block: `CollectorErrorBudgetFastBurn`, `ParityDriftBillingMetric`, `HotRowReachedDecisionEndpoint`, `AuditChainBreak`, `CrossTenantAccessDenied`, `NlqFalseBindNonZero`
- `infra/observe/prometheus.yml:1-17` — No `rule_files:` section; no reference to any alert rule file
- `find /Users/rishabhporwal/Desktop/Brain\ V3 -name "*.yml"` output — no `prometheus-rules.yml`, `alert_rules.yml`, or `PrometheusRule` K8s manifest exists anywhere in the repo
- `infra/terraform/modules/observability/main.tf:79-90` — Only a CrashLoopBackOff CloudWatch metric filter exists; no SLO alerts

**impact:** The six security- and SLO-critical alerts are not deployed anywhere. A cross-tenant access violation (`CrossTenantAccessDenied`), an audit chain break, a billing parity drift, or a collector fast-burn will produce no page. The on-call rotation has no automated detection for P0/P1 conditions listed in doc-04 §L.2.

**rootCause:** Alert rules were designed in the architecture document but the implementation track (creating the YAML file, adding `rule_files:` to `prometheus.yml`, and deploying via Helm/ArgoCD) was not completed.

**fix:** Create `infra/observe/prometheus-rules.yml` containing the §I.3 YAML verbatim (adjusting metric names once OBS-1/OBS-3 counters are emitted). Add `rule_files: ['/etc/prometheus/prometheus-rules.yml']` to `prometheus.yml`. Mount the file in the Prometheus Helm chart. For the five counters that don't yet exist (OBS-1, OBS-3), add `alert: NoDataFor1h` guards to prevent false-negative silence.

**detection:** Currently: zero. After fix: Alertmanager routes pages per doc-04 §L.2 incident severity table.

---

## Finding OBS-8

**Title:** Fallback correlation ID uses `Math.random()` instead of `crypto.randomUUID()` — IDs are non-UUID, low-entropy, and not W3C-traceparent-compatible

**Severity:** Low
**Priority:** P3
**Category:** Correlation ID Propagation
**tenantImpact:** Single-request scope; no cross-tenant blast radius but affects trace stitching for any event without an upstream correlation header

**evidenceRef:**
- `packages/observability/src/index.ts:216-217` — `return \`gen-\${Date.now()}-\${Math.random().toString(36).slice(2, 10)}\`` with inline comment "real impl uses crypto"
- `apps/collector/src/interfaces/rest/collect.route.ts:21-23` — uses `extractCorrelationId` on the `/collect` path; pixel requests from the browser will nearly always lack a `traceparent` header, hitting the fallback

**impact:** Fallback IDs like `gen-1718800000000-abc1234` are not valid W3C `traceparent` format (`00-{32hex}-{16hex}-{2hex}`). They cannot be ingested by the OTel collector as parent span context, breaking the distributed trace chain for browser pixel events. `Math.random()` in V8 is not cryptographically random and can produce collisions under high load, potentially merging log lines from different requests.

**rootCause:** Marked as a known "real impl uses crypto" TODO in the code comment. The crypto import was deferred to M1.

**fix:** Replace the fallback with `import { randomUUID } from 'node:crypto'; return randomUUID();` in `packages/observability/src/index.ts:217`. The result is a valid UUID v4, which can be used as the trace-id component of a synthetic `traceparent` header.

**detection:** Currently: silent; only visible in trace stitching failures. After fix: valid UUIDs in log `correlation_id` field, OTel context propagation works end-to-end.
