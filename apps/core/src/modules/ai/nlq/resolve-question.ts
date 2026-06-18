/**
 * resolve-question.ts — the NLQ resolver orchestrator (Track A / D1).
 *
 * Flow: question → gateway (constrained model selection) → registry + allow-list
 * re-validation → { kind: 'binding' | 'refusal' }.
 *
 * This module does NOT compute a number and does NOT emit SQL. It produces a
 * validated binding (or an honest refusal); Track B's `askBrain` hands the binding
 * to the metric-engine for the (Tier-0, deterministic) number.
 *
 * Defense in depth: even though the gateway already coerces fail-closed, the
 * resolver re-checks the binding against `resolveMetric()` (registry SoR) and the
 * static params allow-list before declaring it valid. A binding that the registry
 * does not know, or params outside the allow-list, collapses to a refusal — a
 * number is NEVER produced for an unresolvable question.
 */

import {
  ResolverClient,
  type ResolverResult,
  type ResolvedParams,
  CHANNEL_ENUM,
} from '@brain/ai-gateway-client';
import { resolveMetric, type MetricId, type MetricVersion } from '@brain/metric-engine';
import { buildResolverSystemPrompt } from '../prompt-registry/resolver-prompt.js';

/** A fully validated binding: registry-known + allow-list-clean params. */
export interface ValidatedBinding {
  readonly kind: 'binding';
  readonly metric_id: MetricId;
  readonly version: MetricVersion;
  readonly params: ResolvedParams;
}

export interface ResolverRefusal {
  readonly kind: 'refusal';
  readonly reason: string;
}

export type ResolveOutcome = ValidatedBinding | ResolverRefusal;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * resolveQuestion — resolve ONE NL question to a validated binding or refusal.
 *
 * @param question - the raw, IN-MEMORY question. NEVER persisted or logged here
 *                   (only the redacted form is stored downstream by Track B).
 * @param client   - the gateway client (injectable; tests pass a stub transport).
 */
export async function resolveQuestion(
  question: string,
  client: ResolverClient,
): Promise<ResolveOutcome> {
  const system = buildResolverSystemPrompt();
  const result: ResolverResult = await client.resolve({ system, question });

  if (result.kind === 'refusal') {
    return { kind: 'refusal', reason: result.reason };
  }

  // Re-validate against the registry SoR (throws on unknown → refusal).
  try {
    resolveMetric(result.metric_id, result.version);
  } catch {
    return { kind: 'refusal', reason: 'no certified metric answers this question' };
  }

  // Re-validate params against the static allow-list (defense in depth).
  const params = validateParams(result.params);
  if (params === null) {
    return { kind: 'refusal', reason: 'requested filters are outside the supported set' };
  }

  return { kind: 'binding', metric_id: result.metric_id, version: result.version, params };
}

function validateParams(raw: ResolvedParams): ResolvedParams | null {
  const out: { date_from?: string; date_to?: string; channel?: ResolvedParams['channel'] } = {};
  if (raw.date_from !== undefined) {
    if (!ISO_DATE.test(raw.date_from)) return null;
    out.date_from = raw.date_from;
  }
  if (raw.date_to !== undefined) {
    if (!ISO_DATE.test(raw.date_to)) return null;
    out.date_to = raw.date_to;
  }
  if (raw.channel !== undefined) {
    if (!(CHANNEL_ENUM as readonly string[]).includes(raw.channel)) return null;
    out.channel = raw.channel;
  }
  // date_from must not be after date_to (honest range).
  if (out.date_from && out.date_to && out.date_from > out.date_to) return null;
  return out;
}
