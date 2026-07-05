/**
 * @module notification
 *
 * Public API for the notification module.
 * M1 scope: transactional email (verify, reset, invite) via SES adapter.
 * Consent/DND/tombstone/WhatsApp: Phase 3 defer.
 *
 * I-ST05: ALL outbound notifications go through this module.
 * No other module may call SES or any email provider directly.
 */

export type {
  NotificationService,
  ContactChannel,
  ContactPurpose,
  CanContactResult,
} from './service.js';
export { NotificationServiceImpl } from './internal/notification.service.impl.js';
export { createEmailAdapter } from './internal/ses-adapter.js';

// D13 compliance gate — the can_contact() engine + write path (brand-scoped callers).
export {
  CanContactEngine,
  PgSuppressionQuery,
  StubDltRegistry,
  StubNcprRegistry,
  FunctionSaltPort,
} from './internal/compliance/index.js';

// CAPI passback surface (composition root wires these; see main.ts).
export { createCapiAdapter } from './internal/capi-adapter.js';
export { createCapiCredsPort } from './internal/compliance/capi-creds.adapter.js';
export { CapiPassbackService } from './internal/capi-passback.service.js';
export { startCapiPassback } from './internal/capi-passback.orchestrator.js';
export { fetchFinalizedPurchaseCandidatesScoped } from './internal/capi-source.query.js';

// Route registrars (mounted by bootstrap/registerWorkspaceAccess.ts).
export { registerDevRoutes } from './internal/dev.routes.js';
export { registerConsentRoutes } from './internal/compliance/consent.routes.js';

/**
 * @public AUD-CODE-003 (open): the pending-window flush handler is the deferred DND-window
 * seam — the queue side is LIVE (can-contact.engine emits `queue_pending_window`, send-log
 * persists status='pending_window'); this handler awaits its scheduler wiring. Deleting it
 * would orphan the live queue path.
 */
export { PendingWindowFlushHandler } from './internal/pending-window.handler.js';
