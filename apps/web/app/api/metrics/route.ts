/**
 * GET /api/metrics — minimal Prometheus text exposition for the web tier (AUD-INFRA-033).
 *
 * WHY THIS EXISTS: the web chart's ServiceMonitor (job brain-web) needs a scrapable endpoint so
 * `up{job="brain-web"}` exists — without it, BrainTargetDown{job=~"brain-.*"} structurally cannot
 * see the user-facing tier (a never-scraped job has no `up` series). Web is a Next.js BFF-proxy
 * shell with no @brain/observability counter registry, so this deliberately exposes ONLY honest
 * process-level gauges — no fabricated business metrics (the C2 anti-false-safety doctrine:
 * liveness comes from `up`, not from inventing series).
 *
 * PATH is /api/metrics (not /metrics): app/(dashboard)/metrics/page.tsx already owns the /metrics
 * URL. Not intercepted by the middleware auth guard (only dashboard/settings/… prefixes) nor the
 * next.config rewrites (/api/bff/*, /api/v1/* — filesystem routes win over afterFiles rewrites).
 */
export const dynamic = 'force-dynamic'; // per-scrape values — never prerender/cache

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export function GET(): Response {
  const mem = process.memoryUsage();
  const body = [
    '# HELP brain_web_process_uptime_seconds Uptime of the web (Next.js) server process.',
    '# TYPE brain_web_process_uptime_seconds gauge',
    `brain_web_process_uptime_seconds ${process.uptime()}`,
    '# HELP brain_web_process_resident_memory_bytes Resident set size of the web server process.',
    '# TYPE brain_web_process_resident_memory_bytes gauge',
    `brain_web_process_resident_memory_bytes ${mem.rss}`,
    '# HELP brain_web_process_heap_used_bytes V8 heap used by the web server process.',
    '# TYPE brain_web_process_heap_used_bytes gauge',
    `brain_web_process_heap_used_bytes ${mem.heapUsed}`,
    '',
  ].join('\n');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': PROMETHEUS_CONTENT_TYPE },
  });
}
