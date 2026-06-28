/**
 * Shared types + helpers for the connector/pixel registrars.
 *
 * Extracted VERBATIM from bootstrap/registerConnectors.ts as part of CQ-2's mechanical
 * split. Nothing here changes behavior — `getBrandId` keeps the identical throw shape and
 * the OAuth command bundle is the exact set of commands that two registrars share.
 */
import type { FastifyRequest } from 'fastify';

import type { InitiateOAuthCommand } from '../../modules/connector/sources/storefront/shopify/application/commands/InitiateOAuthCommand.js';
import type { InitiateMetaOAuthCommand } from '../../modules/connector/sources/advertising/meta/application/commands/InitiateMetaOAuthCommand.js';
import type { HandleMetaOAuthCallbackCommand } from '../../modules/connector/sources/advertising/meta/application/commands/HandleMetaOAuthCallbackCommand.js';
import type { InitiateGoogleAdsOAuthCommand } from '../../modules/connector/sources/advertising/google/application/commands/InitiateGoogleAdsOAuthCommand.js';
import type { HandleGoogleAdsOAuthCallbackCommand } from '../../modules/connector/sources/advertising/google/application/commands/HandleGoogleAdsOAuthCallbackCommand.js';
import type { AuthenticatedRequest } from '../../modules/workspace-access/internal/interfaces/rest/auth.routes.js';

/** Config slice the connector context needs (subset of main's config). */
export interface ConnectorContextConfig {
  nodeEnv: string;
  appBaseUrl: string;
  shopifyCallbackUrl: string;
  metaCallbackUrl: string;
  googleAdsCallbackUrl: string;
  pixelIngestBaseUrl: string;
  kafkaEnv: string;
}

/**
 * The OAuth command instances shared by the OAuth-routes registrar (dispatch + callbacks)
 * and the connector-write registrar (legacy install + ads install routes). Constructed once
 * in the orchestrator so both registrars wire the exact same instances (unchanged behavior).
 */
export interface SharedOAuthCommands {
  initiateOAuth: InitiateOAuthCommand;
  initiateMetaOAuth: InitiateMetaOAuthCommand;
  handleMetaCallback: HandleMetaOAuthCallbackCommand;
  initiateGoogleAdsOAuth: InitiateGoogleAdsOAuthCommand;
  handleGoogleAdsCallback: HandleGoogleAdsOAuthCallbackCommand;
}

/** Extract brand_id from the authenticated request (identical throw shape to the original). */
export function getBrandId(req: FastifyRequest): string {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth?.brandId) {
    throw Object.assign(new Error('No brand context in JWT'), { statusCode: 400, code: 'NO_BRAND_CONTEXT' });
  }
  return auth.brandId;
}
