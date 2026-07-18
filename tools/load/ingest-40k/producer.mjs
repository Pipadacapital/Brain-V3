#!/usr/bin/env node
/**
 * ingest-40k — load + duplicate-injection harness (ADR-0015 / doc-18 PR 0.1).
 *
 * Replays a synthetic pixel CollectorEventV1 stream at a configurable rate against
 * either:
 *   --mode http   POST /collect (or /batch when --batch-size > 1) on the collector —
 *                 exercises the REAL ADR-0015 accept path (produce-to-log-or-WAL
 *                 before ACK); the measured latency IS the accept+ack SLO surface.
 *   --mode kafka  produce straight to the collector topic with an idempotent
 *                 producer (acks=-1, key=brand_id) — broker/Connect-side sizing
 *                 without the HTTP edge. kafkajs is resolved from the collector's
 *                 workspace install (zero new deps in this tool).
 *
 * Duplicate injection (--dup-pct): re-sends a previously-sent envelope VERBATIM
 * (same event_id) — the P2 gate's application-duplicate source. Deterministic:
 * the dup choices come from the same seeded PRNG family as the ids.
 *
 * Event ids are deterministic UUIDv7-style ids in (--seed, start_ts, seq) — see
 * event-gen.mjs — and the unique sent set is streamed to ingest-40k-sent-ids.txt
 * for the P1 zero-loss comparison (sent ids vs landed Bronze rows).
 *
 * Zero npm deps: plain Node ≥ 20 (global fetch). See README.md for the doc-18
 * P1/P2 gate commands. Do NOT point high rates at a shared dev stack.
 */
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { makeEventFactory, deriveBrandIds, mulberry32, fnv1a } from './event-gen.mjs';
import { LatencyRecorder, buildSummary, renderSummary } from './report.mjs';

// ── CLI parsing (plain argv — no dep; repo tools convention is env/flag-driven) ──
function parseArgs(argv) {
  const opts = {
    mode: 'http', // http | kafka
    url: process.env.COLLECTOR_URL || 'http://localhost:8787',
    brokers: process.env.KAFKA_BROKERS || 'localhost:9092',
    topic: process.env.COLLECTOR_TOPIC || 'dev.collector.event.v1',
    rate: 1000, // events/sec
    duration: 60, // seconds
    brands: 1,
    brandIds: null, // csv override
    installToken: process.env.INSTALL_TOKEN || '00000000-0000-0000-0000-000000000001',
    dupPct: 0, // % of sends that re-send a prior event_id
    seed: 'ingest-40k',
    startTs: null, // ms; default Date.now() — recorded in the summary for id regeneration
    batchSize: 1, // http mode: >1 → POST /batch (max 50)
    maxInflight: 1024,
    outDir: '.',
    idsFile: true,
    dryRun: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--mode': opts.mode = next(); break;
      case '--url': opts.url = next(); break;
      case '--brokers': opts.brokers = next(); break;
      case '--topic': opts.topic = next(); break;
      case '--rate': opts.rate = Number(next()); break;
      case '--duration': opts.duration = Number(next()); break;
      case '--brands': opts.brands = Number(next()); break;
      case '--brand-ids': opts.brandIds = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--install-token': opts.installToken = next(); break;
      case '--dup-pct': opts.dupPct = Number(next()); break;
      case '--seed': opts.seed = next(); break;
      case '--start-ts': opts.startTs = Number(next()); break;
      case '--batch-size': opts.batchSize = Math.min(Number(next()), 50); break; // /batch MAX_BATCH=50
      case '--max-inflight': opts.maxInflight = Number(next()); break;
      case '--out-dir': opts.outDir = next(); break;
      case '--no-ids-file': opts.idsFile = false; break;
      case '--dry-run': opts.dryRun = Number(next()); break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default:
        console.error(`unknown flag: ${a} (see --help)`);
        process.exit(2);
    }
  }
  if (!['http', 'kafka'].includes(opts.mode)) { console.error(`--mode must be http|kafka`); process.exit(2); }
  if (!(opts.rate > 0) || !(opts.duration > 0)) { console.error('--rate and --duration must be > 0'); process.exit(2); }
  if (opts.dupPct < 0 || opts.dupPct >= 100) { console.error('--dup-pct must be in [0,100)'); process.exit(2); }
  if (opts.mode === 'kafka' && opts.batchSize !== 1) { console.error('--batch-size applies to http mode only'); process.exit(2); }
  opts.brandIds = opts.brandIds ?? deriveBrandIds(Math.max(1, opts.brands), opts.seed);
  return opts;
}

