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
import { extractCorrelationId } from '@brain/observability';

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

    reply
      .header('X-Correlation-Id', correlationId)
      .header('X-Spool-Id', result.spoolId.toString())
      .header('X-Received-At', result.receivedAt)
      .status(202)
      .send({ accepted: true, received_at: result.receivedAt });
  });
}
