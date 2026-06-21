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
 *   are documented, but the SHIPMENT-LIST endpoint used to enumerate shipments by date, its
 *   pagination params, and the exact RESPONSE FIELD NAMES are NOT in public docs. The live path
 *   below is production-SHAPED but those specifics are env-configurable + defensively mapped and
 *   MUST be confirmed against a real Shiprocket account before production use:
 *     SHIPROCKET_BASE_URL          (default https://apiv2.shiprocket.in)
 *     SHIPROCKET_SHIPMENTS_PATH    (default /v1/external/orders — the list/enumeration endpoint)
 *     SHIPROCKET_SHIPMENTS_KEY     (default 'data' — the array key in the response body)
 *   Field mapping to ShiprocketShipmentRecord tries common Shiprocket names (awb/awb_code,
 *   channel_order_id/order_id, current_status/status, …) — reconcile when a real payload lands.
 *
 * NEVER logs email / password / token (I-S09) or raw AWB numbers (boundary-hashed in the mapper).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ShiprocketShipmentRecord, DataSource } from '@brain/shiprocket-mapper';
import { log } from '../../log.js';
import {
  ShiprocketTokenProvider,
  SHIPROCKET_AUTH_ERROR,
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
  return process.env['SHIPROCKET_FIXTURE_PATH'] ?? DEFAULT_FIXTURE_PATH;
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

  private readonly baseUrl = (process.env['SHIPROCKET_BASE_URL'] ?? 'https://apiv2.shiprocket.in').replace(/\/+$/, '');
  private readonly shipmentsPath = process.env['SHIPROCKET_SHIPMENTS_PATH'] ?? '/v1/external/orders';
  private readonly shipmentsKey = process.env['SHIPROCKET_SHIPMENTS_KEY'] ?? 'data';

  constructor(credentials: ShiprocketApiCredentials) {
    this.live = isLiveMode();
    this.tokenProvider = new ShiprocketTokenProvider(credentials);
  }

  async fetchShipmentPage(fromTs: number, toTs: number, skip = 0): Promise<ShipmentPage> {
    return this.live
      ? this.fetchShipmentPageLive(fromTs, toTs, skip)
      : this.fetchShipmentPageFixture(fromTs, toTs, skip);
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
      res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (err) {
      throw new Error(`${SHIPROCKET_AUTH_ERROR}: shipments request failed: ${String(err)}`);
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
      };
    });

    log.info(`[shiprocket-client] live page=${page} items=${items.length} (field map: confirm-at-real-account)`);
    return { items, hasMore: items.length === PAGE_SIZE, dataSource: 'real' };
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
