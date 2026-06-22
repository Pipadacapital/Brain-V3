/**
 * ask-brain.ts — the Phase 8 "Ask Brain" use-case (Track B, D7).
 *
 * THE HONEST AI SEAM. Flow for ONE question:
 *   1. resolveQuestion(raw, client) → a VALIDATED binding (registry-known, allow-list
 *      params) OR an honest refusal. The model picks a (metric_id, version, params); it
 *      NEVER emits SQL and NEVER produces a number (Track A / I-S08 / METRICS.md §5).
 *   2. If refusal → return a refusal DTO. NO number is computed or surfaced.
 *   3. If binding → compute the number over the metric-engine SOLE read path (I-ST01),
 *      pinned at `as_of` via the snapshot handle, inside withBrandTxn (RLS-scoped).
 *   4. getMetricTrust (Phase 7) → the FROZEN confidence_grade + trust_tier (reused, never
 *      recomputed).
 *   5. Persist ai_provenance: the binding + snapshot_id + the REDACTED question + the frozen
 *      grade/tier. The RAW question is held in memory ONLY and discarded — never persisted
 *      or logged (D4). The NUMBER is NOT persisted (reproduced from snapshot_id + binding).
 *   6. Return the AskBrainResult DTO (money = bigint-minor string + currency, never float).
 *
 * Reproducibility (D3): the snapshot_id encodes `as_of`; reproduceAnswer(brandId, row, deps)
 * decodes it, re-runs the binding through the SAME engine path → the identical serialized
 * number. The eval gate + a unit test assert byte-identity.
 *
 * @see 02-architecture.md §D3/D4/D7
 */

import type { EngineDeps, MetricId, MetricVersion, SilverPool } from '@brain/metric-engine';
import type { ResolverClient } from '@brain/ai-gateway-client';
import { resolveQuestion } from '../nlq/resolve-question.js';
import type { ValidatedBinding } from '../nlq/resolve-question.js';
import { getMetricTrust } from '../../data-quality/index.js';
import { getRevenueMetrics, getBlendedRoas, getKpiSummary } from '../../analytics/index.js';
import { encodeSnapshot, decodeSnapshot } from './snapshot.js';
import { redactQuestion } from '../provenance/redact-question.js';
import { PgAiProvenanceRepository } from '../provenance/ai-provenance.repository.js';
import type { ConfidenceGrade, TrustTier, ResolvedParams } from '../provenance/ai-provenance.dto.js';

/** Per-currency map of bigint minor units serialized to string (never a float). */
export type MoneyRecord = Record<string, string>;

/**
 * A non-money certified scalar (ratio / percent). `value` is the engine's exact decimal STRING
 * (never a float re-derive); `display` is the formatted surface. `currency_code` records which
 * currency row the scalar came from (ROAS/RTO are read per currency) — surfaced only for a
 * single-currency brand; multi-currency falls to figure_kind='none' (no single blended ratio).
 */
export interface ComputedScalar {
  readonly value: string;
  readonly display: string;
  readonly unit: 'ratio' | 'percent';
  readonly currency_code: string | null;
}

/**
 * The certified, reproducible number for a binding. Money metrics carry a per-currency
 * `money` map (bigint-minor string + currency_code); ratio/percent metrics carry `scalar`.
 * figure_kind='none' = a valid binding whose figure is a distribution/timeline (see its
 * dashboard), not one surfaced scalar. no_data=true = honest empty.
 */
export interface ComputedNumber {
  /** The kind of figure surfaced — drives UI rendering. */
  readonly figure_kind: 'money' | 'ratio' | 'percent' | 'none';
  /** Money per currency (bigint-minor string). Present iff figure_kind='money'. */
  readonly money: MoneyRecord | null;
  /** A non-money scalar. Present iff figure_kind='ratio'|'percent'. */
  readonly scalar: ComputedScalar | null;
  /** Honest-empty discriminant: true when the brand has no data for this binding. */
  readonly no_data: boolean;
}

/** Epoch floor for windowed (non-as-of) reads — mirrors the SQL DATE '2000-01-01' lower bound. */
const WINDOW_EPOCH = new Date('2000-01-01T00:00:00Z');

/** figure_kind='none' helper — a valid binding with no single surfaced scalar (NEVER fabricated). */
const FIGURE_NONE: ComputedNumber = { figure_kind: 'none', money: null, scalar: null, no_data: false };

