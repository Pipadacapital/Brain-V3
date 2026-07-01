/**
 * shiprocket-client.ts — Shiprocket shipment-tracking read client (dual-mode).
 *
 * Two source modes (the established dev=fixture / prod=HTTP posture, like woocommerce/gokwik):
 *   - LIVE (NODE_ENV=production OR SHIPROCKET_LIVE=1): real HTTP using a Bearer JWT from
 *     ShiprocketTokenProvider (login → 10-day token, cached + auto-relogin). data_source='real'.
 *     On 401/403 → invalidate the token + throw SHIPROCKET_AUTH_ERROR (reconnect signal, parity
 *     with shopify/woocommerce/gokwik).
 *   - DEV (default): labelled SYNTHETIC fixture, data_source='synthetic'. Cursor / restatement /
 *     ledger semantics are identical; only the SOURCE differs. SHIPROCKET_FIXTURE_PATH overridable.
 *
 * ⚠️ CONFIRM-AGAINST-A-REAL-ACCOUNT (partner-gated — verified research open-question):
 *   Shiprocket's AUTH (login → JWT) and per-AWB tracking (GET /v1/external/courier/track/awb/{awb})
 *   are documented; the SHIPMENT-LIST endpoint used to enumerate shipments by date, its pagination
 *   params, and the exact RESPONSE FIELD NAMES are NOT in public docs. The live LIST path below is
 *   production-SHAPED but those specifics are env-configurable + defensively mapped and MUST be
 *   confirmed against a real Shiprocket account before production use:
 *     SHIPROCKET_BASE_URL          (default https://apiv2.shiprocket.in)
 *     SHIPROCKET_SHIPMENTS_PATH    (default /v1/external/orders — the list/enumeration endpoint)
 *     SHIPROCKET_SHIPMENTS_KEY     (default 'data' — the array key in the response body)
 *     SHIPROCKET_TRACK_PATH        (default /v1/external/courier/track/awb/{awb} — the DOCUMENTED
 *                                   per-AWB tracking endpoint, used by fetchShipmentByAwb for backfill)
 *
 *   FIELD-MAP ANNOTATION (list payload → ShiprocketShipmentRecord) — common Shiprocket order/shipment
 *   names, ranked most→least likely; reconcile when a real payload lands:
 *     awb               ← awb | awb_code
 *     order_id          ← channel_order_id | order_id | id   (merchant order id preferred over SR id)
 *     status            ← current_status | status | shipment_status
 *     status_changed_at ← status_changed_at | updated_at | last_update_at
 *     payment_method    ← payment_method | payment_type      (cod | prepaid normalized in the mapper)
 *     pincode           ← pincode | customer_pincode | delivery_pincode
 *     courier           ← courier | courier_name
 *     customer_phone    ← customer_phone | phone | mobile | customer_mobile | contact  (hashed in mapper)
 *     customer_email    ← customer_email | email | customer_email_id                  (hashed in mapper)
 *
 * SR-7 — TWO live read modes:
 *   1. fetchShipmentPage(from,to,skip)  — date-windowed LIST enumeration (scheduled / on-demand repull).
 *   2. fetchShipmentByAwb(awb)          — per-AWB DOCUMENTED tracking endpoint, for HISTORICAL backfill
 *      of a single AWB whose lifecycle predates / falls outside the list window. Maps the documented
 *      `tracking_data.shipment_track_activities[]` (date+activity/status) into one record per scan, so
 *      the full transition history folds through the SAME canonical mapper + idempotent UUIDv5 dedup.
 *
 * NEVER logs email / password / token (I-S09) or raw AWB numbers (boundary-hashed in the mapper).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ShiprocketShipmentRecord, DataSource } from '@brain/shiprocket-mapper';
import { loadStreamWorkerConfig } from '@brain/config';
import { log } from '../../log.js';
import { CircuitBreaker } from '@brain/observability';
import {
  ShiprocketTokenProvider,
  SHIPROCKET_AUTH_ERROR,
  SHIPROCKET_NETWORK_ERROR,
  SHIPROCKET_REQUEST_TIMEOUT_MS,
  type ShiprocketApiCredentials,
} from './shiprocket-token-provider.js';

export interface ShipmentPage {
  items: ShiprocketShipmentRecord[];
  hasMore: boolean;
  dataSource: DataSource;
}

const PAGE_SIZE = 200;

function isLiveMode(): boolean {
  return process.env['NODE_ENV'] === 'production' || process.env['SHIPROCKET_LIVE'] === '1';
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_PATH = join(__dirname, '..', '_fixtures', 'shiprocket', 'shiprocket-shipment-lifecycle.json');

function fixturePath(): string {
  return loadStreamWorkerConfig().SHIPROCKET_FIXTURE_PATH ?? DEFAULT_FIXTURE_PATH;
}

interface ShipmentFixtureFile {
  _synthetic?: boolean;
  records: ShiprocketShipmentRecord[];
}

/** First non-empty string among the candidate keys on a raw object (defensive field mapping). */
function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (v !== null && v !== undefined && String(v).length > 0) return String(v);
  }
  return null;
}

