/**
 * Public interface for the `connector` module (core monolith bounded context).
 * RULE: only this file may be imported by other modules — enforced by the ESLint
 * boundary rule. All implementation lives under ./internal/ and is private.
 *
 * M1-app-foundation Track 2 deliverables:
 *   - Shopify OAuth initiate + callback (HMAC-first, NN-4)
 *   - connector_instance / connector_sync_status / connector_cursor service + repos
 *   - Pixel installation + verify + status
 *   - Events: connector.connected, connector.sync_started, pixel.installed, pixel.verified
 *
 * Scope note: NO IConnector/BaseConnector/plugin registry (scope-defer — §2).
 * Shopify is a concrete self-contained impl under sources/storefront/shopify/.
 * Meta/Google = zero backend (UI "Coming Soon" is frontend only).
 *
 * Pixel SDK scope note: The production brain.js pixel SDK (anon-id, 30-min session,
 * UTM/click-ID capture, CNAME deployment) is the M1-data-spine deliverable.
 * packages/pixel-sdk is a separate build target. M1-app-foundation pixel scope =
 * migration 006 + snippet endpoint + verify endpoint + status only.
 */

// Re-export domain types needed by the BFF / frontend-api module
export type { ConnectorStatus, SyncState } from '@brain/connector-core';
export type { PixelState } from './pixel/domain/entities/PixelStatus.js';
