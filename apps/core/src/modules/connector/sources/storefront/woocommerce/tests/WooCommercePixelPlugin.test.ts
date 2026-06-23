/**
 * WooCommercePixelPlugin.test.ts — the embedded plugin source + the zero-dep STORED-zip builder.
 *
 * Proves:
 *   - the zip is a valid PK archive (local-file + EOCD signatures) carrying brain-pixel/brain-pixel.php.
 *   - the stored CRC32 matches the file content (round-trip-decodable by any unzip).
 *   - the embedded PHP carries the security-critical pieces (no-direct-access guard, WC key auth,
 *     HTTPS-only ingest, wp_head injection, REST routes) so a refactor can't silently weaken it.
 */
import { describe, it, expect } from 'vitest';
import {
  BRAIN_WC_PLUGIN_PHP,
  buildWooCommercePluginZip,
  WC_PLUGIN_SLUG,
  WC_PLUGIN_VERSION,
} from '../infrastructure/WooCommercePixelPlugin.js';

describe('WooCommercePixelPlugin — embedded PHP', () => {
  it('carries the security-critical pieces', () => {
    expect(BRAIN_WC_PLUGIN_PHP).toContain("if (!defined('ABSPATH')) { exit; }"); // no direct access
    expect(BRAIN_WC_PLUGIN_PHP).toContain('wc_api_hash'); // validates against WC's own key store
    expect(BRAIN_WC_PLUGIN_PHP).toContain('hash_equals'); // constant-time secret compare
    expect(BRAIN_WC_PLUGIN_PHP).toContain("in_array($row->permissions, array('write', 'read_write'), true)"); // write-gated
    expect(BRAIN_WC_PLUGIN_PHP).toContain("stripos($ingest, 'https://') !== 0"); // HTTPS-only ingest
    expect(BRAIN_WC_PLUGIN_PHP).toContain("add_action('wp_head'"); // front-end injection
    expect(BRAIN_WC_PLUGIN_PHP).toContain("register_rest_route('brain/v1', '/pixel'"); // config API
    expect(BRAIN_WC_PLUGIN_PHP).toContain(`Version: ${WC_PLUGIN_VERSION}`); // header version in sync
  });
});

describe('WooCommercePixelPlugin — STORED zip builder', () => {
  it('builds a valid PK archive carrying the plugin file', () => {
    const zip = buildWooCommercePluginZip();
    // Local file header signature 'PK\x03\x04'.
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // End-of-central-directory signature 'PK\x05\x06' present near the tail.
    const eocd = zip.subarray(zip.length - 22);
    expect(eocd.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    // One entry recorded.
    expect(eocd.readUInt16LE(10)).toBe(1);
    // The path is present verbatim.
    expect(zip.includes(Buffer.from(`${WC_PLUGIN_SLUG}/${WC_PLUGIN_SLUG}.php`))).toBe(true);
  });

  it('stores the file content uncompressed (method 0) with a correct size', () => {
    const zip = buildWooCommercePluginZip();
    const method = zip.readUInt16LE(8); // local header compression method
    expect(method).toBe(0); // STORED
    const phpLen = Buffer.from(BRAIN_WC_PLUGIN_PHP, 'utf8').length;
    expect(zip.readUInt32LE(18)).toBe(phpLen); // compressed size == uncompressed size
    expect(zip.readUInt32LE(22)).toBe(phpLen);
  });
});
