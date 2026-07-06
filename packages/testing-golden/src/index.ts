// SPEC: WA.1.10 — @brain/testing-golden public API (§1.10 golden dataset)
export { Rand } from './prng.js';
export { deterministicUuid, sha256HexOf, pixelIdentifyEmailHash } from './ids.js';
export {
  GOLDEN_ORG_ID, GOLDEN_OWNER_USER_ID, GOLDEN_OWNER_EMAIL,
  AURORA, BAZAAR, CEDAR, GOLDEN_BRANDS, GOLDEN_BRAND_IDS,
  CATALOG, CHANNELS, LANDINGS,
  type GoldenBrand, type GoldenChannel, type GoldenProduct,
} from './fixtures.js';
export {
  buildPixelEvent, wrapCanonicalEvent,
  CONSENT_GRANTED, CONSENT_DENIED_ANALYTICS,
  type ConsentMode, type GoldenEvent, type PixelEventInput, type CanonicalEventInput,
} from './envelopes.js';
export { BrandScenarioBuilder, type ScenarioKey, type ScenarioBrandStats, type BrandBuildResult } from './scenarios.js';
export {
  generateGoldenDataset,
  DEFAULT_SEED, DEFAULT_EPOCH_ISO, SPAN_DAYS, DEFAULT_SCENARIO_PLAN,
  type GoldenDataset, type GoldenManifest, type GoldenFile, type GenerateOptions,
} from './generator.js';
