# Dynamic Persona Review — Isolation & Secrets Hardness Skeptic

> Filled by a single persona spawned in Stage 1.
> Persona: `security-stress-tester`
> Skill consulted: `dynamic-persona-spawning` (discipline) + one domain skill: multi-tenancy isolation patterns (anchored to INVARIANTS.md I-S01, TRIGGER-SURFACES.md §Multi-tenancy).

| Field | Value |
|-------|-------|
| **req_id** | `chore-platform-foundations-sprint0` |
| **Persona** | `sprint0-isolation-secrets-hardness-skeptic` (security-stress-tester lens) |
| **Timestamp** | 2026-06-15T11:17:00Z |

---

## What this lens sees

Sprint 0 is the one moment when the tenant and secrets boundaries can be made *structurally impossible to break* — or merely conventionally discouraged. Every pattern baked in here becomes a load-bearing assumption for every subsequent PR. My mandate is not to check whether the words "RLS", "KMS", "IRSA", and "isolation test" appear in the plan — they do. My mandate is to verify that each boundary is *enforced by construction at the layer that owns it*, that no layer defers its own enforcement to a layer above it, and that the CI gate makes a violation impossible to merge rather than merely visible after the fact. I focus on the six layers named in INVARIANTS.md I-S01 (Postgres RLS, per-brand S3 prefix, per-brand KMS DEK, StarRocks row policies, Redis `brandKey()`, and the isolation-fuzz CI harness) and on IRSA scoping, Apicurio FULL_TRANSITIVE enforcement, S3 Object Lock, and the no-PII-in-logs integration point. I also check whether the GUC miss-path (developer forgets to set `app.current_brand_id`) is fail-closed by the RLS policy itself rather than by a runtime exception that could be swallowed.

---

## Layer-by-Layer Audit

### Layer 1 — Postgres RLS + Non-Owner App Role (migration #1)

**What the plan says:** migration #1 establishes RLS on every brand-scoped table with `USING (brand_id = current_setting('app.current_brand_id')::uuid)`; the app role has no `BYPASSRLS`; middleware asserts non-null before every query.

**Gap — GUC miss-path is partially structural but the missing-GUC branch is unspecified:**

The RLS predicate calls `current_setting('app.current_brand_id')`. PostgreSQL's `current_setting()` has two call signatures: the one-argument form `current_setting('app.current_brand_id')` raises `ERROR: unrecognized configuration parameter` (or a cast failure) if the GUC is absent — it does NOT return null. The two-argument form `current_setting('app.current_brand_id', true)` returns null on miss. The canonical isolation outcome for a missed GUC differs by which form is used:

- One-argument form: the query throws before returning rows. This is fail-closed on the data access but the caller sees an exception. If that exception is caught and swallowed (common in ORM error-handling), a subsequent query in the same transaction could succeed with an unset GUC — or the caller could re-issue the query without the GUC set, and if the migration was written without `missing_ok=true`, Postgres 16's behavior is a runtime error, not a zero-row result.
- Two-argument form with `::uuid` cast: `current_setting('app.current_brand_id', true)` returns null on miss; `null::uuid` makes the predicate `brand_id = null` which is always false (SQL null semantics) — this correctly returns zero rows. This is the safer form for the isolation objective.

The plan does not specify which form is used in the migration DDL. If the builder codes the one-argument form (the shorter, more natural form), the isolation behavior on a missed GUC is an unhandled exception rather than a structured empty-result. An exception-swallowing ORM or a try-catch wrapper in the middleware could in principle re-execute the query in a context where the GUC is stale from a prior request's transaction (connection pool reuse without explicit GUC reset between requests). This is the most likely load-bearing mistake: easy to get wrong at migration-write time, invisible in happy-path integration tests, and expensive to retrofit because changing the RLS predicate form requires a new migration and re-testing every isolation negative-test vector.

**Required fix:** migration #1 MUST use `current_setting('app.current_brand_id', true)::uuid` (the two-argument `missing_ok=true` form) in the RLS predicate, so that a missed GUC returns zero rows structurally rather than throwing. Additionally, the `packages/db` query middleware MUST reset the GUC explicitly at connection checkout and re-set it at query time — both, not either/or — to eliminate the connection-pool stale-GUC vector.

