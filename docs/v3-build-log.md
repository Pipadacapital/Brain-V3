# v3 Identity Resolution & Customer Intelligence Platforms — build log

Single-run build per the v3 master prompt, executed against the merged **Brain V4** repo.

## Decisions (locked at start, repo-grounded)
- **Query engine: ADD Trino** over Iceberg for ad-hoc / AI / cache-miss reads (the prompt's locked stack),
  ADDITIVELY alongside the existing StarRocks `mv_*` serving (which keeps powering current dashboards).
  Rationale: user chose "introduce Trino"; done additively so no existing serving is ripped out.
- **Gap-extend, do NOT rebuild.** Both platforms already exist in V4 (identity: Neo4j SoR/ADR-0004,
  `apps/core/src/modules/identity`, `identity-core`, journey-stitch, `silver_identity_link`; intelligence:
  `db/iceberg/spark/gold/gold_customer_360|attribution_*|cohorts|customer_scores|customer_segments|executive_metrics`).
  Build ONLY the genuine missing spec pieces; conform to existing conventions (PRIME DIRECTIVE = no rework).
- **Crypto-shred: extend the existing** KMS PII-vault + per-brand salt + `erase_contact_pii_for_customer`
  to the layers that lack it (Neo4j props, Gold, Redis) — incremental, not a parallel new system.
- **Full build attempted in one run**, with every unit flagged VERIFIED vs SCAFFOLDED. Deferred strategies
  are registered-and-disabled with explicit NotImplementedYet — never silently faked.

## Conflicts found vs the prompt (repo wins, recorded per PRIME DIRECTIVE)
- Prompt says Trino is THE query engine; repo uses StarRocks → resolved: Trino added additively (user choice).
- Prompt says the two platforms "do not yet exist in full form"; repo (V4) has both substantially → resolved:
  gap-extend (user choice).
- Prompt calls the architecture "v3"; repo is "Brain V4" (dbt removed, Spark sole compute, StarRocks serving) →
  conform to V4 conventions.

(Discovery + gap analysis appended below as the workflow completes.)


---
# Gap analysis (workflow output — 7 domain agents + synthesis)

## Build plan summary

One platform build across 6 domains (Identity Resolution, Customer Intelligence Gold, Crypto-shred erasure, MCP read-only tools, Trino+gateway+cache, modes/replay/recompute) on Brain V4 (Spark-on-Iceberg sole compute, Neo4j identity SoR per ADR-0004, StarRocks brain_serving.mv_* sole serving, Zod @brain/contracts SoT, money=bigint minor+currency_code, brand_id-first tenancy, dbt removed). The dominant pattern is EXTEND-not-rebuild: every domain reports a strong existing spine (deterministic IdentityResolver, _gold_base template, per-brand PII vault, MCP_TOOLS registry, withSilverBrand seam, v4-refresh-loop, runResumableBackfill) and a thin set of missing seams. Repo conventions WIN over spec on every conflict: keep merge_id formula/RULE_VERSION byte-identical, Neo4j stays identity SoR (no parallel 15-table PG decision-log, no resurrecting dropped PG identity tables 0101), keep all 5 attribution models ENABLED, StarRocks stays sole serving (Trino is additive-only, never an app read path), brand_id always from session/principal never request body (I-S01), no float money. The keystone risks are the additive envelope extension (must stay FULL_TRANSITIVE), the union-find extraction (must preserve idempotency/replay parity), the backfill lane-isolation hole (generic ingestion-backfill currently produces to the LIVE topic — a §6.4 violation), and disciplined registered-DISABLED NotImplementedYet seams (predictive-LTV/ML+household matchers, erasure-compaction, MCP transport, segment/recfeature lookup, AI-ad-hoc-Trino) that THROW and never fake. Build order: contracts+envelope first, then the Customer Intelligence Gold template/registry foundation in parallel with identity matcher-extraction+confidence, then decision-log/graph/evidence, then dependent Gold builders, then the recompute/replay/modes loop, then the additive Trino+gateway+cache tier, then crypto-shred subject-key extension, with the MCP read-only lookup tools LAST so they bind only to finished read paths and the settled Customer360/Journey boundary.

### Customer360/Journey boundary (identity-side vs intelligence-side)

TWO SEPARATE BOUNDED CONTEXTS sharing ONLY brain_id as the join key — never merged, no cross-module import. IDENTITY-SIDE (control-plane profile): apps/core/.../identity/internal/application/queries/get-customer-360.ts reads the Neo4j identity graph under RLS (SET LOCAL ROLE brain_app + app.current_brand_id GUC, belt-and-suspenders WHERE brand_id=$1). It returns lifecycle + consent state, HASHED identifiers exposed as 12-hex PREFIX only (never raw PII, I-S02), link TIER (strong/medium), and merge/alias history — now extended with ConfidenceVerdict + evidence (identifier_combo, matcher_id, rule_version) for explainability ('WHY two profiles merged'). It carries NO money and NO aggregates. The identity-side Journey is the graph anon->brain_id stitch reconstruction (deterministic, UNAMBIGUOUS-ONLY, never guessed) living inside get-customer-360. INTELLIGENCE-SIDE (aggregate read): packages/metric-engine/src/customer-360.ts reads the gold_customer_360 mart via brain_serving.mv_gold_customer_360 over Iceberg (withSilverBrand/${BRAND_PREDICATE}, honest hasData=false). One row per (brand_id, brain_id): lifetime_value_minor (bigint minor + sibling currency_code, never blended/float), RFM/scores/health band, lifecycle rollup — NO raw or hashed identifiers. The intelligence-side Journey is the NEW gold_journey serving rollup over silver_journey/silver_touchpoint (channel/session metrics, converted flag, NO money column, NO PII), DISTINCT from the identity-side reconstruction. The boundary is enforced at the MCP layer too: customer360_lookup binds the intelligence aggregate read while identity_explainability_lookup binds the identity graph read — two separate tools, never one. Rule: identity answers 'who is this person and why are these records the same person' (hashed, graph, Neo4j SoR); intelligence answers 'what is this customer worth and how do they behave' (aggregate, money, StarRocks mv_*). Do NOT couple them; brain_id is the only thing that crosses.

### Contracts to define FIRST

- EventEnvelopeBase v1.1 (packages/contracts/src/events/m1.events.v1.ts) — ADDITIVELY widen to doc07 15-field parity: add producer, schema_id, partition_key, causation_id(nullable), ingested_at, source, sequence(nullable), consent_flags(nullable map) + schema_name as canonical alias of event_name. MUST stay additive-optional (FULL_TRANSITIVE) and NOT break the 9 M1 events; do NOT add trace_id (transport/observability concern, not a contract field). This is the keystone every other event extends — define first.
- Money primitive reuse (packages/contracts/src/api/_money.ts) — import MinorUnitsSchema (signed bigint-as-string) + MoneyRecordSchema + AttributionModelIdSchema; never define a new money type, never z.number()/float. Confidence is an INTEGER score 0-100, never blended with money.
- Identifier VO + ConfidenceVerdict (new packages/contracts/src/identity/) — Identifier VO {identifier_type, identifier_hash 64-hex, tier, brand_id} hash-only (I-S02); ConfidenceVerdict {score int 0-100, band, reasons[], matcher_id, rule_version, identifier_combo[]} mirroring Customer360Merge. Replaces the hard-coded '1.0' reader string.
- Matcher port + IdentityMatcher/IdentityGraphRepository port + IdentityDecision command (packages/contracts/src/identity/ + apps/stream-worker/src/domain/identity/matchers/Matcher.ts) — Matcher {id, version, status:'enabled'|'disabled-not-implemented', match()->ConfidenceVerdict}; IdentityGraphRepository binds the existing IdentityStore/Neo4j adapter (NOT a PG store); IdentityDecision = reversible command (Mint/Link/Merge/Unmerge/Suppress/RouteToReview) each with an inverse.
- identity.* event schemas (packages/contracts/src/events/identity.events.v1.ts) — identity.{minted,linked,merged,suppressed,review_queued}.v1 (+ doc07 resolution.requested/brain_id.minted/alias.repointed/merge.proposed/merge.committed) extending the extended envelope; TOPIC_SUFFIX/AVRO_SUBJECT consts + IDENTITY_EVENT_SCHEMAS codegen map; payloads carry hashes/brain_id/merge_id/rule_version/ConfidenceVerdict ONLY, never raw PII (C2), partition key = brand_id.
- AttributionModel port + deferred-DISABLED slot (attribution.api.v1.ts) — interface {id:AttributionModelId, computeWeights(touches)->integer 1e8 units summing exact}; reuse AttributionModelIdSchema (no new enum); keep first/last/linear/position/data_driven ENABLED, register only NOT-YET-BUILT predictive models DISABLED.
- IntelligenceJob template contract + Builder-registry contract — read_silver->transform->validate->merge_on_pk->emit_cache_event over _gold_base.run_job; registry of 12 builders {builder, enabled|DISABLED-NotImplementedYet, silver_inputs, gold_table, pk, mv_name, money_columns}; deferred (predictive-LTV/health) registered DISABLED.
- GoldDataProduct schema (packages/contracts/src/gold/) — {name gold_*, grain, owner, freshness_sla, brand_id_column, money_columns[{minor_col,currency_code_col}], serving_mv brain_serving.mv_*, trino_table? (additive)}; describes BOTH the StarRocks serving binding and the optional Trino exploration binding without changing the one-way serving rule.
- cache.invalidated + mv.refreshed + gold.mart.rewritten.v1 event schemas (cache.events.v1.ts) — brand_id-scoped, {brand_id, mart, snapshot_id, row_count, occurred_at, correlation_id}; the single invalidate-on-serving-rewrite entrypoint callable by v4-refresh-loop + future Spark-completion events (prefer per-brand serving-version bump over SCAN/DEL).
- Crypto-shred + DSAR contracts — subject_keyring/pii_erasure_log row contracts (db migration 0114, spec doc08 line248); SubjectKeyProvider/SubjectCryptoProvisioner port signatures (packages/pii-vault); ErasureResult/DSAR {erasure_id, brand_id, surrogate_brain_id, vault_shredded, steps_completed[]} counts-only never raw PII; privacy.erasure.requested event on the EXISTING collector/privacy topic family (no new envelope/topic).
- MCP contracts — extended McpToolSpec (add scope read-enum + input/output schema ref, keep access:'read' sole value, writeToolCount derived ===0); per-tool Zod input/output schemas for the 9 lookup tools (brand_id OMITTED — principal-supplied, fixes the tools.json I-S01 violation; money outputs bigint-minor string + currency_code); tool-status discriminant so DISABLED tools are first-class; prompt-registry entry {tool, content_hash, version}.
- TrinoQueryPort + AnalyticsCachePort + QueryRoute contracts (packages/metric-engine/) — TrinoScope.runScoped mirrors SilverScope reusing the SAME exported ${BRAND_PREDICATE} sentinel (fail-closed missing-sentinel throw); AnalyticsCachePort get/set-TTL/invalidate with brand_id-leading composite keys (brand_id:metric_id:params-hash:serving-version); QueryRoute enum {cache_hit, starrocks_serving, trino_adhoc(DISABLED)}; BffDeps extension cache?/trino?.
- IngestionStrategy registry + Replay/ScopedRecompute/AlgorithmVersion contracts (packages/connector-core) — {strategyId, kind:'incremental-streaming'|'historical-backfill'|deferred, enabled}; ReplayRequest {brand_id, window, algo_version, operator_actor_id, reason} RBAC-operator-only + EXPLICITLY excluded from MCP/agent tool surface; ScopedRecompute {brand_id, affected_brain_ids[], mart_subset[], cache_keys[]}; as-of identity read (brand_id, brain_id|hash, as_of_date)->versioned link row.
- Codegen + Apicurio FULL_TRANSITIVE regen (packages/contracts/scripts/codegen.ts) — emit Avro .avsc for all new identity/cache/intelligence schemas, rewire genMCP() to enumerate MCP_TOOLS (collapse the two divergent registries into one SoR), commit generated artifacts (I-E01). FINAL serialized contract step.

### Waved build order

**Wave 1** — Contracts are the SoT every runtime binds to. The envelope extension is the keystone (serialize FIRST — additive-optional only to preserve FULL_TRANSITIVE and the 9 M1 events; schema_name alias not rename; no trace_id). All identity.*/cache event schemas depend on the extended envelope. Codegen+Apicurio regen runs LAST in the wave so generated Avro/OpenAPI/MCP artifacts are committed (I-E01). Nothing downstream can compile-guard or proof-test without these.
  - Extend EventEnvelopeBase to spec parity
  - Identifier VO + ConfidenceVerdict contracts
  - IdentityDecision command + IdentityMatcher/IdentityGraphRepository port contracts
  - identity.* event contracts
  - identity-event-publisher-and-contracts (schemas)
  - AttributionModel port + deferred-DISABLED registry slot
  - IntelligenceJob template contract
  - GoldDataProduct schema (Trino-additive)
  - Cache-invalidation event contracts
  - Extend PII-vault crypto-shred surface (contract side)
  - confidence-engine-and-verdict (contract part)
  - Codegen + Apicurio FULL_TRANSITIVE regen

**Wave 2** — Customer Intelligence Gold foundation. The IntelligenceJob template (read_silver->transform->validate->merge->emit_cache_event over the EXISTING _gold_base.run_job) and the 12-builder registry are the shared shape every new Gold builder and the cache-invalidation hook depend on. Migrates the 4 standalone-main() customer marts (gold_customer_360/_scores/_segments/_cohorts) onto one template WITHOUT changing any SQL/PK/money math (parity-exact). Attribution registry formalizes the inline model loop but keeps all 5 models ENABLED (repo wins). Serialize internally — they share the base file.
  - IntelligenceJob Template Method
  - Builder registry + Factory
  - Attribution Strategy registry (keep 5 live)

**Wave 3** — Identity core, parallel to wave 2. Register the existing deterministic logic by WRAPPING IdentityResolver (not rebuilding) + 4 disabled matchers that throw NotImplementedYet. Then extract the lowest-UUID-canonical merge into an explicit batch union-find preserving byte-identical merge_id/RULE_VERSION/phone-guard/cycle-guard/medium-resolve-only (serialize after registry). ConfidenceEngine maps tiers->ConfidenceVerdict (int score, never float). BehavioralSignalExtractor surfaces shared-device evidence as CONFIDENCE INPUT ONLY (never a merge key, D-5). Graph-repo gains structured confidence+version on IDENTIFIES/ALIAS_OF, replacing the hard-coded '1.0' reader string.
  - matcher-registry-and-disabled-strategies
  - extract-union-find-into-deterministic-matcher
  - confidence-engine-and-verdict
  - behavioral-signal-extractors
  - identity-graph-repo-confidence-version

**Wave 4** — Decision/graph layer, depends on confidence (w3) + envelope/events (w1). Model outcomes as reversible Commands EXTENDING identity_audit into a decision-log projection (NOT a parallel PG schema, NOT resurrecting dropped 0101 tables; unmergeCustomer is the Merge inverse). Persist evidence (identifier_combo/signals/matcher_id/verdict) on MergeEvent/ALIAS_OF — fixes the reader's identifier_combo:[] regression — + a get-merge-explanation query so the UI shows WHY a merge happened. Project confidence/version/matcher_id additively into the Iceberg silver projections + brain_ops export (parity oracle). IdentityEventPublisher publishes minted/linked/merged/suppressed/review_queued AFTER writeOutcome (mirror M1EventPublisher trace inject).
  - identity-decision-engine-and-decision-log
  - evidence-store-and-explainability
  - silver-identity-confidence-projection
  - identity-event-publisher-and-contracts (publisher code)

**Wave 5** — Dependent Gold builders on the wave-2 template+registry. All are RUNTIME Silver folds (never a precompute table — feature_customer_daily/brain_feature are torn down). Each ships brand_id-first idempotent MERGE + a db/starrocks/mv/mv_*.sql + a metric-engine read seam (a mart isn't 'done' until its mv_* + seam exist; never a bare brain_gold read). Predictive-LTV/predictive-health registered DISABLED NotImplementedYet. gold_journey is DISTINCT from the identity-side reconstruction (boundary preserved, no money column). Refresh-loop edits serialize (single shared orchestration file).
  - gold_customer_health builder
  - LTV builder (historical live, predictive disabled)
  - gold_recommendation_features builder
  - gold_ai_features builder
  - gold_journey (intelligence-side) rollup
  - Refresh-loop wiring for new builders

**Wave 6** — Modes/replay/recompute loop, depends on identity events (w1/w4) + Gold builders (w5). FIRST close the §6.4 lane hole: point the generic ingestion-backfill at BACKFILL_TOPIC/group (reuse ProcessEventUseCase) — no third bespoke pattern. Replay is a per-tenant, RBAC-operator-only, algo_version-pinned re-emit from Bronze SoR on an isolated lane, EXPLICITLY not agent/MCP-invokable. snap_identity_link mirrors snap_order_state for as-of identity (Neo4j stays SoR). The identity.merged/split/erase facts drive a SCOPED Gold recompute for affected brain_ids + tenant-scoped cache bust (not the full cross-brand cycle). Compose into v4-refresh-loop, never a parallel orchestrator.
  - IngestionStrategy registry seam
  - Backfill generic-job lane isolation fix
  - Algorithm-version pin + migration
  - As-of versioned identity projection
  - Bulk Neo4j batch identity load for backfill lane
  - Operator-controlled replay-from-Bronze job
  - identity-change -> scoped-recompute -> cache-invalidation loop
  - identity-timeline-and-replay

**Wave 7** — Additive serving tier (consolidates the Trino + cache-invalidation units that appear across Intelligence/modes/trino-gateway/identity domains — build ONCE). TrinoQueryPort mirrors silver-deps.ts reusing the SAME ${BRAND_PREDICATE} seam (no bespoke isolation); the routing seam is cache-aside->StarRocks-for-known-metrics->Trino-only-for-ad-hoc (REPO WINS: StarRocks stays sole serving, cache-miss on a known metric goes to StarRocks not Trino). Reuse the SINGLE existing ioredis client (brand_id-leading keys, stampede guard). The Trino isolation-fuzz mutation proof MUST leak when the predicate is disabled. AI-ad-hoc-Trino registered DISABLED (the model never emits SQL — invariant preserved). Extend v4-naming-guard so Trino can never become an app serving dependency.
  - TrinoQueryPort interface (port)
  - Trino Iceberg catalog config
  - Trino docker-compose service
  - Trino client adapter
  - Analytics result-cache port + Redis adapter
  - Query-gateway routing seam
  - Cache-invalidation events on Gold rewrite
  - Cache invalidation on Gold rewrite
  - Config: Trino + cache env
  - Trino additive query tier
  - trino-identity-exploration-additive
  - Trino additive ad-hoc/as-of tier
  - Trino isolation-fuzz mutation proof
  - AI ad-hoc Trino — registered DISABLED

**Wave 8** — Crypto-shred subject-key extension, depends on identity events + recompute loop (w6) + Trino verification tier (w7). Add an ADDITIVE per-subject DEK layer (subject_keyring mirrors brand_keyring/brand_identity_salt; brand-level shred stays for whole-brand offboarding). Re-point the vault to getSubjectDek (per-subject crypto-shred; preserve per-brand fallback for legacy rows). The orchestrator runs the ordered DPDP/PDPL sequence as a deterministic consumer on the EXISTING privacy topic family (no new deployable): shred subject DEK -> tombstone to surrogate_brain_id -> scoped Gold re-projection -> erasure-aware compaction (DISABLED NotImplementedYet, don't overclaim I-S05) -> CAPI deletion -> pii_erasure_log.vault_shredded=true. Keep 0100 hard-delete as belt-and-suspenders; key-deny is the PRIMARY mechanism so the envelope survives for audit while the ledger reconciles on the surrogate.
  - subject-keyring-schema
  - subject-dek-provider
  - vault-service-rekey
  - neo4j-subject-shred
  - crypto-shred-erasure-orchestrator
  - dsar-intake-and-erasure-event
  - gold-surrogate-reprojection
  - redis-pii-shred-enumeration
  - erasure-aware-iceberg-compaction
  - trino-erasure-verification

**Wave 9** — MCP read-only tools LAST so they bind only to finished read paths and the settled Customer360/Journey boundary. GAP-EXTEND the existing MCP_TOOLS (the documented SoR) — do not create a new registry; collapse the divergent contracts genMCP onto MCP_TOOLS. Register the 9 lookup tools; segment_lookup/recfeature_lookup register DISABLED NotImplementedYet (no V4 backing read / runtime-folded). Dispatch executes only the EXISTING analytics/identity read use-cases (brand_id from MCP principal NEVER an arg — fixes the tools.json I-S01 violation; money bigint-minor+currency_code; honest-empty mirrors FIGURE_NONE). The proof harness replaces the StubMcpServer with REAL dispatch and asserts writeToolCount===0, no writer reachable from any tool body, no replay/idempotency invoke, disabled tools fail-closed. MCP transport/key-store + AI-Trino stay DISABLED (deferred to M3, never faked). MCP read stays on the metric-engine sole-read-path over mv_* — Trino is exploration only, not the MCP path.
  - Extend McpToolSpec + register the 9 named lookup tools (registry SoR)
  - Per-tool input/output Zod schemas + unify contracts codegen onto MCP_TOOLS
  - MCP tool dispatch/bodies over the existing sole read path
  - Prompt Registry: per-tool registered prompts + content-hash versioning
  - Proof harness: no-write / no-Decision-Log / no-control-plane / no-replay + real brand-scope
  - MCP transport + key principal (DEFERRED-registered)
  - Trino additive binding (flag only — not on MCP path)

### Biggest risks

- ENVELOPE BREAKAGE (wave 1): widening EventEnvelopeBase risks breaking FULL_TRANSITIVE and the 9 live M1 events. Mitigate: additive-optional fields ONLY, add schema_name as an alias (never rename event_name), do NOT add trace_id (transport concern), Apicurio compatibility gate must pass before any consumer change.
- UNION-FIND PARITY REGRESSION (extract-union-find-into-deterministic-matcher): refactoring the per-event lowest-UUID merge into a batch union-find can silently change merge_id, RULE_VERSION, phone-guard/cycle-guard behavior, or medium-resolve-only semantics — breaking idempotency/replay parity (same hash must yield same brain_id forever). Mitigate: WRAP not rebuild, add an order-independence property test, assert byte-identical merge_id against pinned vectors before cutover.
- BACKFILL LANE-ISOLATION HOLE (Backfill generic-job lane isolation fix): the V4-flagship generic ingestion-backfill currently produces to the LIVE collector topic, so a 24-month backfill CAN induce live-lane lag — a direct §6.4 violation and a production incident risk. Mitigate: this is a near-term must-fix onto the existing isolated BACKFILL_TOPIC/group; pair with the bulk Neo4j UNWIND load so backfill doesn't hammer the per-event live resolver.
- TRINO BECOMING AN ACCIDENTAL SERVING DEPENDENCY: across 4 domains Trino is requested; if any app/BFF/metric-engine read drifts onto Trino it violates the CLAUDE.md sole-serving rule and the sub-second SLA. Mitigate: StarRocks mv_* stays sole serving (cache-miss on a known metric -> StarRocks, NOT Trino), Trino read-only over Iceberg, extend v4-naming-guard to fail any Trino app-serving ref, ship the Trino ${BRAND_PREDICATE} isolation-fuzz mutation proof before it serves tenant data.
- CRYPTO-SHRED KEY-GRAIN + OVERCLAIM (wave 8): introducing per-subject DEK alongside legacy per-brand rows risks unreadable legacy data or a half-migrated vault; and claiming I-S05 conformance while erasure-aware Iceberg compaction is unbuilt would be dishonest (a shredded subject could be resurrected from old snapshots). Mitigate: preserve per-brand fallback by key_version, keep 0100 hard-delete as belt-and-suspenders, register erasure-compaction DISABLED NotImplementedYet, prove with the Trino erasure_verification.sql cross-store query.
- SCOPED-RECOMPUTE CORRECTNESS (identity-change -> scoped-recompute -> cache-invalidation loop): a missed identity.merged/split/erase fact, or a recompute that touches the wrong brain_id set, leaves derived Gold/cache stale or corrupts another tenant's mart. Cross-cutting and serialization-sensitive. Mitigate: deterministic affected-brain_id mapping, idempotent targeted re-run, assert non-affected marts untouched, and wire the erase event into the SAME loop.
- MCP READ-ONLY + I-S01 VIOLATION (wave 9): the existing tools.json puts brand_id as an INPUT arg (I-S01 violation), there are two divergent registries, and the spec implies an AI->Trino SQL path that violates the no-SQL-from-model invariant. Mitigate: brand_id from the MCP principal never an arg, collapse onto MCP_TOOLS as sole SoR, register AI-Trino + MCP transport DISABLED, and make the proof harness assert no writer/replay path is reachable from any tool body (the test IS the canary — removing it must fail CI).
- DISABLED-STRATEGY HONESTY DRIFT: ~10 registered-DISABLED seams (predictive-LTV, ML/household/cross-device matchers, erasure-compaction, MCP transport+key store, segment/recfeature lookup, AI-ad-hoc-Trino, deferred ingestion strategies). Any one quietly returning a fake/empty result instead of throwing NotImplementedYet erodes trust and ships a lie. Mitigate: every disabled path THROWS, surfaced honestly, covered by a fail-closed test.
- CACHE-KEY CROSS-TENANT COLLISION (P0): the new analytics result-cache keys must be brand_id-leading + serving-version-bumped; a collision serves brand A's numbers to brand B. Mitigate: brand_id:metric_id:params-hash:serving-version composite by construction, reuse the single ioredis client, version-bump invalidation (no SCAN/DEL races).

### Proof tests

- ORDER-INDEPENDENCE (order-independence.live.test.ts + db/iceberg/spark/parity/order_independence_check.py + DeterministicUnionFindMatcher property test): drive ONE shared fixture (identify+order+touchpoint+merge events, brand-scoped, money bigint+currency_code) twice through the SAME ProcessEventUseCase->Bronze->Spark Silver/Gold — (a) live/sequential, (b) shuffled/reverse 'backfill' order — and assert identical Neo4j graph projection (silver_identity_link, brain_id sets equal) AND identical Gold marts (Σ exact). Plus a resolver property test that union-find produces order-independent canonical components within a batch.
- REPLAY DETERMINISM (Operator-controlled replay-from-Bronze + reproduceAnswer): re-emit a brand's Bronze window and assert same identifier hash -> same brain_id (C-3) with byte-identical merge_id; assert the algo_version-pinned run reproduces every historical number against its pinned model_version + data snapshot; assert ask-brain reproduces byte-identical via snapshot_id.
- SCOPED RECOMPUTE (identity-change -> scoped-recompute -> cache-invalidation loop test): publish identity.merged/split/erase facts and assert ONLY the affected brain_ids' customer_360/attribution marts are re-run + the tenant-scoped Redis cache is busted (version-bump), while non-affected marts and other brands are provably untouched.
- AS-OF VERSIONED IDENTITY (snap_identity_link test via Trino time-travel): query 'identity as-of date D' against the versioned projection (valid_from/valid_to/lifecycle_state from Neo4j ALIAS_OF/MergeEvent) and assert it returns the correct historical link version, not current state.
- CRYPTO-SHRED ERASURE (crypto-shred-erasure.e2e.test.ts): request erasure -> shred the subject DEK -> assert contact_pii is undecryptable + the Trino erasure_verification.sql (brand-predicate scoped, federated over Iceberg Bronze/Silver/Gold) returns 0 readable identifying rows + pii_erasure_log.vault_shredded=true + the money/ledger row SURVIVES reconciled on surrogate_brain_id (envelope survives, key dies).
- AI READ-ONLY (tools/isolation-fuzz/src/mcp-readonly-proof.test.ts): assert writeToolCount===0 + FORBIDDEN_TOOL_NAME_SUBSTRINGS over the expanded MCP_TOOLS; prove no identity-graph/Gold/control-plane/Decision-Log writer is reachable from ANY tool body; prove no replay/idempotency-key invoke path exists (tools are pure reads); assert disabled tools fail-closed NotImplementedYet; assert the model never emits SQL and never produces a number (coerceResolverResult BANNED_KEYS). The test IS the canary — removing the no-write/scope check must fail CI.
- TENANT ISOLATION (tools/isolation-fuzz/src/trino-brand-predicate.test.ts + the MCP brand-A->brand-B negative control + existing silver-order-state.test.ts): disabling the Trino port's ${BRAND_PREDICATE} injection MUST leak brand-B rows (inert-guard fails loud); the MCP brand-A principal querying brand-B must fail-closed; assert no analytics cache key can collide cross-brand (brand_id-leading composite, a collision is a P0).
- MONETARY PRECISION 2dp+3dp (parity oracle Iceberg vs StarRocks export + attribution weight test): assert all money stays bigint minor + sibling currency_code, never blended across currencies, never float; per-currency decimals honored (INR 2dp, KWD/BHD 3dp); attribution weights are integer 1e8 units summing EXACTLY to total via largest-remainder; gold_customer_360/LTV/health marts pass the parity oracle (Σ exact) between Iceberg and the StarRocks serving export.

## Per-domain gaps + build units

### Identity Resolution Platform (Section E)

**Gaps vs spec:**
- MATCHER REGISTRY + DISABLED STRATEGIES: no registry. Deterministic matcher is hard-wired in IdentityResolver.resolve(). Spec wants probabilistic/ML/household/cross-device matchers REGISTERED-DISABLED as NotImplementedYet (never faked) — no abstraction or disabled-strategy seam exists.
- GENERALIZED ORDER-INDEPENDENT UNION-FIND: resolver merges per-event (0/1/≥2 brain_ids), order-independent within one event but NOT a batch union-find producing canonical connected components over the whole identifier graph. Spec wants an explicit union-find matcher provably order-independent across a batch/replay.
- CONFIDENCE ENGINE + ConfidenceVerdict: none. Confidence is implicit today (tier strong/medium + hard-coded '1.0'/'high' string in the reader). No structured score/band/reasons object travels with a resolution/merge.
- BEHAVIORAL SIGNAL EXTRACTORS (identity-side): only PII/id extractors exist. Behavioral events flow to journey/touchpoint but are not extracted as identity confidence signals.
- DECISION ENGINE + DECISION LOG (Command, reversible): no Command-pattern reversible identity decision engine. identity_audit (append-only) + MergeReview (queue) exist but not a structured reversible Decision Log of identity Commands with inverse/compensation. (Existing decision_log 0044/0076 = recommendation domain, different context.)
- EVIDENCE STORE: evidence is loose JSON only (MergeReview.evidence blob, identity_audit.detail jsonb). No first-class evidence store; the reader even returns Customer360Merge.identifier_combo as [] (lost).
- IDENTITY TIMELINE + REPLAY: identity_audit is flat; no per-brain_id timeline projection/query and no productized replay (--replay-from-bronze referenced but unbuilt as an operation).
- EXPLAINABILITY: no surface for WHY two profiles merged (identifier/rule/confidence). Partial data (merge_id, rule_version) exists but is not assembled or surfaced.
- IdentityGraphRepository confidence+version: IdentityStore/Neo4jIdentityRepository lack structured confidence (numeric) + matcher/schema version on edges/nodes; only rule_version + tier present.
- identity.* PUBLISHER: identity outcomes (minted/linked/merged/suppressed/review_queued) are not published as events. M1 events exist for auth/connector/pixel (m1.events.v1.ts) but no identity.*.v1 topic/schema and no stream-worker publisher.
- TRINO (additive): no Trino catalog/binding for ad-hoc + federated identity-graph exploration over silver_identity_alias / brain_ops.silver_identity_link. StarRocks serving stays; Trino is net-new additive.

**Build units:**
- `matcher-registry-and-disabled-strategies` (new, parallel=True) — Matcher port {id,version,status:'enabled'|'disabled-not-implemented',match(...)}. Register existing deterministic logic by WRAPPING IdentityResolver (not rebuilding). Register the 4 deferred matchers DISABLED that throw NotImplementedYet on invoke — never faked. Pure domain, no IO.
    - apps/stream-worker/src/domain/identity/matchers/Matcher.ts
    - apps/stream-worker/src/domain/identity/matchers/MatcherRegistry.ts
    - apps/stream-worker/src/domain/identity/matchers/DeterministicUnionFindMatcher.ts
    - apps/stream-worker/src/domain/identity/matchers/disabled/ProbabilisticMatcher.ts
    - apps/stream-worker/src/domain/identity/matchers/disabled/MlMatcher.ts
    - apps/stream-worker/src/domain/identity/matchers/disabled/HouseholdMatcher.ts
- `extract-union-find-into-deterministic-matcher` (extend, parallel=False) — Refactor lowest-UUID-canonical merge into an explicit union-find component builder, preserving exact behavior (merge_id formula, RULE_VERSION, phone-guard, cycle-guard, medium resolve-only). Add an order-independence property test. Depends on matcher-registry. Repo wins on byte-identical idempotency/replay.
    - apps/stream-worker/src/domain/identity/IdentityResolver.ts
    - apps/stream-worker/src/domain/identity/matchers/DeterministicUnionFindMatcher.ts
- `confidence-engine-and-verdict` (new, parallel=True) — Pure ConfidenceEngine → ConfidenceVerdict {score(int 0-100, never float/money), band, reasons[], matcher_id, rule_version}. Map existing tiers + phone-guard state deterministically. Add ConfidenceVerdict Zod schema to the contracts SoT. @effort(deterministic).
    - apps/stream-worker/src/domain/identity/confidence/ConfidenceEngine.ts
    - apps/stream-worker/src/domain/identity/confidence/ConfidenceVerdict.ts
    - packages/contracts/src/api/identity.api.v1.ts
- `behavioral-signal-extractors` (extend, parallel=True) — Lift inline per-type extraction into named IdentifierExtractor modules; ADD BehavioralSignalExtractor surfacing shared-device/behavioral evidence as CONFIDENCE INPUT ONLY (never a deterministic merge key, D-5). Preserve hashed-at-boundary; no raw PII downstream.
    - apps/stream-worker/src/application/ResolveIdentityUseCase.ts
    - apps/stream-worker/src/domain/identity/extractors/IdentifierExtractor.ts
    - apps/stream-worker/src/domain/identity/extractors/BehavioralSignalExtractor.ts
- `identity-decision-engine-and-decision-log` (extend, parallel=False) — Model outcomes as reversible Commands (Mint/Link/Merge/Unmerge/Suppress/RouteToReview), each with an inverse. EXTEND identity_audit (do NOT add a parallel 15-table PG schema duplicating it / resurrecting dropped PG identity tables 0101) into a decision-log projection capturing command+inverse+ConfidenceVerdict+matcher_id. unmergeCustomer is the Merge inverse. PG operational-only; Neo4j stays SoR.
    - apps/stream-worker/src/domain/identity/decision/IdentityCommand.ts
    - apps/stream-worker/src/domain/identity/decision/DecisionEngine.ts
    - apps/stream-worker/src/infrastructure/neo4j/Neo4jIdentityRepository.ts
    - db/migrations/NNNN_identity_decision_log.sql
- `evidence-store-and-explainability` (extend, parallel=False) — Persist evidence (identifier_combo, signals, matcher_id, ConfidenceVerdict) on MergeEvent/ALIAS_OF instead of lossy []/JSON. Fix the reader's identifier_combo:[] regression. Add get-merge-explanation query + Explainability DTO so the UI shows WHY a merge happened. Depends on confidence + decision-log.
    - apps/stream-worker/src/infrastructure/neo4j/Neo4jIdentityRepository.ts
    - apps/core/src/modules/identity/internal/infrastructure/neo4j-identity-reader.ts
    - apps/core/src/modules/identity/internal/application/queries/get-merge-explanation.ts
    - packages/contracts/src/api/identity.api.v1.ts
- `identity-graph-repo-confidence-version` (extend, parallel=False) — Add structured confidence (int score) + version (matcher/schema version) to IDENTIFIES + ALIAS_OF + Customer in the port + both Neo4j read/write adapters. Keep brand_id-first app-layer isolation + idempotent MERGE; replace the hard-coded '1.0' confidence string in the reader.
    - apps/stream-worker/src/domain/identity/IdentityStore.ts
    - apps/stream-worker/src/infrastructure/neo4j/Neo4jIdentityRepository.ts
    - apps/core/src/modules/identity/internal/infrastructure/neo4j-identity-reader.ts
- `identity-timeline-and-replay` (extend, parallel=True) — Per-brain_id timeline query over identity_audit + decision-log + graph history (brand_id GUC scoping) + UI page. Productize --replay-from-bronze as a bounded idempotent replay (same hash → same brain_id, C-3). Every build ships UI.
    - apps/core/src/modules/identity/internal/application/queries/get-identity-timeline.ts
    - apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts
    - apps/web/app/(dashboard)/identity/timeline/page.tsx
    - apps/web/app/(dashboard)/identity/timeline/timeline-content.tsx
- `identity-event-publisher-and-contracts` (new, parallel=True) — identity.{minted,linked,merged,suppressed,review_queued}.v1 Zod schemas + TOPIC_SUFFIX consts (mirror m1.events.v1.ts) + stream-worker IdentityEventPublisher (mirror core M1EventPublisher trace-context inject). Publish AFTER writeOutcome. Payloads carry hashes/brain_id + ConfidenceVerdict only, NEVER raw PII. NODE_ENV-prefixed topics, partition key = brand_id.
    - packages/contracts/src/events/identity.events.v1.ts
    - apps/stream-worker/src/infrastructure/events/IdentityEventPublisher.ts
    - apps/stream-worker/src/application/ResolveIdentityUseCase.ts
- `silver-identity-confidence-projection` (extend, parallel=True) — Project new confidence + version + matcher_id columns from Neo4j into the Iceberg silver projections + brain_ops StarRocks export, additively (new nullable cols, PK unchanged, bucket(brand_id) preserved). Run via existing run-silver-*.sh + parity oracle. Serving stays brain_serving.mv_* — no bare brain_silver reads.
    - db/iceberg/spark/silver/silver_identity_alias.py
    - db/iceberg/spark/silver/silver_customer_identity.py
    - apps/stream-worker/src/jobs/identity-export/run.ts
- `trino-identity-exploration-additive` (new, parallel=True) — Add Trino additively for ad-hoc + federated identity-graph exploration over brain_silver.silver_identity_alias / brain_ops.silver_identity_link. StarRocks mv_* serving UNCHANGED (app/BFF/metric-engine read only mv_*). brand_id tenant-predicate enforced; bytes-scanned is the cost. Net-new — bind via an ADR.
    - infra/trino/catalog/iceberg.properties
    - docs/architecture/v4/identity-trino-exploration.md

**Conventions to match:** PORTS/ADAPTERS (DDD modular monolith): pure domain in apps/stream-worker/src/domain/identity/ (no IO — IdentityResolver), a domain port (IdentityStore), Neo4j adapter in infrastructure/neo4j/, orchestrated by an application use-case (ResolveIdentityUseCase); core's read/admin side mirrors this behind an IdentityReader DIP port and the identity/index.ts public barrel (only index.ts importable — ESLint boundary). SPARK JOB SHAPE: db/iceberg/spark/{silver,gold}/*.py via _silver_base.py (ensure_silver_table/merge_on_pk/run_job) / _gold_base.py; brand_id is the FIRST column + bucket(N,brand_id) hid

### Customer Intelligence Platform (Section F — intelligence-builders): the Spark-on-Iceberg Gold mart layer (db/iceberg/spark/gold/*) that folds Silver into serving Gold marts, plus the metric-engine read seams and the identity↔intelligence Customer360/Journey boundary.

**Gaps vs spec:**
- No unified IntelligenceJob Template Method: there are TWO partial bases — _gold_base.run_job (used by the 10 NEW gap marts) AND per-file standalone main() (the customer marts: gold_customer_360/_scores/_segments/_cohorts call build_spark()+materialize() directly, NOT run_job). No abstract template enforcing read_silver→transform→validate→merge→emit-cache-event across all builders.
- No Builder/Factory/Strategy abstraction: every mart is a hand-written file; there is no registry/factory enumerating the 12 builders, and no Strategy interface for attribution models (the 5 models are an inline loop in gold_attribution_credit._compute_brand_rows over _attribution_math constants).
- No registered-DISABLED NotImplementedYet seam: there is nowhere to register a deferred strategy as explicitly disabled. The spec's deferred set (predictive-LTV, predictive customer-health, AI features, recommendation features) is simply absent rather than registered-disabled.
- Missing builder: Customer Health — no gold_customer_health mart (churn_risk exists as a column on gold_customer_scores but there is no health builder/score composite).
- Missing builder: Recommendation Features — no gold_recommendation_features mart (must be a RUNTIME Silver fold, never a precompute, per the retired feature_customer_daily).
- Missing builder: AI Features — no gold_ai_features mart.
- Missing builder: LTV — historical LTV is carried as lifetime_value_minor but there is no dedicated LTV builder/mart, and predictive-LTV is neither built nor registered-disabled.
- Missing intelligence-side Journey Gold rollup: silver_journey is the entity grain but there is no gold_journey serving mart distinct from the identity-side journey reconstruction.
- No cache-invalidation events on Gold rewrite: the only freshness mechanism is the refresh loop's StarRocks REFRESH MATERIALIZED VIEW WITH SYNC MODE — no Kafka/Redis event (e.g. gold.mart.rewritten.v1) is emitted when a Gold mart is MERGEd, so app/BFF Redis caches cannot bust on rewrite. Grep found zero cache-invalidation emission in the Spark/gold path.
- Trino absent entirely: no Trino coordinator/catalog/compose binding. Spec decision = ADD Trino additively (interactive/federated ad-hoc tier) while keeping StarRocks mv_* serving.
- Crypto-shred not extended into PII-vault for the intelligence path (packages/pii-vault exists; spec wants it EXTENDED for crypto-shred) — secondary to this domain but on the decision list.

**Build units:**
- `IntelligenceJob Template Method` (extend, parallel=False) — Add an IntelligenceJob template (steps: read_silver → transform → validate → merge_on_pk → emit_cache_event) onto the EXISTING _gold_base.run_job rather than a new framework. Migrate the four standalone-main() customer marts onto it so all builders share one shape. Touches the shared base — serialize against unit 9. Do NOT change any mart's SQL/PK/money math (parity-exact must hold).
    - db/iceberg/spark/gold/_gold_base.py
    - db/iceberg/spark/gold/gold_customer_360.py
    - db/iceberg/spark/gold/gold_customer_scores.py
    - db/iceberg/spark/gold/gold_customer_segments.py
    - db/iceberg/spark/gold/gold_cohorts.py
- `Builder registry + Factory` (new, parallel=True) — Declarative map of the 12 builders → (module, enabled|DISABLED-NotImplementedYet, silver_inputs, pk, mv_name). Registered-DISABLED entries (predictive-LTV, predictive customer-health if added) raise NotImplementedYet, never emit faked rows. Pure additive metadata module; no mart behavior change.
    - db/iceberg/spark/gold/_builder_registry.py
- `Attribution Strategy registry (keep 5 live)` (extend, parallel=True) — Formalize the inline model loop into a Strategy registry but KEEP first/last/linear/position/data_driven ENABLED — repo wins (they are genuinely built + parity-tested). Only NOT-YET-BUILT predictive strategies get registered-DISABLED. No change to weight/credit_id/money math.
    - db/iceberg/spark/gold/_attribution_math.py
    - db/iceberg/spark/gold/gold_attribution_credit.py
- `gold_customer_health builder` (new, parallel=True) — Runtime fold from silver_customer + gold_customer_scores (recency/churn_risk) + engagement signal. Deterministic composite health band live; predictive-health registered-DISABLED. brand_id-first, mv_* + metric-engine read seam.
    - db/iceberg/spark/gold/gold_customer_health.py
    - db/starrocks/mv/mv_gold_customer_health.sql
    - packages/metric-engine/src/customer-health.ts
- `gold_recommendation_features builder` (new, parallel=True) — RUNTIME Silver fold ONLY — never a precompute table (feature_customer_daily/brain_feature are torn down). Honors the V4 features-are-runtime invariant; brand_id-first, idempotent MERGE on PK.
    - db/iceberg/spark/gold/gold_recommendation_features.py
    - db/starrocks/mv/mv_gold_recommendation_features.sql
- `gold_ai_features builder` (new, parallel=True) — Runtime-folded AI feature mart from the Silver spine. No model precompute. brand_id-scoped.
    - db/iceberg/spark/gold/gold_ai_features.py
    - db/starrocks/mv/mv_gold_ai_features.sql
- `LTV builder (historical live, predictive disabled)` (new, parallel=True) — Historical LTV mart (bigint minor + currency_code, per-currency never blended) folded from silver_customer/silver_order_state. Predictive-LTV strategy registered-DISABLED NotImplementedYet in the builder registry — never faked.
    - db/iceberg/spark/gold/gold_ltv.py
    - db/starrocks/mv/mv_gold_ltv.sql
- `gold_journey (intelligence-side) rollup` (new, parallel=True) — Serving journey rollup over silver_journey/silver_touchpoint, DISTINCT from the identity-side get-customer-360 reconstruction (boundary preserved). No money column; deterministic channel/session metrics only.
    - db/iceberg/spark/gold/gold_journey.py
    - db/starrocks/mv/mv_gold_journey.sql
- `Cache-invalidation events on Gold rewrite` (extend, parallel=False) — Emit a gold.mart.rewritten.v1 event (brand_id, mart, snapshot_id, row_count, occurred_at) from merge_on_pk/run_job after a successful MERGE; app-side consumer busts the tenant-scoped Redis cache. Additive to the existing mv SYNC refresh. Shares _gold_base with unit 1 — serialize.
    - db/iceberg/spark/gold/_gold_base.py
    - db/iceberg/spark/job_log.py
    - tools/dev/v4-refresh-loop.sh
    - apps/core/src/modules/frontend-api/internal/bff.routes.ts
- `Trino additive query tier` (new, parallel=True) — Add Trino coordinator over the same Iceberg REST/MinIO catalogs as the ad-hoc/federated tier; StarRocks mv_* stays the sub-second serving path (one-way rule unchanged). Tenant predicate (brand_id) enforced at the query seam. Bind via lakehouse-query-trino conventions.
    - docker-compose.yml
    - db/trino/catalog/iceberg.properties
    - db/trino/README.md
- `Refresh-loop wiring for new builders` (extend, parallel=False) — Sequence the new gold_customer_health/recommendation_features/ai_features/ltv/journey run scripts + their mv refreshes into the dependency-ordered loop (after their Silver inputs). Single shared orchestration file — serialize all loop edits.
    - tools/dev/v4-refresh-loop.sh

**Conventions to match:** ["Spark Gold job shape (match gold_customer_360.py / gold_executive_metrics.py): module docstring stating the exact transform + parity source; from __future__ import annotations (Python 3.8 image); sys.path insert to import iceberg_base/_gold_base; _COLUMNS contract with brand_id FIRST and money as bigint minor + currency_code; _read_silver helper with graceful-absent probe (SystemExit on required, None on optional); materialize/build(spark)->fqtn returning (fqtn, rows); idempotent MERGE on PK (WHEN MATCHED UPDATE / WHEN NOT MATCHED INSERT); main() emitting job_log with V4_CORRELATION_ID.", "T

### Crypto-shredding (Rule B.9) — per-data-subject envelope encryption + DPDP/PDPL right-to-erasure across Bronze/Silver/Neo4j/Gold/Redis, extending the existing per-brand PII vault.

**Gaps vs spec:**
- KEY GRAIN MISMATCH (core B.9 gap): crypto-shred today is PER-BRAND only (brand_keyring.is_active=false shreds the WHOLE brand's PII). Per-SUBJECT erasure is a hard DELETE of contact_pii rows, NOT crypto-shred. Spec B.9 wants a PER-DATA-SUBJECT envelope key so destroying ONE subject's key renders only that subject's PII unreadable everywhere, while non-PII + the envelope (row/skeleton) survive. No per-subject DEK layer exists.
- No pii_erasure_log table (spec doc 08 line 248: erasure_id, brand_id, brain_id, surrogate_brain_id, request_source, requested_at, erased_at, vault_shredded). I-S05 gates on vault_shredded=true; absent.
- No erasure ORCHESTRATOR sequence. Current erase is a single synchronous PG+Neo4j op; spec wants the ordered sequence: destroy subject key -> tombstone customer to surrogate_brain_id -> re-project marts -> erasure-aware Iceberg compaction -> CAPI deletion -> vault_shredded=true, as a stream-worker consumer off privacy.erasure on the existing topic family.
- No surrogate_brain_id re-pointing. eraseCustomer sets lifecycle_state='erased' but does NOT re-key the customer to an opaque surrogate; ledger/audit/Gold rows still carry the real brain_id (spec: math reconciles on surrogate, person forgotten).
- Neo4j gap: identifier HASH values persist on Identifier nodes after erase (edges only set is_active=false). Spec wants subject-key destruction to render Neo4j identifier props unreadable/removed; no per-subject envelope of graph PII props and no surrogate re-point of the Customer node id.
- Gold gap: no erasure path over db/iceberg/spark/gold/* marts (gold_customer_360, gold_customer_scores, gold_customer_segments carry brain_id). No surrogate re-projection job; erased subjects keep identifying join keys in Gold/serving MVs.
- Bronze gap: raw Bronze Iceberg event hashes persist; no erasure-aware Iceberg compaction job to rewrite partitions so a shredded subject is not resurrected from old snapshots (I-S05 step 4).
- Redis gap: per-subject PII/identifier material in Redis (dedup keys, OAuth/identity caches) is not enumerated or shredded on erasure; only per-brand DEK cache invalidation exists (KmsVaultKeyProvider.invalidate(brandId)).
- No DSAR intake API / privacy.erasure.requested event. Erasure is only reachable via internal identity.routes; no data-subject-facing request intake, no privacy.erasure event on the topic family to drive the orchestrator.
- CAPI deletion exists but is NOT wired into an erasure orchestrator sequence (it fires independently off consent withdrawal; the erasure flow does not invoke it as step 5).
- Trino absent entirely. No federated erasure-VERIFICATION query path to prove (across Iceberg Bronze/Silver/Gold) that no readable subject PII survives post-shred — the I-S05 integration-test assertion has no cross-store query engine.
- erase-customer.ts docstring references the dropped 0038 erase_customer fn while the live path uses 0100 — stale doc, confirm single source of truth before extending.

**Build units:**
- `subject-keyring-schema` (new, parallel=True) — Per-data-subject DEK layer (nested envelope: subject DEK wraps PII, itself KMS-wrapped under the same CMK as brand_keyring). Add tenancy.subject_keyring(brand_id, brain_id, kms_key_id, wrapped_subject_dek_b64, key_version, is_active, created_at, shredded_at; PK(brand_id,brain_id)) FORCE-RLS, brain_app SELECT-only — MIRROR brand_keyring/brand_identity_salt exactly. Add pii_erasure_log(erasure_id uuid PK, brand_id, brain_id, surrogate_brain_id uuid, request_source, requested_at, erased_at, vault_shredded bool) per spec line 248. Add SECURITY DEFINER provision_subject_dek + get_subject_keyring + shred_subject_dek(brand,brain)->UPDATE is_active=false,shredded_at=now() (NOT delete: envelope survives). Reuse 0109 DO-block assertion pattern.
    - db/migrations/0114_subject_keyring_and_pii_erasure_log.sql
- `subject-dek-provider` (extend, parallel=False) — EXTEND the VaultKeyProvider port (do NOT rebuild): add SubjectKeyProvider interface getSubjectDek(brandId, brainId, keyVersion?) + KmsSubjectKeyProvider (reads get_subject_keyring, KMS-unwraps subject DEK, in-memory cache keyed (brand,brain), fails CLOSED on is_active=false, invalidate(brandId,brainId)). Add SubjectCryptoProvisioner.provision(brandId, brainId) (random 32B subject DEK, KMS-wrap, provision_subject_dek, idempotent). Keep brand-DEK providers intact (deferred/back-compat). Mirror KmsVaultKeyProvider/BrandCryptoProvisioner shape verbatim.
    - packages/pii-vault/src/index.ts
- `vault-service-rekey` (extend, parallel=False) — Re-point put()/getMatchPii() to getSubjectDek(brandId, brainId) instead of getDek(brandId), so a contact_pii row is encrypted under its SUBJECT key (per-subject crypto-shred). Provision the subject DEK lazily on first put. Repo unchanged structurally (already per (brand,brain)); add subject key provisioning on write. Depends on subject-dek-provider. PRESERVE the per-brand path as fallback for legacy rows by key_version/keyring lookup.
    - apps/core/src/modules/identity/internal/application/contact-pii-vault.service.ts
    - apps/core/src/modules/identity/internal/infrastructure/contact-pii-vault.repository.ts
- `crypto-shred-erasure-orchestrator` (new, parallel=True) — The ordered DPDP/PDPL sequence as a deterministic (@effort deterministic) stream-worker consumer off the existing collector/privacy topic family (NO new deployable, NO new topic — mirror RequestCapiDeletionUseCase). Steps: (1) shred_subject_dek (key-deny -> contact_pii unreadable) (2) tombstone customer -> surrogate_brain_id (Neo4j + ledger re-point handoff) (3) enqueue Gold re-projection (4) enqueue erasure-aware compaction (deferred-disabled, see below) (5) invoke RequestCapiDeletion (6) write pii_erasure_log.vault_shredded=true. Idempotent ON CONFLICT. Reuse SaltProvider + CapiDeletionRepository.
    - apps/stream-worker/src/application/EraseSubjectUseCase.ts
    - apps/stream-worker/src/infrastructure/pg/PiiErasureLogRepository.ts
- `dsar-intake-and-erasure-event` (extend, parallel=False) — Add a DSAR/right-to-erasure intake endpoint (brand-session-scoped, never client-supplied brand_id) that emits a privacy.erasure.requested event onto the existing topic family (consumed by the orchestrator) and writes the requested pii_erasure_log row. EXTEND erase-customer.ts to delegate to the async orchestrator rather than the synchronous one-shot delete; keep the synchronous path for the Shopify GDPR-redact webhook. Fix the stale 0038 docstring.
    - apps/core/src/modules/identity/internal/routes/identity.routes.ts
    - packages/contracts/src/consent/index.ts
    - apps/core/src/modules/identity/internal/application/erase-customer.ts
- `neo4j-subject-shred` (extend, parallel=False) — EXTEND eraseCustomer Cypher: after edge tombstone, REMOVE/NULL identifier hash props on Identifier nodes for the subject (or re-key Customer.brain_id -> surrogate_brain_id) so Neo4j props are no longer subject-identifying. Return surrogate for the orchestrator. Per-brand isolation stays application-layer (every Cypher carries brand_id) — match existing convention.
    - apps/core/src/modules/identity/internal/infrastructure/neo4j-identity-reader.ts
- `gold-surrogate-reprojection` (new, parallel=True) — Spark job (match _gold_base.py shape + idempotent MERGE + run-*.sh) that re-points erased brain_id -> surrogate_brain_id across customer-grain Gold marts (gold_customer_360/_scores/_segments) reading pii_erasure_log, so math reconciles on the surrogate while the person is unjoinable. Money columns (bigint minor + currency_code) survive untouched on the surrogate. brand_id-scoped.
    - db/iceberg/spark/gold/gold_erasure_reproject.py
    - db/iceberg/spark/gold/run-gold-erasure-reproject.sh
- `erasure-aware-iceberg-compaction` (new, parallel=True) — DEFERRED — register DISABLED as NotImplementedYet (never fake). Bronze Iceberg partition rewrite + snapshot-expiry so a shredded subject's hashes cannot be resurrected from old snapshots (I-S05 step 4). Build the job skeleton + run script that throws NotImplementedYet until the rewrite/expiry strategy is ratified; orchestrator step 4 calls it but tolerates the disabled state. Match the existing Spark job + run-*.sh convention.
    - db/iceberg/spark/maintenance/erasure_compaction.py
    - db/iceberg/spark/maintenance/run-erasure-compaction.sh
- `trino-erasure-verification` (new, parallel=True) — ADD Trino ADDITIVELY (keep StarRocks serving untouched) as the federated cross-store erasure-VERIFICATION query tier over the Iceberg Bronze/Silver/Gold catalogs. erasure_verification.sql proves (tenant/brand-predicate scoped) that no readable subject PII survives post-shred — the concrete I-S05 integration-test assertion. e2e test: request erasure -> shred subject DEK -> assert contact_pii undecryptable + Trino query returns 0 identifying rows + pii_erasure_log.vault_shredded=true + ledger row survives on surrogate. Match existing .e2e.test.ts harness.
    - infra/trino/catalog/iceberg.properties
    - infra/trino/docker-compose.trino.yml
    - db/iceberg/trino/erasure_verification.sql
    - apps/stream-worker/src/tests/crypto-shred-erasure.e2e.test.ts
- `redis-pii-shred-enumeration` (extend, parallel=False) — On erasure, enumerate + DEL any subject-scoped Redis keys (dedup/identity caches) and invalidate the cached subject DEK (extend invalidate(brandId,brainId)). Keep keys tenant(brand_id)-scoped. No new Redis usage — reuse the existing redis client wiring in main.ts.
    - apps/core/src/modules/identity/internal/infrastructure/contact-pii-vault.service.ts
    - apps/stream-worker/src/application/EraseSubjectUseCase.ts

**Conventions to match:** "PORTS/ADAPTERS: extend the existing TS interface ports in packages/pii-vault (VaultKeyProvider, KmsDecryptPort/KmsEncryptPort, BrandSaltSource) — Dev/Unwired/Kms triad, default-CLOSED in prod, in-memory key cache + invalidate(), lazy @aws-sdk/client-kms import, IRSA creds. SQL ACCESS: every keyed table is FORCE-RLS + brain_app SELECT-only; all writes/reads go through SECURITY DEFINER search_path-pinned fns (provision_brand_crypto / get_brand_keyring / get_brand_identity_salt) returning ONLY the requested brand's row; idempotent ON CONFLICT DO NOTHING (never rotate/resurrect); migration tail D

### mcp-ai-readonly — AI read-only MCP tools (F5 / B.11): Tool Registry + Prompt Registry, authz + tenant isolation, proof of no-write / no-replay

**Gaps vs spec:**
- The named read-only LOOKUP tools the spec wants do NOT exist as registered tools: Identity Explainability, Customer360 Lookup, Journey Lookup, Timeline Lookup, Segment Lookup, Attribution Lookup, LTV Lookup, RecFeature Lookup, MarketingPerf Lookup. The ai-gateway-client registry has only list_metrics + resolve_and_compute; the contracts registry has only get_brand_event_count.
- TWO divergent MCP registries with different shapes and different contents (ai-gateway-client MCP_TOOLS {name,access,description} vs contracts genMCP {name,description,read_only,scope,inputSchema,outputSchema}). The spec wants ONE Tool Registry; Single-Primitive Rule is violated by the split.
- No per-tool authz `scope` on the canonical registry (McpToolSpec has no scope field). Spec §8.3 requires MCP scopes as an enforcement layer; only the contracts copy carries scope:'analytics:read'.
- Prompt Registry is NOT content-hash-versioned and is single-prompt (resolver-prompt.ts only). Spec §7.6/§N.4 wants a content-hash-versioned registry promoted through CI eval gates with active hashes per task, plus an internal read GET /internal/ai/prompts. The 9 new lookup tools have no registered prompts/descriptions/eval baselines.
- No proof harness that AI cannot WRITE to identity / Gold / control-plane / Decision-Log, and no proof that tools cannot replay-invoke (idempotency/no side-effect). Current CI only asserts writeToolCount===0 + name substrings + a STUB brand-scope control disconnected from real dispatch.
- No real MCP tool dispatch/bodies: there is no code that executes a named lookup tool against the analytics/identity read paths. Tool execution is only modeled by an in-test StubMcpServer.
- No backing read for Segment Lookup (no getSegments in analytics) and RecFeature Lookup features are runtime-folded (no permanent feature table per V4) — these must be registered-DISABLED NotImplementedYet, never faked.
- Tenant isolation defect in the contracts tool shape: brand_id is an INPUT arg in tools.json inputSchema, contradicting I-S01 (brand_id from session/principal, never request body) which the rest of the repo (ask-brain, get-customer-360) enforces.
- No MCP transport/principal surface for THIS path (POST /mcp + mcp_key issuance/scoping/revocation per §7.4/§8.5). Spec marks LiteLLM+MCP deployment deferred to M3, so this is gap-but-deferred (register DISABLED, do not fake).
- Trino is absent entirely (no refs in apps/packages/db/docs). Decision is ADD Trino additively; it is not on the MCP read path (reads stay on metric-engine sole-read-path over StarRocks mv_*) — additive, out of this domain's hot path, flagged only.
- Money-shape parity for the new lookup outputs is unspecified: outputs must use bigint-minor STRING + sibling currency_code (the MoneyRecord/ComputedScalar convention), but no contract schemas exist for the lookup outputs yet.

**Build units:**
- `Extend McpToolSpec + register the 9 named lookup tools (registry SoR)` (extend, parallel=False) — GAP-EXTEND the existing MCP_TOOLS array — do NOT create a new registry. Add `scope` (read-scope enum) + optional input/output schema ref to McpToolSpec, keep access:'read' the only value and writeToolCount derived. Add identity_explainability_lookup, customer360_lookup, journey_lookup, timeline_lookup, segment_lookup, attribution_lookup, ltv_lookup, recfeature_lookup, marketingperf_lookup. Tools with no V4 backing read (segment_lookup, recfeature_lookup) register DISABLED as NotImplementedYet — present in registry, dispatch throws NotImplemented, never faked. This is the SoR consumed by everything else; serialize it first.
    - packages/ai-gateway-client/src/mcp-tools.ts
    - packages/ai-gateway-client/src/index.ts
    - apps/core/src/modules/ai/mcp/tools.ts
- `Per-tool input/output Zod schemas + unify contracts codegen onto MCP_TOOLS` (extend, parallel=False) — Add Zod input/output schemas per lookup tool (brand_id OMITTED from inputs — supplied by the MCP principal, NEVER an arg; fixes the I-S01 conflict in the current tools.json). Outputs use bigint-minor STRING + sibling currency_code. Rewire genMCP() to enumerate MCP_TOOLS (the ai-gateway-client SoR) instead of its hand-written array, collapsing the two divergent registries into one. Depends on build unit 1.
    - packages/contracts/src/index.ts
    - packages/contracts/scripts/codegen.ts
    - packages/contracts/generated/mcp/tools.json
- `MCP tool dispatch/bodies over the existing sole read path` (new, parallel=False) — New dispatch that executes each enabled tool by calling the EXISTING analytics/identity read use-cases (getJourneyTimeline, getJourneyFirstTouchMix, getAttributionByChannel/getAttributionReconciliation, getChannelRoas/getCampaignRoas for MarketingPerf, getCohortRetention/getCustomerBaseSummary/getTopProducts for LTV+Customer360, getCustomer360 for Identity Explainability). brand_id from the MCP session principal only; RLS-scoped reads; money bigint-minor+currency_code; honest-empty (no fabrication, mirror FIGURE_NONE pattern). NO new topic/deployable — mounts over the read path. Disabled tools throw NotImplemented. Depends on units 1-2.
    - apps/core/src/modules/ai/mcp/dispatch.ts
    - apps/core/src/modules/ai/mcp/tools.ts
    - apps/core/src/modules/ai/index.ts
- `Prompt Registry: per-tool registered prompts + content-hash versioning` (extend, parallel=True) — GAP-EXTEND the existing in-code prompt builder pattern: add a content-hash-versioned entry per lookup tool (description/usage handed to the caller LLM), derived deterministically from the registry so it can't drift. Keep RESOLVER_PROMPT_VERSION style. Surfaces the active hashes for the later GET /internal/ai/prompts (§7.6). Parallel-safe with dispatch (no overlapping symbols).
    - apps/core/src/modules/ai/prompt-registry/resolver-prompt.ts
    - apps/core/src/modules/ai/prompt-registry/tool-prompts.ts
    - apps/core/src/modules/ai/index.ts
- `Proof harness: no-write / no-Decision-Log / no-control-plane / no-replay + real brand-scope` (extend, parallel=False) — GAP-EXTEND the existing CI-blocking test. Keep writeToolCount===0 + FORBIDDEN substrings (now over the expanded registry). Replace the StubMcpServer with the REAL dispatch (unit 3) for the brand-A→brand-B negative control. ADD proofs: (a) every tool resolves only to a read use-case — assert no identity-graph/Gold/control-plane/Decision-Log writer is reachable from a tool body; (b) no replay/idempotency-key invoke path exists (tools are pure reads, no side-effect); (c) disabled tools fail-closed NotImplemented, not faked. This is the spec's PROVE requirement. Depends on units 1-3.
    - tools/isolation-fuzz/src/mcp.test.ts
    - tools/isolation-fuzz/src/mcp-readonly-proof.test.ts
- `MCP transport + key principal (DEFERRED-registered)` (new, parallel=True) — POST /mcp + mcp_key issuance/scope-intersection/revocation (§7.4/§8.5) is spec-deferred to M3. Register the surface DISABLED/NotImplementedYet (no fake), document the deferral, and ensure the dispatch (unit 3) is transport-agnostic so the real transport plugs in later. Do NOT build a fake key store.
    - apps/core/src/modules/ai/mcp/server.ts
    - docs/architecture/v4/14-implementation-plan.md
- `Trino additive binding (flag only — not on MCP path)` (new, parallel=True) — Decision = ADD Trino additively while keeping StarRocks serving. MCP read-only tools deliberately stay on the metric-engine sole-read-path over brain_serving.mv_*; Trino is the exploration/federation tier, NOT the MCP read path. Record as additive future work; no code change in this domain.
    - docs/architecture/v4/14-implementation-plan.md

**Conventions to match:** "PORTS/ADAPTERS: the MCP registry lives in the @brain/ai-gateway-client seam package and is re-exported (not re-sourced) by apps/core/src/modules/ai/mcp/tools.ts; the core ai module exposes ONLY index.ts (impl private under internal/). LiteLLM access is behind an injectable GatewayTransport/ResolverClient (tests pass a deterministic stub; no live LLM in CI). REGISTRY-AS-SoR: tool/metric/prompt content is DERIVED from METRIC_REGISTRY (METRIC_ID_ENUM, metricCatalogue()) — never a hand-maintained list that can drift. READ-ONLY BY CONSTRUCTION: every tool access:'read' (the only allowed value), wr

### trino-gateway-cache — Analytics Gateway + Trino (additive) + Redis result-cache over the V4 StarRocks/Iceberg serving tier

**Gaps vs spec:**
- NO query-result cache: there is zero Redis cache-aside for analytics results. Spec wants cache-hit→Redis. Today every BFF analytics read goes straight to StarRocks via withSilverBrand. Missing: a tenant-scoped Redis result cache (keys, TTL, stampede protection, invalidate-on-write).
- NO gateway routing decision: the BFF routes call withSilverBrand directly with no router that chooses cache-hit vs StarRocks-serving vs Trino-adhoc. Spec wants a routing seam (hit→Redis; miss/ad-hoc/AI→Trino→write-back).
- NO Trino at all: no TrinoQueryPort interface, no Trino adapter, no Trino docker-compose service, no Trino Iceberg catalog config. Spec wants Trino over Iceberg as the miss/ad-hoc/AI/federation tier (ADDITIVE — StarRocks serving stays).
- NO cache-invalidation on Gold rewrite: refresh_serving_mvs() refreshes MVs but cannot bust a result cache (none exists). Spec wants invalidation when Gold is rewritten — needs a programmatic invalidation contract the refresh loop (and any future Spark-completion event) calls.
- NO ad-hoc/AI Trino query surface: ask-brain.ts is registry-bound (model never emits SQL). A raw-SQL-over-Trino AI/ad-hoc path is genuinely absent — and per the no-SQL-from-model invariant it must be REGISTERED-DISABLED NotImplementedYet, never faked into emitting SQL.
- NO isolation-fuzz coverage for a Trino path: the existing mutation proof (tools/isolation-fuzz/src/silver-order-state.test.ts) covers only the StarRocks seam; a Trino port needs the equivalent ${BRAND_PREDICATE} mutation proof before it can serve tenant data.

**Build units:**
- `TrinoQueryPort interface (port)` (new, parallel=True) — Mirror silver-deps.ts EXACTLY: structural TrinoPool (query/getConnection over the Trino JS client shape), withTrinoBrand(pool, brandId, fn) handing a TrinoScope.runScoped that substitutes the SAME ${BRAND_PREDICATE} sentinel → `brand_id = ?`, fail-closed missing-sentinel throw, unavailable→empty degrade. Reuse the exported BRAND_PREDICATE constant. Export from packages/metric-engine/src/index.ts. Money stays bigint-minor+currency_code (Trino reads the same Iceberg Gold). Do NOT couple to mysql2.
    - packages/metric-engine/src/trino-deps.ts
- `Trino client adapter` (new, parallel=False) — Concrete adapter implementing TrinoPool over trino-client (or HTTP). Built in main.ts composition root beside srPool and injected into BffDeps. If Trino is deferred for now, register it DISABLED: construct a NotImplementedYet adapter whose runScoped throws an explicit 'trino adapter not implemented yet' — never a fake/empty result. Conflicts with main.ts wiring edits → serialize with cache + gateway units.
    - packages/metric-engine/src/trino-client.ts
    - apps/core/src/main.ts
- `Trino docker-compose service` (extend, parallel=True) — Add a `trino` service under profiles:[lakehouse] (trinodb/trino image), ports e.g. 8080, joining the same network as iceberg-rest/minio (the run-gold scripts' netns posture is the reference). Additive — does NOT touch starrocks/iceberg-rest. Mount the catalog config from the next unit.
    - docker-compose.yml
- `Trino Iceberg catalog config` (new, parallel=True) — connector.name=iceberg, iceberg.catalog.type=rest, iceberg.rest-catalog.uri=http://iceberg-rest:8181, S3/MinIO creds (endpoint http://minio:9000, path-style, brain/brainbrain) — mirror db/starrocks/external_iceberg_silver_gold_catalog.sql so brain_silver/brain_gold namespaces resolve. READ-ONLY posture (ADR-002 one-way rule: no Trino→Iceberg writes for serving).
    - db/trino/catalog/iceberg.properties
    - db/trino/config.properties
- `Analytics result-cache port + Redis adapter` (new, parallel=False) — Per caching-strategy skill: AnalyticsCachePort (get/set with TTL/invalidate). Redis adapter reuses the existing ioredis client from main.ts (do NOT add a 2nd Redis). Cache keys MUST be brand_id-leading + metric_id + params hash + serving snapshot/version (tenant-scoped, multi-tenancy invariant). TTL from config. Stampede guard (single-flight/SETNX lock). Add cache?: AnalyticsCachePort to BffDeps in _shared.ts. Serialize with main.ts wiring + gateway unit.
    - packages/metric-engine/src/analytics-cache.ts
    - apps/core/src/modules/frontend-api/internal/routes/_shared.ts
    - apps/core/src/main.ts
- `Query-gateway routing seam` (new, parallel=False) — A thin routeQuery(deps, brandId, key, loader) helper: 1) cache-aside read (hit→Redis return); 2) miss→run the registry/metric-engine loader (StarRocks serving via withSilverBrand — REPO WINS: known metrics stay StarRocks); 3) write-back to Redis with TTL. Trino is wired as the explicit ad-hoc/federation branch (DISABLED NotImplementedYet until the adapter lands). Routes are gap-EXTENDED to wrap reads in routeQuery — do NOT duplicate the use-cases. Touch routes incrementally (start with analytics-core) to keep diffs reviewable.
    - apps/core/src/modules/frontend-api/internal/routes/_query-gateway.ts
    - apps/core/src/modules/frontend-api/internal/routes/analytics-core.routes.ts
- `Cache invalidation on Gold rewrite` (extend, parallel=False) — After refresh_serving_mvs() completes the MV SYNC refresh, bust the Redis result-cache namespace (e.g. DEL by brand/metric prefix or bump a per-brand serving-version key embedded in the cache key — version-bump is preferred: O(1), no SCAN). Add the invalidation contract to analytics-cache.ts so both the loop (via a tiny invoker) and any future Spark-completion event call the same path. Depends on the cache-port unit.
    - tools/dev/v4-refresh-loop.sh
    - packages/metric-engine/src/analytics-cache.ts
- `Config: Trino + cache env` (extend, parallel=True) — Add TRINO_HOST/PORT/CATALOG/SCHEMA + ANALYTICS_CACHE_TTL_SECONDS + ANALYTICS_CACHE_ENABLED to the memoized core loader (match existing per-service loader + zero-default-drift convention). Trino disabled by default until the adapter is real.
    - packages/config/src/core.ts
- `Trino isolation-fuzz mutation proof` (new, parallel=True) — Mirror silver-order-state.test.ts: disabling the Trino port's ${BRAND_PREDICATE} injection (__unsafeDisableBrandPredicate) MUST leak brand-B rows; if it doesn't the guard is inert and the test fails loud. Gating proof before Trino serves any tenant data. Can be authored in parallel against the port interface; runs once the adapter exists.
    - tools/isolation-fuzz/src/trino-brand-predicate.test.ts
- `AI ad-hoc Trino — registered DISABLED` (extend, parallel=True) — Spec's AI→Trino branch CONFLICTS with the no-SQL-from-model invariant (ask-brain binds registry metrics, model never emits SQL). Register the ad-hoc/federated-Trino strategy as DISABLED NotImplementedYet (explicit refusal DTO), never faked. Keeps the seam present + auditable without weakening the invariant. Minimal touch — a guarded branch + a documented refusal reason.
    - apps/core/src/modules/ai/internal/ask-brain.ts
    - packages/ai-gateway-client/src/resolver-schema.ts

**Conventions to match:** ["PORTS/ADAPTERS: structural pool interface (SilverPool) declared in @brain/metric-engine, concrete adapter built ONLY in the apps/core/src/main.ts composition root and injected via BffDeps. A read seam is `withXBrand(pool, brandId, fn)` handing a scope whose runScoped substitutes the ${BRAND_PREDICATE} sentinel, fails closed if the sentinel is absent, and degrades unknown-table/db to empty (silver-deps.ts is the template).", "BFF SHAPE: per-feature Fastify route PLUGINs under frontend-api/internal/routes/*.routes.ts composed by bff.routes.ts over one shared BffDeps (routes/_shared.ts); routes

### modes-replay-recompute (F2/F3/F4, B.12) — incremental-streaming vs historical-backfill as two strategies behind one domain logic, order-independence (stream==backfill), operator-controlled replay/algorithm-migration with as-of versioned identities, and the identity-change→Gold-recompute→cache-invalidation loop.

**Gaps vs spec:**
- No explicit STRATEGY seam unifying incremental-streaming vs historical-backfill behind one domain interface. They converge implicitly (both -> Bronze -> same ProcessEventUseCase -> same Spark Silver/Gold), but there is no registered strategy abstraction and no place to register DEFERRED strategies as DISABLED/NotImplementedYet (spec wants 'two strategies behind SAME domain logic' + deferred-registered-disabled).
- LANE-ISOLATION HOLE: the GENERIC ingestion-backfill (the V4 framework flagship) produces to the LIVE collector topic (run.ts: LIVE_TOPIC = {env}.collector.event.v1), NOT the isolated BACKFILL_TOPIC. Only the LEGACY order path (BackfillOrderConsumer on order.backfill.v1) honors the isolated lane. A generic 24-month backfill therefore CAN induce live-lane lag — directly contradicts §6.4 'separate backfill lane, zero live-lane lag'.
- NO order-independence test. The H1 'order-tolerant by construction' claim is asserted in the spec but never PROVEN by a direct test that builds the identity graph + Gold marts two ways (stream order vs shuffled/backfill order) on a shared fixture and asserts byte/Σ-equality. Existing tests (ingestion-backfill.unit.test.ts, parity oracle) do not cover this.
- NO replay / algorithm-migration job. Bronze is declared the replay SoR but there is NO per-tenant operator-controlled replay-from-Bronze recompute job, NO algorithm-version pin/migration mechanism, and NOTHING enforces 'NOT agent-invokable' (no operator-only/RBAC guard, no exclusion from the MCP/tool surface). v4-refresh-loop recomputes EVERYTHING cross-brand on a timer — it is neither per-tenant, nor operator-triggered, nor version-pinned.
- Identity is NOT as-of-queryable. Neo4j holds valid_from/valid_to/committed_at/lifecycle_state, but identity-export FLATTENS to current state only (silver_identity_link/silver_customer_identity have no version/valid_from columns and no snap_identity_link snapshot exists). snap_* covers orders+attribution but not identity, so 'as-of versioned identities' has primitives but no projection or read path.
- identity-change -> intelligence-recompute LOOP is absent. ResolveIdentityUseCase and merge-admin mutate Neo4j but publish NO identity.merged/split/updated fact to the bus; there is NO consumer that maps an affected brain_id to a SCOPED Gold recompute, and NO cache invalidation on identity change. The only propagation is the next coarse, cross-brand, scheduled identity-export + full v4-refresh cycle (not event-driven, not scoped, not cache-aware).
- NO bulk Neo4j batch load for backfill identity. Backfilled events land in Bronze; identity resolution is the per-event live ResolveIdentityUseCase path. Spec wants a bulk/UNWIND-batched Neo4j load for the historical lane so a 24-month backfill does not resolve identity one event at a time on the live resolver.
- NO Trino tier (decision = add additively) for as-of/time-travel reads, federated/ad-hoc lakehouse queries, and as the order-independence test harness reading Iceberg snapshots — while keeping StarRocks mv_* as the sole app serving path.
- Crypto-shred recompute coupling: PII-vault + crypto-shred erase exist, but the erase event does NOT drive the scoped-recompute/cache-invalidation loop (same missing loop as identity merge/split) so an erased customer's derived Gold/cache can stay stale until the next full cycle.

**Build units:**
- `IngestionStrategy registry seam` (new, parallel=True) — Thin registry placing the EXISTING live path and runResumableBackfill behind one domain interface (strategy id + enabled flag). Register 'incremental-streaming' + 'historical-backfill' ENABLED; register deferred strategies (e.g. 'cdc-log', 'file-settlement') DISABLED -> throw NotImplementedYet, never faked. Pure additive; does not rebuild either path. Match connector-core ports/adapters style.
    - packages/connector-core/src/contracts/IngestionStrategy.ts
    - packages/connector-core/src/index.ts
    - apps/stream-worker/src/jobs/ingestion-backfill/run.ts
    - apps/stream-worker/src/main.ts
- `Backfill generic-job lane isolation fix` (extend, parallel=False) — Point the GENERIC ingestion-backfill sink at BACKFILL_TOPIC (isolated lane) instead of LIVE_TOPIC, and consume it on the backfill consumer group (extend BackfillOrderConsumer or add a sibling backfill collector consumer reusing ProcessEventUseCase). Closes the §6.4 lane hole WITHOUT a third pattern. Touches main.ts wiring -> serialize.
    - apps/stream-worker/src/jobs/ingestion-backfill/run.ts
    - apps/stream-worker/src/main.ts
    - packages/config/src/stream-worker.ts
- `Order-independence test (stream==backfill graph)` (new, parallel=True) — ONE shared fixture (identify + order + touchpoint + merge events, brand-scoped, money bigint+currency_code). Drive it twice through the SAME ProcessEventUseCase -> Bronze -> Spark Silver/Gold: (a) live/sequential order, (b) shuffled/reverse 'backfill' order. Assert identical Neo4j graph projection (silver_identity_link) AND identical Gold marts (Σ exact, brain_id sets equal). Reuse the established produce->Kafka->Spark->poll StarRocks w/ REFRESH EXTERNAL TABLE harness. This is the direct proof the spec demands.
    - apps/stream-worker/src/tests/order-independence.live.test.ts
    - apps/stream-worker/src/jobs/_fixtures/order-independence.fixture.ts
    - db/iceberg/spark/parity/order_independence_check.py
- `Operator-controlled replay-from-Bronze job` (new, parallel=False) — Per-tenant replay: re-emit a brand's Bronze (24-mo SoR) window through the SAME ProcessEventUseCase on an ISOLATED replay lane/group (mirror the backfill lane). Checkpointed/idempotent (reuse ResourceBackfillState pattern). Trigger is an RBAC-gated operator REST endpoint ONLY — explicitly NOT registered on the MCP/tool/agent surface (assert in code + test). Pin algo_version on the run. Compose into v4-refresh, do not fork the orchestrator.
    - apps/stream-worker/src/jobs/replay/run.ts
    - apps/stream-worker/src/main.ts
    - packages/config/src/stream-worker.ts
    - apps/core/src/modules/.../interfaces/rest/replay.routes.ts
- `Algorithm-version pin + migration` (extend, parallel=False) — Stamp algo_version (identity rule_version already 'v1-deterministic' in Neo4j; extend to marts). Operator-triggered migration recomputes a tenant under a NEW version while history stays reproducible (each number pinned to model_version + data snapshot per §3.x attribution rule). Builds on the existing model_id/model_version attribution discipline.
    - apps/stream-worker/src/application/ResolveIdentityUseCase.ts
    - db/iceberg/spark/gold/gold_attribution_credit.py
    - db/iceberg/spark/gold/_attribution_math.py
    - packages/connector-core/src/contracts/IngestionManifest.ts
- `As-of versioned identity projection` (extend, parallel=True) — Extend identity-export to project Neo4j ALIAS_OF.valid_from/valid_to + MergeEvent.committed_at + lifecycle_state into a versioned/history table, and add snap_identity_link mirroring snap_order_state.py (daily SCD, PK incl. snapshot_date, idempotent MERGE). Gives 'identity as-of D' without inventing a second SoR — Neo4j stays SoR, StarRocks/Iceberg is the projection.
    - apps/stream-worker/src/jobs/identity-export/run.ts
    - db/iceberg/spark/silver/snap_identity_link.py
    - db/starrocks/ops/ops_silver_identity_link_history.sql
    - db/iceberg/spark/silver/run-silver-identity-snapshot.sh
- `identity-change -> scoped-recompute -> cache-invalidation loop` (new, parallel=False) — Publish identity.merged/split/updated FACTS (hashed ids only per C2, brand_id-first, FULL_TRANSITIVE) from ResolveIdentityUseCase + merge-admin + erase-customer. A consumer maps affected brain_id(s) -> a SCOPED Gold recompute (targeted re-run of customer_360/attribution marts for those brain_ids, not the whole brand) + tenant-scoped Redis cache invalidation. Also wire the crypto-shred erase event into this loop. Cross-cutting -> serialize.
    - packages/contracts/src/events/identity.merged.v1.ts
    - packages/contracts/src/events/identity.split.v1.ts
    - packages/contracts/src/events/identity.updated.v1.ts
    - apps/stream-worker/src/application/ResolveIdentityUseCase.ts
    - apps/core/src/modules/identity/internal/application/merge-admin.ts
    - apps/stream-worker/src/jobs/identity-recompute/run.ts
- `Bulk Neo4j batch identity load for backfill lane` (extend, parallel=True) — Add an UNWIND-batched bulk MERGE method to Neo4jIdentityRepository and route the historical/backfill lane through it (batch identifiers per chunk) so a 24-month backfill does not hammer the per-event live resolver. Keep MERGE-on-stable-keys idempotency. Isolated to the backfill lane.
    - apps/stream-worker/src/infrastructure/neo4j/Neo4jIdentityRepository.ts
    - apps/stream-worker/src/interfaces/consumers/BackfillOrderConsumer.ts
    - apps/stream-worker/src/application/ResolveIdentityUseCase.ts
- `Trino additive ad-hoc/as-of tier` (new, parallel=True) — Add Trino over the existing Iceberg REST catalog for time-travel/as-of + federated/ad-hoc queries + the order-independence harness; KEEP StarRocks mv_* as the sole APP serving path. Extend v4-naming-guard so Trino can NOT become an app serving dependency (CLAUDE.md invariant). Tenant-predicate scoped reads only.
    - ops/trino/catalog/iceberg.properties
    - docker-compose.yml
    - db/trino/README.md
    - tools/lint/v4-naming-guard.sh

**Conventions to match:** ["Ports/adapters: connector-core contracts (IResourcePageFetcher, IEventSink, IDeadLetterSink, IResourceBackfillStateRepository) + domain-entity (ResourceBackfillState) vs Pg-repo (PgResourceBackfillStateRepository) split; connectors supply only paging, the driver owns checkpoint/resume/dedup/no-loss.", "Spark job shape: _silver_base.py/_gold_base.py helpers, idempotent MERGE on brand-first PK, snap_*.py daily-SCD (PK incl. snapshot_date), run-*.sh wrappers, job_log.py emitting the cycle correlation_id; tenant isolation + money discipline live INSIDE the job.", "Event envelope: CanonicalEvent 

### Contracts + envelope + schema (C.4/C.5, E.3, F.3) — the @brain/contracts Zod-as-source-of-truth surface, the Redpanda event envelope, Avro/Apicurio codegen, and the money/currency + brand_id tenant conventions.

**Gaps vs spec:**
- ENVELOPE GAP (largest): EventEnvelopeBaseSchema implements only 6 of the spec's 15 envelope fields. Missing producer, schema_id, partition_key, causation_id, ingested_at, source, sequence, consent_flags; and it names the type field event_name where the spec wire field is schema_name. trace_id is NOT a contract field (the spec uses correlation_id+causation_id; trace context is a transport/observability concern injected at the messaging layer — do not add trace_id to the Zod envelope).
- No identity.* EVENT contracts exist. Spec topic catalogue wants identity.resolution.requested.v1, identity.brain_id.minted.v1, identity.alias.repointed.v1, identity.merge.proposed.v1, identity.merge.committed.v1 — none are in packages/contracts/src/events.
- No IdentityMatcher port, Identifier VO, IdentityDecision command, ConfidenceVerdict, or IdentityGraphRepository port as CONTRACTS. Hashing primitives exist in identity-core but there is no typed Identifier value-object schema, no IdentityDecision command schema, no ConfidenceVerdict (confidence tier + rule_version + identifier_combo) schema, no IdentityGraphRepository port interface contract.
- No AttributionModel port contract. AttributionModelId enum + pure model functions exist in metric-engine, but there is no port/strategy interface contract that lets a model register itself (and no registered-DISABLED NotImplementedYet slot for deferred models).
- No IntelligenceJob template contract. ops_ml_prediction_log is a sink table but there is no contract describing an intelligence/ML job's input/output envelope, model+version provenance, or the registered-DISABLED deferred-strategy pattern.
- No GoldDataProduct schema. Gold marts exist as Spark jobs + StarRocks mv_*, but there is no contract describing a Gold data product (name, grain, owner, freshness SLA, money columns + currency_code, brand_id tenancy) that the serving layer and a future Trino exploration tier can both bind to.
- No cache-invalidation EVENT contracts. doc 06 §1.14 says the Analytics API owns its cache; there is no cache.invalidated / mv.refreshed event contract to drive invalidate-on-write or signal mv_* SYNC refresh completion.
- Trino is additive-new: no trino references in code (only in docs/requirements + STACK.md). The contracts/GoldDataProduct schema must be Trino-bindable additively WITHOUT touching the StarRocks mv_* serving path (StarRocks stays the sub-second serving tier).
- consent_flags is only a runtime CollectorEventEnvelope field (packages/events) and is absent from the Zod EventEnvelopeBase — the customer-domain consent extension is not contract-typed.

**Build units:**
- `Extend EventEnvelopeBase to spec parity` (extend, parallel=False) — Add the missing spec fields to EventEnvelopeBaseSchema ADDITIVELY (additive-optional only, to keep FULL_TRANSITIVE): producer, schema_id, partition_key, causation_id(nullable), ingested_at, source, sequence(nullable), consent_flags(nullable map). Keep event_name AND add schema_name as the canonical wire alias (do not break the 9 M1 events). Do NOT add trace_id (not a contract field). Touches the shared base every event extends -> serialize this first; everything else builds on it. Re-run codegen + commit generated/avro.
    - packages/contracts/src/events/m1.events.v1.ts
    - packages/contracts/src/index.ts
- `Identifier VO + ConfidenceVerdict contracts` (new, parallel=True) — Identifier VO = { identifier_type (email|phone|device_id|external_id, mirror identity-core IdentifierType), identifier_hash (64-hex), tier, brand_id }. ConfidenceVerdict = { confidence (string/decimal), rule_version, identifier_combo: string[], verdict enum } mirroring the existing Customer360Merge fields. PII discipline: hash/prefix only, never raw (I-S02). brand_id required. New subdir packages/contracts/src/identity/ — pattern-match the api/ + events/ file layout.
    - packages/contracts/src/identity/identifier.vo.v1.ts
    - packages/contracts/src/identity/confidence.v1.ts
    - packages/contracts/src/index.ts
- `IdentityDecision command + IdentityMatcher/IdentityGraphRepository port contracts` (new, parallel=True) — IdentityDecision command = cmd.identity.* envelope payload (resolve/merge/unmerge decision) following doc07 cmd.{domain}.{noun}.{verb}.requested naming. IdentityMatcher port = TS interface (match(identifiers)->ConfidenceVerdict). IdentityGraphRepository port = interface the Neo4j adapter (silver_customer_identity.py source) + a registered-DISABLED NotImplementedYet stub satisfy. Ports are interface contracts only; concrete adapters stay in their packages. Depends on Identifier VO + ConfidenceVerdict unit.
    - packages/contracts/src/identity/identity-decision.cmd.v1.ts
    - packages/contracts/src/identity/ports.v1.ts
    - packages/contracts/src/index.ts
- `identity.* event contracts` (new, parallel=False) — 5 events from doc07 catalogue: identity.resolution.requested, identity.brain_id.minted, identity.alias.repointed, identity.merge.proposed, identity.merge.committed — each extend the (now-extended) EventEnvelopeBase + TOPIC_SUFFIX + AVRO_SUBJECT + add to an IDENTITY_EVENT_SCHEMAS codegen map. DEPENDS on the envelope-extension unit -> not parallel-safe with it. brand_id tenant key + no raw PII.
    - packages/contracts/src/events/identity.events.v1.ts
    - packages/contracts/src/index.ts
- `AttributionModel port + deferred-DISABLED registry slot` (extend, parallel=True) — Add an AttributionModel port contract (interface: id: AttributionModelId, computeWeights(touches)->weight units summing to 1e8). Reuse AttributionModelIdSchema from _money.ts (no new enum). Register any spec-deferred model as DISABLED NotImplementedYet (throws, never fakes) — never a silent stub. Pure no-float discipline already established in attribution-models.ts.
    - packages/contracts/src/api/attribution.api.v1.ts
    - packages/metric-engine/src/attribution-models.ts
    - packages/contracts/src/index.ts
- `IntelligenceJob template contract` (new, parallel=True) — Contract for an ML/intelligence job: { job_id, brand_id, model_id, model_version, input_ref, output schema, prompt_hash?, metric_binding? } mirroring doc06 §1.11 AI provenance + the ops_ml_prediction_log columns. Money outputs use MinorUnitsSchema + currency_code. Deferred job types registered DISABLED NotImplementedYet.
    - packages/contracts/src/intelligence/intelligence-job.v1.ts
    - packages/contracts/src/index.ts
- `GoldDataProduct schema (Trino-additive)` (new, parallel=True) — Contract describing a Gold data product: { name (gold_*), grain, owner, freshness_sla, brand_id_column (tenant key, always present), money_columns: {minor_col, currency_code_col}[], serving_mv (brain_serving.mv_*), trino_table? }. Additive — describes BOTH the StarRocks mv_* serving binding AND an optional Trino exploration binding without changing the serving one-way rule. Validate against the 23 gold_*.py marts.
    - packages/contracts/src/gold/gold-data-product.v1.ts
    - packages/contracts/src/index.ts
- `Cache-invalidation event contracts` (new, parallel=False) — cache.invalidated + mv.refreshed events extending EventEnvelopeBase (brand_id-scoped, tenant-keyed cache keys per doc06 §1.14 + caching-strategy: invalidate-on-write). mv.refreshed signals brain_serving.mv_* SYNC refresh completion. DEPENDS on the envelope-extension unit.
    - packages/contracts/src/events/cache.events.v1.ts
    - packages/contracts/src/index.ts
- `Extend PII-vault crypto-shred surface (contract side)` (extend, parallel=True) — ErasureResultSchema + VaultCoverageSchema already exist. Extend with a crypto-shred contract (key_version, shred result counts) so the Identifier VO references the keyring/crypto-shred unit. The actual crypto lives in packages/identity-core + packages/pii-vault (extend those, do NOT rebuild). Counts only, never raw PII.
    - packages/contracts/src/identity/identifier.vo.v1.ts
    - packages/contracts/src/api/identity.api.v1.ts
- `Codegen + Apicurio FULL_TRANSITIVE regen` (extend, parallel=False) — After all new schemas land, extend codegen.ts to emit Avro .avsc for the new identity/cache events + run it, committing generated artifacts (I-E01 contract-first gate). Must keep FULL_TRANSITIVE compatibility (additive-only). FINAL serialized unit.
    - packages/contracts/scripts/codegen.ts
    - packages/contracts/generated/avro/
    - infra/redpanda/schemas/

**Conventions to match:** ["Contract file layout: one file per event/API family under packages/contracts/src/{events,api,...}, each exporting <Name>Schema + z.infer type + <NAME>_TOPIC_SUFFIX/_EVENT_NAME/_AVRO_SUBJECT consts + a <GROUP>_SCHEMAS codegen map; ALL re-exported from src/index.ts (schema + type blocks). New subdirs (identity/, gold/, intelligence/) follow the same shape.", "Envelope extension: events EXTEND EventEnvelopeBaseSchema via .extend({ event_name: z.literal(...), payload: ... }); topics built via buildTopic(env, suffix) => {env}.{suffix}; dedup/idempotency key = (brand_id, event_id); partition key =
