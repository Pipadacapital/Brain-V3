/**
 * ga4-manifest.test.ts — locks the GA4 backfill-depth correction (2026-07-12 audit).
 *
 * The 14-month GA4 "Data retention" property setting binds user/event-level Explorations only —
 * runReport STANDARD AGGREGATES are not retention-capped. The manifest therefore declares Brain's
 * 24-month default, not the old 420-day under-claim. This test prevents a silent regression back
 * to the shorter window (which would strand 10 months of importable history).
 */
import { describe, it, expect } from 'vitest';
import { GA4_INGESTION_MANIFEST } from '../manifests/ga4.manifest.js';
import { TWO_YEARS_MS } from '../contracts/IngestionManifest.js';

describe('GA4_INGESTION_MANIFEST — backfill depth', () => {
  const sessions = GA4_INGESTION_MANIFEST.resources.find((r) => r.name === 'ga4.sessions')!;

  it('declares the ga4.sessions resource', () => {
    expect(sessions).toBeDefined();
    expect(sessions.backfillSupported).toBe(true);
  });

  it('maxBackfillWindowMs is Brain\'s 24-month default (NOT the retired 420-day cap)', () => {
    expect(sessions.maxBackfillWindowMs).toBe(TWO_YEARS_MS);
    expect(sessions.maxBackfillWindowMs).toBeGreaterThan(420 * 24 * 60 * 60 * 1000);
  });

  it('keeps the date_window walk + provider_id dedup (cross-lane id parity)', () => {
    expect(sessions.cursorStrategy).toBe('date_window');
    expect(sessions.dedupKeyStrategy).toBe('provider_id');
    expect(sessions.pageSize).toBe(28);
  });
});