**Severity: CRITICAL.** This is an I-S01 invariant. If the builder uses the one-argument form and the middleware swallows the error, the isolation boundary is not structural — it depends on runtime error propagation.

---

### Layer 2 — StarRocks Row Policies (the intake-flagged gap)

**What the plan says:** the CTO Advisor intake (C2) correctly flags that exit criterion 5 targets Postgres RLS only and that StarRocks row policies are a separate enforcement point. Track 4 in the recommended decomposition names StarRocks row policies as a deliverable. Workstream E acceptance criterion is "query Bronze from StarRocks" — not "StarRocks row policies active and verified."

**Gap — StarRocks row policy enforcement is named but not CI-gated at Sprint 0:**

The isolation negative-test harness (Workstream F) is described as "brand-A→brand-B = 0 rows/403" and is wired against Postgres RLS. It is not described as running against StarRocks. Exit criterion 5 reads "RLS on; isolation negative-test passes (brand-A→brand-B = 0 rows/403)" — the canonical interpretation is Postgres-only. If the StarRocks row policy fixture is omitted from the isolation-fuzz harness at Sprint 0, the analytics serving layer ships without a CI gate that proves brand isolation. Any developer who later adds a new mart or aggregate query that bypasses the row policy has no automatic regression catch. Since StarRocks is the analytics serving layer (the layer the Analytics API reads from — the sole consumer per ADR-002), a row-policy gap here is architecturally equivalent to having no isolation at the serving layer.

TRIGGER-SURFACES.md §Multi-tenancy explicitly lists StarRocks row policies as a required enforcement surface and states "P0 isolation tests (API/DB/StarRocks/MCP) must pass before any launch." The plan names the CI gate but scopes it only to Postgres. This is the gap the intake review flagged; my audit confirms it is not resolved in the Sprint-0 task breakdown.

**Required fix:** the Workstream E acceptance criterion for "StarRocks cluster + external Iceberg catalog" must be expanded to: StarRocks cluster up AND a per-brand row policy applied to the Bronze test table AND the isolation-fuzz CI harness runs a cross-brand query against StarRocks (via the Analytics API path) and asserts zero rows. This must be a binary Sprint-0 exit criterion, not a deferred M1 task. The row policy template (tied to `brand_id`) must be the one established at cluster-setup time so it is enforced on every subsequent table provisioned from that template.

**Severity: HIGH.** I-S01 requires isolation enforced at every layer independently. StarRocks without a CI-gated row policy is a structural gap at the analytics serving layer.

---

### Layer 3 — Iceberg Bronze: Per-Brand S3 Prefix + Per-Brand KMS DEK

**What the plan says:** ADR-005/007 bind per-brand S3 prefix and per-brand KMS DEK. The CMK root is provisioned in Sprint 0; per-brand DEK creation is deferred to runtime brand onboarding. S3 Bronze bucket with Object Lock enabled is a Sprint-0 IaC item.

**Gap — S3 bucket policy does not enforce prefix-scoped access by default; prefix isolation is conventional unless enforced by IAM policy:**

The per-brand S3 prefix (`bronze/brand=<id>/...`) is a naming convention enforced at write time by the stream-worker. But if the S3 bucket IAM policy (or the workload IRSA role) does not explicitly scope access to `arn:aws:s3:::bucket/bronze/brand=<id>/*` for each workload's service account, then any workload with any `s3:GetObject` permission on the bucket can read any brand's prefix. The plan provisions "IAM/IRSA least-privilege roles per workload" (Workstream D) but does not specify that those roles are scoped to the per-brand prefix path. A stream-worker role scoped to `arn:aws:s3:::bucket/*` (the whole bucket) is not structurally isolated — a bug in the stream-worker's prefix construction leaks cross-brand data with no S3-layer barrier.

The per-brand KMS DEK (envelope-wrapped under a small CMK set) adds cryptographic isolation — even if the wrong prefix is accessed, the data is unreadable without the correct DEK. But the DEK is not provisioned at Sprint 0 (deferred to brand onboarding), so during the Sprint-0 development and CI period, the Bronze test data may be written with a shared or default key, not a per-brand DEK. If the pattern of "write with shared key in dev" is normalized, engineers may build assumptions into the stream-worker that the DEK is always present — but in dev it is not — creating a gap that is only closed in production.

