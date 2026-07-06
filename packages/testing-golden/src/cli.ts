// SPEC: WA.1.10 — golden dataset CLI (§1.10)
//
// Usage:
//   pnpm --filter @brain/testing-golden generate -- --out <dir> [--seed <s>] [--epoch <iso>]
//
// Writes one JSONL file per lane (collector.event.v1.jsonl, shopify.orders.raw.v1.jsonl)
// plus manifest.json (counts, checksums, scenario coverage map).

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateGoldenDataset, DEFAULT_SEED, DEFAULT_EPOCH_ISO } from './generator.js';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new Error(`missing value for ${flag}`);
  }
  return v;
}

function main(): void {
  const out = resolve(argValue('--out') ?? 'golden-out');
  const seed = argValue('--seed') ?? DEFAULT_SEED;
  const epochIso = argValue('--epoch') ?? DEFAULT_EPOCH_ISO;

  const { files, manifest } = generateGoldenDataset({ seed, epochIso });

  mkdirSync(out, { recursive: true });
  for (const f of files) {
    writeFileSync(resolve(out, f.file), f.jsonl, 'utf8');
  }
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`[testing-golden] seed=${seed} epoch=${epochIso}`);
  for (const f of files) {
    console.log(`[testing-golden]   ${f.file}  events=${f.count}  sha256=${f.sha256.slice(0, 16)}…`);
  }
  console.log(`[testing-golden] total=${manifest.totalEvents}  identifiedPurchaserRate=${manifest.identifiedPurchaserRate.toFixed(3)}`);
  console.log(`[testing-golden] datasetChecksum=${manifest.datasetChecksum}`);
  console.log(`[testing-golden] wrote ${files.length + 1} files to ${out}`);
}

main();