export class ShiprocketShipmentClient {
  private readonly live: boolean;
  private readonly tokenProvider: ShiprocketTokenProvider;
  private fixtureRecords: ShiprocketShipmentRecord[] | null = null;
  private readonly breaker: CircuitBreaker;

  private readonly baseUrl = loadStreamWorkerConfig().SHIPROCKET_BASE_URL.replace(/\/+$/, '');
  private readonly shipmentsPath = loadStreamWorkerConfig().SHIPROCKET_SHIPMENTS_PATH;
  private readonly shipmentsKey = loadStreamWorkerConfig().SHIPROCKET_SHIPMENTS_KEY;
  private readonly trackPath = loadStreamWorkerConfig().SHIPROCKET_TRACK_PATH;

  constructor(credentials: ShiprocketApiCredentials) {
    this.live = isLiveMode();
    this.tokenProvider = new ShiprocketTokenProvider(credentials);
    this.breaker = new CircuitBreaker({ name: 'shiprocket', failureThreshold: 5, openMs: 30_000 });
  }

  async fetchShipmentPage(fromTs: number, toTs: number, skip = 0): Promise<ShipmentPage> {
    return this.breaker.fire(() =>
      this.live
        ? this.fetchShipmentPageLive(fromTs, toTs, skip)
        : this.fetchShipmentPageFixture(fromTs, toTs, skip),
    );
  }