**Required fix (two parts):** (1) The Terraform IAM policy for every workload's IRSA role that touches S3 must scope the `s3:GetObject`/`s3:PutObject` permission to the specific prefix pattern the workload owns — the stream-worker gets `s3:PutObject` on `bronze/brand=*/...` but NOT `s3:GetObject` on the full bucket. The Analytics API (or the StarRocks Iceberg external catalog role) gets `s3:GetObject` scoped to the relevant prefix. This must be Terraform-enforced, not convention-enforced. (2) The dev environment must use a placeholder per-brand DEK (even a synthetic test key) from day one so the DEK-absent code path is never normalized. The Terraform module for the CMK + DEK path must include a dev-test fixture that exercises the full envelope-encryption path.

**Severity: HIGH.** Without IAM-enforced prefix scoping, the S3 prefix isolation is a naming convention, not a structural boundary. A bug in prefix construction has no S3-layer backstop.

---

### Layer 4 — Apicurio FULL_TRANSITIVE + No-PII-in-Events Lint

**What the plan says:** Apicurio registry is provisioned with FULL_TRANSITIVE compatibility mode. The no-PII schema-lint CI gate is active (Workstream F). Contract codegen CI gate (buf-breaking + Pact stub) is in Workstream C.

**Gap — FULL_TRANSITIVE is a registry setting, not a CI-enforced schema-publish gate:**

Apicurio's `FULL_TRANSITIVE` compatibility mode is enforced at schema-publish time by the Apicurio server — it rejects a new schema version that breaks forward or backward compatibility with all prior versions. However, enforcement is only triggered if the publisher actually uses the Apicurio API to register the schema. If a developer produces an Avro message directly to Redpanda without going through the schema registry (by disabling the schema-id header or using a raw producer), FULL_TRANSITIVE provides zero protection. The CI gate described is "buf-breaking + Pact stub" (for Protobuf/REST contracts) — it is not described as validating that every Avro producer in the codebase is configured to use the schema registry and that the schema-id header is mandatory.

Additionally, the no-PII schema-lint gate (doc 07 §26 gate 6) is described as a CI gate on `packages/contracts` and `packages/events`. But the no-PII lint operates on the schema definition — it does not validate that the actual runtime Avro payload does not contain PII in a field that the schema permits as `bytes` or `string` without a PII type annotation. A developer who adds a `bytes` field labeled `payload_blob` can embed a raw email address. The lint passes; the PII leaks.

**Required fix:** (1) The stream-worker's Redpanda producer configuration must be Terraform/Helm-enforced to set `enable.idempotence=true` and the Apicurio schema registry URL as the schema serializer — this must be a required environment variable in the Helm chart, not an optional one. The CI integration test for the hello-world event flow must assert that the Avro message produced carries a valid schema-id header (verifiable by the Apicurio API). (2) The no-PII lint should be extended to flag any `bytes` or `string` field in an event schema that does not carry a `doc` annotation from an approved set (`hashed_id`, `brand_id`, `event_id`, `timestamp`, `vault_reference`, `non_pii_metadata`) — forcing explicit annotation for every field so PII cannot hide in a generic `bytes` field.

**Severity: MEDIUM.** A producer that bypasses the schema registry silently breaks the FULL_TRANSITIVE guarantee and can deliver unreplayable or PII-bearing events to Bronze without CI catching it.

---

### Layer 5 — Redis `brandKey()` Helper

**What the plan says:** `tenant-context.brandKey()` is the single helper; raw Redis key construction is lint-banned. This is correct per I-S01 and the STACK.md ADR-004 binding.

**Gap — the lint ban must be active at Sprint 0, not deferred:**

The ESLint rule that bans raw Redis key construction outside `tenant-context.brandKey()` is mentioned in the constraint list (INVARIANTS.md I-S01 anti-patterns: "No raw Redis keys built outside `tenant-context.brandKey()`. Raw key construction in application code is lint-banned.") but it is not listed as an explicit deliverable in any Sprint-0 workstream. Workstream A includes "ESLint/Prettier, money-minor-units lint" and Workstream F includes "no-PII-in-logs lint." The Redis key lint is not explicitly called out.

If the Redis key lint is not active in the Sprint-0 ESLint config, the first developer to write a cache hit in M1 will build raw keys. Those raw key patterns become copy-pasted across the codebase. Retrofitting a lint rule that fails hundreds of existing call sites is significantly more painful than establishing it at Sprint 0 when there is zero application code.

