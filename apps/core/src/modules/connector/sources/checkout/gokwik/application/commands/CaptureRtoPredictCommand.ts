/**
 * CaptureRtoPredictCommand — at-checkout RTO-predict capture handler.
 *
 * This command is called at the checkout moment (synchronous path) to request a GoKwik
 * RTO risk prediction and emit a canonical gokwik.rto_predict.v1 event to the live lane.
 *
 * HONESTY INVARIANTS:
 *   - If the GoKwik connector is not connected, the command returns { connected: false }.
 *     The caller surfaces 'not connected' to the UI — never fabricates a prediction.
 *   - The risk_flag is ALWAYS categorical; no numeric score is ever stored or surfaced.
 *   - brandId ALWAYS comes from the caller (MT-1) — never from the GoKwik payload.
 *
 * PROD CUTOVER: replace NotConnectedRtoPredictClient with GokwikLiveRtoPredictClient
 * once GoKwik partner credentials are available. No call-site changes required.
 *
 * EXTERNAL BLOCKER: Live GoKwik RTO-Predict API shape + partner credentials needed
 * before GokwikLiveRtoPredictClient can be written. The interface is stable here.
 */

import { randomUUID } from 'node:crypto';
import type { Producer } from 'kafkajs';
import { injectKafkaTraceContext } from '@brain/observability';
import type { IRtoPredictClient } from '../../domain/IRtoPredictClient.js';
import { RtoPredictNotConnectedError } from '../../domain/IRtoPredictClient.js';
import {
  mapGokwikRtoPredict,
  uuidV5FromRtoPredict,
  GOKWIK_RTO_PREDICT_V1_EVENT_NAME,
  type GokwikRtoPredictRecord,
} from '@brain/gokwik-mapper';
import { CollectorEventV1Schema } from '@brain/contracts';

export interface CaptureRtoPredictInput {
  /** Brand UUID — authoritative from caller (MT-1), never from payload. */
  brandId: string;
  /** Order identifier (ledger spine key). */
  orderId: string;
  /** Destination pincode. */
  pincode?: string | null;
  /** Payment method at checkout. */
  paymentMethod?: 'cod' | 'prepaid' | null;
  /** sha256(salt || phone) — raw phone NEVER passed (I-S02). */
  customerMobileHash?: string | null;
  /** Order value in minor units. */
  orderValueMinor?: number | null;
  /** Correlation ID for tracing. */
  correlationId: string;
}

export type CaptureRtoPredictResult =
  | {
      connected: true;
      eventId: string;
      riskFlag: 'high' | 'medium' | 'low' | 'control' | 'unknown';
      riskFlagRaw: string | null;
      riskReason: string | null;
    }
  | {
      connected: false;
      reason: string;
    };

export class CaptureRtoPredictCommand {
  constructor(
    private readonly rtoPredictClient: IRtoPredictClient,
    private readonly producer: Producer,
    private readonly liveTopic: string,
  ) {}

  async execute(input: CaptureRtoPredictInput): Promise<CaptureRtoPredictResult> {
    const { brandId, orderId, correlationId } = input;

    // Generate a deterministic request_id for idempotency.
    // Using randomUUID here is acceptable because each checkout attempt is a new event.
    // The uuidV5FromRtoPredict (brand:order:request_id) deduplicates at the Bronze layer.
    const requestId = randomUUID();

    let rtoResponse: Awaited<ReturnType<IRtoPredictClient['predict']>>;
    try {
      rtoResponse = await this.rtoPredictClient.predict({
        brandId,
        orderId,
        requestId,
        pincode: input.pincode,
        paymentMethod: input.paymentMethod,
        customerMobileHash: input.customerMobileHash,
        orderValueMinor: input.orderValueMinor,
      });
    } catch (err) {
      if (err instanceof RtoPredictNotConnectedError) {
        // Honest 'not connected' — caller surfaces this state, no fabrication.
        return { connected: false, reason: err.message };
      }
      throw err; // propagate unexpected errors
    }

    // Build the canonical gokwik.rto_predict.v1 record.
    const record: GokwikRtoPredictRecord = {
      order_id: orderId,
      request_id: rtoResponse.requestId,
      risk_flag: rtoResponse.riskFlagRaw,
      risk_reason: rtoResponse.riskReason,
      occurred_at: rtoResponse.occurredAt,
    };

    const mapped = mapGokwikRtoPredict(record, brandId, 'real');
    const eventId = uuidV5FromRtoPredict(brandId, orderId, rtoResponse.requestId);

    // Produce to the live lane — partition key = brandId (MT-1).
    const envelope = CollectorEventV1Schema.parse({
      schema_version: '1' as const,
      event_id: eventId,
      brand_id: brandId,
      correlation_id: correlationId,
      event_name: GOKWIK_RTO_PREDICT_V1_EVENT_NAME,
      occurred_at: mapped.occurred_at,
      ingested_at: new Date().toISOString(),
      properties: mapped.properties as unknown as Record<string, unknown>,
    });

    // OTel trace-context propagation (OBS-1/OBS-2): inject traceparent so the
    // stream-worker consumer resumes this trace across the Kafka boundary.
    const headers: Record<string, Buffer | string> = {
      correlation_id: Buffer.from(correlationId),
      event_name: Buffer.from(GOKWIK_RTO_PREDICT_V1_EVENT_NAME),
    };
    injectKafkaTraceContext(headers);
    await this.producer.send({
      topic: this.liveTopic,
      messages: [
        {
          key: brandId,
          value: Buffer.from(JSON.stringify(envelope)),
          headers,
        },
      ],
    });

    return {
      connected: true,
      eventId,
      riskFlag: mapped.properties.risk_flag,
      riskFlagRaw: mapped.properties.risk_flag_raw,
      riskReason: mapped.properties.risk_reason,
    };
  }
}
