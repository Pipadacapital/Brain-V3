# Phase 0 — Deferred Rename Plan (kebab-case file naming)

**Status:** DEFERRED. This document is the captured work-list for a later, purely mechanical
PR-0.4 rename pass. **No renames are executed in Phase 0** (Phase 0 is non-breaking; a file rename
is import-graph churn that touches read paths, so it is staged here, not applied).

**Source of truth for the rule:** [`06-naming-violations.md`](./06-naming-violations.md) §1, and the V4
NAMING contract. **Disposition + sequencing:** [`07-code-violations.md`](./07-code-violations.md) (V-CODE-9 file
casing) and [`14-implementation-plan.md`](./14-implementation-plan.md) PR-0.4.

> The companion Phase 0 hygiene item — removing the dead `packages/identity-graph` package
> (V-CODE-10, imported nowhere) — **was executed in Phase 0** (Area D) because it is non-breaking
> (no importer to churn). Only the file renames are deferred here.

---

## The rule (V4 NAMING contract)

| Artifact | Required convention | Example |
| --- | --- | --- |
| Files | `kebab-case` | `customer-repository.ts` |
| Classes | `PascalCase` (already conformant — **do not touch**) | `CustomerRepository` |

**Architecture-wins rule:** the contract is the source of truth; the file is renamed to match.

**What changes:** only the *file name* and every *import specifier* that references it. The exported
`PascalCase` class/symbol names stay **unchanged** (classes are already conformant — `06` §2).

**Mechanical transform:** lowercase the stem and insert a hyphen at each original case boundary,
applying the acronym + interface-prefix exceptions below.

---

## Scope at capture time (this session)

Filesystem-verified count of PascalCase `.ts` source files (regex `/[A-Z][A-Za-z0-9]*\.ts$`,
excluding `node_modules/`, `dist/`, and `*.d.ts`) under `apps/` + `packages/` + `tools/`:

| Area | Count |
| --- | --- |
| `apps/core` | 75 |
| `apps/stream-worker` | 34 |
| `packages/connector-core` | 16 |
| `packages/connector-secrets` | 3 |
| **Total** | **128** |

> `06-naming-violations.md` cited **125** at audit time; the current count is **128** (natural drift
> as connector/pixel code was added). The rule and disposition are unchanged; the authoritative list
> is the full inventory at the bottom of this doc — **re-run the grep before executing** the pass, as
> the set will keep drifting until the rename lands.
>
> Regeneration command (run from repo root):
> ```sh
> find apps packages tools -type f -name '*.ts' \
>   | grep -v node_modules | grep -v '/dist/' | grep -vE '\.d\.ts$' \
>   | grep -E '/[A-Z][A-Za-z0-9]*\.ts$' | sort
> ```

---

## Acronym + interface-prefix exceptions (human-decided targets)

The naive "hyphen at every case boundary" transform mangles acronyms (e.g. `OAuth` → `o-auth`) and
the `I`-prefixed interface convention. The mechanical pass MUST apply these explicit decisions so
acronyms stay whole.

### Acronym normalization (keep acronym as one token)

| Acronym in PascalCase stem | kebab token |
| --- | --- |
| `OAuth` | `oauth` (NOT `o-auth`) |
| `GA4` / `Ga4` | `ga4` |
| `M1` | `m1` |
| `RTO` | `rto` |
| `HMAC` / `Hmac` | `hmac` |
| `DLQ` / `Dlq` | `dlq` |
| `CAPI` / `Capi` | `capi` |
| `Pg` | `pg` |
| `Aws` | `aws` |
| `API` / `Api` | `api` |

Affected `OAuth` files (must become `…-oauth-…`, not `…-o-auth-…`):

