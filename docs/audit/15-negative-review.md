# PASS 17 — Negative Review (Adversarial / Skeptic Pass)

**Reviewer:** Independent principal-level adversary. No attachment to the codebase.
**Mandate:** Try to BREAK Brain. Hidden tech debt, scalability cliffs, security/operational/business risks, prod-failing assumptions, unhandled edges. Every claim cites code.
**Repo:** `/Users/rishabhporwal/Desktop/Brain V3/worktrees/audit`

---

## Summary verdict

Brain's *invariant-critical* primitives (RLS FORCE + two-arg fail-closed GUC, per-brand salt hard-crash, HMAC timing-safe compare, constant-time JWT verify, integer-minor-unit money) are genuinely well-built — the obvious attacks are closed. The danger is one layer down: the system **cannot deploy as documented** (every prod/staging Helm chart and the collector kustomize overlay referenced by ArgoCD are absent), it **cannot scale horizontally without corruption of its own cost/rate-limit guarantees** (the near-real-time ingest pipeline is an in-process, all-brands, single-threaded loop with no leader election), and its **stated security boundary in the collector is not implemented in code** (no `SET ROLE`, default superuser DSN). The "near-real-time" pipeline is also the *only* live ingest path (push needs a tunnel), so the scalability cliff is on the critical path, not a fallback. Cost-routing is comment-only: the single model call defaults to **Opus** while labelled "Tier-3 small model", with no gateway config, no prompt-cache markers, and no per-tenant spend cap.

**Counts:** Critical 2 · High 4 · Medium 5 · Low 3

---

## CRITICAL

### NR-C1 — Every prod/staging deploy manifest referenced by ArgoCD is missing from the repo
**Severity:** Critical | **Category:** Operational / Deploy integrity
**Evidence:**
- `infra/argocd/envs/prod/core.yaml:17` → `path: infra/helm/core`
- `infra/argocd/envs/prod/web.yaml:17` → `path: infra/helm/web`
- `infra/argocd/envs/prod/stream-worker.yaml:18` → `path: infra/helm/stream-worker`
- `infra/argocd/envs/prod/collector.yaml:26` → `path: infra/k8s/collector/overlays/production`
- Actual filesystem: `infra/helm/` contains only `authentik/` and `README.md`; `infra/helm/{core,web,collector,stream-worker}` and `infra/k8s/collector/overlays/production` **do not exist** (verified by `test -d`).
- `infra/helm/README.md:1` even asserts "one chart per deployable (collector / stream-worker / core / litellm)" — none of those charts exist.

**Impact (prod):** A first GitOps sync against prod resolves four Applications whose source paths render nothing. The platform has no auditable Deployment/Service/HPA manifests, no resource limits, no replica counts, no probes — the entire runtime topology is undefined in-repo. "Manual promotion gate" (`stream-worker.yaml:25`) gates a sync that produces zero manifests. There is also a referenced `litellm` chart (the model gateway) that is likewise absent — the cost/routing tier-3/4 mechanism has no deployable.
**Root cause:** Deploy manifests were never committed (or live in another repo) while the ArgoCD Applications that point at them were. Doc 04 §K claims the charts exist.
**Recommended fix:** Commit the four charts + the collector overlay + the litellm chart, or repoint the Applications. Add a CI job that fails if any `argocd .../path:` does not resolve to an existing directory.
**Priority:** P0 | **Tenant impact:** Platform-wide (all tenants — nothing runs). | **Detection:** First ArgoCD sync ("path does not exist" / empty manifest); no metric catches it pre-deploy today.

---

### NR-C2 — Collector connects to Postgres with no `SET ROLE`; default DSN is superuser → RLS fully bypassed on the ingest write path
**Severity:** Critical | **Category:** Tenant isolation / Security
**Evidence:**
- `apps/collector/src/infrastructure/pg-spool.repository.ts:3-11` documents: *"Connects as brain_app … switches to brain_app role … For dev the superuser 'brain' is used with SET ROLE brain_app to simulate the production role boundary."*
- The class body (`:23-30`) builds `new Pool({ connectionString, … })` and **never issues `SET ROLE`/`SET LOCAL ROLE`** — `grep "SET ROLE" apps/collector/src` returns only the comment. No role switch is implemented anywhere in the collector.
- `apps/collector/src/main.ts:91` → `new PgSpoolRepository(cfg.DATABASE_URL)`.
- `.env.example:` ships `DATABASE_URL=postgres://brain:brain@localhost:5432/brain` — the **superuser** role. The collector has no `BRAIN_APP_DATABASE_URL` (the stream-worker has one at `apps/stream-worker/src/main.ts:51`; the collector does not).