**Required fix:** add an explicit Sprint-0 deliverable in Workstream A (or F): the ESLint rule banning direct Redis key string construction (e.g., any string literal matching `:` in a Redis client call that does not pass through `brandKey()`) must be active and green on the hello-world integration path. This is a 30-minute implementation task with high structural impact.

**Severity: MEDIUM.** Without the lint rule active at Sprint 0, the invariant is convention-only until M1 introduces the first cache usage.

---

### Layer 6 — IRSA Least-Privilege (No Static Keys)

**What the plan says:** IAM/IRSA least-privilege roles per workload (Workstream D). No static AWS credentials — IRSA only. "Workloads assume scoped roles."

**Gap — IRSA role scoping is pod-level unless namespace+service-account binding is Terraform-enforced:**

IRSA (IAM Roles for Service Accounts) binds an IAM role to a Kubernetes service account via an OIDC trust policy. The trust policy condition should be `StringEquals: "oidc.eks.region.amazonaws.com/id/XXXXX:sub": "system:serviceaccount:<namespace>:<service-account-name>"`. If the Terraform module uses `StringLike` with a wildcard on the namespace or service account name (a common misconfiguration seen in Terraform EKS IRSA modules), any pod in the cluster that can mount any service account token can escalate to the role. This is a cluster-wide privilege escalation vector, not a per-workload one.

The plan says "scoped roles" but does not specify that the OIDC trust condition uses `StringEquals` with explicit namespace+service-account, not `StringLike` with a wildcard. This distinction is not visible in the high-level plan and is often wrong in the first Terraform module written, especially when the builder copies a generic EKS IRSA module from the registry.

**Required fix:** the Terraform IRSA module for every workload (collector, stream-worker, core, jobs) must use `StringEquals` conditions on both namespace and service account name — never `StringLike` with wildcards. A Checkov/OPA policy rule must enforce this in the IaC CI gate (Workstream H): any IRSA trust policy that uses `StringLike` on the subject field fails the plan gate. This is a one-time Checkov rule that prevents an entire class of cluster-level privilege escalation.

**Severity: HIGH.** A wildcard IRSA trust policy collapses workload isolation to cluster-level isolation. Any pod that can mutate a service account (via a misconfigured RBAC rule) can assume any IAM role.

---

### Layer 7 — S3 Object Lock (WORM) for Audit Checkpoint

**What the plan says:** S3 Bronze bucket + Object Lock enabled is a Sprint-0 IaC item. The WORM anchor is an hourly checkpoint job (Argo) shipping in M1/M2.

**Gap — Object Lock mode and retention period must be specified at bucket creation time; they cannot be changed after the fact:**

S3 Object Lock has two modes: `GOVERNANCE` (allows authorized users with `s3:BypassGovernanceRetention` to delete or change retention) and `COMPLIANCE` (no one, including AWS root, can delete or shorten the retention period during the lock). For an audit WORM anchor that is a compliance invariant (I-S06, COMPLIANCE.md "7-year retention"), the mode must be `COMPLIANCE`. If the Terraform resource specifies `object_lock_configuration { rule { default_retention { mode = "GOVERNANCE" } } }` — the shorter path because it requires less AWS root-account ceremony — then an IAM principal with the `s3:BypassGovernanceRetention` permission (which is easy to grant and often granted to "admin" roles) can delete audit checkpoint objects. This defeats the WORM guarantee.

Additionally, the retention period must be set to the full legal retention requirement (COMPLIANCE.md states 7 years for Phase 1 India) at bucket creation. S3 Object Lock in `COMPLIANCE` mode does not allow shortening a retention period already set. If the builder sets a short retention (e.g., 90 days for development convenience) in the initial Terraform apply, and a checkpoint job writes an object with that retention period, the retention period cannot be extended retroactively — objects written with the 90-day period will expire at 90 days, not 7 years.

**Required fix:** the Terraform S3 bucket resource for the audit WORM anchor must explicitly set `object_lock_configuration { rule { default_retention { mode = "COMPLIANCE", years = 7 } } }` — `COMPLIANCE` mode, not `GOVERNANCE`, and 7-year retention, not a short dev-convenience period. A Checkov rule must enforce that no data store tagged as `purpose=audit` uses `GOVERNANCE` mode or a retention period below the legal minimum. This is a cannot-be-retrofitted-without-data-loss decision.

