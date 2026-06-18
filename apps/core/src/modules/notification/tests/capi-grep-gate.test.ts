/**
 * capi-grep-gate.test.ts — structural I-ST05 enforcement (Phase 6, Track B, architecture §6c).
 *
 * THE INVARIANT: can_contact() is the SOLE outbound gate; there is NO direct CAPI
 * conversion-send path. The ONLY place that POSTs a conversion to Meta's Conversions API
 * (the `<pixelId>/events` endpoint carrying hashed match `user_data`) is capi-adapter.ts,
 * and it is structurally UNREACHABLE unless can_contact(purpose='advertising') returned
 * `allow`. A CAPI send wired ANYWHERE ELSE would fork the gate (I-ST05 violation).
 *
 * SCOPE (deliberate): the Meta Graph HOST `graph.facebook.com` legitimately appears in two
 * PRE-EXISTING, non-CAPI integrations — the Meta OAuth token exchange (connector) and the
 * Insights ad-spend pull (stream-worker). Those are NOT conversion sends and predate this
 * feature. The discriminating marker of a CAPI *conversion passback* is the Conversions
 * API send itself: a POST to the `<pixelId>/events` endpoint (and the deletion variant).
 * This gate asserts that marker — the CAPI send — appears ONLY in capi-adapter.ts.
 *
 * MARKER PRECISION: the Conversions-API send path is ALWAYS the pixel-id-prefixed
 * `${pixelId}/events` template (see capi-adapter.ts). We key on the `}/events` boundary —
 * the pixel-id template interpolation immediately before the events endpoint — NOT a bare
 * `/events` substring. A bare `/events` would false-flag a read-only BFF route literal
 * (e.g. `GET /api/v1/feedback/capi/events`), which is a UI surface, not a Conversions-API
 * send. The tighter marker discriminates the actual send from any REST route string.
 *
 * If a future change adds a `${pixelId}/events` Conversions-API POST outside
 * capi-adapter.ts, this test FAILS the build (a direct-send-path / I-ST05 violation).
 */

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// The CAPI Conversions-API send marker: the pixel-id-prefixed `${pixelId}/events` POST
// path. The `}/events` boundary (template interpolation of the pixel id, immediately before
// the events endpoint) discriminates the actual Conversions-API send — both the send
// (`${pixelId}/events`) and the deletion (`${pixelId}/events?delete=true`) variants in
// capi-adapter.ts — from a bare `/events` REST route literal (a UI/BFF read surface).
const CAPI_SEND_MARKER = /\}\/events(\?delete=true)?['"`]/;

// The ONLY file permitted to contain the CAPI send marker.
const ALLOWED_FILE = path.join('notification', 'internal', 'capi-adapter.ts');

async function scanTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    if (e.isDirectory()) files.push(...(await scanTsFiles(full)));
    else if (e.isFile() && e.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('I-ST05 grep gate — the CAPI conversion send lives ONLY in capi-adapter.ts', () => {
  it('no `<pixelId>/events` Conversions-API send marker outside capi-adapter.ts', async () => {
    // Scan the entire apps/core/src tree (CWD is apps/core during the test run).
    const srcRoot = path.resolve(process.cwd(), 'src');
    const files = await scanTsFiles(srcRoot);

    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith('.test.ts')) continue; // this gate file itself contains the marker text
      const content = await readFile(file, 'utf8');
      if (CAPI_SEND_MARKER.test(content) && !file.endsWith(ALLOWED_FILE)) {
        offenders.push(file);
      }
    }

    expect(
      offenders,
      `I-ST05 VIOLATION: a CAPI Conversions-API send (<pixelId>/events) appears outside ` +
        `capi-adapter.ts — this is a direct-send path that bypasses can_contact(). ` +
        `Offending files:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('capi-adapter.ts DOES contain the send marker (the gate is not vacuously passing)', async () => {
    const adapterPath = path.resolve(
      process.cwd(),
      'src/modules/notification/internal/capi-adapter.ts',
    );
    const content = await readFile(adapterPath, 'utf8');
    expect(CAPI_SEND_MARKER.test(content)).toBe(true);
  });
});
