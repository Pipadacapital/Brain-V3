#!/usr/bin/env node
// SPEC: WA.1.10 — JSONL → keyed Kafka console-producer lines (§1.10 harness)
//
// Reads a golden JSONL file and prints `key<TAB>value` lines to stdout, ready for
//   kafka-console-producer.sh --property parse.key=true --property key.separator=<TAB>
// Key = brand_id (tenant partition key — same convention as WebhookPipeline's
// producer.send key). Files whose records lack brand_id (raw lanes) take --key <const>.
//
// Usage: node produce-jsonl.mjs <file.jsonl> [--key <constant>]

import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: produce-jsonl.mjs <file.jsonl> [--key <constant>]');
  process.exit(1);
}
const keyFlagIdx = process.argv.indexOf('--key');
const constKey = keyFlagIdx !== -1 ? process.argv[keyFlagIdx + 1] : null;

const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
let count = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  let key = constKey;
  if (!key) {
    const parsed = JSON.parse(line);
    key = parsed.brand_id;
    if (!key) {
      console.error(`[produce-jsonl] line ${count + 1}: no brand_id and no --key given`);
      process.exit(1);
    }
  }
  process.stdout.write(`${key}\t${line}\n`);
  count += 1;
}
console.error(`[produce-jsonl] emitted ${count} keyed records from ${file}`);
