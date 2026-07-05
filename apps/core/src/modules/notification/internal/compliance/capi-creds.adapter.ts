/**
 * CAPI credentials adapter (Phase 6, Track B) — the CapiCredsPort seam impl.
 *
 * Mirrors the SaltPort adapter pattern (FunctionSaltPort): a thin adapter behind the port the
 * passback service depends on. The credential VALUE is NEVER logged — only the
 * Secrets Manager ARN ref is dereferenced at send time in prod.
 *
 * DEFAULT-CLOSED: in dev (and whenever a brand has no Meta connector secret_ref)
 * getCreds returns `null` → createCapiAdapter resolves the DevCapiAdapter → the send
 * is `would_send_dev` and NEVER reaches the network. This is the construction-time
 * analogue of the gate's default-closed posture: unknown creds never send.
 *
 * The PROD adapter (reading connector_instance.secret_ref) is a documented platform
 * follow-up — the seam is real now and returns null in dev, exactly like the DLT/NCPR
 * default-closed stubs ship behind their ports.
 */

import type { CapiCreds, CapiCredsPort } from './ports.js';

/**
 * Dev/default-closed creds port: ALWAYS resolves `null` (no Meta creds in dev). The
 * passback adapter therefore resolves to the DevCapiAdapter (would_send_dev), never
 * sending. Used in every non-prod environment and whenever the prod resolver is absent.
 */
class DevCapiCredsPort implements CapiCredsPort {
  async getCreds(_brandId: string): Promise<CapiCreds | null> {
    return null;
  }
}

/**
 * Factory: returns the dev default-closed creds port unless a prod resolver is supplied.
 * The prod resolver (connector_instance.secret_ref → pixelId + accessTokenRef) is the
 * documented platform follow-up; until then EVERY environment is default-closed.
 */
export function createCapiCredsPort(
  prodResolver?: CapiCredsPort,
): CapiCredsPort {
  return prodResolver ?? new DevCapiCredsPort();
}