- `…/advertising/google/application/commands/HandleGoogleAdsOAuthCallbackCommand.ts` → `handle-google-ads-oauth-callback-command.ts`
- `…/advertising/google/application/commands/InitiateGoogleAdsOAuthCommand.ts` → `initiate-google-ads-oauth-command.ts`
- `…/advertising/meta/application/commands/HandleMetaOAuthCallbackCommand.ts` → `handle-meta-oauth-callback-command.ts`
- `…/advertising/meta/application/commands/InitiateMetaOAuthCommand.ts` → `initiate-meta-oauth-command.ts`
- `…/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts` → `handle-oauth-callback-command.ts`
- `…/storefront/shopify/application/commands/InitiateOAuthCommand.ts` → `initiate-oauth-command.ts`
- `…/storefront/shopify/domain/value-objects/OAuthStateNonce.ts` → `oauth-state-nonce.ts`
- `…/storefront/shopify/infrastructure/state/IOAuthStateStore.ts` → `i-oauth-state-store.ts`
- `…/storefront/shopify/infrastructure/state/InProcessOAuthStateStore.ts` → `in-process-oauth-state-store.ts`
- `…/storefront/shopify/infrastructure/state/RedisOAuthStateStore.ts` → `redis-oauth-state-store.ts`

### Interface-prefix (`I…`) decision

The codebase uses the `IFoo` interface-naming convention. The default mechanical target is
`i-foo.ts` (e.g. `ISecretsManager.ts` → `i-secrets-manager.ts`). `06` §1 offers an alternative
(`secrets-manager.contract.ts`). **DECISION FOR THE PASS:** keep the literal `i-` prefix
(`i-secrets-manager.ts`) — it is a pure mechanical transform that preserves the existing
interface-vs-impl signal and avoids a semantic `.contract.ts` re-classification (out of scope for a
casing pass). Revisit `.contract.ts` as a separate, opt-in cleanup if desired.

`I`-prefixed files (→ `i-…`):

- `packages/connector-core/src/contracts/IConnector.ts` → `i-connector.ts`
- `packages/connector-core/src/contracts/IMapper.ts` → `i-mapper.ts`
- `packages/connector-core/src/domain/repositories/IConnectorCursorRepository.ts` → `i-connector-cursor-repository.ts`
- `packages/connector-core/src/domain/repositories/IConnectorInstanceRepository.ts` → `i-connector-instance-repository.ts`
- `packages/connector-core/src/domain/repositories/IConnectorSyncStatusRepository.ts` → `i-connector-sync-status-repository.ts`
- `packages/connector-core/src/domain/repositories/IResourceBackfillStateRepository.ts` → `i-resource-backfill-state-repository.ts`
- `packages/connector-secrets/src/ISecretsManager.ts` → `i-secrets-manager.ts`
- `apps/core/.../pixel/domain/repositories/IPixelInstallationRepository.ts` → `i-pixel-installation-repository.ts`
- `apps/core/.../pixel/domain/repositories/IPixelStatusRepository.ts` → `i-pixel-status-repository.ts`
- `apps/core/.../gokwik/domain/IRtoPredictClient.ts` → `i-rto-predict-client.ts`
- `apps/core/.../shopify/domain/repositories/IConnectorCursorRepository.ts` → `i-connector-cursor-repository.ts`
- `apps/core/.../shopify/domain/repositories/IConnectorInstanceRepository.ts` → `i-connector-instance-repository.ts`
- `apps/core/.../shopify/domain/repositories/IConnectorSyncStatusRepository.ts` → `i-connector-sync-status-repository.ts`
- `apps/core/.../shopify/infrastructure/state/IOAuthStateStore.ts` → `i-oauth-state-store.ts`
- `apps/core/.../webhooks/platform/IWebhookStrategy.ts` → `i-webhook-strategy.ts`

---

## Execution procedure (for the deferred pass — DO NOT RUN IN PHASE 0)

1. **Re-generate** the inventory with the grep above (the set drifts; trust the live grep over the
   list below).
2. For each file, derive the target via the rule + the acronym/interface exceptions.
3. **macOS / case-insensitive FS:** two-step `git mv` is required so Git records the rename when only
   casing changes:
   ```sh
   git mv path/Foo.ts path/Foo.ts.tmp && git mv path/Foo.ts.tmp path/foo.ts
   ```