function printHelp() {
  console.log(`ingest-40k — CollectorEventV1 load + duplicate-injection harness (doc-18 PR 0.1)

Usage: node tools/load/ingest-40k/producer.mjs [flags]

  --mode http|kafka     http = POST /collect|/batch (real accept path, default)
                        kafka = direct idempotent produce (broker-side sizing)
  --rate N              target events/sec (default 1000)
  --duration S          seconds of sustained send (default 60)
  --brands N            distribute events across N deterministic brand_ids (default 1)
  --brand-ids a,b,...   explicit brand uuid list (overrides --brands)
  --install-token T     properties.install_token (R2 brand derivation input)
  --dup-pct P           % of sends that RE-SEND a prior event_id verbatim (default 0)
  --seed S              determinism seed for ids/noise (default 'ingest-40k')
  --start-ts MS         id timestamp anchor (default now; recorded in summary)
  --batch-size N        http only: N>1 → POST /batch (≤50) (default 1)
  --max-inflight N      in-flight request cap (default 1024)
  --out-dir DIR         artifacts dir (default .)
  --no-ids-file         skip the sent-ids manifest (summary still regenerates ids)
  --dry-run N           print N sample envelopes as JSON and exit (no network)

  http env: COLLECTOR_URL   kafka env: KAFKA_BROKERS, COLLECTOR_TOPIC

Artifacts: ingest-40k-summary.json, ingest-40k-sent-ids.txt, ingest-40k-dup-ids.txt`);
}

// ── Senders ────────────────────────────────────────────────────────────────────

/** http single/batch sender. Returns { acked, http503, error } counts for the request. */
function makeHttpSender(opts, latency, counters) {
  const single = `${opts.url.replace(/\/$/, '')}/collect`;
  const batch = `${opts.url.replace(/\/$/, '')}/batch`;
  return async function send(envelopes) {
    const isBatch = envelopes.length > 1;
    const t = performance.now();
    try {
      const res = await fetch(isBatch ? batch : single, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': envelopes[0].correlation_id },
        body: JSON.stringify(isBatch ? { events: envelopes } : envelopes[0]),
      });
      latency.record(performance.now() - t);
      // Drain the body so undici can reuse the connection.
      const body = await res.json().catch(() => ({}));
      if (res.status === 503) counters.http503 += envelopes.length;
      else if (res.ok) counters.acked += isBatch ? Number(body.accepted ?? envelopes.length) : envelopes.length;
      else counters.errors += envelopes.length;
    } catch {
      latency.record(performance.now() - t);
      counters.errors += envelopes.length;
    }
  };
}

/**
 * kafka sender — idempotent producer (acks=-1, key=brand_id), mirroring the
 * collector's own producer posture (apps/collector/src/infrastructure/kafka-producer.ts).
 * kafkajs is resolved from the collector workspace package — no new deps here.
 */
async function makeKafkaSender(opts, latency, counters) {
  const req = createRequire(new URL('../../../apps/collector/package.json', import.meta.url));
  const { Kafka, logLevel } = req('kafkajs');
  const kafka = new Kafka({
    clientId: 'ingest-40k',
    brokers: opts.brokers.split(',').map((s) => s.trim()),
    logLevel: logLevel.NOTHING,
  });
  // idempotent ⇒ kafkajs enforces maxInFlightRequests=1 + retries≥1 (same as the collector).
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1, retries: 5 });
  await producer.connect();
  const send = async function send(envelopes) {
    const t = performance.now();
    try {
      await producer.send({
        topic: opts.topic,
        acks: -1,
        messages: envelopes.map((ev) => ({
          key: ev.brand_id,
          value: JSON.stringify(ev),
          headers: { 'x-correlation-id': ev.correlation_id, 'x-event-name': ev.event_name },
        })),
      });
      latency.record(performance.now() - t);
      counters.acked += envelopes.length;
    } catch {
      latency.record(performance.now() - t);
      counters.errors += envelopes.length;
    }
  };
  send.close = () => producer.disconnect();
  return send;
}

// ── Main loop ──────────────────────────────────────────────────────────────────