  // ── LIVE: real Shiprocket REST read (production-shaped; field map confirm-at-real-account) ──
  private async fetchShipmentPageLive(fromTs: number, toTs: number, skip: number): Promise<ShipmentPage> {
    const token = await this.tokenProvider.getToken();
    const page = Math.floor(skip / PAGE_SIZE) + 1;
    const fromDate = new Date(fromTs * 1000).toISOString().slice(0, 10);
    const toDate = new Date(toTs * 1000).toISOString().slice(0, 10);
    const url =
      `${this.baseUrl}${this.shipmentsPath}` +
      `?per_page=${PAGE_SIZE}&page=${page}&from=${fromDate}&to=${toDate}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(SHIPROCKET_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // TRANSIENT network / timeout (undici "fetch failed", AbortSignal timeout) — NOT an auth failure.
      // Retryable next run; must not force RECONNECT_REQUIRED (the token/secret are valid).
      throw new Error(`${SHIPROCKET_NETWORK_ERROR}: shipments request failed: ${String(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      this.tokenProvider.invalidate(); // stale token → next call re-logs-in
      throw new Error(`${SHIPROCKET_AUTH_ERROR}: shipments rejected (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`shiprocket shipments fetch failed (${res.status})`);
    }

    const body = (await res.json()) as Record<string, unknown>;
    const rawArr = Array.isArray(body) ? body : ((body[this.shipmentsKey] as unknown[] | undefined) ?? []);
    const items: ShiprocketShipmentRecord[] = (Array.isArray(rawArr) ? rawArr : []).map((r) => {
      const o = r as Record<string, unknown>;
      // ⚠️ Defensive field map — confirm exact names against a real Shiprocket payload.
      return {
        awb: pick(o, ['awb', 'awb_code']),
        order_id: pick(o, ['order_id', 'channel_order_id', 'id']),
        status: pick(o, ['current_status', 'status', 'shipment_status']),
        status_changed_at: pick(o, ['status_changed_at', 'updated_at', 'last_update_at']),
        payment_method: pick(o, ['payment_method', 'payment_type']),
        pincode: pick(o, ['pincode', 'customer_pincode', 'delivery_pincode']),
        courier: pick(o, ['courier', 'courier_name']),
        // SR-6: capture raw phone/email so the mapper can hash them at the boundary (raw DROPPED there);
        // links the shipment to the customer 360 / journey. NEVER logged (boundary-hashed downstream).
        customer_phone: pick(o, ['customer_phone', 'phone', 'mobile', 'customer_mobile', 'contact']),
        customer_email: pick(o, ['customer_email', 'email', 'customer_email_id']),
      };
    });

    log.info(`[shiprocket-client] live page=${page} items=${items.length} (field map: confirm-at-real-account)`);
    return { items, hasMore: items.length === PAGE_SIZE, dataSource: 'real' };
  }

  /**
   * SR-7 — HISTORICAL BACKFILL via the DOCUMENTED per-AWB tracking endpoint.
   *
   * GET {base}{SHIPROCKET_TRACK_PATH with {awb} substituted}. Unlike the date-windowed list path, this
   * endpoint is publicly documented, so it is the reliable way to recover a single shipment's FULL
   * lifecycle history (e.g. when re-onboarding a brand whose shipments predate the repull window).
   *
   * Maps the documented `tracking_data.shipment_track_activities[]` (each a {date, activity/status, …}
   * scan) into one ShiprocketShipmentRecord per scan — so every transition folds through the SAME
   * canonical mapper + idempotent UUIDv5 dedup as the list path (replay-safe, no double-count). The
   * top-level `tracking_data.shipment_track[0]` carries the AWB / courier / order context.
   *
   * In DEV (fixture mode) this returns the fixture records for the AWB (history already enumerated),
   * keeping cursor/restatement semantics identical. NEVER logs the raw AWB.
   */
  async fetchShipmentByAwb(awb: string): Promise<ShiprocketShipmentRecord[]> {
    if (!this.live) {
      // Dev: the lifecycle fixture already enumerates every scan for an AWB.
      return this.loadFixture().filter((r) => r.awb === awb);
    }
    return this.breaker.fire(() => this.fetchShipmentByAwbLive(awb));
  }

  private async fetchShipmentByAwbLive(awb: string): Promise<ShiprocketShipmentRecord[]> {
    const token = await this.tokenProvider.getToken();
    const url = `${this.baseUrl}${this.trackPath.replace('{awb}', encodeURIComponent(awb))}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(SHIPROCKET_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // TRANSIENT network / timeout — NOT an auth failure (retryable, no reconnect signal).
      throw new Error(`${SHIPROCKET_NETWORK_ERROR}: tracking request failed: ${String(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      this.tokenProvider.invalidate();
      throw new Error(`${SHIPROCKET_AUTH_ERROR}: tracking rejected (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`shiprocket tracking fetch failed (${res.status})`);
    }

    const body = (await res.json()) as Record<string, unknown>;
    // Documented shape: { tracking_data: { shipment_track: [ {…} ], shipment_track_activities: [ {…} ] } }
    const td = (body['tracking_data'] as Record<string, unknown> | undefined) ?? {};
    const trackArr = (td['shipment_track'] as Record<string, unknown>[] | undefined) ?? [];
    const head = trackArr[0] ?? {};
    const activities = (td['shipment_track_activities'] as Record<string, unknown>[] | undefined) ?? [];

    // Order/courier/payment context from the track head; status + timestamp from each activity scan.
    const orderId = pick(head, ['channel_order_id', 'order_id', 'id']);
    const courier = pick(head, ['courier_name', 'courier']);
    const pincode = pick(head, ['destination_pin', 'pincode', 'delivery_pincode']);
    const payment = pick(head, ['payment_method', 'payment_type']);

    const items: ShiprocketShipmentRecord[] = activities.map((a) => ({
      awb,
      order_id: orderId,
      // ⚠️ activity scans carry status under 'activity'/'status'/'sr-status-label' — confirm at real account.
      status: pick(a, ['status', 'activity', 'sr-status-label', 'sr-status']),
      status_changed_at: pick(a, ['date', 'updated_at', 'status_changed_at']),
      payment_method: payment,
      pincode,
      courier,
      customer_phone: pick(head, ['customer_phone', 'phone', 'mobile', 'contact']),
      customer_email: pick(head, ['customer_email', 'email']),
    }));

    log.info(`[shiprocket-client] live tracking scans=${items.length} (field map: confirm-at-real-account)`);
    return items;
  }

  // ── DEV: synthetic fixture ────────────────────────────────────────────────
  private loadFixture(): ShiprocketShipmentRecord[] {
    if (this.fixtureRecords !== null) return this.fixtureRecords;
    let records: ShiprocketShipmentRecord[] = [];
    try {
      const raw = readFileSync(fixturePath(), 'utf8');
      const parsed = JSON.parse(raw) as ShipmentFixtureFile;
      records = Array.isArray(parsed.records) ? parsed.records : [];
    } catch (err) {
      log.warn(`could not read synthetic Shiprocket fixture — empty source: ${String(err)}`);
    }
    this.fixtureRecords = records;
    return records;
  }

  private fetchShipmentPageFixture(fromTs: number, toTs: number, skip: number): Promise<ShipmentPage> {
    const eligible = this.loadFixture().filter((r) => {
      const changed = r.status_changed_at ? Date.parse(r.status_changed_at) : NaN;
      if (Number.isNaN(changed)) return false;
      const sec = Math.floor(changed / 1000);
      return sec >= fromTs && sec <= toTs;
    });

    const page = eligible.slice(skip, skip + PAGE_SIZE);
    return Promise.resolve({
      items: page,
      hasMore: skip + PAGE_SIZE < eligible.length,
      dataSource: 'synthetic',
    });
  }
}

export { PAGE_SIZE as SHIPROCKET_SHIPMENT_PAGE_SIZE };
