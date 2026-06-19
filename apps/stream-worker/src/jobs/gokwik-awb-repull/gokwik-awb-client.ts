/**
 * gokwik-awb-client.ts — GoKwik AWB Service read client (DEV-HONEST).
 *
 * Mirrors razorpay-settlements-client.ts (paged, auth-header, never-log-body).
 *
 * DEV BOUNDARY (05-architecture.md §3 / §4 — MANDATORY, explicit):
 *   GoKwik's AWB READ API shape (auth headers appid/appsecret, pagination, backfill depth)
 *   is UNDOCUMENTED publicly (research open-question). The AWB lifecycle is REAL as a signal
 *   (research finding 3 confirms the late-changing transition→terminal state machine), but
 *   there is NO documented read endpoint to call in dev. So in dev this client reads from a
 *   LABELLED SYNTHETIC FIXTURE (_fixtures/gokwik-shopflo/gokwik-awb-lifecycle.json) and stamps
 *   data_source='synthetic' downstream. The cursor / restatement / Gold semantics are REAL and
 *   production-shaped — only the data SOURCE is synthetic until partner sandbox access.
 *
 * When a real partner credential exists, swap the fixture read for the documented HTTP call;
 * the paged fetchAwbPage(from,to,skip) interface + data_source flip is the only change.
 *
 * NEVER logs appid / appsecret (I-S09) or raw AWB numbers (boundary-hashed in the mapper).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { GokwikAwbRecord, DataSource } from '@brain/gokwik-mapper';
import { log } from "../../log.js";

export interface GokwikApiCredentials {
  appid: string;       // NEVER logged (I-S09)
  appsecret: string;   // NEVER logged (I-S09)
}

export interface AwbPage {
  items: GokwikAwbRecord[];
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
  'gokwik-shopflo',
  'gokwik-awb-lifecycle.json',
);

/**
 * Fixture path. Overridable via GOKWIK_AWB_FIXTURE_PATH so e2e tests can supply a
 * now-relative fixture (the static fixture's fixed dates would drift out of the 45-day
 * trailing window over wall-clock time). Dev/prod use the default committed fixture.
 */
function fixturePath(): string {
  return process.env['GOKWIK_AWB_FIXTURE_PATH'] ?? DEFAULT_FIXTURE_PATH;
}

interface AwbFixtureFile {
  _synthetic?: boolean;
  records: GokwikAwbRecord[];
}

export class GokwikAwbClient {
  private readonly fixtureRecords: GokwikAwbRecord[];

  /**
   * @param credentials  appid + appsecret — held in memory only, NEVER logged (I-S09).
   *                      In dev they are accepted but not used (the source is the synthetic
   *                      fixture); they exist so the prod swap is a one-line change.
   */
  constructor(_credentials: GokwikApiCredentials) {
    // credentials object intentionally not retained beyond the dev path (I-S09).
    let records: GokwikAwbRecord[] = [];
    try {
      const raw = readFileSync(fixturePath(), 'utf8');
      const parsed = JSON.parse(raw) as AwbFixtureFile;
      records = Array.isArray(parsed.records) ? parsed.records : [];
    } catch (err) {
      log.warn(`could not read synthetic AWB fixture — empty source: ${String(err)}`);
    }
    this.fixtureRecords = records;
  }

  /**
   * Fetch one page of AWB records whose status_changed_at falls within [fromTs, toTs].
   *
   * DEV: reads from the synthetic fixture (data_source='synthetic'). NEVER hits the network.
   * The interface is shaped exactly like the (undocumented) real paged read for a one-line swap.
   *
   * @param fromTs  Unix seconds — window start (inclusive)
   * @param toTs    Unix seconds — window end (inclusive)
   * @param skip    Pagination offset
   */
  async fetchAwbPage(fromTs: number, toTs: number, skip = 0): Promise<AwbPage> {
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

export { PAGE_SIZE as GOKWIK_AWB_PAGE_SIZE };
