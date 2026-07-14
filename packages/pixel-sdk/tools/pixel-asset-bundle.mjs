// SPEC: A.1.1 (WA-03 pixel build unification)
/**
 * pixel-asset-bundle.mjs — the shared esbuild bundling seam for the served /pixel.js asset.
 * Used by tools/build-pixel-asset.mjs (writes the checked-in artifact) AND by
 * src/asset/pixel-asset-build.test.ts (rebuilds + byte-compares to prove the artifact is not
 * stale). ONE place defines the bundle options so the drift test proves the real build.
 */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BUILT_MODULE_PATH = join(PKG_ROOT, 'src/asset/generated/pixel-asset.built.ts');

/** Bundle src/asset/entry.ts into the single self-contained IIFE. Returns the JS text. */
export async function buildPixelAssetBundle() {
  const result = await build({
    entryPoints: [join(PKG_ROOT, 'src/asset/entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2017',
    charset: 'utf8',
    legalComments: 'none',
    minify: false,
    write: false,
  });
  return result.outputFiles[0].text;
}

/** Write the bundle as the checked-in importable TS string module. Returns the path written. */
export function writeBuiltModule(js) {
  const header = [
    '// SPEC: A.1.1 (WA-03 pixel build unification)',
    '/**',
    ' * GENERATED FILE — DO NOT EDIT.',
    ' *',
    ' * The served /pixel.js brain.js asset: the esbuild IIFE bundle of src/asset/entry.ts',
    ' * (+ runtime.ts + auto-instrument.ts + constants.ts). Regenerate with:',
    ' *   pnpm --filter @brain/pixel-sdk build:asset',
    ' * Staleness is CI-guarded by src/asset/pixel-asset-build.test.ts (rebuild + byte-compare).',
    ' */',
    '',
  ].join('\n');
  mkdirSync(dirname(BUILT_MODULE_PATH), { recursive: true });
  writeFileSync(
    BUILT_MODULE_PATH,
    `${header}export const PIXEL_ASSET_JS: string = ${JSON.stringify(js)};\n`,
  );
  return BUILT_MODULE_PATH;
}
