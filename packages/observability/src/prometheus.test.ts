/**
 * prometheus.test.ts — registry + exposition format (AUD-LOCAL-016).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { incrementCounter, renderPrometheusText, resetMetricsRegistry, setGauge } from './index.js';

afterEach(() => resetMetricsRegistry());

describe('prometheus registry + exposition', () => {
  it('renders an incremented counter with the brain_ prefix (dashboard expr name)', () => {
    incrementCounter('collector_accept_total');
    incrementCounter('collector_accept_total');
    const text = renderPrometheusText();
    expect(text).toContain('# TYPE brain_collector_accept_total counter');
    expect(text).toContain('brain_collector_accept_total 2');
  });

  it('keeps label sets as distinct series and accumulates per-series', () => {
    incrementCounter('ingest_scheduler_dispatch_total', { provider: 'shopify' });
    incrementCounter('ingest_scheduler_dispatch_total', { provider: 'shopify' }, 3);
    incrementCounter('ingest_scheduler_dispatch_total', { provider: 'meta' });
    const text = renderPrometheusText();
    expect(text).toContain('brain_ingest_scheduler_dispatch_total{provider="shopify"} 4');
    expect(text).toContain('brain_ingest_scheduler_dispatch_total{provider="meta"} 1');
  });

  it('treats label order as irrelevant (same series) and escapes label values', () => {
    incrementCounter('x_total', { a: '1', b: '2' });
    incrementCounter('x_total', { b: '2', a: '1' });
    incrementCounter('esc_total', { v: 'quo"te\\back\nline' });
    const text = renderPrometheusText();
    expect(text).toContain('brain_x_total{a="1",b="2"} 2');
    expect(text).toContain('brain_esc_total{v="quo\\"te\\\\back\\nline"} 1');
  });

  it('does not double-prefix names that already start with brain_', () => {
    incrementCounter('brain_already_total');
    expect(renderPrometheusText()).toContain('brain_already_total 1');
    expect(renderPrometheusText()).not.toContain('brain_brain_');
  });

  it('renders empty registry as empty string', () => {
    expect(renderPrometheusText()).toBe('');
  });

  it('renders a gauge with the gauge TYPE and brain_ prefix', () => {
    setGauge('silver_identity_watermark_age_seconds', {}, 42);
    const text = renderPrometheusText();
    expect(text).toContain('# TYPE brain_silver_identity_watermark_age_seconds gauge');
    expect(text).toContain('brain_silver_identity_watermark_age_seconds 42');
  });

  it('OVERWRITES a gauge series (last write wins, does not accumulate)', () => {
    setGauge('wm_age', { brand_id: 'b1' }, 10);
    setGauge('wm_age', { brand_id: 'b1' }, 7200);
    const text = renderPrometheusText();
    expect(text).toContain('brain_wm_age{brand_id="b1"} 7200');
    expect(text).not.toContain('brain_wm_age{brand_id="b1"} 10');
  });

  it('keeps counters and gauges independent in the exposition', () => {
    incrementCounter('c_total');
    setGauge('g_seconds', {}, 5);
    const text = renderPrometheusText();
    expect(text).toContain('# TYPE brain_c_total counter');
    expect(text).toContain('# TYPE brain_g_seconds gauge');
    expect(text).toContain('brain_c_total 1');
    expect(text).toContain('brain_g_seconds 5');
  });
});
