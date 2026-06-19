# Pass 4: Design Pattern Audit (design-patterns)

## Board Verdict

The Brain V3 codebase demonstrates a solid DDD scaffold in its most mature bounded context (Identity) and the connector sub-context (Shopify). `IdentityResolver` is a textbook pure-domain service, `ConnectorInstance` / `ConnectorCursor` are immutable value-carrying entities with private constructors and factory methods, the repository interface + infrastructure split is honored in the connector sub-domain, and CQRS read/write separation is respected inside the measurement module. However, five concrete defects undermine these otherwise good patterns. (1) The domain module `SharedUtilityPolicy` is defined but never imported anywhere in the production callchain — its phone-guard logic is re-implemented inline inside `IdentityResolver`, making `SharedUtilityPolicy` a dead module that misleads readers about where the authoritative logic lives. (2) The `connector/sources/storefront/shopify/domain/` directory has been promoted into a de facto shared connector kernel: five non-shopify sub-contexts (meta, google_ads, razorpay, shopflo, gokwik) reach across with relative `../../../../storefront/shopify/domain/` imports, leaking `ConnectorInstance`, `ConnectorSyncStatus`, `IConnectorInstanceRepository`, `ISecretsManager`, and `OAuthStateNonce` into every other provider. (3) The critical deterministic functions `computeLedgerEventId` and `toBillingPostedPeriod` are copy-pasted across four files — the canonical home in `packages/metric-engine/measurement/internal/domain` is bypassed in `LedgerWriter.ts`, `revenue-finalization.ts`, and `credit-writer.ts`, creating a silent divergence risk for the idempotency dedup key. (4) All five `emitEvent` injections in `apps/core/src/main.ts` are log-only stubs; `connector.connected.v1` and related domain events never enter Redpanda even though doc-07 mandates downstream consumers for recommendation, data-quality, and notification. (5) `RecognizeOrderCommand` and `PostReversalCommand` / `PostFinalizationCommand` construct `PgLedgerRepository` directly inside their constructors (bypassing the repository interface pattern used everywhere in connector), making the measurement module untestable in unit isolation and coupling it hard to Postgres.

**Severity counts: Critical 0 | High 2 | Medium 2 | Low 1**

---

## Finding DP-1

**Title:** `SharedUtilityPolicy` domain class is dead code — phone-guard logic is duplicated inside `IdentityResolver` instead

**Severity:** High

**Category:** DDD tactical / domain service misuse

**evidenceRef:**
- `apps/stream-worker/src/domain/identity/SharedUtilityPolicy.ts:26-66` — declares `SharedUtilityPolicy.evaluate()` and `computeSuppressedUntil()`.
- `apps/stream-worker/src/domain/identity/IdentityResolver.ts:117-159` — re-implements phone-guard (active-suppression check at line 126, threshold check at line 141, `computeSuppressedUntil` at line 291) inline, never calling `SharedUtilityPolicy`.
- `grep -rn "SharedUtilityPolicy" apps/` returns only the declaration file and its `.d.ts` emit; zero callers.

**Impact:** The suppression threshold comparison in `IdentityResolver` uses `existingCount + 1 > brandConfig.phone_guard_threshold` (line 141), while `SharedUtilityPolicy.evaluate` uses `distinctBrainIdCount > threshold` (SharedUtilityPolicy.ts:47) — strict-greater-than versus the add-one-first. Any future developer reasoning from `SharedUtilityPolicy` about policy behavior will be wrong. Any unit test exercising `SharedUtilityPolicy` in isolation tests dead code.

**Root Cause:** `SharedUtilityPolicy` was scaffolded as a separate strategy object but `IdentityResolver.resolve()` was written (or later modified) with its own inline implementation of the same checks, leaving the policy class stranded.

**Fix:** Either (a) have `IdentityResolver.resolve()` delegate the phone-guard evaluation to `SharedUtilityPolicy.evaluate()` and remove the inline duplication, or (b) delete `SharedUtilityPolicy` if a standalone strategy class is not wanted. The threshold semantics (`> threshold` vs `existingCount + 1 > threshold`) must be reconciled first — the intended check is whether ADDING this phone to a new brain_id would push count over threshold, so the `+1` form in `IdentityResolver` is most likely correct; `SharedUtilityPolicy` should be updated to match before wiring.