const TICK_MS = 20;
const DUP_RING_MAX = 10_000;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startTsMs = opts.startTs ?? Date.now();
  const factory = makeEventFactory({
    seed: opts.seed,
    startTsMs,
    brandIds: opts.brandIds,
    installToken: opts.installToken,
  });

  if (opts.dryRun > 0) {
    for (let i = 0; i < opts.dryRun; i++) console.log(JSON.stringify(factory.next(i)));
    return;
  }

  mkdirSync(opts.outDir, { recursive: true });
  const idsStream = opts.idsFile
    ? createWriteStream(join(opts.outDir, 'ingest-40k-sent-ids.txt'), { flags: 'w' })
    : null;
  const dupStream = opts.dupPct > 0
    ? createWriteStream(join(opts.outDir, 'ingest-40k-dup-ids.txt'), { flags: 'w' })
    : null;

  const latency = new LatencyRecorder();
  const counters = { acked: 0, errors: 0, http503: 0, throttledTicks: 0 };
  const sender = opts.mode === 'kafka'
    ? await makeKafkaSender(opts, latency, counters)
    : makeHttpSender(opts, latency, counters);

  const dupRand = mulberry32(fnv1a(`${opts.seed}:dup`));
  /** ring of recently sent envelopes — dup-injection source */
  const recent = [];
  let seq = 0; // unique envelopes generated
  let dupsSent = 0;
  let dispatched = 0; // unique + dup sends handed to the sender
  let inflight = 0;
  let stopping = false;

  const totalBudget = Math.round(opts.rate * opts.duration);
  const t0 = performance.now();

  console.error(
    `[ingest-40k] mode=${opts.mode} rate=${opts.rate}/s duration=${opts.duration}s ` +
    `brands=${opts.brandIds.length} dup-pct=${opts.dupPct}% seed=${opts.seed} start_ts=${startTsMs}`,
  );

  /** Dispatch one send of `envelopes` with inflight accounting. */
  const dispatch = (envelopes) => {
    inflight += 1;
    void sender(envelopes).finally(() => { inflight -= 1; });
  };

  let pendingBatch = [];
  const flushBatch = () => {
    if (pendingBatch.length > 0) { dispatch(pendingBatch); pendingBatch = []; }
  };
  const enqueue = (envelope) => {
    if (opts.mode === 'http' && opts.batchSize > 1) {
      pendingBatch.push(envelope);
      if (pendingBatch.length >= opts.batchSize) flushBatch();
    } else {
      dispatch([envelope]);
    }
  };

  await new Promise((resolve) => {
    const finish = () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      flushBatch();
      // Drain in-flight sends (bounded wait: 30s).
      const deadline = Date.now() + 30_000;
      const drain = setInterval(() => {
        if (inflight === 0 || Date.now() > deadline) { clearInterval(drain); resolve(); }
      }, 50);
    };
    process.once('SIGINT', finish);
    const timer = setInterval(() => {
      const elapsed = (performance.now() - t0) / 1000;
      if (elapsed >= opts.duration || dispatched >= totalBudget) { finish(); return; }
      // Open-loop pacing: how many sends SHOULD have been dispatched by now.
      const target = Math.min(totalBudget, Math.floor(opts.rate * elapsed));
      let want = target - dispatched;
      if (want <= 0) return;
      if (inflight >= opts.maxInflight) { counters.throttledTicks += 1; return; }
      while (want-- > 0 && inflight < opts.maxInflight) {
        const isDup = opts.dupPct > 0 && recent.length > 0 && (dupRand() % 10_000) < opts.dupPct * 100;
        let envelope;
        if (isDup) {
          envelope = recent[dupRand() % recent.length];
          dupsSent += 1;
          dupStream?.write(`${envelope.event_id}\n`);
        } else {
          envelope = factory.next(seq);
          seq += 1;
          recent.push(envelope);
          if (recent.length > DUP_RING_MAX) recent.shift();
          idsStream?.write(`${envelope.event_id}\n`);
        }
        dispatched += 1;
        enqueue(envelope);
      }
    }, TICK_MS);
  });

  if (sender.close) await sender.close().catch(() => undefined);
  await Promise.all([idsStream, dupStream].map(
    (s) => s && new Promise((r) => s.end(r)),
  ));

  const elapsedSeconds = (performance.now() - t0) / 1000;
  const summary = buildSummary({
    opts, startTsMs, elapsedSeconds, uniqueSent: seq, dupsSent, counters, latency,
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(opts.outDir, 'ingest-40k-summary.json'), JSON.stringify(summary, null, 2));
  console.error(renderSummary(summary));
  console.log(JSON.stringify(summary));

  // Gate-friendly exit: non-zero when any send errored (503 backpressure is NOT an
  // error — it is the collector's documented shed behavior; assert on it explicitly
  // in chaos runs via the summary).
  process.exit(counters.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[ingest-40k] fatal:', err);
  process.exit(1);
});
