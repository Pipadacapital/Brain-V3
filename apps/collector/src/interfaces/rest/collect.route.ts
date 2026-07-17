/**
 * POST /collect — accept-before-validate ingest endpoint.
 *
 * D-1 ORDERING (immutable invariant, re-anchored by ADR-0015 direct-to-log ingest):
 *   1. Read body.
 *   2. PRODUCE to the log (idempotent producer, acks=-1) — the produce-ack is the durability
 *      anchor. On produce failure: fsync'd append to the bounded local-disk WAL instead
 *      (AcceptEventUseCase.anchor) — the fallback append is then the anchor.
 *   3. Return HTTP 200 { accepted: true }.
 *
 * There is NO validation and NO Apicurio call in this handler. The Postgres spool + drainer
 * are DELETED (ADR-0015 D1) — downstream is Connect → Bronze → Silver.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AcceptEventUseCase } from '../../application/accept-event.usecase.js';
import { extractCorrelationId, incrementCounter } from '@brain/observability';
import { log } from '../../log.js';

/** brand_id (tenant key, a UUID — not PII) off a raw ingest body, when present pre-validation. */
function brandIdOf(rawBody: Record<string, unknown>): string | undefined {
  return typeof rawBody['brand_id'] === 'string' ? (rawBody['brand_id'] as string) : undefined;
}

/**
 * ITP defense (M1 pixel scope): set the brain_anon_id as a SERVER-set first-party cookie. Safari/ITP
 * caps SCRIPT-set (document.cookie) first-party cookies to 7 days, but NOT HTTP-`Set-Cookie` ones —
 * so the server stamping it here makes the anon-id durable when served from a first-party CNAME.
 * Flag-gated (PIXEL_FIRST_PARTY_COOKIE=true) + only effective on a first-party ingest host; the
 * stateless-edge default (REC-4) stays unless enabled. UUID-guarded (no header injection).
 */
const ANON_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TWO_YEARS_SECONDS = 63_072_000;

function maybeSetFirstPartyCookie(
  rawBody: Record<string, unknown>,
  reply: FastifyReply,
  enabled: boolean,
): void {
  if (!enabled) return;
  const props = rawBody['properties'] as Record<string, unknown> | undefined;
  const anon = typeof props?.['brain_anon_id'] === 'string' ? (props['brain_anon_id'] as string) : '';
  if (!ANON_UUID_RE.test(anon)) return;
  reply.header(
    'Set-Cookie',
    `__brain_anon_id=${anon}; Max-Age=${TWO_YEARS_SECONDS}; Path=/; SameSite=Lax; Secure; HttpOnly`,
  );
}