**Priority:** P1

**Tenant Impact:** Single-tenant (per-brand GUC scoped), but wrong suppression boundary affects any brand whose phone counts are exactly at the threshold — they may get suppressed one event earlier (IdentityResolver) vs one event later (SharedUtilityPolicy), resulting in ghost merges or over-suppression depending on which path a future refactor takes.

**Detection:** Currently invisible; `SharedUtilityPolicy` has no coverage in the live code path. A future developer wiring tests against it would see passing tests for dead code. Only detectable by grep for zero callers or by a dead-code linter rule.

---

## Finding DP-2

**Title:** Five non-Shopify connector sub-contexts directly import Shopify domain artifacts — shared connector kernel leaks across bounded sub-contexts

**Severity:** High

**Category:** Bounded-context boundary violation / connector domain ownership

**evidenceRef:**
- `apps/core/src/modules/connector/sources/advertising/meta/application/commands/HandleMetaOAuthCallbackCommand.ts:25-28` — imports `ConnectorInstance`, `ConnectorSyncStatus`, `IConnectorInstanceRepository`, `IConnectorSyncStatusRepository`, `IOAuthStateStore`, `ISecretsManager` from `../../../../storefront/shopify/domain/` and `../../../../storefront/shopify/infrastructure/`.
- `apps/core/src/modules/connector/sources/advertising/google/application/commands/HandleGoogleAdsOAuthCallbackCommand.ts:20-23` — same Shopify-domain imports.
- `apps/core/src/modules/connector/sources/payment/razorpay/application/commands/ConnectRazorpayCommand.ts:19-23` — same.
- `apps/core/src/modules/connector/sources/checkout/gokwik/application/commands/ConnectGokwikCommand.ts:21-25` — same.
- `apps/core/src/modules/connector/sources/checkout/shopflo/application/commands/ConnectShopfloCommand.ts:19-23` — same.
- `apps/core/src/modules/connector/sources/advertising/meta/application/commands/InitiateMetaOAuthCommand.ts:17` — imports `OAuthStateNonce` from `../../../../storefront/shopify/domain/value-objects/`.

**Impact:** `ConnectorInstance`, `ConnectorSyncStatus`, and the repository interfaces are physically housed inside `connector/sources/storefront/shopify/domain/`. Any rename, refactor, or shopify-specific constraint added to that path (e.g., adding a `shopDomain` required field variant) silently affects all five providers. The `IOAuthStateStore` is also shopify-namespaced (`shopify:oauth:state:{state}` key scheme in `InProcessOAuthStateStore`) yet used as the state store for Meta and Google Ads OAuth — if the key prefix is ever made provider-specific, all providers share the same namespace by accident. This is a structural encapsulation violation: `meta` and `google_ads` have a hard compile-time dependency on `storefront/shopify`.

**Root Cause:** When the second and third connector providers were added, the shared domain types (`ConnectorInstance`, repo interfaces, secrets interface) were not elevated into a shared `connector/shared/` or `connector/catalog/domain/` location. The Shopify sub-context acts as the accidental kernel.

**Fix:** Create `apps/core/src/modules/connector/shared/domain/` containing `ConnectorInstance.ts`, `ConnectorSyncStatus.ts`, `IConnectorInstanceRepository.ts`, `IConnectorSyncStatusRepository.ts`, and move `ISecretsManager` there (or to `connector/shared/infrastructure/`). Move `OAuthStateNonce` and `IOAuthStateStore` there too. Update all import paths. The `InProcessOAuthStateStore` key prefix `shopify:oauth:state:` should become `{provider}:oauth:state:` to avoid cross-provider nonce collision.

**Priority:** P1

**Tenant Impact:** Multi-tenant blast radius — a nonce key-space collision between providers under the same in-process state store would allow a Meta OAuth callback to consume a Shopify state nonce (or vice-versa), potentially routing `brandId` to the wrong provider's OAuth flow (though in practice the providers use separate routes so collision is unlikely today).

