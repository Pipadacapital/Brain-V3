/**
 * WooCommercePixelPlugin — the Brain Pixel WordPress/WooCommerce plugin, embedded as source +
 * a zero-dependency STORED-zip builder so the Brain dashboard can serve a ready-to-upload .zip.
 *
 * WHY a plugin (and why this is the honest "same way as Shopify"): WordPress/WooCommerce has NO
 * remote ScriptTag-injection API the way Shopify does — the WC REST keys Brain holds grant access
 * to products/orders/customers/webhooks, NOT to the theme <head>. So the parallel of Shopify's
 * one-time OAuth app authorization is a one-time plugin activation. After that single step the
 * Brain UI's "Install on WooCommerce" button auto-CONFIGURES the plugin in one click (no paste):
 *
 *   1. Merchant uploads + activates this plugin once (Plugins → Add New → Upload).
 *   2. Brain POSTs {install_token, brand_id, ingest_base_url} to the plugin's REST route,
 *      authenticated with the SAME WC consumer key/secret the merchant already gave Brain
 *      (validated against WooCommerce's own key store — wc_api_hash + constant-time compare).
 *   3. The plugin injects <script src="<ingest>/pixel.js?t=&b=" defer> into wp_head on every
 *      front-end page. The served pixel.js self-bootstraps from ?t=&b= (registerPixelAssetRoute),
 *      so the SAME comprehensive, multi-storefront asset runs on WooCommerce.
 *
 * SECURITY: the plugin NEVER stores or echoes secrets; it persists only the (non-secret) install
 * token + brand id + ingest URL as WP options. The config route is write-gated on a valid WC
 * read_write/write key. No raw PII ever touches this path.
 *
 * The PHP is embedded as a string (same pattern as pixel-asset.route.ts's PIXEL_JS) so it is always
 * available regardless of cwd/bundling, and the served zip is always in lock-step with this source.
 */
import { createHash } from 'node:crypto';

/** Bumped whenever the plugin PHP changes — surfaced in the plugin header + GET status route. */
export const WC_PLUGIN_VERSION = '1.0.0';

/** Folder + main-file slug inside the zip (WordPress expects <slug>/<slug>.php). */
export const WC_PLUGIN_SLUG = 'brain-pixel';

/**
 * The Brain Pixel plugin PHP. A single-file plugin: header + wp_head injector + a REST config
 * endpoint authenticated against WooCommerce's own consumer-key store.
 */