**Severity: HIGH.** S3 Object Lock settings are bucket-level and cannot be changed after objects are written. A `GOVERNANCE` mode or short retention period baked in at Sprint 0 makes the WORM guarantee hollow and non-retrofittable without destroying and recreating the bucket.

---

### Layer 8 — Isolation Negative-Test Harness as CI Gate (P0 Exit Criterion)

**What the plan says:** isolation negative-test harness in CI (Workstream F); exit criterion 5: "RLS on; isolation negative-test passes (brand-A→brand-B = 0 rows/403)."

**Gap — the isolation harness tests one layer (Postgres RLS) and does not cover StarRocks, Redis, or MCP — yet TRIGGER-SURFACES.md requires all four:**

TRIGGER-SURFACES.md §Multi-tenancy states: "P0 isolation tests (API/DB/StarRocks/MCP) must pass before any launch." COMPLIANCE.md §Controls "Brand isolation — absolute and structural" cites: "CI isolation-fuzz: a synthetic cross-brand query at each layer (Postgres, StarRocks, MCP) must return nothing, not another brand's data."

Exit criterion 5 as written tests only Postgres RLS. The StarRocks layer test gap is flagged by the CTO Advisor intake (C2) but left as a "LOW concern" recommendation. The MCP layer test is not mentioned at all in the Sprint-0 workstreams. The Redis layer test (cross-brand `brandKey()` collision) is not mentioned.

My lens: if the isolation harness is a CI gate only for Postgres at Sprint 0, then for the entire Sprint 0 and M1 development period, every push to main passes isolation checks even if the StarRocks row policy, the Redis key construction, and the MCP scope check are broken. The CI gate is the structural enforcement mechanism. A gap in the gate means the structural enforcement is incomplete — the invariant is stated but not enforced.

**Required fix:** exit criterion 5 must be expanded to cover all four layers: (a) Postgres RLS: brand-A query as brand-B returns 0 rows; (b) StarRocks row policy: Analytics API query with brand-B context against brand-A data returns 0 rows; (c) Redis: `brandKey()` for brand-A cannot be constructed with brand-B context (a test that calls `brandKey()` with the wrong brand_id and asserts the key is structurally different, preventing a cache hit); (d) MCP: a brand-B MCP key cannot retrieve brand-A metric bindings (403). These tests do not require a full MCP implementation — they require stubs with the correct authorization assertion. This is additional scope but it is required by the canonical TRIGGER-SURFACES.md definition of "isolation fuzz at every layer."

**Severity: HIGH.** An isolation CI gate that covers only one of four named enforcement layers is not a structural enforcement mechanism — it is a partial check. The three uncovered layers can silently fail for the entire duration of M1 development without a CI gate stopping it.

---

### Layer 9 — No-PII-in-Logs: OTel Integration Point

**What the plan says:** no-PII-in-logs lint active (Workstream F); logger middleware redaction at the logger AND at the log-shipping layer (COMPLIANCE.md).

**Gap — the OTel span attribute sanitization is not mentioned as a Sprint-0 deliverable:**

OpenTelemetry spans carry attributes. If a developer adds `span.setAttributes({ email: user.email, ... })` to a trace span, that PII flows through the OTel collector to Grafana Cloud — outside the application logger's redaction path. The logger middleware redacts PII at the log level; the OTel collector processes span attributes independently. The plan establishes Grafana Cloud + OTel collector (Workstream G) and no-PII-in-logs lint (Workstream F) but does not describe whether the OTel collector pipeline includes a PII redaction processor or whether the `packages/observability` SDK helper enforces that span attributes are checked for PII-shaped values before being set.

The no-PII-in-logs lint (static analysis on log statements) does not catch dynamic `span.setAttributes()` calls where the value is determined at runtime. The nightly log-grep (staging) would catch PII in log lines, but not in span attributes shipped to Grafana Cloud (which is a separate data path).

**Required fix:** the `packages/observability` SDK must include an OTel span attribute wrapper that applies the same PII redaction as the logger middleware — specifically, it must refuse to set span attributes whose key matches a PII-pattern list (`email`, `phone`, `name`, `address`, `pan_`, `card_`) and must hash or drop the value. The OTel collector pipeline (the `otelcol-contrib` config) must include a `transform` processor that redacts known PII attribute patterns before forwarding to Grafana Cloud. Both must be Sprint-0 deliverables, not M1 additions.