**Detection:** Compile-time only if Shopify's domain types change signature; no runtime alert. A path-based import linter rule would catch new violations; currently absent.

---

## Finding DP-3

**Title:** `computeLedgerEventId` and `toBillingPostedPeriod` are copy-pasted across four files with no shared source-of-truth

**Severity:** Medium

**Category:** DRY / domain service duplication / idempotency key risk

**evidenceRef:**
- Canonical source: `apps/core/src/modules/measurement/internal/domain/recognition/services/LedgerEventId.ts:16-26` and `apps/core/src/modules/measurement/internal/domain/recognition/entities/LedgerEntry.ts:34-38`.
- Copy 1: `apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts:43-58` — local re-implementations of both functions.
- Copy 2: `apps/stream-worker/src/jobs/revenue-finalization.ts:42-59` — another local copy with identical logic but independent file.
- Copy 3: `apps/core/src/modules/attribution/internal/credit-writer.ts:38-42` — `toBillingPostedPeriod` duplicated again (function body identical).

**Impact:** The `computeLedgerEventId` function is the idempotency key for every `realized_revenue_ledger` row. If any copy drifts (e.g., a delimiter change `\0` → `|`, or a version string bump `v1` → `v2`), the same real-world event would generate a different `ledger_event_id` depending on which code path processed it, breaking the `ON CONFLICT DO NOTHING` idempotency guarantee and producing duplicate ledger rows — directly corrupting realized GMV figures shown to customers.

**Root Cause:** `stream-worker` does not import from `apps/core` (by design — separate deployable), and the `measurement` module's domain utilities were not promoted to a shared package (e.g., `packages/metric-engine` or a new `packages/ledger-utils`). Each new call site re-implemented the function locally.

**Fix:** Extract `computeLedgerEventId` and `toBillingPostedPeriod` into `packages/metric-engine/src/ledger-event-id.ts` (or a thin `packages/ledger-utils` package). Both `apps/core` and `apps/stream-worker` already depend on `@brain/metric-engine`. Export these two functions from the package index and replace all four local copies with the single import. Add a linter or test that asserts the function output is stable across versions.

**Priority:** P1

**Tenant Impact:** Per-brand (each row is brand-scoped), but a drifted key would silently double-insert ledger rows for ALL brands processed by the drifted code path, multiplying revenue figures. The `ON CONFLICT` dedup becomes ineffective for any order whose event routes through the diverged version.

**Detection:** Silent — no alert. Would surface as anomalous revenue spikes in the analytics dashboard or as unexpected non-zero `rowCount` from inserts that should have been suppressed. A determinism test asserting identical output from all copies would catch this.

---

## Finding DP-4

**Title:** All `emitEvent` injections in `apps/core/src/main.ts` are log-only stubs — `connector.connected.v1` and related events never reach Redpanda

**Severity:** Medium

**Category:** Event-driven pattern / saga / outbox

