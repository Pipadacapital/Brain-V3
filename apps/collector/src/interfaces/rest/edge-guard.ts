/**
 * edge-guard — per-install_token rate-limit + origin allowlist for /collect (REC-9).
 *
 * REJECT-BEFORE-SPOOL: this is a Fastify preHandler that runs BEFORE the /collect handler
 * inserts into collector_spool. Rejecting abusive traffic here does NOT violate D-1 (the
 * accept-before-validate ordering) — D-1 governs the ACCEPT path (no schema validation /
 * Apicurio / Kafka pre-ACK). Abuse protection is an admission gate, not event validation.
 *
 * INVARIANTS:
 *  - The rate-limit key is the body's install_token (the per-tenant abuse unit). A token-less
 *    body is admitted (it quarantines downstream via R2) but counted under a shared bucket so
 *    a flood of token-less bodies cannot exhaust memory.
 *  - Origin allowlist: when configured, an Origin header not on the allowlist is rejected 403.
 *    Empty allowlist = allow-all (dev default).
 *  - VETO Set-Cookie (REC-4): this plugin NEVER sets a cookie; the edge stays stateless.
 *  - Deterministic tier-1: a fixed-window counter per (token, window). No model, no statistics.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export interface EdgeGuardConfig {
  /** Max events per install_token per window. */
  maxPerWindow: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Allowed Origins (exact match). Empty = allow all (dev). */
  originAllowlist: string[];
  /** Clock injection for tests. */
  now?: () => number;
  /** Max distinct buckets retained (bounds memory under a token-fuzzing flood). */
  maxBuckets?: number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

const TOKENLESS_KEY = '__tokenless__';

export class EdgeRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly maxBuckets: number;

  constructor(private readonly cfg: EdgeGuardConfig) {
    this.now = cfg.now ?? (() => Date.now());
    this.maxBuckets = cfg.maxBuckets ?? 50_000;
  }

  /** Returns true when the request is WITHIN the limit (admit), false when OVER (reject). */
  admit(installToken: string | undefined): boolean {
    const key = installToken && installToken.length > 0 ? installToken : TOKENLESS_KEY;
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.cfg.windowMs) {
      // Evict the oldest bucket if we hit the cap (bounded memory under fuzzing).
      if (!bucket && this.buckets.size >= this.maxBuckets) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { windowStart: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this.cfg.maxPerWindow;
  }

  /** Returns true when the Origin is allowed (or no allowlist configured). */
  originAllowed(origin: string | undefined): boolean {
    if (this.cfg.originAllowlist.length === 0) return true;
    if (!origin) return false; // an allowlist is configured but the request has no Origin → reject
    return this.cfg.originAllowlist.includes(origin);
  }
}

/** Register the edge guard as a preHandler scoped to the /collect routes. */
export function registerEdgeGuard(
  app: FastifyInstance,
  limiter: EdgeRateLimiter,
): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    // Only guard the ingest endpoints.
    if (req.url !== '/collect' && req.url !== '/v1/events') return;

    // Origin allowlist (reject-before-spool).
    const origin = req.headers['origin'] as string | undefined;
    if (!limiter.originAllowed(origin)) {
      // NO Set-Cookie (REC-4) — stateless rejection.
      await reply.code(403).send({ accepted: false, error: { code: 'ORIGIN_NOT_ALLOWED' } });
      return;
    }

    // Per-install_token rate-limit (reject-before-spool).
    const body = (req.body ?? {}) as Record<string, unknown>;
    const props = (body['properties'] ?? {}) as Record<string, unknown>;
    const installToken = typeof props['install_token'] === 'string' ? props['install_token'] : undefined;
    if (!limiter.admit(installToken)) {
      await reply
        .code(429)
        .header('Retry-After', '1')
        .send({ accepted: false, error: { code: 'RATE_LIMITED' } });
      return;
    }
  });
}
