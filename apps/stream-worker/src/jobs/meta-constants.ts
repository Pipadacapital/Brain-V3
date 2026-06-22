/**
 * meta-constants.ts — shared Meta (Facebook) Graph API constants.
 *
 * Single source of truth for the Graph API version used across all Meta jobs
 * (meta-spend-repull, meta-token-refresh). Previously triplicated — now ONE place.
 *
 * Pinned to v25.0 (verified current Feb-2026; review at each Meta breaking-change cycle).
 */

/** Graph API version string — referenced in every URL that talks to Meta's Graph API. */
export const GRAPH_API_VERSION = 'v25.0';

/** Base URL for the Graph API (data endpoints). */
export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/** Base URL for OAuth endpoints (token exchange). */
export const GRAPH_OAUTH_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`;
