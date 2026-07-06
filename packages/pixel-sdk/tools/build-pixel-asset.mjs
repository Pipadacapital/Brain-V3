// SPEC: A.1.1 (WA-03 pixel build unification)
/**
 * build-pixel-asset.mjs — bundles src/asset/entry.ts into the single self-contained /pixel.js
 * IIFE and writes it as a checked-in, importable TS string module
 * (src/asset/generated/pixel-asset.built.ts). The collector serves THIS artifact — the served
 * pixel is a literal build artifact of @brain/pixel-sdk (WA-03), no hand-maintained IIFE.
 *
 * esbuild is pinned EXACTLY (package.json devDependency) so the emitted bundle is deterministic;
 * src/asset/pixel-asset-build.test.ts rebuilds and byte-compares to catch a stale artifact.
 *
 * Not minified on purpose: the served asset stays debuggable + marker-greppable (same posture as
 * the previous readable hand-written IIFE). target=es2017 keeps the deliberately ES5-ish source
 * untransformed (no downlevel rewriting of the verbatim-ported logic).
 *
 * Run: pnpm --filter @brain/pixel-sdk build:asset
 */
import { buildPixelAssetBundle, writeBuiltModule } from './pixel-asset-bundle.mjs';

const js = await buildPixelAssetBundle();
const outPath = writeBuiltModule(js);
console.log(`[build-pixel-asset] wrote ${outPath} (${js.length} bytes)`);