export interface AskBrainBinding {
  readonly metric_id: MetricId;
  readonly metric_version: MetricVersion;
  readonly params: ResolvedParams;
  readonly snapshot_id: string;
}

/** The result the BFF returns. Discriminated by `kind`. */
export type AskBrainResult =
  | {
      readonly kind: 'answer';
      readonly binding: AskBrainBinding;
      readonly number: ComputedNumber;
      readonly confidence_grade: ConfidenceGrade;
      readonly trust_tier: TrustTier;
      readonly provenance_id: string;
    }
  | {
      readonly kind: 'refusal';
      readonly reason: string;
    };

export interface AskBrainDeps {
  /** Raw pg.Pool for the engine + provenance writer (EngineDeps-compatible). */
  readonly engine: EngineDeps;
  /** StarRocks Silver/Gold pool — the lakehouse readers (ad_spend, blended_roas; Phase G). */
  readonly srPool: SilverPool;
  /** The NLQ resolver gateway client (Track A). */
  readonly resolver: ResolverClient;
}

/**
 * askBrain — resolve a question → certified number + confidence + provenance.
 *
 * @param brandId  - The brand UUID (from session, NEVER request body — I-S01).
 * @param question - The RAW question (held in memory ONLY; never persisted/logged).
 * @param asOf     - The as-of date (server-computed YYYY-MM-DD; pins the snapshot).
 * @param deps     - AskBrainDeps (engine pool + resolver client).
 */
export async function askBrain(
  brandId: string,
  question: string,
  asOf: string,
  deps: AskBrainDeps,
): Promise<AskBrainResult> {
  // 1. Resolve — the ONLY model call. The raw question is passed IN-MEMORY only.
  const outcome = await resolveQuestion(question, deps.resolver);

  // 2. Honest refusal — no number is ever computed or surfaced.
  if (outcome.kind === 'refusal') {
    return { kind: 'refusal', reason: outcome.reason };
  }

  // 3. Pin the read frame + compute over the metric-engine SOLE read path.
  const snapshotId = encodeSnapshot(asOf);
  const number = await computeBinding(brandId, outcome, asOf, deps.engine, deps.srPool);

  // 4. Frozen confidence + tier (Phase 7 — reused, never recomputed).
  const trust = await getMetricTrust(brandId, deps.engine);
  const confidenceGrade = trust.effectiveConfidence as ConfidenceGrade;
  const trustTier = toTrustTier(trust.tier);

  // 5. Persist provenance — REDACTED question only; NO number persisted.
  const repo = new PgAiProvenanceRepository(deps.engine.pool);
  const provenanceId = await repo.insert({
    brandId,
    metricId: outcome.metric_id,
    metricVersion: outcome.version,
    params: outcome.params,
    snapshotId,
    questionRedacted: redactQuestion(question), // raw NEVER persisted
    confidenceGrade,
    trustTier,
  });

  // 6. Return the certified-number DTO.
  return {
    kind: 'answer',
    binding: {
      metric_id: outcome.metric_id,
      metric_version: outcome.version,
      params: outcome.params,
      snapshot_id: snapshotId,
    },
    number,
    confidence_grade: confidenceGrade,
    trust_tier: trustTier,
    provenance_id: provenanceId,
  };
}

/**
 * reproduceAnswer — re-run a persisted binding at its snapshot → the identical number.
 *
 * THE REPRODUCIBILITY GUARANTEE (D3): given a stored provenance row's binding + snapshot_id,
 * decode the as_of and re-run the SAME engine compute path → byte-identical serialized number.
 * Used by the reproducibility unit test + eval gate.
 *
 * @param brandId    - The brand UUID.
 * @param binding    - The persisted binding (metric_id, version, params).
 * @param snapshotId - The persisted snapshot handle.
 * @param deps       - EngineDeps (raw pg.Pool).
 * @param srPool     - StarRocks Silver/Gold pool (lakehouse readers; Phase G).
 */
export async function reproduceAnswer(
  brandId: string,
  binding: { metric_id: MetricId; version: MetricVersion; params: ResolvedParams },
  snapshotId: string,
  deps: EngineDeps,
  srPool: SilverPool,
): Promise<ComputedNumber> {
  const asOf = decodeSnapshot(snapshotId); // throws on a corrupt handle (fail-closed)
  return computeBinding(
    brandId,
    { kind: 'binding', metric_id: binding.metric_id, version: binding.version, params: binding.params },
    asOf,
    deps,
    srPool,
  );
}

