/**
 * NotConnectedRtoPredictClient — the honest guard implementation of IRtoPredictClient.
 *
 * This is the default implementation used when no live GoKwik partner credential is
 * available. It satisfies the IRtoPredictClient interface but ALWAYS throws
 * RtoPredictNotConnectedError — surfacing 'not connected' clearly instead of
 * fabricating a prediction or returning a zero/default value.
 *
 * Brain rules: "No empty charts as a success state" + "Revenue truth over platform truth"
 * — a fabricated prediction is worse than surfacing an honest 'not connected' state.
 *
 * Production cutover: replace this binding with GokwikLiveRtoPredictClient once
 * GoKwik partner credentials are available and the API contract is confirmed.
 * The swap is purely a DI binding change — no call-site edits required.
 *
 * EXTERNAL BLOCKER: GoKwik AWB live client + RTO-Predict API shape (endpoint URL,
 * auth header names, request/response field names) need GoKwik partner credentials.
 * The live client MUST NOT be written or mocked until the real API contract is available.
 */

import type { IRtoPredictClient, RtoPredictRequest, RtoPredictResponse } from '../domain/IRtoPredictClient.js';
import { RtoPredictNotConnectedError } from '../domain/IRtoPredictClient.js';

export class NotConnectedRtoPredictClient implements IRtoPredictClient {
  async predict(req: RtoPredictRequest): Promise<RtoPredictResponse> {
    // Explicit 'not connected' — NEVER fabricate data.
    throw new RtoPredictNotConnectedError(req.brandId);
  }
}
