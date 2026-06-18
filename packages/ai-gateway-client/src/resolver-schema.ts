/**
 * resolver-schema.ts — the ONLY shape the NLQ model may return (Track A / D1).
 *
 * STRUCTURAL HONESTY BAN (I-S08 / METRICS.md §5):
 *   - `metric_id` is a JSON-schema `enum` built FROM the metric registry keys, so
 *     the model literally cannot name a metric outside the 16 certified ids.
 *   - There is NO `sql` field and NO `value`/`number`/`amount` field ANYWHERE in
 *     the schema — text-to-SQL and model-authored numbers are STRUCTURALLY
 *     IMPOSSIBLE, not merely discouraged.
 *   - `params` is a fixed allow-list (date range + a known channel enum). Anything
 *     outside it is rejected → coerced to a refusal (fail-closed).
 *
 * The model does ONE job: select a `(metric_id, version, params)` over a fixed
 * enum, or honestly refuse. The number is computed downstream by the metric-engine
 * (Tier-0 deterministic) — never here.
 */

import { METRIC_REGISTRY, type MetricId, type MetricVersion } from '@brain/metric-engine';

// ── The metric_id enum (derived from the registry — the SOLE source of truth) ──

/**
 * The 16 certified metric ids, derived at module-load from METRIC_REGISTRY.
 * If a metric is added/removed in the registry, this enum tracks it automatically —
 * there is no second hand-maintained list to drift.
 */
export const METRIC_ID_ENUM: readonly MetricId[] = Object.keys(METRIC_REGISTRY) as MetricId[];

/**
 * The fixed params allow-list. The model may ONLY populate these keys; the
 * resolver re-validates every value against a static allow-list before compute.
 */
export const PARAM_KEYS = ['date_from', 'date_to', 'channel'] as const;
export type ParamKey = (typeof PARAM_KEYS)[number];

/**
 * The known channel enum (allow-list). Mirrors the deterministic journey channels
 * the registry metrics understand. Any channel value outside this set → refusal.
 */
export const CHANNEL_ENUM = [
  'paid_meta',
  'paid_google',
  'paid_tiktok',
  'paid',
  'email',
  'organic_social',
  'referral',
  'direct',
] as const;
export type Channel = (typeof CHANNEL_ENUM)[number];

export interface ResolvedParams {
  readonly date_from?: string;
  readonly date_to?: string;
  readonly channel?: Channel;
}

// ── The constrained result type (the ONLY thing the resolver may emit) ─────────

export interface BindingResult {
  readonly kind: 'binding';
  readonly metric_id: MetricId;
  readonly version: MetricVersion;
  readonly params: ResolvedParams;
}

export interface RefusalResult {
  readonly kind: 'refusal';
  /** Honest, human-readable "no certified metric answers this" reason. */
  readonly reason: string;
}

/**
 * ResolverResult — a discriminated union with NO `sql` and NO numeric-answer member.
 * The compiler itself is part of the ban: there is no field a number could land in.
 */
export type ResolverResult = BindingResult | RefusalResult;

// ── The JSON Schema handed to the gateway as a tool/structured-output constraint ─

/**
 * The JSON schema the gateway sends as the model's required output shape.
 * `metric_id` is an `enum` of the registry keys — the model cannot return a value
 * outside it. There is deliberately no `sql`/`value`/`number` property defined, and
 * `additionalProperties:false` everywhere forbids the model inventing one.
 */
export function buildResolverJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'metric_id', 'version', 'params'],
        properties: {
          kind: { const: 'binding' },
          metric_id: { type: 'string', enum: [...METRIC_ID_ENUM] },
          version: { type: 'string', pattern: '^v[0-9]+$' },
          params: {
            type: 'object',
            additionalProperties: false,
            properties: {
              date_from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              date_to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              channel: { type: 'string', enum: [...CHANNEL_ENUM] },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'reason'],
        properties: {
          kind: { const: 'refusal' },
          reason: { type: 'string' },
        },
      },
    ],
  };
}

// ── Fail-closed coercion: anything malformed/out-of-enum → refusal ─────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isMetricId(v: unknown): v is MetricId {
  return typeof v === 'string' && (METRIC_ID_ENUM as readonly string[]).includes(v);
}

function isVersion(v: unknown): v is MetricVersion {
  return typeof v === 'string' && /^v[0-9]+$/.test(v);
}

function isChannel(v: unknown): v is Channel {
  return typeof v === 'string' && (CHANNEL_ENUM as readonly string[]).includes(v);
}

/**
 * coerceResolverResult — parse an UNTRUSTED model payload into a ResolverResult.
 *
 * FAIL-CLOSED: any field that is missing, malformed, out-of-enum, or unexpected
 * (e.g. a `sql` or `value`/`number` key the model tried to smuggle in) collapses
 * the result to `{ kind: 'refusal' }`. A number is NEVER read from the model.
 *
 * This is the runtime half of the structural ban (the schema is the request half).
 */
export function coerceResolverResult(raw: unknown): ResolverResult {
  if (typeof raw !== 'object' || raw === null) {
    return refuse('empty or non-object model response');
  }
  const obj = raw as Record<string, unknown>;

  // Reject any attempt to smuggle a query or a number through an unexpected key.
  const BANNED_KEYS = ['sql', 'query', 'value', 'number', 'amount', 'result', 'answer'];
  for (const k of BANNED_KEYS) {
    if (k in obj) {
      return refuse(`model returned a banned field "${k}" — only a metric binding may be selected`);
    }
  }

  if (obj.kind === 'refusal') {
    return { kind: 'refusal', reason: typeof obj.reason === 'string' ? obj.reason : 'no certified metric answers this' };
  }

  if (obj.kind !== 'binding') {
    return refuse(`unrecognized result kind "${String(obj.kind)}"`);
  }

  if (!isMetricId(obj.metric_id)) {
    return refuse('metric_id outside the certified registry enum');
  }
  if (!isVersion(obj.version)) {
    return refuse('invalid metric version');
  }

  const params = coerceParams(obj.params);
  if (params === null) {
    return refuse('params outside the fixed allow-list');
  }

  return { kind: 'binding', metric_id: obj.metric_id, version: obj.version, params };
}

function coerceParams(raw: unknown): ResolvedParams | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  // Any key outside the allow-list fails closed.
  for (const k of Object.keys(obj)) {
    if (!(PARAM_KEYS as readonly string[]).includes(k)) return null;
  }

  const out: { date_from?: string; date_to?: string; channel?: Channel } = {};
  if (obj.date_from !== undefined) {
    if (typeof obj.date_from !== 'string' || !ISO_DATE.test(obj.date_from)) return null;
    out.date_from = obj.date_from;
  }
  if (obj.date_to !== undefined) {
    if (typeof obj.date_to !== 'string' || !ISO_DATE.test(obj.date_to)) return null;
    out.date_to = obj.date_to;
  }
  if (obj.channel !== undefined) {
    if (!isChannel(obj.channel)) return null;
    out.channel = obj.channel;
  }
  return out;
}

function refuse(reason: string): RefusalResult {
  return { kind: 'refusal', reason };
}
