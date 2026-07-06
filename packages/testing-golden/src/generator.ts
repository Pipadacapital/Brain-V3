// SPEC: WA.1.10 — golden dataset generator: ~50k events, 3 brands, full scenario matrix (§1.10)
//
// Deterministic by construction: seeded PRNG substreams, deterministic ids, and a
// PARAMETERIZED epoch — no Date.now() / Math.random() anywhere in generation.
// Same (seed, epoch) → byte-identical JSONL files → identical checksums, forever.

import { CollectorEventV1Schema } from '@brain/contracts';
import { Rand } from './prng.js';
import { sha256HexOf } from './ids.js';
import { AURORA, BAZAAR, CEDAR, GOLDEN_BRANDS, type GoldenBrand } from './fixtures.js';
import { BrandScenarioBuilder, type ScenarioKey, type ScenarioBrandStats } from './scenarios.js';
import type { GoldenEvent } from './envelopes.js';

export const DEFAULT_SEED = 'brain-golden-v1';
/** Fixed, well in the past — every prepaid order clears the recognition horizon at capture time. */
export const DEFAULT_EPOCH_ISO = '2026-03-02T00:00:00.000Z';
export const SPAN_DAYS = 28;

/** Scenario→brand persona counts. Tuned to land ~50k events total (locked by the spec test). */
export const DEFAULT_SCENARIO_PLAN: Readonly<Record<GoldenBrand['key'], Partial<Record<ScenarioKey, number>>>> = {
  aurora: {
    anonymous_only: 1600,
    anon_to_known_mid_session: 140,
    multi_device: 60,
    refund: 40,
    late_identify_day7: 50,
    consent_off: 120,
  },
  bazaar: {
    anonymous_only: 1250,
    cod_order: 200,
    shared_device_family: 50,
    consent_off: 80,
  },
  cedar: {
    anonymous_only: 950,
    gcc_kwd_order: 120,
    multi_device: 30,
    consent_off: 60,
  },
};

export interface GoldenFile {
  /** JSONL file name (lane + .jsonl). */
  readonly file: string;
  /** Kafka topic suffix — prepend the env prefix (dev|prod) when producing. */
  readonly topicSuffix: string;
  readonly count: number;
  readonly sha256: string;
  readonly jsonl: string;
}

export interface GoldenManifest {
  generator: string;
  spec: string;
  seed: string;
  epoch: string;
  spanDays: number;
  totalEvents: number;
  brands: Array<{
    key: GoldenBrand['key'];
    brandId: string;
    installToken: string;
    currencyCode: string;
    events: number;
  }>;
  files: Array<Omit<GoldenFile, 'jsonl'>>;
  /** scenario → brand → coverage stats (persona/anon/order id samples included). */
  scenarios: Partial<Record<ScenarioKey, Partial<Record<GoldenBrand['key'], ScenarioBrandStats>>>>;
  /** Designed deterministic identification rate over purchasers (spec Wave-A exit asks > 0.40). */
  identifiedPurchaserRate: number;
  /** sha256 over the concatenated per-file checksums — the ONE dataset fingerprint. */
  datasetChecksum: string;
}

export interface GoldenDataset {
  files: GoldenFile[];
  manifest: GoldenManifest;
}

export interface GenerateOptions {
  seed?: string;
  epochIso?: string;
  plan?: Readonly<Record<GoldenBrand['key'], Partial<Record<ScenarioKey, number>>>>;
}

function toJsonl(events: Array<Record<string, unknown>>): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
}

export function generateGoldenDataset(options: GenerateOptions = {}): GoldenDataset {
  const seed = options.seed ?? DEFAULT_SEED;
  const epochIso = options.epochIso ?? DEFAULT_EPOCH_ISO;
  const plan = options.plan ?? DEFAULT_SCENARIO_PLAN;
  const epochMs = Date.parse(epochIso);
  if (Number.isNaN(epochMs)) throw new Error(`invalid epoch: ${epochIso}`);

  const root = new Rand(`golden||${seed}||${epochIso}`);
  const allEvents: Array<{ brand: GoldenBrand; ev: GoldenEvent }> = [];
  const scenarios: GoldenManifest['scenarios'] = {};
  const brandEventCounts: Record<string, number> = {};
  let purchasers = 0;
  let identifiedPurchasers = 0;

  for (const brand of GOLDEN_BRANDS) {
    const builder = new BrandScenarioBuilder(brand, root.fork(brand.key), epochMs, SPAN_DAYS);
    const result = builder.build(plan[brand.key]);
    for (const ev of result.events) allEvents.push({ brand, ev });
    brandEventCounts[brand.key] = result.events.length;
    for (const [key, stats] of Object.entries(result.stats) as Array<[ScenarioKey, ScenarioBrandStats]>) {
      (scenarios[key] ??= {})[brand.key] = stats;
      purchasers += stats.purchasers;
      identifiedPurchasers += stats.identifiedPurchasers;
    }
  }

  // Deterministic ordering per lane: (occurred_at, event_id).
  const lanes = new Map<string, GoldenEvent[]>();
  for (const { ev } of allEvents) {
    const arr = lanes.get(ev.lane) ?? [];
    arr.push(ev);
    lanes.set(ev.lane, arr);
  }
  for (const arr of lanes.values()) {
    arr.sort((a, b) => a.occurredAtMs - b.occurredAtMs || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  }

  // Contract validation: EVERY collector-lane event must parse the LIVE zod contract.
  for (const ev of lanes.get('collector.event.v1') ?? []) {
    CollectorEventV1Schema.parse(ev.value);
  }

  const files: GoldenFile[] = [...lanes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([lane, events]) => {
      const jsonl = toJsonl(events.map((e) => e.value));
      return {
        file: `${lane}.jsonl`,
        topicSuffix: lane,
        count: events.length,
        sha256: sha256HexOf(jsonl),
        jsonl,
      };
    });

  const totalEvents = files.reduce((n, f) => n + f.count, 0);
  const datasetChecksum = sha256HexOf(files.map((f) => `${f.file}:${f.sha256}`).join('\n'));

  const manifest: GoldenManifest = {
    generator: '@brain/testing-golden',
    spec: 'WA.1.10',
    seed,
    epoch: epochIso,
    spanDays: SPAN_DAYS,
    totalEvents,
    brands: [AURORA, BAZAAR, CEDAR].map((b) => ({
      key: b.key,
      brandId: b.id,
      installToken: b.installToken,
      currencyCode: b.currencyCode,
      events: brandEventCounts[b.key] ?? 0,
    })),
    files: files.map(({ jsonl: _jsonl, ...rest }) => rest),
    scenarios,
    identifiedPurchaserRate: purchasers === 0 ? 0 : identifiedPurchasers / purchasers,
    datasetChecksum,
  };

  return { files, manifest };
}
