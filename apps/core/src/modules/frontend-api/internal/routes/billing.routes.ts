/**
 * Billing BFF routes (CQ-1 decomposition).
 *
 * Realized-GMV meter: sealed billing periods, the inspectable bill, GST invoice
 * issue/read, and credit notes. The bill is computed from a SEALED, immutable
 * gmv_meter_snapshot per period (reproducible from the ledger), NOT recomputed live.
 * Brand from session (D-1); money is bigint-minor string.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import {
  getBillingPeriods,
  sealBillingPeriod,
  getInspectableBill,
  issueInvoice,
  issueCreditNote,
  getInvoice,
} from '../../../billing/index.js';
import type {
  BillingPeriods as ContractBillingPeriods,
  SealPeriodResult as ContractSealPeriodResult,
  InspectableBill as ContractInspectableBill,
  Invoice as ContractInvoice,
  IssueInvoiceResult as ContractIssueInvoiceResult,
  IssueCreditNoteResult as ContractIssueCreditNoteResult,
} from '@brain/contracts';
import type { BffDeps } from './_shared.js';

export function registerBillingRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, pool, srPool } = deps;

  // ── Billing endpoints (P1 — realized-GMV meter) ───────────────────────────
  // Brain charges %-of-realized-GMV. The bill is computed from a SEALED, immutable
  // gmv_meter_snapshot per period (reproducible from the ledger), NOT recomputed live.
  // Brand from session (D-1): auth.brandId, NEVER from request body. Money is bigint-minor string.

  /**
   * GET /api/v1/billing/periods
   *
   * Returns the active brand's sealed billing periods (the bill basis) — honest discriminated
   * union: state:'no_data' when no period has ever been sealed, else state:'has_data'.
   * Reads gmv_meter_snapshot via the RLS-enforced pool (brain_app + brand GUC).
   */
  fastify.get(
    '/api/v1/billing/periods',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      // Honest-empty: no active brand → nothing to meter yet.
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const result: ContractBillingPeriods = await getBillingPeriods(auth.brandId, requestId, {
        pool,
      });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/billing/periods/seal  body: { period: 'YYYY-MM' }
   *
   * Meters the active brand's realized GMV for the period (via realized_gmv_as_of — the SOLE
   * as-of path, D-3) and SEALS it into the immutable gmv_meter_snapshot. Idempotent: re-sealing
   * a sealed period is a no-op (`sealed:false`) and the original figure stands — a sealed bill
   * basis can never silently change (0040 append-only-by-GRANT). Brand from session (D-1).
   */
  fastify.post(
    '/api/v1/billing/periods/seal',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['period'],
          additionalProperties: false,
          properties: { period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PERIOD', message: "period must be 'YYYY-MM'." },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before metering billing.' },
        });
      }
      if (!pool || !srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database / Silver tier not available' },
        });
      }

      const { period } = request.body as { period: string };
      // Epic 1: the GMV meter reads the lakehouse gold ledger (srPool); the snapshot stays in PG (pool).
      const result: ContractSealPeriodResult = await sealBillingPeriod(
        auth.brandId,
        period,
        requestId,
        { pool, srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/billing/bill?period=YYYY-MM
   *
   * The inspectable bill for a sealed period: fee = sealed realized-GMV basis × rate, itemized
   * down to the per-event_type composition that reconciles to the basis (drift surfaced honestly).
   * state:'not_sealed' when the period has no seal yet. Brand from session (D-1).
   */
  fastify.get(
    '/api/v1/billing/bill',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          required: ['period'],
          additionalProperties: false,
          properties: { period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PERIOD', message: "period must be 'YYYY-MM'." },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      const { period } = request.query as { period: string };

      // Honest: no active brand → nothing sealed to bill.
      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: { state: 'not_sealed', billing_period: period },
        });
      }
      if (!pool || !srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const result: ContractInspectableBill = await getInspectableBill(
        auth.brandId,
        period,
        requestId,
        { pool, srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/billing/invoice?period=YYYY-MM
   *
   * The issued GST invoice for a period (immutable): number, GST breakdown, line items.
   * state:'not_issued' when the period has no invoice yet. Brand from session (D-1).
   */
  fastify.get(
    '/api/v1/billing/invoice',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          required: ['period'],
          additionalProperties: false,
          properties: { period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PERIOD', message: "period must be 'YYYY-MM'." },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      const { period } = request.query as { period: string };

      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: { state: 'not_issued', billing_period: period },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const result: ContractInvoice = await getInvoice(auth.brandId, period, requestId, { pool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/billing/invoice/issue  body: { period: 'YYYY-MM' }
   *
   * Issues the GST invoice for a sealed period — allocates a gapless invoice_number and writes
   * the immutable invoice + line + tax_ledger atomically. Idempotent: issued:false when an
   * invoice already exists (no number consumed). Brand from session (D-1).
   */
  fastify.post(
    '/api/v1/billing/invoice/issue',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['period'],
          additionalProperties: false,
          properties: { period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PERIOD', message: "period must be 'YYYY-MM'." },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before issuing an invoice.' },
        });
      }
      if (!pool || !srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const { period } = request.body as { period: string };
      const result: ContractIssueInvoiceResult = await issueInvoice(
        auth.brandId,
        period,
        requestId,
        { pool, srPool },
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * POST /api/v1/billing/invoice/credit-note  body: { period, reason, taxable_minor? }
   *
   * Issues an immutable credit note against the period's issued invoice — gapless-numbered, with
   * reversing GST. Full reversal by default, or a partial taxable amount. Capped at the invoice
   * total (rejected when over-credited). Brand from session (D-1).
   */
  fastify.post(
    '/api/v1/billing/invoice/credit-note',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['period', 'reason'],
          additionalProperties: false,
          properties: {
            period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
            taxable_minor: { type: 'string', pattern: '^\\d+$' },
          },
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_INPUT', message: "period must be 'YYYY-MM' and reason is required." },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.code(409).send({
          request_id: requestId,
          error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand before issuing a credit note.' },
        });
      }
      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const { period, reason, taxable_minor } = request.body as {
        period: string;
        reason: string;
        taxable_minor?: string;
      };
      const result: ContractIssueCreditNoteResult = await issueCreditNote(
        auth.brandId,
        period,
        reason,
        requestId,
        { pool },
        taxable_minor != null ? { taxableMinor: BigInt(taxable_minor) } : undefined,
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );
}
