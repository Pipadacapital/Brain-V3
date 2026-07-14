/**
 * Meta CAPI channel adapter — Phase 6 conversion passback (mirrors ses-adapter.ts).
 *
 * I-ST05: this is the ONLY egress path to Meta's Conversions API. The Meta Graph host
 * (graph.facebook.com) appears NOWHERE else in the codebase (CI grep gate enforces it).
 * The adapter is UNREACHABLE unless can_contact(purpose='advertising') already returned
 * `allow` — the passback service refuses to construct a payload on a block.
 *
 * DEFAULT-CLOSED by construction:
 *   - DevCapiAdapter is the ONLY adapter in dev. It NEVER calls the network and NEVER
 *     fakes a `sent` — it logs a masked line and returns `would_send_dev`.
 *   - MetaCapiAdapter is instantiated ONLY when env ∈ {production,staging} AND creds
 *     resolve (pixelId + access token present). Unknown/absent creds in any env →
 *     DevCapiAdapter → `would_send_dev`, never sends.
 *
 * PII: `em`/`ph` are already Meta-format UNSALTED sha256 hashes (computed transiently
 * at the boundary via @brain/identity-core metaMatchHash). Raw email/phone NEVER reach
 * this adapter, never get logged, never travel on the wire (I-S02).
 *
 * Money: `customData.value` is a MAJOR-unit decimal per the Meta spec. The minor→major
 * conversion happens ONLY here, at the wire boundary — no float money is ever stored
 * (I-S07). capi_passback_log persists the BIGINT value_minor + currency_code.
 */

import type { CapiCreds } from './compliance/ports.js';
import { log } from "../../../log.js";

/** Meta CAPI userData — all PII fields are ALREADY hashed (em/ph). Click-ids are not PII. */
export interface CapiUserData {
  /** sha256(normalized email) — Meta match spec. NEVER raw. */
  em?: string[];
  /** sha256(normalized E.164 phone) — Meta match spec. NEVER raw. */
  ph?: string[];
  /** Meta click id from silver.touchpoint (not PII). */
  fbc?: string;
  /** Meta browser id from silver.touchpoint (not PII). */
  fbp?: string;
}

export interface CapiEventPayload {
  pixelId: string;
  eventName: 'Purchase';
  /** Deterministic dedup key: sha256(brand_id‖order_id‖'Purchase'‖ledger_event_id). */
  eventId: string;
  /** Unix seconds (the order's occurred_at). */
  eventTime: number;
  actionSource: 'website';
  userData: CapiUserData;
  /** value is MAJOR units (Meta spec); converted from BIGINT minor at this boundary. */
  customData: { value: number; currency: string };
  correlationId: string;
}

export type CapiSendStatus = 'sent' | 'would_send_dev';
export interface CapiSendResult {
  status: CapiSendStatus;
  fbtraceId?: string;
}

/** A subject-level deletion/suppression request to Meta (retroactive consent withdrawal). */
export interface CapiDeletionPayload {
  pixelId: string;
  /** The withdrawn subject's Meta-format match hashes (em/ph) — used to target deletion. */
  userData: CapiUserData;
  correlationId: string;
}

export type CapiDeletionStatus = 'deleted' | 'would_delete_dev';
export interface CapiDeletionResult {
  status: CapiDeletionStatus;
  fbtraceId?: string;
}

export interface CapiAdapter {
  send(payload: CapiEventPayload): Promise<CapiSendResult>;
  delete(payload: CapiDeletionPayload): Promise<CapiDeletionResult>;
}

// ── Masking helper (no raw PII ever, hashes truncated in logs) ────────────────

function maskHashes(hashes?: string[]): string[] | undefined {
  if (!hashes) return undefined;
  return hashes.map((h) => `${h.slice(0, 8)}…`);
}

/**
 * Development adapter — the DEFAULT-CLOSED stub. The ONLY adapter in dev.
 * NEVER calls the network. NEVER fakes a `sent`. Logs a masked line and returns
 * `would_send_dev` / `would_delete_dev`. The dev-honesty boundary: real Meta CAPI
 * needs a live access token + pixel id (a platform follow-up).
 */