4. Update every import specifier referencing the old path (relative imports + any `tsconfig` path
   aliases). A codemod / `tsc`-aware rename (e.g. `ts-morph` or your IDE's "rename file") is
   preferred over hand-editing to keep the import graph correct.
5. **Verify (gate):** `pnpm typecheck` green monorepo-wide, then `pnpm test:unit` green. No behavior
   change is permitted — this is import-path churn only.
6. **Zero non-source impact:** `apps/web` is a clean consumer of REST DTOs; these files are
   backend/package internals, so the rename has **zero UI and zero API-contract impact** (`06` §1).
7. Land as its own PR (PR-0.4) separate from any logic change so the diff is reviewable as a pure
   rename.

---

## Out of scope here (tracked elsewhere)

- **Serving-object `gold_*` → `mv_*` naming** (`06` §7) — this is a HIGH-RISK *semantic* naming +
  storage-relocation (Iceberg Gold + StarRocks `mv_*` over it), parity-gated, requiring stakeholder
  sign-off. It is **not** a file-casing rename and is owned by the Gold/serving migration phases, not
  PR-0.4.
- Class / function / table / column / event / API naming — all **conformant** (`06` §2–6); nothing to
  rename.

---

## Full inventory (128 files at capture — re-run the grep before executing)

#### `apps/core`

- `apps/core/src/infrastructure/events/M1EventPublisher.ts`
- `apps/core/src/infrastructure/secrets/AwsSecretsProvider.ts`
- `apps/core/src/infrastructure/secrets/LocalSecretsProvider.ts`
- `apps/core/src/infrastructure/secrets/SecretsProvider.ts`
- `apps/core/src/modules/connector/backfill/application/commands/RequestConnectorBackfillCommand.ts`
- `apps/core/src/modules/connector/backfill/infrastructure/PgBackfillJobRepository.ts`
- `apps/core/src/modules/connector/pixel/application/commands/GetOrCreatePixelInstallationCommand.ts`
- `apps/core/src/modules/connector/pixel/application/commands/VerifyPixelCommand.ts`
- `apps/core/src/modules/connector/pixel/application/install/PixelInstaller.ts`
- `apps/core/src/modules/connector/pixel/application/queries/GetPixelHealthQuery.ts`
- `apps/core/src/modules/connector/pixel/domain/entities/PixelInstallation.ts`
- `apps/core/src/modules/connector/pixel/domain/entities/PixelStatus.ts`
- `apps/core/src/modules/connector/pixel/domain/repositories/IPixelInstallationRepository.ts`
- `apps/core/src/modules/connector/pixel/domain/repositories/IPixelStatusRepository.ts`
- `apps/core/src/modules/connector/pixel/infrastructure/repositories/PgPixelInstallationRepository.ts`
- `apps/core/src/modules/connector/pixel/infrastructure/repositories/PgPixelStatusRepository.ts`
- `apps/core/src/modules/connector/platform/ShopifyConnectorAdapter.ts`
- `apps/core/src/modules/connector/sources/advertising/application/commands/ActivateAdAccountCommand.ts`
- `apps/core/src/modules/connector/sources/advertising/google/application/commands/HandleGoogleAdsOAuthCallbackCommand.ts`
- `apps/core/src/modules/connector/sources/advertising/google/application/commands/InitiateGoogleAdsOAuthCommand.ts`
- `apps/core/src/modules/connector/sources/advertising/meta/application/commands/HandleMetaOAuthCallbackCommand.ts`
- `apps/core/src/modules/connector/sources/advertising/meta/application/commands/InitiateMetaOAuthCommand.ts`
- `apps/core/src/modules/connector/sources/analytics/ga4/Ga4ConnectorAdapter.ts`
- `apps/core/src/modules/connector/sources/checkout/gokwik/application/commands/CaptureRtoPredictCommand.ts`
- `apps/core/src/modules/connector/sources/checkout/gokwik/application/commands/ConnectGokwikCommand.ts`
- `apps/core/src/modules/connector/sources/checkout/gokwik/domain/IRtoPredictClient.ts`
- `apps/core/src/modules/connector/sources/checkout/gokwik/infrastructure/NotConnectedRtoPredictClient.ts`
- `apps/core/src/modules/connector/sources/checkout/shopflo/application/commands/ConnectShopfloCommand.ts`
- `apps/core/src/modules/connector/sources/checkout/shopflo/domain/value-objects/ShopfloHmac.ts`
- `apps/core/src/modules/connector/sources/payment/razorpay/application/commands/ConnectRazorpayCommand.ts`
- `apps/core/src/modules/connector/sources/payment/razorpay/application/commands/RotateWebhookSecretCommand.ts`
- `apps/core/src/modules/connector/sources/payment/razorpay/domain/value-objects/RazorpayHmac.ts`
- `apps/core/src/modules/connector/sources/payment/razorpay/infrastructure/RedisDedupAdapter.ts`
- `apps/core/src/modules/connector/sources/payment/razorpay/infrastructure/repositories/PgRazorpayOrderMapRepository.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/DisconnectCommand.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/InitiateOAuthCommand.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/InstallPixelCommand.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/RegisterWebhooksCommand.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/UninstallPixelCommand.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/application/install/ShopifyPixelInstaller.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/application/queries/GetConnectorStatusQuery.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/domain/ShopifyHostPolicy.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/domain/entities/ConnectorCursor.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/domain/entities/ConnectorInstance.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/domain/entities/ConnectorSyncStatus.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/domain/repositories/IConnectorCursorRepository.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/domain/repositories/IConnectorInstanceRepository.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/domain/repositories/IConnectorSyncStatusRepository.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/domain/value-objects/OAuthStateNonce.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/domain/value-objects/ShopifyHmac.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/api/ShopifyAdminClient.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorSyncStatusRepository.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/state/IOAuthStateStore.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/state/InProcessOAuthStateStore.ts`
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/state/RedisOAuthStateStore.ts`
- `apps/core/src/modules/connector/sources/storefront/woocommerce/application/commands/ConnectWooCommerceCommand.ts`
- `apps/core/src/modules/connector/sources/storefront/woocommerce/application/commands/InstallWooCommercePixelCommand.ts`
- `apps/core/src/modules/connector/sources/storefront/woocommerce/application/install/WooCommercePixelInstaller.ts`
- `apps/core/src/modules/connector/sources/storefront/woocommerce/domain/value-objects/WooCommerceHmac.ts`
- `apps/core/src/modules/connector/sources/storefront/woocommerce/infrastructure/WooCommercePixelPlugin.ts`
- `apps/core/src/modules/connector/sync/application/commands/RequestConnectorSyncCommand.ts`
- `apps/core/src/modules/connector/sync/infrastructure/PgSyncRequestRepository.ts`
- `apps/core/src/modules/connector/webhooks/infrastructure/ProviderRedisDedupAdapter.ts`
- `apps/core/src/modules/connector/webhooks/infrastructure/RawArchiveRepository.ts`
- `apps/core/src/modules/connector/webhooks/platform/HmacConfig.ts`
- `apps/core/src/modules/connector/webhooks/platform/IWebhookStrategy.ts`
- `apps/core/src/modules/connector/webhooks/platform/WebhookPipeline.ts`
- `apps/core/src/modules/connector/webhooks/strategies/GokwikWebhookStrategy.ts`
- `apps/core/src/modules/connector/webhooks/strategies/RazorpayWebhookStrategy.ts`
- `apps/core/src/modules/connector/webhooks/strategies/ShiprocketWebhookStrategy.ts`
- `apps/core/src/modules/connector/webhooks/strategies/ShopfloWebhookStrategy.ts`
- `apps/core/src/modules/connector/webhooks/strategies/ShopifyWebhookStrategy.ts`
- `apps/core/src/modules/connector/webhooks/strategies/WooCommerceWebhookStrategy.ts`

#### `apps/stream-worker`

- `apps/stream-worker/src/application/ProcessEventUseCase.ts`
- `apps/stream-worker/src/application/ProjectConsentUseCase.ts`
- `apps/stream-worker/src/application/RequestCapiDeletionUseCase.ts`
- `apps/stream-worker/src/application/ResolveIdentityUseCase.ts`
- `apps/stream-worker/src/domain/bronze/BronzeRow.ts`
- `apps/stream-worker/src/domain/bronze/DedupPolicy.ts`
- `apps/stream-worker/src/domain/identity/IdentityResolver.ts`
- `apps/stream-worker/src/domain/identity/IdentityStore.ts`
- `apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts`
- `apps/stream-worker/src/infrastructure/health/HealthServer.ts`
- `apps/stream-worker/src/infrastructure/kafka/DlqProducer.ts`
- `apps/stream-worker/src/infrastructure/kafka/DlqRedriver.ts`
- `apps/stream-worker/src/infrastructure/neo4j/Neo4jIdentityRepository.ts`
- `apps/stream-worker/src/infrastructure/pg/BackfillJobRepository.ts`
- `apps/stream-worker/src/infrastructure/pg/BronzeRepository.ts`
- `apps/stream-worker/src/infrastructure/pg/CapiDeletionRepository.ts`
- `apps/stream-worker/src/infrastructure/pg/ConnectorInstanceHealthRepository.ts`
- `apps/stream-worker/src/infrastructure/pg/ConsentRepository.ts`
- `apps/stream-worker/src/infrastructure/pg/CursorRepository.ts`
- `apps/stream-worker/src/infrastructure/pg/DlqRecordRepository.ts`
- `apps/stream-worker/src/infrastructure/pg/LeaderLock.ts`
- `apps/stream-worker/src/infrastructure/pg/StitchMapWriter.ts`
- `apps/stream-worker/src/infrastructure/pg/SyncRunRepository.ts`
- `apps/stream-worker/src/infrastructure/redis/ConnectorRateLimiter.ts`
- `apps/stream-worker/src/infrastructure/redis/RedisDedupAdapter.ts`
- `apps/stream-worker/src/infrastructure/redis/RetryCounterAdapter.ts`
- `apps/stream-worker/src/infrastructure/secrets/SaltProvider.ts`
- `apps/stream-worker/src/interfaces/consumers/BackfillOrderConsumer.ts`
- `apps/stream-worker/src/interfaces/consumers/CapiDeletionConsumer.ts`
- `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts`
- `apps/stream-worker/src/interfaces/consumers/ConsentSuppressorConsumer.ts`
- `apps/stream-worker/src/interfaces/consumers/EventBronzeBridgeConsumer.ts`
- `apps/stream-worker/src/jobs/ingestion-backfill/PgResourceBackfillStateRepository.ts`
- `apps/stream-worker/src/tests/support/InMemoryRetryCounter.ts`

#### `packages/connector-core`

- `packages/connector-core/src/contracts/Backfill.ts`
- `packages/connector-core/src/contracts/CanonicalEvent.ts`
- `packages/connector-core/src/contracts/ConnectorFactory.ts`
- `packages/connector-core/src/contracts/Dedup.ts`
- `packages/connector-core/src/contracts/IConnector.ts`
- `packages/connector-core/src/contracts/IMapper.ts`
- `packages/connector-core/src/contracts/IngestionManifest.ts`
- `packages/connector-core/src/contracts/NoLoss.ts`
- `packages/connector-core/src/domain/entities/ConnectorCursor.ts`
- `packages/connector-core/src/domain/entities/ConnectorInstance.ts`
- `packages/connector-core/src/domain/entities/ConnectorSyncStatus.ts`
- `packages/connector-core/src/domain/entities/ResourceBackfillState.ts`
- `packages/connector-core/src/domain/repositories/IConnectorCursorRepository.ts`
- `packages/connector-core/src/domain/repositories/IConnectorInstanceRepository.ts`
- `packages/connector-core/src/domain/repositories/IConnectorSyncStatusRepository.ts`
- `packages/connector-core/src/domain/repositories/IResourceBackfillStateRepository.ts`

#### `packages/connector-secrets`

- `packages/connector-secrets/src/AwsSecretsManager.ts`
- `packages/connector-secrets/src/ISecretsManager.ts`
- `packages/connector-secrets/src/LocalSecretsManager.ts`