**evidenceRef:**
- `apps/core/src/main.ts:447` — pixel `emitEvent` = `app.log.info(...)`.
- `apps/core/src/main.ts:628-630` — Shopify OAuth callback `emitEvent` = `app.log.info(...)` with comment "Event stub: M1 uses in-process logging; async event bus is M2".
- `apps/core/src/main.ts:636-638` — disconnect `emitEvent` = `app.log.info(...)`.
- `apps/core/src/main.ts:667-669` — Meta/Google Ads `emitConnectorEvent` = `app.log.info(...)`.
- `apps/core/src/main.ts:1548-1550` — pixel verify `emitEvent` = `app.log.info(...)`.
- `docs/requirements/07_Brain_Event_Contracts.md:126` — states `connector.connected.v1` / `connector.health.changed.v1` must flow to consumers: **recommendation**, **notification**, **data-quality**.
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md` (recon map) — M2 binding for connector domain events.

**Impact:** Downstream consumers that doc-07 requires for `connector.connected.v1` (recommendation engine trigger, data-quality re-eval, notification of workspace members) receive zero events in production today. When a brand connects Shopify, Meta, or Google Ads, the recommendation module never learns a connector is available, data-quality never triggers a post-connect check, and no notification is sent. This is a documented M2 deferral but not communicated in code as a tracked gap — the log-only stubs look like working event emission to a reviewer.

**Root Cause:** The Kafka producer for domain events was deferred to M2 per the "Event stub: M1" comment. The injection seam is correctly designed (the `emitEvent: (name, payload) => Promise<void>` function parameter), but the concrete implementation is a no-op logger in all five wiring sites.

**Fix:** Either (a) wire a real `KafkaProducer.produce(topic, payload)` into the `emitEvent` lambda in `main.ts` for M2, or (b) add a transactional outbox table (`connector_event_outbox`) written in the same transaction as the connector state change, with a relay job publishing to Redpanda — this is the safer pattern for "exactly-once" domain event delivery. Until M2 ships, add a `TODO(M2)` ticket reference and a startup warning log that domain events are suppressed.

**Priority:** P2

**Tenant Impact:** Per-brand — each brand that connects a connector misses the downstream event fan-out. Not a correctness bug today (downstream consumers are stubs), but becomes one the moment recommendation or notification modules are wired.

**Detection:** Not observable in prod today (downstream consumers are not deployed). Will surface as missing recommendation/notification triggers when those modules are wired. A test asserting that `emitEvent` was called with the correct topic and payload would catch stub-only wiring.

---

## Finding DP-5

**Title:** `RecognizeOrderCommand`, `PostReversalCommand`, and `PostFinalizationCommand` construct `PgLedgerRepository` directly — no repository interface, no DI

**Severity:** Low

**Category:** Repository pattern / dependency inversion / testability

**evidenceRef:**
- `apps/core/src/modules/measurement/internal/application/commands/RecognizeOrder.ts:17` — `this.repo = new PgLedgerRepository(pool);` inside the constructor.
- `apps/core/src/modules/measurement/internal/application/commands/PostReversal.ts:38` — same for `PostReversalCommand`.
- `apps/core/src/modules/measurement/internal/application/commands/PostReversal.ts:80` — same for `PostFinalizationCommand`.
- Contrast: `apps/core/src/modules/connector/sources/storefront/shopify/domain/repositories/IConnectorInstanceRepository.ts` — the connector sub-context defines an interface and injects it into commands.
- No `ILedgerRepository` interface exists anywhere under `apps/core/src/modules/measurement/`.

**Impact:** Unit-testing any of the three measurement commands requires a live Postgres connection — there is no interface to swap for a fake. The commands are coupled to `PgLedgerRepository`'s specific pool type, making cross-test isolation (in-memory or mock repo) impossible without monkey-patching. Contrast with `HandleOAuthCallbackCommand`, which accepts `IConnectorInstanceRepository` and is fully unit-testable. The measurement command layer is the write-critical path for all revenue recognition; coupling it hard to the concrete repo raises the cost of any schema change.

**Root Cause:** The measurement module was implemented later than the connector sub-context and followed a simpler pattern (pass `Pool`, construct repo inside). The repository interface convention from the connector module was not applied here.

**Fix:** Define `ILedgerRepository` interface in `apps/core/src/modules/measurement/internal/domain/recognition/repositories/ILedgerRepository.ts` with `insert(entry: LedgerEntry): Promise<boolean>`. Have `RecognizeOrderCommand`, `PostReversalCommand`, and `PostFinalizationCommand` accept `ILedgerRepository` as a constructor parameter. `PgLedgerRepository` implements the interface. Wire the concrete class at the composition root (`OrderEventConsumer` constructor or `main.ts`). This unblocks deterministic unit tests for the recognition policy path.

**Priority:** P3

**Tenant Impact:** No production blast radius — this is a testability and future-maintainability concern. If the ledger schema changes, all three command constructors break silently until runtime.

**Detection:** Not detectable in production; visible only in CI if a unit test suite requiring non-Postgres isolation is added. Current test suite uses live Postgres for all measurement tests.
