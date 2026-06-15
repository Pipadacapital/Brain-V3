/**
 * @module frontend-api
 *
 * Public API for the frontend-api (BFF) module.
 * httpOnly cookie session, CSRF protection, fan-out to internal modules.
 *
 * NN-3: validateSession runs on every BFF route (including proxy routes).
 */

export { registerBffRoutes } from './internal/bff.routes.js';
