/**
 * route.test.ts — /api/metrics Prometheus exposition (AUD-INFRA-033).
 *
 * The web ServiceMonitor (job brain-web) scrapes this route; a regression here silently removes
 * the web tier from BrainTargetDown coverage, so the exposition contract is pinned: 200, the
 * Prometheus text content-type, and valid gauge lines (HELP/TYPE + a finite sample).
 */
import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('GET /api/metrics', () => {
  it('returns 200 with the Prometheus text exposition content-type', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  it('exposes the process gauges as parseable exposition lines', async () => {
    const body = await GET().text();
    for (const metric of [
      'brain_web_process_uptime_seconds',
      'brain_web_process_resident_memory_bytes',
      'brain_web_process_heap_used_bytes',
    ]) {
      expect(body).toContain(`# TYPE ${metric} gauge`);
      const sample = body
        .split('\n')
        .find((line) => line.startsWith(`${metric} `));
      expect(sample, `${metric} sample line`).toBeDefined();
      const value = Number(sample!.split(' ')[1]);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('ends with a trailing newline (exposition format requirement)', async () => {
    const body = await GET().text();
    expect(body.endsWith('\n')).toBe(true);
  });
});