export function registerCollectRoute(
  app: FastifyInstance,
  acceptUseCase: AcceptEventUseCase,
  opts: { firstPartyCookie?: boolean } = {},
): void {
  // D-1: the accept/ACK path must NOT read the full collector config. The first-party-cookie
  // flag is injected at wiring time (main.ts) so the hot path stays config-load-independent.
  const firstPartyCookie = opts.firstPartyCookie ?? false;
  // ── CORS (REQUIRED) ──────────────────────────────────────────────────────────────────────────
  // The pixel runs on arbitrary storefront origins (boddactive.com, …) and POSTs events cross-origin
  // to this collector. The browser sends a CORS preflight (OPTIONS /collect) first; without an answer
  // it 404s and the event POST is BLOCKED — so no events ever arrive. We allow any origin (the SDK
  // posts with credentials:"omit", so wildcard is safe) and answer the preflight here, before routing.
  // NOTE (AUD-INFRA-025): the ACAO header is response plumbing, NOT the access decision — Origin
  // ENFORCEMENT (EDGE_ORIGIN_ALLOWLIST) and install_token→brand_id binding live in the edge-guard
  // preHandler, which 403s the actual POST before it reaches the accept path.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      await reply
        .header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Content-Type, X-Correlation-Id, Idempotency-Key')
        .header('Access-Control-Max-Age', '86400')
        .code(204)
        .send();
    }
  });

  app.post('/collect', async (req: FastifyRequest, reply: FastifyReply) => {
    const correlationId = extractCorrelationId(
      req.headers as Record<string, string | string[] | undefined>,
    );

    // Body is accepted as raw JSON — no schema validation in this handler (D-1).
    const rawBody = (req.body ?? {}) as Record<string, unknown>;

    // Request-scoped child logger: bind correlation_id (start of the trace chain, echoed in the
    // X-Correlation-Id header and carried onto the Kafka message headers) and brand_id (tenant
    // key, a UUID — not PII) so every accept-path line is correlatable.
    const rlog = log.child({ correlation_id: correlationId, brand_id: brandIdOf(rawBody) });

    // ACK boundary (ADR-0015): produce-ack (or fallback WAL append) must land before we reply.
    const result = await acceptUseCase.execute(rawBody, correlationId);

    // ACK counter — the denominator of the collector accept+ack SLO (C2 / R-05).
    incrementCounter('collector_accept_total');
    rlog.debug('event accepted', { durability: result.durability });
    maybeSetFirstPartyCookie(rawBody, reply, firstPartyCookie); // ITP defense (flag-gated)
    reply
      .header('X-Correlation-Id', correlationId)
      .header('X-Received-At', result.receivedAt)
      .status(200)
      .send({ accepted: true, received_at: result.receivedAt });
  });

  // Also support /v1/events as an alias (contract OpenAPI path)
  app.post('/v1/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const correlationId = extractCorrelationId(
      req.headers as Record<string, string | string[] | undefined>,
    );
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const rlog = log.child({ correlation_id: correlationId, brand_id: brandIdOf(rawBody) });
    const result = await acceptUseCase.execute(rawBody, correlationId);

    incrementCounter('collector_accept_total');
    rlog.debug('event accepted', { durability: result.durability });
    maybeSetFirstPartyCookie(rawBody, reply, firstPartyCookie); // ITP defense (flag-gated)
    reply
      .header('X-Correlation-Id', correlationId)
      .header('X-Received-At', result.receivedAt)
      .status(202)
      .send({ accepted: true, received_at: result.receivedAt });
  });

  /**
   * POST /batch — accept-before-validate batch ingest (Phase H pixel). Body: { events: [...] }.
   *
   * Same D-1 ordering as /collect: ONE produceBatch (or ONE fsync'd WAL append) BEFORE the ACK;
   * NO event validation / Apicurio here. The ONLY structural guard is transport-level — events
   * must be a non-empty array within MAX_BATCH (caps payload vs the 1 MiB body limit); that is
   * an envelope shape check, not event validation. Events are never validated here, so a
   * malformed event still lands as-received and is quarantined in Silver downstream.
   */
  app.post('/batch', async (req: FastifyRequest, reply: FastifyReply) => {
    const correlationId = extractCorrelationId(
      req.headers as Record<string, string | string[] | undefined>,
    );

    // Request-scoped child logger — correlation_id binds the whole batch; brand_id is per-event
    // (a batch may span events from one storefront) so it is not bound at batch scope.
    const rlog = log.child({ correlation_id: correlationId });

    const body = (req.body ?? {}) as { events?: unknown };
    const events = body.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > MAX_BATCH) {
      rlog.warn('rejected /batch — events must be a non-empty array within MAX_BATCH', {
        count: Array.isArray(events) ? events.length : 0,
        max_batch: MAX_BATCH,
      });
      return reply.status(400).send({
        accepted: 0,
        error: { code: 'INVALID_BATCH', message: `events must be a non-empty array of at most ${MAX_BATCH} items.` },
      });
    }

    // Anchor the whole batch durably in ONE produceBatch — one broker round-trip (or one
    // fsync'd WAL append when the log is down) before the ACK. Atomic at batch granularity:
    // the batch anchors entirely or 5xxs entirely (the client retry contract re-sends it).
    const rawEvents = events.map((ev) => (ev ?? {}) as Record<string, unknown>);
    const result = await acceptUseCase.executeMany(rawEvents, correlationId);
    incrementCounter('collector_accept_total', {}, rawEvents.length);

    rlog.debug('batch accepted', { accepted: result.accepted, durability: result.durability });
    reply
      .header('X-Correlation-Id', correlationId)
      .status(200)
      .send({ accepted: result.accepted, received_at: result.receivedAt });
  });
}

/** Max events per /batch POST — caps payload against the 1 MiB body limit. */
const MAX_BATCH = 50;
