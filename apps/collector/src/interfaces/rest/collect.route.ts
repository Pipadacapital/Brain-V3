/**
 * POST /collect — accept-before-validate ingest endpoint.
 *
 * D-1 ORDERING (immutable invariant, block at review if violated):
 *   1. Read body.
 *   2. INSERT INTO collector_spool (durable commit) — AcceptEventUseCase.
 *   3. Return HTTP 200 { accepted: true }.
 *
 * There is NO validation, NO Apicurio call, NO Kafka produce in this handler.
 * Downstream: drainer loop (interfaces/jobs/drainer.ts).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AcceptEventUseCase } from '../../application/accept-event.usecase.js';
import { extractCorrelationId, incrementCounter } from '@brain/observability';
import { loadCollectorConfig } from '@brain/config';
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

function maybeSetFirstPartyCookie(rawBody: Record<string, unknown>, reply: FastifyReply): void {
  if (!loadCollectorConfig().PIXEL_FIRST_PARTY_COOKIE) return;
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
): void {
  // ── CORS (REQUIRED) ──────────────────────────────────────────────────────────────────────────
  // The pixel runs on arbitrary storefront origins (boddactive.com, …) and POSTs events cross-origin
  // to this collector. The browser sends a CORS preflight (OPTIONS /collect) first; without an answer
  // it 404s and the event POST is BLOCKED — so no events ever arrive. We allow any origin (the SDK
  // posts with credentials:"omit", so wildcard is safe) and answer the preflight here, before routing.
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
    // X-Correlation-Id header and carried on the spooled body → injected onto Kafka by the drainer)
    // and brand_id (tenant key, a UUID — not PII) so every accept-path line is correlatable.
    const rlog = log.child({ correlation_id: correlationId, brand_id: brandIdOf(rawBody) });

    // ACK boundary: spool INSERT must commit before we reply.
    const result = await acceptUseCase.execute(rawBody);

    // ACK counter — the denominator of the collector accept+ack SLO (C2 / R-05).
    incrementCounter('collector_accept_total');
    rlog.debug('event accepted + spooled', { spool_id: result.spoolId.toString() });
    maybeSetFirstPartyCookie(rawBody, reply); // ITP defense (flag-gated)
    reply
      .header('X-Correlation-Id', correlationId)
      .header('X-Spool-Id', result.spoolId.toString())
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
    const result = await acceptUseCase.execute(rawBody);

    incrementCounter('collector_accept_total');
    rlog.debug('event accepted + spooled', { spool_id: result.spoolId.toString() });
    maybeSetFirstPartyCookie(rawBody, reply); // ITP defense (flag-gated)
    reply
      .header('X-Correlation-Id', correlationId)
      .header('X-Spool-Id', result.spoolId.toString())
      .header('X-Received-At', result.receivedAt)
      .status(202)
      .send({ accepted: true, received_at: result.receivedAt });
  });

  /**
   * POST /batch — accept-before-validate batch ingest (Phase H pixel). Body: { events: [...] }.
   *
   * Same D-1 ordering as /collect, per event: spool INSERT (durable commit) BEFORE the ACK; NO event
   * validation / Apicurio / Kafka here (the drainer does that). The ONLY structural guard is transport-
   * level — events must be a non-empty array within MAX_BATCH (caps payload vs the 1 MiB body limit);
   * that is an envelope shape check, not event validation. Each event is spooled independently so one
   * malformed event never blocks the rest (it lands in the drainer's quarantine downstream).
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

    // Spool each event durably (D-1) — independent inserts; ACK reflects the spool commit.
    const spoolIds: string[] = [];
    let receivedAt = '';
    for (const ev of events) {
      const rawEvent = (ev ?? {}) as Record<string, unknown>;
      const result = await acceptUseCase.execute(rawEvent);
      incrementCounter('collector_accept_total');
      spoolIds.push(result.spoolId.toString());
      receivedAt = result.receivedAt;
    }

    rlog.debug('batch accepted + spooled', { accepted: spoolIds.length });
    reply
      .header('X-Correlation-Id', correlationId)
      .status(200)
      .send({ accepted: spoolIds.length, received_at: receivedAt, spool_ids: spoolIds });
  });
}

/** Max events per /batch POST — caps payload against the 1 MiB body limit. */
const MAX_BATCH = 50;
