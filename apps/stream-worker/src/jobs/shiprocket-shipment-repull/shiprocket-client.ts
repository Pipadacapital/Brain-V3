/**
 * shiprocket-client.ts — Shiprocket shipment-tracking read client (DEV-HONEST).
 *
 * Mirrors gokwik-awb-client.ts (paged, auth-token, never-log-body).
 *
 * DEV BOUNDARY (SPEC 3 gap — MANDATORY, explicit):
 *   Shiprocket's tracking READ shape (the exact list/track payload keys, the numeric
 *   current_status_id→label map, pagination, backfill depth) is NOT fully documented publicly
 *   (research open-question). The shipment lifecycle is REAL as a signal (the forward→NDR→RTO
 *   /Delivered state machine is documented), but there is no confirmed read schema to call in
 *   dev. So in dev this client reads from a LABELLED SYNTHETIC FIXTURE
 *   (_fixtures/shiprocket/shiprocket-shipment-lifecycle.json) and stamps data_source='synthetic'
 *   downstream. The cursor / restatement / ledger semantics are REAL and production-shaped — only
 *   the data SOURCE is synthetic until partner sandbox access.
 *
 * When real partner credentials exist, swap the fixture read for the documented HTTP call against
 * GET /v1/external/courier/track/... using a Bearer token from ShiprocketTokenProvider; the paged
 * fetchShipmentPage(from,to,skip) interface + data_source flip is the only change. On a 401/403 the
 * real client MUST throw `${SHIPROCKET_AUTH_ERROR}: ...` (and call tokenProvider.invalidate()) so the
 * repull records a reconnect signal — exactly as gokwik/razorpay/shopify do.
 *
 * NEVER logs email / password / token (I-S09) or raw AWB numbers (boundary-hashed in the mapper).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ShiprocketShipmentRecord, DataSource } from '@brain/shiprocket-mapper';
import { log } from '../../log.js';
import type { ShiprocketApiCredentials } from './shiprocket-token-provider.js';

export interface ShipmentPage {
  items: ShiprocketShipmentRecord[];
  /** true if there may be more pages */
  hasMore: boolean;
  /** provenance of the page — drives the Synthetic (dev) badge */
  dataSource: DataSource;
}

const PAGE_SIZE = 200;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_PATH = join(
  __dirname,
  '..',
  '_fixtures',
  'shiprocket',
  'shiprocket-shipment-lifecycle.json',
);

/**
 * Fixture path. Overridable via SHIPROCKET_FIXTURE_PATH so e2e tests can supply a now-relative
 * fixture (the static fixture's fixed dates would drift out of the 45-day trailing window over
 * wall-clock time). Dev/prod use the default committed fixture.
 */
function fixturePath(): string {
  return process.env['SHIPROCKET_FIXTURE_PATH'] ?? DEFAULT_FIXTURE_PATH;
}

interface ShipmentFixtureFile {
  _synthetic?: boolean;
  records: ShiprocketShipmentRecord[];
}

export class ShiprocketShipmentClient {
  private readonly fixtureRecords: ShiprocketShipmentRecord[];

  /**
   * @param _credentials  email + password — held in memory only, NEVER logged (I-S09). In dev they
   *                       are accepted but not used (the source is the synthetic fixture); they exist
   *                       so the prod swap (ShiprocketTokenProvider + HTTP) is a one-line change.
   */
  constructor(_credentials: ShiprocketApiCredentials) {
    let records: ShiprocketShipmentRecord[] = [];
    try {
      const raw = readFileSync(fixturePath(), 'utf8');
      const parsed = JSON.parse(raw) as ShipmentFixtureFile;
      records = Array.isArray(parsed.records) ? parsed.records : [];
    } catch (err) {
      log.warn(`could not read synthetic Shiprocket fixture — empty source: ${String(err)}`);
    }
    this.fixtureRecords = records;
  }

  /**
   * Fetch one page of shipment records whose status_changed_at falls within [fromTs, toTs].
   *
   * DEV: reads from the synthetic fixture (data_source='synthetic'). NEVER hits the network.
   * Shaped exactly like the (to-confirm) real paged read for a one-line swap.
   *
   * @param fromTs  Unix seconds — window start (inclusive)
   * @param toTs    Unix seconds — window end (inclusive)
   * @param skip    Pagination offset
   */
  async fetchShipmentPage(fromTs: number, toTs: number, skip = 0): Promise<ShipmentPage> {
    const eligible = this.fixtureRecords.filter((r) => {
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
