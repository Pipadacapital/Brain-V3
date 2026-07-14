// SPEC: A.1.1 (WA-03 pixel build unification)
/**
 * pixel-asset-build.test.ts — the checked-in served asset (generated/pixel-asset.built.ts) is a
 * LITERAL, current build artifact of src/asset/*: rebuild with the same pinned esbuild options
 * and byte-compare. A red here means someone edited the asset sources without regenerating
 * (`pnpm --filter @brain/pixel-sdk build:asset`) — or hand-edited the generated file (never do
 * that; the WA-03 amendment ended the hand-maintained-IIFE era).
 */
import { describe, it, expect } from 'vitest';
// @ts-ignore — untyped internal build tool (plain .mjs, not part of the published surface)
import { buildPixelAssetBundle } from '../../tools/pixel-asset-bundle.mjs';
import { PIXEL_ASSET_JS } from './generated/pixel-asset.built.js';
import { PIXEL_ASSET_VERSION } from './constants.js';

describe('WA-03 (A.1.1) — served asset is a literal, non-stale build artifact', () => {
  it('rebuilding src/asset/entry.ts byte-matches the checked-in artifact', async () => {
    const rebuilt = (await buildPixelAssetBundle()) as string;
    expect(rebuilt).toBe(PIXEL_ASSET_JS);
  });

  it('stamps the pixel version into the bundle (collector_version provenance)', () => {
    expect(PIXEL_ASSET_JS.includes(PIXEL_ASSET_VERSION)).toBe(true);
  });
});
