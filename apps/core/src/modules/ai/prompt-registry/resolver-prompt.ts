/**
 * resolver-prompt.ts — the versioned NLQ resolver system prompt (Track A / D1).
 *
 * The STABLE, CACHEABLE prefix handed to the gateway: it lists the certified metric
 * enum + the fixed params allow-list and instructs the model to SELECT-ONLY — never
 * to write SQL, never to produce a number, and to honestly refuse off-domain
 * questions. The model's output is ALSO structurally constrained by the JSON schema
 * (ai-gateway-client/resolver-schema.ts); this prompt is the natural-language half.
 *
 * Versioned (PROMPT_VERSION) so an eval re-baseline is tied to a prompt change.
 */

import { METRIC_REGISTRY, type MetricId } from '@brain/metric-engine';
import { CHANNEL_ENUM } from '@brain/ai-gateway-client';

export const RESOLVER_PROMPT_VERSION = 'nlq-resolver-v1';

/** One-line intent hint per metric id, sourced deterministically from the registry. */
function metricCatalogue(): string {
  return (Object.keys(METRIC_REGISTRY) as MetricId[])
    .map((id) => {
      const def = METRIC_REGISTRY[id].v1;
      // First sentence of the registry description = the human-facing intent.
      const intent = def.description.split('.')[0]?.trim() ?? id;
      return `- ${id} (v1): ${intent}`;
    })
    .join('\n');
}

/**
 * buildResolverSystemPrompt — the stable system prompt. Deterministic (no model
 * call); its content is fully derived from the registry so it can never name a
 * metric the engine cannot compute.
 */
export function buildResolverSystemPrompt(): string {
  return [
    'You are Brain\'s metric resolver. Your ONLY job is to map a user\'s natural-language',
    'question to ONE certified metric from the catalogue below, or to honestly refuse.',
    '',
    'HARD RULES:',
    '- You select a metric_id from the enum. You NEVER write SQL. You NEVER produce a number,',
    '  total, percentage, or any computed value. The number is computed downstream by a',
    '  deterministic engine — not by you.',
    '- You may ONLY set these params: date_from (YYYY-MM-DD), date_to (YYYY-MM-DD), channel',
    `  (one of: ${CHANNEL_ENUM.join(', ')}). No other fields exist.`,
    '- If no certified metric answers the question, OR the question is off-domain, ambiguous,',
    '  or asks for a raw query / unsupported breakdown, return { kind: "refusal" } with a short',
    '  honest reason. Never fabricate a binding to seem helpful.',
    '',
    'CERTIFIED METRIC CATALOGUE (the ONLY metrics that exist):',
    metricCatalogue(),
    '',
    'Respond ONLY with the structured result: either',
    '  { kind: "binding", metric_id, version, params } or { kind: "refusal", reason }.',
  ].join('\n');
}