**Severity: MEDIUM.** PII in span attributes shipped to a managed observability platform (Grafana Cloud, a third-party sub-processor) is a DPDP compliance violation. The no-PII-in-logs lint does not cover this path.

---

## Concerns (summary)

### Concern 1 — CRITICAL
- **Severity:** Critical
- **Concern:** Postgres RLS predicate form unspecified — the one-argument `current_setting()` form throws on a missed GUC instead of returning zero rows, creating a fail-open path when the exception is caught by ORM error handlers or middleware.
- **Rationale:** I-S01 requires that isolation is structural. A throw-on-miss predicate is not the same as a zero-row-on-miss predicate. The builder will very likely write the shorter one-argument form by default. Connection pool reuse without explicit GUC reset between requests means a stale brand_id can bleed across requests if the exception is swallowed. The correct form is `current_setting('app.current_brand_id', true)::uuid`. This must be the explicitly mandated form in migration #1, not left to the builder's discretion.

### Concern 2 — HIGH
- **Severity:** High
- **Concern:** StarRocks row policies are not CI-gated in the isolation-fuzz harness at Sprint 0 — the analytics serving layer ships without structural isolation enforcement at the CI gate.
- **Rationale:** Exit criterion 5 covers only Postgres. TRIGGER-SURFACES.md requires StarRocks + MCP in the isolation fuzz. A row-policy gap at the analytics serving layer (the sole read path per ADR-002) means every M1 dbt model and Analytics API query is unchecked against cross-brand leakage. This is an I-S01 violation at the serving layer.

### Concern 3 — HIGH
- **Severity:** High
- **Concern:** IRSA trust policy may use `StringLike` with wildcards instead of `StringEquals` with explicit namespace+service-account binding, collapsing workload isolation to cluster-level.
- **Rationale:** This is the single most common EKS IRSA misconfiguration in real-world Terraform modules. Without a Checkov/OPA enforcement rule in the IaC CI gate, the builder will very likely copy a generic module that uses `StringLike`. A wildcard IRSA trust policy means any pod can assume any workload's IAM role if it can mount the right service account token. This breaks secrets isolation (I-S09) and prefix-scoped S3 access (I-S01 physical isolation layer).

### Concern 4 — HIGH
- **Severity:** High
- **Concern:** S3 Object Lock must be `COMPLIANCE` mode with 7-year retention at bucket creation — `GOVERNANCE` mode or short retention is a non-retrofittable decision.
- **Rationale:** I-S06 mandates WORM-anchored audit log with legal retention. S3 Object Lock in `GOVERNANCE` mode can be bypassed by any IAM principal with `s3:BypassGovernanceRetention`. Objects written with short retention periods cannot have their retention extended retroactively. The Terraform resource for the audit bucket must be specified correctly at Sprint 0 or the WORM guarantee is hollow.

### Concern 5 — HIGH
- **Severity:** High
- **Concern:** The isolation negative-test harness covers only Postgres RLS; three of four canonical layers (StarRocks, Redis, MCP) are unverified by the CI gate.
- **Rationale:** TRIGGER-SURFACES.md requires all four layers in the isolation fuzz. COMPLIANCE.md's "Brand isolation — absolute and structural" control evidence is CI-driven. A partial isolation gate does not satisfy I-S01's "every layer independently" requirement. During M1, all new data-access code is developed without StarRocks, Redis, or MCP isolation regression testing.

### Concern 6 — MEDIUM
- **Severity:** Medium
- **Concern:** OTel span attributes are not covered by the no-PII-in-logs lint or the logger middleware redaction, creating a PII leakage path to Grafana Cloud.
- **Rationale:** `span.setAttributes()` bypasses the logger. PII in span attributes ships to a third-party sub-processor (Grafana Cloud) outside the DPDP-compliant log-shipping path. The OTel collector transform processor must be configured to redact PII attributes at Sprint 0, not M1.

### Concern 7 — MEDIUM
- **Severity:** Medium
- **Concern:** The Redis raw-key lint is not an explicit Sprint-0 deliverable — the invariant is convention-only until the lint is active.
- **Rationale:** Without the lint rule in the Sprint-0 ESLint config, the first cache usage in M1 sets the pattern. Raw key construction becomes normalized. Retrofitting a lint rule against a codebase with cache usage is high-friction. This is a 30-minute task at Sprint 0 versus a multi-sprint refactor at M2.