export class DevCapiAdapter implements CapiAdapter {
  async send(payload: CapiEventPayload): Promise<CapiSendResult> {
    log.info('', { detail: {
            event_name: payload.eventName,
            event_id: payload.eventId,
            pixel_id: payload.pixelId || '(none)',
            em: maskHashes(payload.userData.em),
            ph: maskHashes(payload.userData.ph),
            has_fbc: Boolean(payload.userData.fbc),
            has_fbp: Boolean(payload.userData.fbp),
            currency: payload.customData.currency,
            correlation_id: payload.correlationId,
            note: 'DEV MODE: CAPI not sent — no Meta creds (platform follow-up).',
          } });
    return { status: 'would_send_dev' };
  }

  async delete(payload: CapiDeletionPayload): Promise<CapiDeletionResult> {
    log.info('', { detail: {
            pixel_id: payload.pixelId || '(none)',
            em: maskHashes(payload.userData.em),
            ph: maskHashes(payload.userData.ph),
            correlation_id: payload.correlationId,
            note: 'DEV MODE: CAPI deletion not sent — no Meta creds (platform follow-up).',
          } });
    return { status: 'would_delete_dev' };
  }
}

/**
 * Production Meta CAPI adapter — instantiated ONLY when env ∈ {production,staging}
 * AND creds resolved. POSTs to the Conversions API. Same dynamic-import-of-prod-dep
 * trick as SesEmailAdapter (undici is not required in dev).
 *
 * The access token is the dereferenced secret (the credential VALUE) — it is NEVER
 * logged. graph.facebook.com appears ONLY in this file (I-ST05 grep gate).
 */
class MetaCapiAdapter implements CapiAdapter {
  private static readonly GRAPH_VERSION = 'v19.0';

  constructor(
    private readonly pixelId: string,
    private readonly accessToken: string,
  ) {}

  private async post(path: string, body: unknown): Promise<{ fbtraceId?: string }> {
    // Dynamic import keeps undici a prod-only dep (absent in dev, mirrors SES).
    const undici = await (new Function('m', 'return import(m)')('undici') as Promise<{
      fetch: (url: string, init: unknown) => Promise<{ json: () => Promise<unknown> }>;
    }>);
    const host = 'graph.facebook.com';
    const url = `https://${host}/${MetaCapiAdapter.GRAPH_VERSION}/${path}`;
    const res = await undici.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { fbtrace_id?: string };
    return { fbtraceId: json.fbtrace_id };
  }

  async send(payload: CapiEventPayload): Promise<CapiSendResult> {
    const body = {
      data: [
        {
          event_name: payload.eventName,
          event_time: payload.eventTime,
          event_id: payload.eventId,
          action_source: payload.actionSource,
          user_data: payload.userData,
          custom_data: {
            value: payload.customData.value,
            currency: payload.customData.currency,
          },
        },
      ],
      access_token: this.accessToken,
    };
    const { fbtraceId } = await this.post(`${this.pixelId}/events`, body);
    return { status: 'sent', fbtraceId };
  }

  async delete(payload: CapiDeletionPayload): Promise<CapiDeletionResult> {
    // Meta deletion/suppression of prior events for a subject (user_data match).
    const body = {
      data: [{ user_data: payload.userData }],
      access_token: this.accessToken,
    };
    const { fbtraceId } = await this.post(`${this.pixelId}/events?delete=true`, body);
    return { status: 'deleted', fbtraceId };
  }
}

/**
 * Factory: returns MetaCapiAdapter ONLY when env ∈ {production,staging} AND creds
 * resolved (pixelId + accessToken present). Otherwise DevCapiAdapter — the
 * default-closed stub. This is the construction-time analogue of the gate's
 * default-closed posture: unknown/absent creds NEVER send.
 *
 * @param env           NODE_ENV / deploy env.
 * @param creds         Resolved CapiCreds, or null when absent (dev). The factory
 *                      also takes the dereferenced access token (prod only) — in
 *                      dev it is undefined and the Dev adapter is returned.
 * @param accessToken   The dereferenced secret VALUE (prod only; never in dev).
 */
export function createCapiAdapter(
  env: string,
  creds: CapiCreds | null,
  accessToken?: string,
): CapiAdapter {
  const isProdLike = env === 'production' || env === 'staging';
  if (isProdLike && creds?.pixelId && accessToken) {
    return new MetaCapiAdapter(creds.pixelId, accessToken);
  }
  // Unknown/absent creds in ANY env → default-closed Dev stub (never sends).
  return new DevCapiAdapter();
}
