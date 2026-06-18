/**
 * client.ts — the @brain/ai-gateway-client litellm seam (Track A / D1).
 *
 * Wraps the litellm gateway (LITELLM_BASE_URL, default http://localhost:4000) and
 * makes a SINGLE tool/JSON-schema-constrained call to the latest Claude model to
 * resolve an NL question into a `ResolverResult` (binding | refusal).
 *
 * Cost doctrine (cost-routing-paradigms, Tier-3 — the ONLY model call in Phase 8):
 *   - temperature 0 (deterministic selection), max_tokens capped (≤256 output).
 *   - 1 transport retry MAX, then a fail-closed refusal (no retry storms).
 *   - The stable system prompt (enum + allow-list + select-only instruction) is the
 *     cacheable prefix — passed as the `system` field so the gateway can prompt-cache
 *     it across calls. A cache miss on this stable prefix is a cost bug.
 *
 * The model can ONLY return the constrained schema (resolver-schema.ts); its payload
 * is run through `coerceResolverResult` (fail-closed) so a malformed/out-of-enum
 * response — or any smuggled `sql`/number — becomes a refusal. No number is ever
 * read from the model.
 *
 * TESTABILITY: the HTTP call is behind an injectable `GatewayTransport`. Tests pass
 * a deterministic stub (no live LLM in CI); production uses `fetchTransport`.
 */

import {
  buildResolverJsonSchema,
  coerceResolverResult,
  type ResolverResult,
} from './resolver-schema.js';

/** The latest Claude model served by the litellm gateway for this Tier-3 task. */
export const DEFAULT_RESOLVER_MODEL = 'claude-opus-4-8';

/** Hard cost caps for the single resolver call (cost-routing Tier-3 budget). */
export const RESOLVER_MAX_OUTPUT_TOKENS = 256;
export const RESOLVER_TEMPERATURE = 0;

export interface GatewayRequest {
  readonly model: string;
  readonly system: string;
  readonly question: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly maxTokens: number;
  readonly temperature: number;
}

/**
 * GatewayTransport — the injectable HTTP seam. Returns the RAW JSON object the model
 * emitted into the constrained tool/output (UNTRUSTED — coerced by the caller).
 * Throws on transport error (the client retries once then refuses).
 */
export type GatewayTransport = (req: GatewayRequest) => Promise<unknown>;

export interface ResolverClientConfig {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly transport?: GatewayTransport;
}

export interface ResolveCall {
  readonly system: string;
  readonly question: string;
}

export class ResolverClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly transport: GatewayTransport;

  constructor(config: ResolverClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.LITELLM_BASE_URL ?? 'http://localhost:4000').replace(/\/$/, '');
    this.model = config.model ?? DEFAULT_RESOLVER_MODEL;
    this.transport = config.transport ?? fetchTransport(this.baseUrl, config.apiKey ?? process.env.LITELLM_API_KEY);
  }

  /**
   * resolve — ONE model call, fail-closed to a refusal on any error/malformed output.
   * The raw question is passed IN-MEMORY only; this client never persists or logs it.
   */
  async resolve(call: ResolveCall): Promise<ResolverResult> {
    const req: GatewayRequest = {
      model: this.model,
      system: call.system,
      question: call.question,
      jsonSchema: buildResolverJsonSchema(),
      maxTokens: RESOLVER_MAX_OUTPUT_TOKENS,
      temperature: RESOLVER_TEMPERATURE,
    };

    let raw: unknown;
    try {
      raw = await this.transport(req);
    } catch {
      // 1 retry max on transport error, then refuse (no retry storms).
      try {
        raw = await this.transport(req);
      } catch {
        return { kind: 'refusal', reason: 'resolver temporarily unavailable — no certified metric answer produced' };
      }
    }
    return coerceResolverResult(raw);
  }
}

/**
 * fetchTransport — the production litellm transport (native fetch, no extra dep).
 * Sends an OpenAI-compatible chat-completions request with a JSON-schema response
 * format. The `system` prompt is the cacheable stable prefix.
 */
export function fetchTransport(baseUrl: string, apiKey?: string): GatewayTransport {
  return async (req: GatewayRequest): Promise<unknown> => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.question },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'resolver_result', strict: true, schema: req.jsonSchema },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`[ai-gateway-client] litellm returned ${res.status}`);
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('[ai-gateway-client] no content in gateway response');
    }
    return JSON.parse(content) as unknown;
  };
}