### Concern 8 — MEDIUM
- **Severity:** Medium
- **Concern:** Per-brand S3 prefix isolation is convention-enforced, not IAM-enforced — a prefix construction bug in the stream-worker has no S3-layer backstop if IRSA roles are scoped to the full bucket.
- **Rationale:** IRSA roles scoped to `arn:aws:s3:::bucket/*` rather than `arn:aws:s3:::bucket/bronze/brand=*/...` mean any workload role can read any brand's prefix. The per-brand KMS DEK provides cryptographic backstop but is not provisioned at Sprint 0 — dev Bronze data uses a shared key. The Terraform IAM policy for each workload must scope S3 access to the prefix pattern the workload owns.

---

## Recommendations

1. **Before migration #1 is written:** mandate in the Architect's implementation plan that the RLS predicate MUST use `current_setting('app.current_brand_id', true)::uuid` (two-argument form) and that the `packages/db` middleware MUST reset the GUC to null at connection checkout, then re-set it explicitly before every query. Include a unit test that asserts a query issued without the GUC set returns zero rows (not an exception). This is the single highest-leverage invariant at Sprint 0.

2. **Before exit criterion 5 is signed off:** expand the isolation-fuzz harness to cover all four canonical layers (Postgres, StarRocks, Redis, MCP) — even if StarRocks and MCP use stubs in Sprint 0 CI. The Architect must make this an explicit acceptance criterion in Workstream F and Workstream E. The StarRocks row policy template must be provisioned at cluster setup time (Workstream E) so it applies to all subsequent tables.

3. **In the Terraform IRSA module:** add a Checkov/OPA rule that fails the IaC plan gate if any IRSA trust policy uses `StringLike` on the subject condition. Enforce `StringEquals` with explicit `system:serviceaccount:<namespace>:<service-account-name>` for every workload. This rule must be active in the Workstream H CI gate before any Terraform apply to dev.

4. **In the Terraform S3 bucket resource for the audit anchor:** explicitly set `object_lock_configuration { rule { default_retention { mode = "COMPLIANCE", years = 7 } } }`. Add a Checkov rule that fails any bucket tagged `purpose=audit` without `COMPLIANCE` mode + minimum 7-year retention.

5. **In `packages/observability` SDK + OTel collector config:** add a span-attribute PII guard in the SDK wrapper and a `transform` processor in the OTel collector config that redacts known PII key patterns. Both must be Sprint-0 deliverables, not M1 additions. Coordinate with Workstream G.

6. **In Workstream A ESLint config:** add the Redis raw-key lint rule as an explicit deliverable alongside the money-minor-units lint. Cost: 30 minutes. Benefit: the invariant is structural from day one.

7. **In Terraform IRSA + S3 IAM policies:** scope every workload's S3 access to the prefix pattern it owns, not the full bucket. The stream-worker gets `PutObject` on `bronze/brand=*/...` but NOT `GetObject` on the bucket root. Document this in the Architect's IaC design as a required policy structure.

8. **Apicurio schema registry:** the Helm chart for the Redpanda producer (stream-worker) must make the schema registry URL a required environment variable with no default. The CI hello-world flow test must assert the Avro message carries a valid Apicurio schema-id header. This must be in the Workstream E acceptance criterion.

---

## Skills consulted

- `dynamic-persona-spawning` (discipline: count/type/depth/≥1-concern rules)
- Domain anchor: multi-tenancy isolation + secrets hardening (INVARIANTS.md I-S01, I-S06, I-S09; TRIGGER-SURFACES.md §Multi-tenancy; COMPLIANCE.md §Brand isolation; STACK.md ADR-001/005/007; doc 08 §3; doc 12 Workstream F)

---

## One line for the CTO Advisor synthesis

**The plan names all six isolation layers but does not structurally enforce them: the RLS predicate form, the StarRocks CI gate, the IRSA trust policy scope, and the S3 Object Lock mode are four load-bearing decisions that, if wrong at Sprint 0, become expensive or impossible to retrofit — mandate them explicitly in the Architect's plan before a single line of migration #1 is written.**