export const BRAIN_WC_PLUGIN_PHP = `<?php
/**
 * Plugin Name: Brain Pixel
 * Plugin URI: https://brain.ai
 * Description: First-party Brain Pixel for WooCommerce — captures the customer journey (page/product/
 *   collection views, cart, search, checkout steps, clicks, scroll depth) with zero theme edits.
 *   Configured automatically from the Brain dashboard ("Install on WooCommerce").
 * Version: ${WC_PLUGIN_VERSION}
 * Author: Brain
 * License: GPL-2.0-or-later
 * Requires Plugins: woocommerce
 */

if (!defined('ABSPATH')) { exit; } // No direct access.

define('BRAIN_PIXEL_VERSION', '${WC_PLUGIN_VERSION}');

/**
 * Inject the Brain Pixel into <head> on every front-end page (never wp-admin). The served pixel.js
 * self-bootstraps window.__brain from the ?t=&b= query params, so no inline config is needed here.
 */
add_action('wp_head', function () {
    if (is_admin()) { return; }
    $token  = get_option('brain_pixel_install_token');
    $brand  = get_option('brain_pixel_brand_id');
    $ingest = get_option('brain_pixel_ingest_base_url');
    if (empty($token) || empty($brand) || empty($ingest)) { return; }
    $src = rtrim($ingest, '/') . '/pixel.js?t=' . rawurlencode($token) . '&b=' . rawurlencode($brand);
    echo '<script async src="' . esc_url($src) . '" data-brain-pixel="1"></script>' . "\\n";
}, 1);

/**
 * Validate an incoming request against WooCommerce's own consumer-key store (the SAME ck/cs the
 * merchant gave Brain). Mirrors WC_REST_Authentication: hash the key with wc_api_hash, look it up,
 * constant-time compare the secret, require write permission. Returns true or a WP_Error.
 */
function brain_pixel_authenticate($request) {
    list($ck, $cs) = brain_pixel_read_basic_auth();
    if (empty($ck) || empty($cs)) {
        return new WP_Error('brain_unauthorized', 'Missing WooCommerce API credentials.', array('status' => 401));
    }
    if (!function_exists('wc_api_hash')) {
        return new WP_Error('brain_no_woocommerce', 'WooCommerce is not active.', array('status' => 500));
    }
    global $wpdb;
    $hashed = wc_api_hash($ck);
    $row = $wpdb->get_row($wpdb->prepare(
        "SELECT consumer_secret, permissions FROM {$wpdb->prefix}woocommerce_api_keys WHERE consumer_key = %s",
        $hashed
    ));
    if (!$row) {
        return new WP_Error('brain_unauthorized', 'Invalid WooCommerce API key.', array('status' => 401));
    }
    if (!hash_equals((string) $row->consumer_secret, (string) $cs)) {
        return new WP_Error('brain_unauthorized', 'Invalid WooCommerce API secret.', array('status' => 401));
    }
    if (!in_array($row->permissions, array('write', 'read_write'), true)) {
        return new WP_Error('brain_forbidden', 'WooCommerce API key lacks write permission.', array('status' => 403));
    }
    return true;
}

/**
 * Read consumer key/secret from HTTP Basic auth, falling back to the Authorization header (some
 * FPM/Apache setups do not populate PHP_AUTH_*) and finally to query params (WC's own fallback).
 */
function brain_pixel_read_basic_auth() {
    $ck = isset($_SERVER['PHP_AUTH_USER']) ? $_SERVER['PHP_AUTH_USER'] : '';
    $cs = isset($_SERVER['PHP_AUTH_PW']) ? $_SERVER['PHP_AUTH_PW'] : '';
    if (empty($ck)) {
        $auth = '';
        if (isset($_SERVER['HTTP_AUTHORIZATION'])) { $auth = $_SERVER['HTTP_AUTHORIZATION']; }
        elseif (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) { $auth = $_SERVER['REDIRECT_HTTP_AUTHORIZATION']; }
        if (stripos($auth, 'Basic ') === 0) {
            $decoded = base64_decode(substr($auth, 6));
            if ($decoded !== false && strpos($decoded, ':') !== false) {
                list($ck, $cs) = explode(':', $decoded, 2);
            }
        }
    }
    if (empty($ck) && isset($_GET['consumer_key']))    { $ck = sanitize_text_field(wp_unslash($_GET['consumer_key'])); }
    if (empty($cs) && isset($_GET['consumer_secret'])) { $cs = sanitize_text_field(wp_unslash($_GET['consumer_secret'])); }
    return array($ck, $cs);
}

add_action('rest_api_init', function () {
    // GET /wp-json/brain/v1/pixel — presence + current config (no secrets). Used by Brain to detect
    // the plugin before pushing config (a 404 here = plugin not installed/active).
    register_rest_route('brain/v1', '/pixel', array(
        'methods'             => 'GET',
        'permission_callback' => 'brain_pixel_authenticate',
        'callback'            => function () {
            return new WP_REST_Response(array(
                'plugin'     => 'brain-pixel',
                'version'    => BRAIN_PIXEL_VERSION,
                'configured' => (bool) get_option('brain_pixel_install_token'),
                'brand_id'   => get_option('brain_pixel_brand_id') ?: null,
            ), 200);
        },
    ));
    // POST /wp-json/brain/v1/pixel — auto-configure (one-click "Install on WooCommerce" from Brain).
    register_rest_route('brain/v1', '/pixel', array(
        'methods'             => 'POST',
        'permission_callback' => 'brain_pixel_authenticate',
        'callback'            => function (WP_REST_Request $request) {
            $token  = sanitize_text_field((string) $request->get_param('install_token'));
            $brand  = sanitize_text_field((string) $request->get_param('brand_id'));
            $ingest = esc_url_raw((string) $request->get_param('ingest_base_url'));
            if (empty($token) || empty($brand) || empty($ingest)) {
                return new WP_Error('brain_bad_request', 'install_token, brand_id and ingest_base_url are required.', array('status' => 400));
            }
            if (stripos($ingest, 'https://') !== 0) {
                return new WP_Error('brain_bad_request', 'ingest_base_url must be HTTPS.', array('status' => 400));
            }
            update_option('brain_pixel_install_token', $token, false);
            update_option('brain_pixel_brand_id', $brand, false);
            update_option('brain_pixel_ingest_base_url', $ingest, false);
            return new WP_REST_Response(array('ok' => true, 'configured' => true, 'version' => BRAIN_PIXEL_VERSION), 200);
        },
    ));
    // DELETE /wp-json/brain/v1/pixel — remove config (stops injection). Plugin stays active.
    register_rest_route('brain/v1', '/pixel', array(
        'methods'             => 'DELETE',
        'permission_callback' => 'brain_pixel_authenticate',
        'callback'            => function () {
            delete_option('brain_pixel_install_token');
            delete_option('brain_pixel_brand_id');
            delete_option('brain_pixel_ingest_base_url');
            return new WP_REST_Response(array('ok' => true, 'configured' => false), 200);
        },
    ));
});

// Clean up options on uninstall (not just deactivate).
register_uninstall_hook(__FILE__, 'brain_pixel_uninstall');
function brain_pixel_uninstall() {
    delete_option('brain_pixel_install_token');
    delete_option('brain_pixel_brand_id');
    delete_option('brain_pixel_ingest_base_url');
}
`;

// ── Zero-dependency STORED (uncompressed) zip builder ────────────────────────────
// WordPress's plugin uploader accepts STORED zips. We avoid a zip dependency AND avoid committing a
// binary by building the archive in memory from the embedded PHP above — always in lock-step.

const CRC_TABLE: number[] = (() => {
  const t: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!)! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Build a STORED (no-compression) zip from the given entries. Deterministic (fixed DOS timestamp). */
function buildStoredZip(entries: ZipEntry[]): Buffer {
  const DOS_TIME = 0; // fixed → byte-stable archive across builds
  const DOS_DATE = 0x21; // 1980-01-01 (lowest legal DOS date)
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(0, 8); // method 0 = stored
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18); // compressed size
    lfh.writeUInt32LE(size, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len
    locals.push(lfh, nameBuf, e.data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // central dir signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(0, 10); // method
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(size, 20);
    cdh.writeUInt32LE(size, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra
    cdh.writeUInt16LE(0, 32); // comment
    cdh.writeUInt16LE(0, 34); // disk number
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42); // local header offset
    centrals.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + e.data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** Stable content hash of the plugin source — used as the download ETag / version validator. */
export function pluginSourceHash(): string {
  return createHash('sha256').update(BRAIN_WC_PLUGIN_PHP).digest('hex').slice(0, 16);
}

/** The ready-to-upload Brain Pixel plugin zip (brain-pixel/brain-pixel.php). */
export function buildWooCommercePluginZip(): Buffer {
  return buildStoredZip([
    { name: `${WC_PLUGIN_SLUG}/${WC_PLUGIN_SLUG}.php`, data: Buffer.from(BRAIN_WC_PLUGIN_PHP, 'utf8') },
  ]);
}
