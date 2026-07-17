# ingest-40k — load + duplicate-injection harness (ADR-0015 / doc-18 PR 0.1)

Plain-Node (zero-npm-dep) harness that replays a synthetic pixel `CollectorEventV1`
stream at a configurable rate, injects application duplicates on demand, and reports
achieved rate + ACK-latency percentiles + error/503 counts. It is the measurement
instrument for the doc-18 **P1** (broker-restart chaos, zero loss, p99 ACK < 50 ms)
and **P2** (duplicate-injection, Bronze zero-dupe post-compaction) verification gates.

Relationship to `tools/load-test/` (k6): the k6 scripts remain the general HTTP soak
harness. This tool exists because the ADR-0015 gates need things k6 can't do:
a **direct Kafka producer mode** (broker-side sizing), **deterministic UUIDv7-style
event ids** (regenerable sent-set for exact loss accounting), a **sent-id manifest**,
and **verbatim duplicate re-sends**.

> The harness only SENDS. All landing-side assertions (Bronze counts, dupe checks)
> are out-of-band SQL over duckdb-serving — commands below. Do **not** point high
> rates at a shared dev stack.

## Modes

| Mode | Path | What it measures |
| --- | --- | --- |
| `--mode http` (default) | `POST /collect` (or `/batch` when `--batch-size > 1`) on `:8787` | The REAL ADR-0015 accept path: produce-to-log (idempotent, `acks=-1`) or bounded local-disk WAL **before** the HTTP ACK. Latency here is the accept+ack SLO surface (P1 p99 < 50 ms). 503 + `Retry-After` = documented backpressure shed (WAL at cap AND log unreachable) — counted separately, never as an error. |
| `--mode kafka` | Idempotent produce straight to the collector topic (`dev.collector.event.v1`), key = `brand_id`, `acks=-1` | Broker/Connect-sink-side sizing without the HTTP edge. Latency = produce-ack. Uses `kafkajs` resolved from `apps/collector`'s workspace install (run `pnpm install` at repo root first). |

## Usage

```sh
# Shape check — print 3 sample envelopes, no network:
node tools/load/ingest-40k/producer.mjs --dry-run 3

# HTTP mode, 500 events/sec for 2 min, 4 brands, 5% duplicate injection:
node tools/load/ingest-40k/producer.mjs \
  --mode http --url http://localhost:8787 \
  --rate 500 --duration 120 --brands 4 --dup-pct 5 \
  --install-token <pixel-install-token> --out-dir /tmp/ingest-40k

# Kafka producer mode (broker-side sizing), 5k/sec for 60s:
node tools/load/ingest-40k/producer.mjs \
  --mode kafka --brokers localhost:9092 --topic dev.collector.event.v1 \
  --rate 5000 --duration 60 --brands 8 --out-dir /tmp/ingest-40k
```

Run `--help` for the full flag list. Key semantics:

- **`--rate` / `--duration`** — open-loop pacing (20 ms scheduler ticks); the summary
  reports the *achieved* rate so a saturated target shows up as a shortfall, plus
  `throttled_ticks` when the `--max-inflight` cap (default 1024) gated dispatch.
- **`--brands N`** — events round-robin across N deterministic brand uuids (derived
  from `--seed`); `--brand-ids a,b,c` overrides with real brand uuids. The top-level
  `brand_id` is partitioning-only/untrusted; `properties.install_token` (R2) is what
  Silver admission trusts — pass a real `--install-token` if the run must survive the
  Silver gate, otherwise Bronze-level assertions still hold.
- **`--dup-pct P`** — P% of sends re-send a previously sent envelope **verbatim**
  (same `event_id`) — the P2 application-duplicate source. Dup picks are seeded-PRNG
  deterministic; re-sent ids are listed in `ingest-40k-dup-ids.txt`.
- **Determinism** — `event_id`s are UUIDv7-style, fully determined by
  (`--seed`, `start_ts_ms`, sequence). Both are recorded in the summary JSON, so the
  exact sent-id set can be regenerated offline even without the manifest.

## Artifacts (in `--out-dir`)

| File | Contents |
| --- | --- |
| `ingest-40k-summary.json` | mode/target, seed + `start_ts_ms`, unique/dup counts, target vs achieved rate, acked/errors/503s, p50/p95/p99/max ACK latency. Also printed to stdout as one JSON line (orchestrator-friendly) and human-rendered on stderr. |
| `ingest-40k-sent-ids.txt` | one **unique** sent `event_id` per line — the P1 loss-check truth set. |
| `ingest-40k-dup-ids.txt` | one line per duplicate re-send (only with `--dup-pct > 0`). |