/**
 * computeBinding — dispatch a validated binding to the metric-engine sole-read-path.
 *
 * Each metric_id maps to its existing engine compute path (NO ad-hoc SUM, NO model number).
 * Money metrics return a per-currency bigint-minor string map. A metric whose Ask-Brain
 * compute is not yet wired returns figure_kind='none' (honest — a binding with no surfaced
 * number, NEVER a fabricated one).
 */
async function computeBinding(
  brandId: string,
  binding: ValidatedBinding,
  asOf: string,
  deps: EngineDeps,
  srPool: SilverPool,
): Promise<ComputedNumber> {
  const asOfDate = new Date(`${asOf}T00:00:00Z`);

  switch (binding.metric_id) {
    case 'realized_revenue': {
      // Reuse the canonical analytics sole-read-path (identical to the dashboard number).
      const snap = await getRevenueMetrics(brandId, asOfDate, deps);
      if (snap.state === 'no_data') return { figure_kind: 'money', money: null, scalar: null, no_data: true };
      return { figure_kind: 'money', money: snap.realized, scalar: null, no_data: false };
    }
    case 'provisional_revenue': {
      const snap = await getRevenueMetrics(brandId, asOfDate, deps);
      if (snap.state === 'no_data') return { figure_kind: 'money', money: null, scalar: null, no_data: true };
      return { figure_kind: 'money', money: snap.provisional, scalar: null, no_data: false };
    }
    case 'ad_spend': {
      // Ad spend to date — the spend_minor side of the blended-ROAS read (same named seam,
      // ad_spend_as_of). Windowed [epoch, as_of] → deterministic given as_of (reproducible).
      const roas = await getBlendedRoas(brandId, { fromDate: WINDOW_EPOCH, toDate: asOfDate }, { srPool });
      if (roas.state === 'no_data') return { figure_kind: 'money', money: null, scalar: null, no_data: true };
      const money: MoneyRecord = {};
      for (const r of roas.rows) money[r.currency_code] = r.spend_minor;
      return { figure_kind: 'money', money, scalar: null, no_data: false };
    }
    case 'blended_roas': {
      // ROAS = realized ÷ spend (engine-computed exact decimal, never re-derived here). Per
      // currency; surface a single scalar only for a single-currency brand (a blended ratio
      // across currencies is not one number → honest 'none').
      const roas = await getBlendedRoas(brandId, { fromDate: WINDOW_EPOCH, toDate: asOfDate }, { srPool });
      if (roas.state === 'no_data') return { figure_kind: 'ratio', money: null, scalar: null, no_data: true };
      if (roas.rows.length !== 1) return FIGURE_NONE;
      const row = roas.rows[0]!;
      if (row.roas_ratio == null) return { figure_kind: 'ratio', money: null, scalar: null, no_data: true };
      return {
        figure_kind: 'ratio',
        money: null,
        scalar: { value: row.roas_ratio, display: `${row.roas_ratio}×`, unit: 'ratio', currency_code: row.currency_code },
        no_data: false,
      };
    }
    case 'cod_rto_rate': {
      // RTO rate % — the engine's KPI sole-read-path (rto_rate_pct, exact decimal string).
      const kpi = await getKpiSummary(brandId, asOfDate, deps);
      if (kpi.state === 'no_data') return { figure_kind: 'percent', money: null, scalar: null, no_data: true };
      if (kpi.kpis.length !== 1) return FIGURE_NONE;
      const k = kpi.kpis[0]!;
      return {
        figure_kind: 'percent',
        money: null,
        scalar: { value: k.rto_rate_pct, display: `${k.rto_rate_pct}%`, unit: 'percent', currency_code: k.currency_code },
        no_data: false,
      };
    }
    default:
      // The binding is valid + reproducible, but its figure is a distribution/timeline/grade —
      // not a single surfaced scalar (it lives on its dashboard). Honest: no number is surfaced
      // (NEVER fabricated). The provenance still records the binding so the audit trail is complete.
      // NB: confidence grades (cost/effective/attribution_confidence) are deliberately NOT surfaced
      // here — they are time-varying (latest DQ), so they'd break the snapshot-reproducibility
      // guarantee (D3); they are persisted separately as the frozen confidence_grade instead.
      return FIGURE_NONE;
  }
}

/** Map the engine's lowercase trust tier to the UI/DB enum casing. */
function toTrustTier(tier: string): TrustTier {
  switch (tier) {
    case 'trusted':
      return 'Trusted';
    case 'estimated':
      return 'Estimated';
    default:
      return 'Untrusted';
  }
}
