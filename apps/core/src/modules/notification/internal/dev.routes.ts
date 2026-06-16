/**
 * DEV-ONLY routes — surfacing email action links so register→verify / forgot→reset /
 * invite→accept can be completed in the browser without a real inbox.
 *
 * SECURITY: this entire file's routes are registered ONLY when NODE_ENV !== 'production'
 * (the caller in main.ts gates registration). The backing store (dev-link-capture) is
 * ALSO never populated in production. Two independent gates — never call this without
 * the env check.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getDevLink } from './dev-link-capture.js';

export function registerDevRoutes(fastify: FastifyInstance): void {
  // GET /api/v1/dev/last-email-link?email=<address>
  // Returns the most recent verify/reset/invite link captured for that recipient.
  fastify.get('/api/v1/dev/last-email-link', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();
    const email = (request.query as { email?: string })?.email;

    if (!email) {
      return reply.code(400).send({
        request_id: requestId,
        error: { code: 'MISSING_EMAIL', message: 'Provide ?email=<address>.' },
      });
    }

    const link = getDevLink(email);
    if (!link) {
      return reply.code(404).send({
        request_id: requestId,
        error: {
          code: 'NO_LINK',
          message: `No captured email link for ${email}. Register / request a reset first.`,
        },
      });
    }

    return reply.send({
      request_id: requestId,
      email,
      type: link.type,
      token: link.token,
      url: link.url,
      captured_at: link.capturedAt,
    });
  });
}