Exit code: non-zero when any send **errored** (transport failure / non-503 5xx).
503 backpressure is the collector's documented shed behavior — assert on
`http_503` explicitly per scenario instead.

## Gate P1 — broker-restart chaos (zero acknowledged-event loss, p99 ACK < 50 ms)

1. Start the run (HTTP mode — the ACK contract is what's under test):

   ```sh
   node tools/load/ingest-40k/producer.mjs \
     --mode http --rate 1000 --duration 300 --brands 4 \
     --out-dir /tmp/p1 &
   ```

2. Mid-run, restart the broker (compose service name is `kafka`):

   ```sh
   docker compose restart kafka
   ```

   Expectation while the broker is down: ACKs continue via the bounded local-disk
   WAL (durability anchor moves to the fsync'd append); 503s appear **only** if the
   WAL saturates. On reconnect the WAL flushes to the log.

3. After the run, wait ≥ 2 Connect commit intervals (~60 s) for the sink to drain,
   then assert **every acknowledged id landed** — load the manifest into DuckDB and
   anti-join against Bronze (via duckdb-serving `POST :8091/v1/query`, or the duckdb
   CLI attached to the Iceberg REST catalog):

   ```sql
   -- Zero loss: every sent (ACKed) event_id has ≥ 1 Bronze row.
   SELECT count(*) AS missing
   FROM read_csv('/tmp/p1/ingest-40k-sent-ids.txt',
                 columns = {'event_id': 'VARCHAR'}, header = false) s
   LEFT JOIN iceberg.brain_bronze.collector_events_connect_lifted b
     ON b.event_id = s.event_id
   WHERE b.event_id IS NULL;
   -- PASS: missing = 0.
   ```

   (Coarse version, no manifest join: Bronze `count(*)` over the run window per
   brand `>= events_sent_unique` — same shape as `tools/load-test/README.md`.)

4. Latency gate: `ack_latency.p99_ms < 50` in `ingest-40k-summary.json`, and
   `errors = 0` (503s allowed only in the WAL-saturation scenario being tested).

## Gate P2 — duplicate injection (Bronze zero-dupe post-compaction; Silver always)

1. Run with duplicate injection (both modes are valid P2 sources — HTTP exercises
   application-level dups through the whole path; kafka mode isolates the sink):

   ```sh
   node tools/load/ingest-40k/producer.mjs \
     --mode http --rate 500 --duration 120 --brands 4 --dup-pct 5 \
     --out-dir /tmp/p2
   ```

2. Let the Bronze compaction dedup lane run (doc-18 PR 2.2 —
   `db/iceberg/duckdb/maintenance/bronze_dedup.py`, keep-latest on
   `(brand_id, event_id)`), then assert Bronze zero-dupe:

   ```sql
   -- Post-compaction: (brand_id, event_id) unique in Bronze.
   SELECT count(*) AS dupes
   FROM (SELECT brand_id, event_id
           FROM iceberg.brain_bronze.collector_events_connect_lifted
          GROUP BY brand_id, event_id
         HAVING count(*) > 1);
   -- PASS: dupes = 0.
   ```

3. Silver is duplicate-free **always** (MERGE backstop, no compaction wait):

   ```sql
   SELECT count(*) AS dupes
   FROM (SELECT brand_id, event_id
           FROM iceberg.brain_silver.silver_collector_event
          GROUP BY brand_id, event_id
         HAVING count(*) > 1);
   -- PASS: dupes = 0.
   ```

4. Cross-check magnitude: pre-compaction Bronze surplus over unique ids should be
   ≈ `duplicates_sent` (+ any at-least-once transport re-deliveries).

## Notes / limits

- Node ≥ 20 required (global `fetch`, ESM). Syntax-checkable offline:
  `node --check tools/load/ingest-40k/*.mjs`.
- A single Node process sustains ~5–10k HTTP events/sec (use `--batch-size` up to 50
  to push further); for a true 40k/sec soak, shard N processes with distinct
  `--seed` values (id spaces are disjoint per seed) and sum the summaries.
- The harness never reads the stack; pair it with the operator assertions here and
  in `tools/load-test/README.md` (commit cadence, consumer lag, zero-OOM).
