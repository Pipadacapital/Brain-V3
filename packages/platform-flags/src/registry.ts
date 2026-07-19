// SPEC: 0.5
/**
 * @brain/platform-flags — the TYPED registry of every known per-brand feature flag.
 *
 * §0.5: "New behavior ships behind feature flags (per-brand; …default OFF)."
 * This const object is the single source of truth for which flags EXIST. A flag
 * not in this registry cannot be set and always reads as disabled (fail-closed):
 * a typo'd flag name can never accidentally enable anything.
 *
 * Waves B–I add their flags HERE (additive — never remove or rename an entry;
 * a retired flag is deleted only after every read site is gone).
 *
 * The Python twin (db/iceberg/spark/_platform_flags.py) mirrors the WAVE-A names
 * Spark jobs read (stitch.v2) — keep the two lists in lockstep.
 */

export interface FlagDefinition {
  /** The program wave that owns this flag (flag matrix, PLAN-OF-RECORD §"Flag matrix"). */
  readonly wave: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';
  /** The spec section whose behavior this flag gates. */
  readonly spec: string;
  /** One-line operator-facing description (shown in the admin surface). */
  readonly description: string;
}

export const PLATFORM_FLAGS = {
  // ── Wave A — identity foundation ────────────────────────────────────────────
  'pixel.identify': {
    wave: 'A',
    spec: 'A.1.1',
    description: 'Pixel emits pixel.identify.v1 (client-hashed email/phone identify events).',
  },
  'pixel.autodetect.enabled': {
    wave: 'A',
    spec: 'A.1.1',
    description:
      'Pixel MutationObserver form auto-detect (email/tel inputs, on-blur hash-and-fire). Requires consent.',
  },
  'connector.identity_fields': {
    wave: 'A',
    spec: 'A.1.4',
    description: 'Connectors hash + emit the expanded identity field set in-process before Kafka.',
  },
  'stitch.v2': {
    wave: 'A',
    spec: 'A.2.1',
    description:
      'Spark incremental multi-key stitch → silver_session_identity (+ silver_stitch_conflicts).',
  },
  'identity.probabilistic': {
    wave: 'A',
    spec: 'A.3',
    description:
      'Probabilistic matcher writes silver_probabilistic_stitch (quarantined; never attribution/revenue).',
  },
  'identity.tp_cache': {
    wave: 'A',
    spec: 'A.4',
    description: 'Redis touchpoint cache consumer ({brand}:tp:{brain} zset, deterministic-only).',
  },
  'identity.priority_config': {
    wave: 'A',
    spec: 'A.1.5',
    description:
      'Per-brand ORDERED identity priority resolution (highest-priority match wins; lower-priority conflict → route to review, NEVER silent overwrite). OFF = fixed-tier union-find, byte-identical.',
  },
  'identity.shared_device_guard': {
    wave: 'A',
    spec: 'A.2.3.4',
    description:
      'Resolver shared-device guard: a medium (anon/device) signal may NOT pull a NEW strong identifier into a brain already owned by a DIFFERENT strong identifier — the new strong id mints its own person, so two family members on one device stay separate brains (stitch surfaces the conflict). OFF = legacy medium-adoption, byte-identical.',
  },

  // ── Wave B — journey ────────────────────────────────────────────────────────
  'journey.engine': {
    wave: 'B',
    spec: 'B',
    description: 'Canonical journey generation v2 (versioned journey_events consumers).',
  },

  // ── Audit gap G1 — query-time bi-temporal identity for the REVENUE spine ──────
  'identity.revenue_querytime': {
    wave: 'A',
    spec: 'A.2.2 / audit-G1',
    description:
      'Revenue spine (silver_order_state / gold_revenue_ledger / gold_customer_360) resolves ' +
      'brain_id at QUERY TIME against the bi-temporal, MULTI-KEY silver_identity_map ' +
      '(email + phone + platform_customer_id; identity_current predicate; merge-reconciled) into ' +
      'an ADDITIVE brain_id_v2 column, run in PARALLEL with the legacy flat single-key ' +
      '(pre_hashed_email → silver_identity_alias) brain_id for parity comparison. OFF (default, ' +
      'fail-closed) → brain_id_v2 is NULL and the legacy flat brain_id stays byte-identical to pre-wave.',
  },

  // ── Wave C — measurement ────────────────────────────────────────────────────
  'measurement.marts_migration': {
    wave: 'C',
    spec: 'C.4',
    description: 'CAC/ROAS/executive marts read gold_measurement_* (parity-gated vs legacy).',
  },
  // 'measurement.inventory_movement' (C.2.6) RETIRED by DR-002: the inventory movement fact and its
  // silver_inventory_level source were consumer-less and deleted (Bronze-replayable when a surface ships).

  // ── Wave D — semantic serving ───────────────────────────────────────────────
  'semantic.serving': {
    wave: 'D',
    spec: 'D.3',
    description: 'Gateway/dashboards/BAI serve from compiled semantic views (per-endpoint parity).',
  },

  // ── Waves E–I — scaffolds (OFF by construction; endpoints 501 behind flag) ──
  'features.online_serving': {
    wave: 'E',
    spec: 'E',
    description: 'Online feature endpoint GET /v1/features/... (501 stub until Wave E logic ships).',
  },
  'recommendations.api': {
    wave: 'G',
    spec: 'G',
    description:
      'GET /v1/recommendations over gold_recommendations (501 stub per AMD-21 until models ship).',
  },
  'recommendations.request_time': {
    wave: 'G',
    spec: 'realtime-phase-2',
    description:
      'Realtime Phase 2: GET /v1/recommendations computes the detector set at REQUEST TIME against ' +
      'the freshest Silver/Gold (duckdb-serving), Redis-cached + gold.rewritten.v1-invalidated, instead of ' +
      'reading the batch-cron-persisted set. OFF (default) = the stored getRecommendations path.',
  },

  // ── Wave F — AI platform infrastructure (SPEC:F; scaffold-only, OFF by construction) ──
  'ai.gateway.call_logging': {
    wave: 'F',
    spec: 'F.2',
    description:
      'LiteLLM success/failure callback logs each model call to ops_llm_calls (prompt HASH + ' +
      'redacted-PII prompt store via the masking hook). OFF = no logger, no ops_llm_calls writes. ' +
      'Adapter is NotImplemented until Wave F logic ships.',
  },
  'ai.copilot.tools': {
    wave: 'F',
    spec: 'F.3',
    description:
      'MCP copilot tool surface exposed to an agent runtime (read-only tools over the semantic ' +
      'catalog + Journey/Feature APIs; NEVER Trino/raw tables). OFF = registry inert, no agent ' +
      'runtime mounts the tools. execution_mode `auto` code path remains unreachable (Wave I gate).',
  },

  // ── Wave H — decision engine (SPEC:H; scaffold-only, OFF by construction) ──
  'decision.engine': {
    wave: 'H',
    spec: 'H',
    description:
      'Decision engine over gold_decisions (versioned-policy-compiled arbitration; candidates + ' +
      'per-candidate EV + constraint evaluations persisted). OFF = decision-policies compiler is ' +
      'shape-validation only, NO evaluator/EV/arbitration runs and NO gold_decisions rows are ' +
      'written. Evaluator adapter is NotImplemented until Wave H logic ships.',
  },

  // ── Wave I — action platform (SPEC:I; per-executor, fail-closed; adapters are NotImplemented) ──
  'actions.executor.shopify_discount': {
    wave: 'I',
    spec: 'I',
    description:
      'Expose the shopify-discount ExecutorPort adapter (@brain/action-core). OFF + adapter ' +
      'NotImplemented until the Wave-I governance gate (human-approved policy version + holdout ' +
      'support + per-executor rollback) is met; execution_mode `auto` stays unreachable meanwhile.',
  },
  'actions.executor.meta_audience': {
    wave: 'I',
    spec: 'I',
    description:
      'Expose the meta-audience ExecutorPort adapter (@brain/action-core). OFF + adapter ' +
      'NotImplemented until the Wave-I governance gate is met.',
  },
  'actions.executor.messaging': {
    wave: 'I',
    spec: 'I',
    description:
      'Expose the messaging ExecutorPort adapter (@brain/action-core). OFF + adapter ' +
      'NotImplemented until the Wave-I governance gate is met.',
  },
  'actions.executor.webhook': {
    wave: 'I',
    spec: 'I',
    description:
      'Expose the webhook ExecutorPort adapter (@brain/action-core). OFF + adapter ' +
      'NotImplemented until the Wave-I governance gate is met.',
  },
} as const satisfies Record<string, FlagDefinition>;

/** Union of every known flag name — the only strings isFlagEnabled/setFlag accept. */
export type PlatformFlag = keyof typeof PLATFORM_FLAGS;

/** All known flag names, in registry order (drives the admin list surface). */
export const ALL_PLATFORM_FLAGS = Object.keys(PLATFORM_FLAGS) as PlatformFlag[];

/** Type guard: is this string a registered flag? Unknown flags always read disabled. */
export function isKnownFlag(flag: string): flag is PlatformFlag {
  return Object.prototype.hasOwnProperty.call(PLATFORM_FLAGS, flag);
}
