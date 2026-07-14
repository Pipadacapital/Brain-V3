// SPEC: D.3
/**
 * @brain/metric-engine — SemanticServingRouter (the Wave-D consumer-migration flag switch).
 *
 * ── WHAT THIS IS ──────────────────────────────────────────────────────────────
 * Wave D converges BAI answers and dashboard numbers by construction: every one of the
 * certified metrics is served through ONE compiled definition. Consumers (BFF/dashboards/BAI)
 * migrate off the legacy Gold marts and onto the COMPILED semantic views — but ONLY behind the
 * per-brand `semantic.serving` flag (§0.5, DEFAULT OFF). This router is the single, additive
 * switch every migrated read passes through:
 *
 *   flag OFF (default)  → legacyCompute()   — the existing mv_gold_* mart read. BYTE-IDENTICAL.
 *   flag ON  + compiled → semanticCompute() — the compiled semantic-view read (D.2 artifact).
 *   flag ON  + NO compiled read for this metric → legacyCompute() (safe per-metric migration:
 *                          a metric whose compiled view has not landed yet stays on legacy even
 *                          with the flag ON, so brands can flip the flag before every metric is
 *                          migrated without ever getting a 500 or an empty panel).
 *
 * This mirrors the proven ServingCacheReader.enabled pass-through pattern: the OFF path is a pure
 * pass-through to the legacy closure, so turning the flag on/off can NEVER change a number for a
 * metric that hasn't been migrated, and turning it on for a migrated metric serves the compiled
 * view — which the D3 parity tests pin to be equal to the legacy mart to the minor unit.
 *
 * ── WHY A STRUCTURAL FLAG PORT (not a @brain/platform-flags import) ────────────
 * metric-engine is a leaf serving library with a single runtime dep (@brain/money). It must NOT
 * take a hard dependency on the flags package (hexagonal boundary + build-graph hygiene). The
 * SemanticFlagPort below is the minimal structural port the composition root's FlagService
 * satisfies at runtime. FAIL-CLOSED is inherited from FlagService (a store error reads false),
 * and this router additionally treats ANY thrown flag read as OFF — a flag lookup can never break
 * a serving read (it degrades to the legacy path).
 *
 * @see packages/platform-flags/src/domain/flag-service.ts — the concrete FlagService (DEFAULT OFF)
 * @see packages/metric-engine/src/serving-cache.ts        — the sibling enabled-pass-through pattern
 * @see knowledge-base/amendments/AMD-25-d3-compiled-view-precondition.md — the D.2 precondition note
 */

/** The one flag this router reads. Kept as a literal so the port stays independent of the registry. */
export const SEMANTIC_SERVING_FLAG = 'semantic.serving' as const;

/**
 * The metrics WD-D3 migrates first — the highest-value, most-asked headline metrics the delta plan
 * calls out (revenue / orders / aov / roas / cac / cm*). This is the D.3 migration scope, NOT the
 * full 22-metric registry: a metric listed here is one whose compiled semantic view is a migration
 * target and whose parity is pinned by the D3.parity tests. Metrics not listed here still route
 * through this router (they just fall back to legacy under the flag until their compiled view lands).
 */
export const SEMANTIC_SERVING_METRICS = [
  'realized_revenue',
  'provisional_revenue',
  'order_status_mix',
  'aov',
  'blended_roas',
  'cac',
  'cod_mix', // CoD CM2 / contribution-after-RTO — the served CM* metric (AMD-17)
] as const;

export type SemanticServingMetric = (typeof SEMANTIC_SERVING_METRICS)[number];

/** Is this metricId in the D.3 first-migration scope? */
export function isSemanticServingMetric(metricId: string): metricId is SemanticServingMetric {
  return (SEMANTIC_SERVING_METRICS as readonly string[]).includes(metricId);
}

// ── Structural flag port (satisfied by @brain/platform-flags FlagService) ───────

/**
 * Minimal structural port for reading the `semantic.serving` flag. The composition root's
 * FlagService satisfies this at runtime (its isFlagEnabled accepts the flag union, of which
 * 'semantic.serving' is a member). No @brain/platform-flags import in this package.
 */
export interface SemanticFlagPort {
  isFlagEnabled(brandId: string, flag: string): Promise<boolean>;
}

/**
 * A compiled semantic read closure for a metric — the D.2 artifact read (compiled Trino view).
 * Registered per metric id; the router calls it ONLY when the flag is ON for the brand.
 */
export type SemanticCompute<T = unknown> = () => Promise<T>;

export interface SemanticServingRouterConfig {
  /** The flag port (FlagService). Absent → the router is a permanent pass-through (always legacy). */
  readonly flags?: SemanticFlagPort;
  /**
   * OPTIONAL default-off master kill for the whole router regardless of per-brand flag state
   * (composition-root env). Defaults to true (router active); set false to force every read legacy
   * (e.g. a global rollback without touching per-brand flags). NEVER forces compiled — it can only
   * force legacy.
   */
  readonly enabled?: boolean;
}

export interface SemanticServingRouter {
  /**
   * Route ONE metric read through the semantic-serving flag switch.
   *
   * @param brandId         - brand UUID (from session; the flag is read for THIS brand).
   * @param metricId        - the registered metric id being served.
   * @param legacyCompute   - the existing mv_gold_* mart read (the safe-OFF path). ALWAYS provided.
   * @param semanticCompute - OPTIONAL compiled semantic-view read. When absent (metric not yet
   *                          migrated) the router serves legacy even with the flag ON.
   * @returns the metric value — from the compiled view iff (flag ON ∧ semanticCompute given), else legacy.
   */
  route<T>(
    brandId: string,
    metricId: string,
    legacyCompute: () => Promise<T>,
    semanticCompute?: SemanticCompute<T>,
  ): Promise<T>;

  /**
   * Resolve which serving MODE a read WOULD take, without running either closure. Used by parity
   * tests and by the /catalog surface to report per-brand migration state. Never throws.
   */
  resolveMode(brandId: string, metricId: string, hasSemanticCompute: boolean): Promise<'legacy' | 'semantic'>;
}

/**
 * Create the SemanticServingRouter. Inject at the composition root; pass to the BFF routes + the
 * BAI ask path. With no `flags` (or enabled=false) it is a pure legacy pass-through, so a build
 * that hasn't wired the flag service is exactly the pre-Wave-D behavior.
 */
export function createSemanticServingRouter(
  config: SemanticServingRouterConfig = {},
): SemanticServingRouter {
  const { flags } = config;
  const enabled = config.enabled ?? true;

  /** FAIL-CLOSED flag read: any error (or missing port / disabled router) → false → legacy. */
  async function flagOn(brandId: string): Promise<boolean> {
    if (!enabled || !flags || !brandId) return false;
    try {
      return await flags.isFlagEnabled(brandId, SEMANTIC_SERVING_FLAG);
    } catch {
      return false;
    }
  }

  return {
    async route<T>(
      brandId: string,
      _metricId: string,
      legacyCompute: () => Promise<T>,
      semanticCompute?: SemanticCompute<T>,
    ): Promise<T> {
      // No compiled read available for this metric → legacy, regardless of flag (safe migration).
      if (!semanticCompute) return legacyCompute();
      const on = await flagOn(brandId);
      return on ? semanticCompute() : legacyCompute();
    },

    async resolveMode(
      brandId: string,
      _metricId: string,
      hasSemanticCompute: boolean,
    ): Promise<'legacy' | 'semantic'> {
      if (!hasSemanticCompute) return 'legacy';
      return (await flagOn(brandId)) ? 'semantic' : 'legacy';
    },
  };
}
