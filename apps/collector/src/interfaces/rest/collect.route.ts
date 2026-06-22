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

/**
 * ITP defense (M1 pixel scope): set the brain_anon_id as a SERVER-set first-party cookie. Safari/ITP
 * caps SCRIPT-set (document.cookie) first-party cookies to 7 days, but NOT HTTP-`Set-Cookie` ones —
 * so the server stamping it here makes the anon-id durable when served from a first-party CNAME.
 * Flag-gated (PIXEL_FIRST_PARTY_COOKIE=true) + only effective on a first-party ingest host; the
 * stateless-edge default (REC-4) stays unless enabled. UUID-guarded (no header injection).
 */
const FIRST_PARTY_COOKIE = process.env['PIXEL_FIRST_PARTY_COOKIE'] === 'true';
const ANON_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TWO_YEARS_SECONDS = 63_072_000;

function maybeSetFirstPartyCookie(rawBody: Record<string, unknown>, reply: FastifyReply): void {
  if (!FIRST_PARTY_COOKIE) return;
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
  app.post('/collect', async (req: FastifyRequest, reply: FastifyReply) => {
    const correlationId = extractCorrelationId(
      req.headers as Record<string, string | string[] | undefined>,
    );

    // Body is accepted as raw JSON — no schema validation in this handler (D-1).
    const rawBody = (req.body ?? {}) as Record<string, unknown>;

    // ACK boundary: spool INSERT must commit before we reply.
    const result = await acceptUseCase.execute(rawBody);

    // ACK counter — the denominator of the collector accept+ack SLO (C2 / R-05).
    incrementCounter('collector_accept_total');
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
    const result = await acceptUseCase.execute(rawBody);

    incrementCounter('collector_accept_total');
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

    const body = (req.body ?? {}) as { events?: unknown };
    const events = body.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > MAX_BATCH) {
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

    reply
      .header('X-Correlation-Id', correlationId)
      .status(200)
      .send({ accepted: spoolIds.length, received_at: receivedAt, spool_ids: spoolIds });
  });
}

/** Max events per /batch POST — caps payload against the 1 MiB body limit. */
const MAX_BATCH = 50;