**Impact (prod):** RLS (`brain_app` FORCE, `db/migrations/0004_brand.sql:34-39`) is the tenant-isolation control. The collector silently runs as `brain` (BYPASSRLS by default for a superuser; the `0001_init.sql:48` guard only protects `brain_app`, not `brain`). The boundary is "documented but not coded" — it depends entirely on an operator setting `DATABASE_URL` to a `brain_app` DSN, which is undocumented and contradicted by `.env.example`. This is the MEMORY.md "dev superuser masks RLS" risk, but worse: there is no `brain_app` env var to set and no `SET ROLE`, so the masking can reach prod silently.
**Root cause:** Aspirational comment never implemented; collector lacks a separate `brain_app` DSN env var.
**Recommended fix:** Add `BRAIN_APP_DATABASE_URL` to collector config (mirror stream-worker); fail-fast at startup if the connected role has `rolsuper`/`rolbypassrls` (e.g. `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`); update `.env.example`.
**Priority:** P0 | **Tenant impact:** Multi-tenant — superuser bypass means any spool read/write is cross-tenant. | **Detection:** No alert today; would surface only as an incident (one tenant's raw bodies visible to a query lacking a brand filter).

---

## HIGH

### NR-H1 — Near-real-time ingest is a single in-process, all-brands, sequential loop with no leader election; it is a scalability cliff AND a horizontal-scale corruption
**Severity:** High | **Category:** Scalability / Operational
**Evidence:**
- `apps/stream-worker/src/jobs/ingest-scheduler/run.ts:56-99` — `tick()` calls `enumerateConnectedConnectors(pool)` (ALL brands × ALL connectors) and dispatches each `run()` **sequentially** in a single `for` loop (`:64-65` "never Promise.all").
- `:124-141` — an `inFlight` guard means a tick that takes longer than the interval simply does not start the next one. So with `N` connectors at `T`s each, effective cadence = `N·T`, **not** the advertised 45 s (`DEFAULT_INTERVAL_MS = 48` → `45_000`, `:48`). "Near-real-time (30–60 s)" silently degrades to minutes/hours as tenants grow. One slow/timing-out provider `run()` stalls **every** brand queued behind it in the loop.
- `apps/stream-worker/src/main.ts:299` — `startIngestScheduler(...)` is called **unconditionally** at process start, with **no leader election / singleton lock**. If stream-worker runs `R` replicas, all `R` enumerate every connector and race for the per-connector `FOR UPDATE SKIP LOCKED` lock → `R×` provider-API attempts, `R×` DB connections, wasted work, and provider rate-limit exhaustion (the very thing the sequential loop tries to avoid is defeated by horizontal scaling).
- Per `docs/dev/ingestion-in-dev.md:20,66-67,77` this polling scheduler is the **only** live ingest path without a tunnel — so the cliff is on the critical path, not a degraded fallback.

**Impact (prod):** Freshness SLO violated as a function of tenant count (not load spikes — *steady-state growth*). Cannot scale stream-worker horizontally without multiplying provider calls and tripping rate limits / bans.
**Root cause:** "Reuse the on-demand claimer for everything" collapsed scheduling and execution into one unsharded in-process loop; no work-partitioning or coordinator.
**Recommended fix:** (1) Leader-elect the scheduler (advisory lock / lease) so exactly one replica schedules; (2) decouple scheduling from execution — enqueue per-connector jobs onto a partitioned queue (Kafka/pg-queue) consumed by all replicas, so one slow connector can't head-of-line-block others and work fans across replicas; (3) shard enumeration by `hash(connector_id) % replicaCount`.
**Priority:** P1 | **Tenant impact:** Multi-tenant — a slow connector for tenant A delays every other tenant's freshness; scale-out amplifies provider abuse across all tenants. | **Detection:** Tick-duration / lag metric (does the scheduler emit `tick done dispatched=x/y` only to stdout — `:95`; no metric/alert today).

### NR-H2 — `collector_spool` stores raw inbound bodies (PII) with no `brand_id`, no RLS, and no retention; drained rows are never deleted
**Severity:** High | **Category:** Security / Privacy / Data growth
**Evidence:**
- `db/migrations/0015_collector_spool.sql:21-28` — `collector_spool(raw_body JSONB, status, …)`. **No `brand_id` column. No `ENABLE/FORCE ROW LEVEL SECURITY`** (the file's `:5` comment "collector_spool has NO RLS — intentional" confirms it; grep shows 0 RLS mentions).
- `apps/collector/src/infrastructure/pg-spool.repository.ts:50-58` reads `WHERE status='pending'` **globally** (cross-tenant) — required for pre-routing, but means a single table holds every tenant's raw PII bodies untagged.
- `markDrained` (`:66-72`) sets `status='drained'` but **never deletes**. No `DELETE FROM collector_spool`, no TTL/retention job anywhere (`grep` returns nothing). Drained rows (raw email/phone pre-hash) accumulate forever.
- A poison body that repeatedly fails the drainer's Avro encode (`apps/collector/src/interfaces/jobs/drainer.ts:62`) stays `pending` indefinitely with raw PII.

**Impact (prod):** (a) Unbounded growth of a PII-bearing table → storage + slow `pending` scans even with the partial index. (b) GDPR/DPDP erasure cannot target a tenant's rows (no `brand_id`) and never purges (no retention) → a data-subject-deletion gap for any PII captured during a Redpanda outage. (c) Combined with NR-C2 (superuser DSN), any unfiltered read is cross-tenant.
**Root cause:** Spool designed as a transient degraded-mode buffer but given no lifecycle (delete-after-drain) and no privacy classification.
**Recommended fix:** Delete on drain (or `DELETE … WHERE status='drained'` reaper); add a `received_at`-based TTL purge for stuck `pending`; classify the table as PII and document its erasure story; if feasible, tag rows with the resolved `brand_id` post-routing.
**Priority:** P1 | **Tenant impact:** Multi-tenant (untagged cross-tenant PII; erasure gap spans all tenants). | **Detection:** Table-size growth alert (none configured); surfaces as a privacy-audit finding or disk-fill incident.

### NR-H3 — OAuth CSRF state is held in an in-process Map → multi-replica core breaks connector installs intermittently
**Severity:** High | **Category:** Correctness under scale / Connector availability
**Evidence:**
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/state/InProcessOAuthStateStore.ts:22-29` — state nonce stored in `private store = new Map<…>()`.
- `apps/core/src/main.ts:544` — `const oauthStateStore = new InProcessOAuthStateStore();` (the wired prod instance).
- `consumeAndGetBrandId` (`:41-47`) reads from the same in-memory Map; returns `null` if absent.
- Prod core is load-balanced/HPA-managed (the collector ArgoCD app manages HPA replicas — `infra/argocd/envs/prod/collector.yaml:53` strips `/spec/replicas`; core is the same pattern). The Shopify OAuth `begin` and `callback` are separate HTTP requests that can land on different pods.

**Impact (prod):** `begin` sets the nonce on pod A; the provider redirects the merchant's browser to `callback`, which the LB routes to pod B → nonce not found → install fails with an HMAC/state error. Non-deterministic, sticky-session-dependent, and it also loses all pending installs on any pod restart/deploy. Connector onboarding (a core funnel step per the brand→website→pixel model) becomes flaky in prod.
**Root cause:** In-memory store acceptable only for single-replica; not externalized to Redis/Postgres.
**Recommended fix:** Back the state store with Redis (TTL'd) or a Postgres table — the codebase already uses both. Single-use + TTL semantics port directly.
**Priority:** P1 | **Tenant impact:** Per-tenant (a tenant's install fails) but affects all tenants statistically; blast radius = onboarding. | **Detection:** OAuth callback error-rate; no dedicated metric today.

### NR-H4 — The single LLM call defaults to Opus (most expensive large model) while labelled "Tier-3 small model"; no per-tenant spend cap, no real prompt caching, no gateway config
**Severity:** High | **Category:** Cost routing / FinOps (cost-routing-paradigms)
**Evidence:**
- `packages/ai-gateway-client/src/client.ts:30-31` — `DEFAULT_RESOLVER_MODEL = 'claude-opus-4-8'`, immediately under `:8` "Cost doctrine … Tier-3 — the ONLY model call". **Opus is a Tier-4 large model**, not Tier-3 small. This is the skill's "Defaulting to a model / wrong tier" anti-pattern — NLQ resolution against a *bounded JSON schema* (`buildResolverJsonSchema()`, `:85`) is exactly a small-model/Tier-3 task.
- `fetchTransport` (`:110-131`) sends `system` as a **plain string** with **no `cache_control` block**. Anthropic prompt caching (via an OpenAI-compat `/v1/chat/completions` body) requires explicit cache markers — a plain system string is **not** cached. The code's own `:13` comment warns "A cache miss on this stable prefix is a cost bug" — and the implementation guarantees that miss.
- No per-tenant spend cap / virtual-key budget exists: `grep "virtual_key|max_budget|budget_duration|tpm_limit"` across `infra/`+`docs/` returns nothing; there is **no litellm gateway config file** in the repo at all (and the chart is missing — NR-C1). The only control is a per-call `max_tokens: 256` (`:34,121`).
- `@effort(...)` declarations exist only as JSDoc comments (e.g. `apps/stream-worker/src/application/ResolveIdentityUseCase.ts:3`); there is **no runtime `effort()` wrapper, no cost telemetry, no CI gate** parsing them. The skill's phase-gate ("effort-tier declaration + cost telemetry live before any model-calling feature ships; per-tenant cap live before the highest-cost feature ships") is unmet.

**Impact (prod):** One mis-routed tier is 1–2 orders of magnitude of cost (the skill's 1:100:1000:10000 ratio). Opus on every NLQ + a guaranteed cache miss + no per-tenant cap means a single tenant looping NLQ can run the model bill unbounded with no throttle and no fallback. The cost-mix dashboard and large-model-creep alarm the doctrine requires do not exist.
**Root cause:** Cost-routing treated as documentation, not enforced infrastructure; default model chosen for quality with no tier/cost review.
**Recommended fix:** Route the resolver through the gateway's `small_model` policy tier (cheapest model passing the eval bar) rather than hardcoding Opus; add `cache_control` to the stable system prefix; ship the litellm config with per-tenant virtual-key budgets + soft-warn/hard-stop; add a CI gate that parses `@effort` and rejects a model call whose declared tier ≠ implementation.
**Priority:** P1 | **Tenant impact:** Multi-tenant (no per-tenant cap → one tenant's spend is unbounded and uncontained). | **Detection:** No cost telemetry today (the gap itself). Surfaces as a model-bill spike.

---

## MEDIUM

### NR-M1 — System is hard-locked to exponent-2 currencies; CAPI passback also loses bigint precision via `Number()`
**Severity:** Medium | **Category:** Money / Internationalization correctness
**Evidence:**
- `packages/money/src/index.ts:114-116` `MINOR_UNITS = { INR:100, AED:100, SAR:100 }`; `apps/web/lib/format/money-display.ts:20-24` `MINOR_DIVISORS = {INR:100n,…}` + `padStart(2,'0')` (`:55`). Every formatter assumes 2 decimal places.
- `apps/core/src/modules/notification/internal/capi-passback.service.ts:173` — `value: Number(conv.valueMinor) / 100`. This (a) hardcodes `/100` (not the `MINOR_UNITS` table) and (b) coerces a bigint minor value through `Number()` before dividing — for amounts above `Number.MAX_SAFE_INTEGER` minor units precision is lost silently.

**Impact:** Onboarding a zero-decimal (JPY) or three-decimal (KWD/BHD) currency — both plausible for the AED/SAR Gulf markets already declared — produces wrong displayed and wrong Meta-CAPI-reported values (off by 100×), corrupting ad-platform optimization signals. Documented as Phase-1-only (INR/AED/SAR all ×100), so latent today, but the `/100` is scattered, not centralized, so the Phase-5 multi-currency ADR will miss sites.
**Root cause:** Phase-1 shortcut (`packages/money/src/index.ts:16` "Extend via an ADR when Phase-5 ships") implemented as scattered literals rather than a single `MINOR_UNITS` lookup.
**Recommended fix:** Replace `capi-passback.service.ts:173` with a `MINOR_UNITS`-driven integer-safe conversion from `@brain/money`; grep-ban literal `/100` in money paths via lint.
**Priority:** P2 | **Tenant impact:** Per-tenant (a non-INR/AED/SAR tenant). | **Detection:** Wrong CAPI value vs order value; no automated check.

### NR-M2 — `SaltProvider` decodes salt hex via `Buffer.from(hex)` which silently accepts/truncates invalid hex
**Severity:** Medium | **Category:** Identity / Crypto robustness
**Evidence:** `apps/stream-worker/src/infrastructure/secrets/SaltProvider.ts:113` `salt = Buffer.from(trimmed, 'hex')`. Node's hex decoder does **not throw** on non-hex characters — it stops at the first invalid pair and returns a shorter buffer. The `try/catch` at `:112-118` therefore never fires for bad hex; only the `:122` 32-byte length guard catches it. A 64-char string with a non-hex char near the end could decode to a *different* but still 32-byte buffer in edge cases, or (more commonly) a too-short buffer caught by the guard.
**Impact:** Mostly defended by the length guard (good), but the code's intent ("hex decode failed → throw" at `:115`) is dead — a malformed salt fails on length, not on the more specific decode error, weakening diagnosability. Low-probability wrong-salt-without-crash only if a malformed-but-32-byte decode occurs.
**Root cause:** Assumption that `Buffer.from(x,'hex')` validates; it doesn't.
**Recommended fix:** Pre-validate `/^[0-9a-f]{64}$/` before decoding; keep the length guard as defense-in-depth.
**Priority:** P2 | **Tenant impact:** Per-brand. | **Detection:** Identity-bridge crash log (length guard).

### NR-M3 — `formatMoneyDisplay` round-trips through `Number(decimalString)` for Intl, reintroducing float for large amounts
**Severity:** Medium | **Category:** Money display correctness
**Evidence:** `apps/web/lib/format/money-display.ts:55-70` builds an exact decimal string from bigint parts (correct) then `…format(Number(decimalString))` (`:70`) — converting back to a JS `Number` before `Intl.NumberFormat`. For amounts above `Number.MAX_SAFE_INTEGER` major units (₹90,071,992,547,409.91+) the displayed value loses precision despite the careful bigint decomposition. The `:48-51` comment hand-waves this ("no precision is lost within the MAX_SAFE_INTEGER range") — i.e. it *is* lost beyond it.
**Impact:** Aggregate revenue tiles (sum across a large tenant over a long window) can display slightly wrong digits. Display-only, but undermines the "no float money ever" invariant the file claims to uphold (`:6`).
**Root cause:** `Intl.NumberFormat` takes a `number`; no bigint formatter used.
**Recommended fix:** Format the integer major/minor parts directly with `Intl.NumberFormat` on the bigint major part + literal minor, or use `Intl.NumberFormat`'s string/bigint support, avoiding `Number()`.
**Priority:** P3 | **Tenant impact:** Large-tenant aggregates only. | **Detection:** Visual discrepancy; no automated check.

### NR-M4 — `infra/redpanda/topics.yml` ships `min.insync.replicas: "1"` with a comment "2 for prod" — durability depends on an un-enforced manual edit
**Severity:** Medium | **Category:** Operational / Durability
**Evidence:** `infra/redpanda/topics.yml:17` `min.insync.replicas: "1"   # 2 for prod` (also `:28`,`:39`). The prod-correct value lives in a comment, not in a prod overlay. `infra/terraform/modules/redpanda/main.tf:93,106` does set `"2"`, so there are **two sources of truth** for the same setting and the YAML one is prod-unsafe by default.
**Impact:** If the YAML path is the one applied (it's the dev-compose/topic-bootstrap source), a prod topic created from it has ISR=1 → a single broker loss can lose acknowledged events (ingest data loss). Two-source-of-truth invites drift.
**Root cause:** Env-specific durability encoded as a comment; no prod overlay for `topics.yml`.
**Recommended fix:** Single source of truth (Terraform) for prod topic config, or a prod `topics.yml` overlay; CI assert ISR≥2 for any prod topic.
**Priority:** P2 | **Tenant impact:** Multi-tenant (shared topics → loss affects all tenants on that partition). | **Detection:** Redpanda under-replicated-partition metric.

### NR-M5 — `resolveSaltHex` returns `''` in prod and relies on every call site re-implementing the D-2 guard; one missing guard = silent empty-salt hashing
**Severity:** Medium | **Category:** Identity / Defense-in-depth
**Evidence:** `packages/identity-core/src/index.ts:89-99` — in prod, `resolveSaltHex` deliberately **does not crash**; it returns the possibly-empty env value (`:98`) and documents (`:80-84`) that the *caller's* D-2 guard is "the single, intact crash point." The guards do exist at the audited sites (`apps/core/src/main.ts:398-403`, `:565-569`; `SaltProvider.forBrand` throws). But this is fail-*open by default, guard-by-convention*: any future call site that forgets the `if (!salt || salt.length !== 64) throw` will hash all brands with `''` → identical cross-brand hashes (the one invariant D-2 forbids), with no central enforcement.
**Impact:** A latent footgun. The safety of the most security-critical invariant depends on each of 8+ call sites independently re-implementing the same guard correctly.
**Root cause:** Resolver intentionally pushed the crash to callers "to keep the prod path untouched," trading central fail-closed for distributed guards.
**Recommended fix:** Make `resolveSaltHex` itself throw in prod on empty/wrong-length (it already knows `NODE_ENV==='production'` at `:95`), making it the single crash point; the call-site guards then become redundant belt-and-suspenders instead of the sole defense.
**Priority:** P2 | **Tenant impact:** Multi-tenant (empty salt → cross-brand correlation). | **Detection:** Would only surface via a hash-collision audit; no runtime alarm.

---

## LOW

### NR-L1 — Drainer holds back-pressure forever with no dead-letter / poison handling
**Severity:** Low | **Category:** Operational
**Evidence:** `apps/collector/src/interfaces/jobs/drainer.ts:59-69` — a row that fails to produce (bad Avro, oversized) is retried every tick forever; there is no attempt counter, no DLQ, no max-age. Combined with NR-H2 (no delete), a single poison row blocks `ORDER BY id` progress behind it if produce throws before advancing (depends on `DrainEventsUseCase` ordering).
**Impact:** A poison body can wedge the spool drain head-of-line; raw PII retained indefinitely.
**Priority:** P3 | **Tenant impact:** Single-tenant (the poison body's tenant) but can stall the shared drain. | **Detection:** Spool `pending` count climbs.

### NR-L2 — `getSecret`/spool/model paths `JSON.parse` untrusted stored or remote content without a size/shape guard
**Severity:** Low | **Category:** Robustness
**Evidence:** `LocalSecretsManager.getSecret` `:90-95` and `getShopifyClientSecret` paths, `pg-spool.repository` returns `raw_body` straight to the producer, and `ai-gateway-client/src/client.ts:140` `JSON.parse(content)` on raw model output (dev `LocalSecretsManager` only, so contained). No size caps on parsed JSON.
**Impact:** Low (LocalSecretsManager is dev-only; model output is `max_tokens:256` bounded). A malformed model response throws, which is caught fail-closed (`:96-101`) — acceptable.
**Priority:** P3 | **Tenant impact:** Negligible. | **Detection:** Parse-error logs.

### NR-L3 — Scheduler / drainer observability is `console.*` only — no metrics, no traces, despite a `@brain/observability` package existing
**Severity:** Low | **Category:** Observability
**Evidence:** `apps/stream-worker/src/jobs/ingest-scheduler/run.ts:59-97` and `apps/collector/src/interfaces/jobs/drainer.ts:46-68` emit only `console.info/warn/error`. There is a `packages/observability` package and an OTEL collector config (`infra/observe/otel-collector.yml`), but the two most operationally critical loops (the only live ingest path and the durability buffer) emit no metric — so NR-H1's freshness cliff and NR-H2's growth are invisible until incident.
**Impact:** The scalability cliff and spool growth have no leading indicator; first signal is a customer-visible staleness or a disk alert.
**Priority:** P3 | **Tenant impact:** Platform-wide blind spot. | **Detection:** N/A — that's the finding.

---

## What I tried to break but couldn't (credibility notes)

- **RLS fail-open via one-arg `current_setting`:** `db/migrations/0004_brand.sql:66-85` has a migration-time assertion that *rejects* any policy using one-arg `current_setting` — genuinely enforced, not just convention.
- **BYPASSRLS on `brain_app`:** `db/migrations/0001_init.sql:48-51` hard-fails the migration if `brain_app` has `rolbypassrls`. Solid. (The gap is `brain` superuser — NR-C2 — not `brain_app`.)
- **HMAC / JWT timing attacks:** `ShopifyHmac.ts:55` uses `timingSafeEqual`; `jwt.ts:76-85` is a correct constant-time compare with a length pre-check. Closed.
- **Dev-salt leaking to prod:** `packages/identity-core/src/index.ts:95` gates `resolveDevSaltHex` strictly behind `NODE_ENV !== 'production'`; `LocalSecretsManager` hard-fails in prod (`:33-38`). The dev convenience does not reach prod (caveat NR-M5 on the empty-salt fail-open).
- **Identity merge fan-out:** `IdentityResolver.ts:14-16,141` has a phone-guard threshold (default 10) + alias-chain cycle guard → bounded, no unbounded merge storm.
