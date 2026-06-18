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
export { createEmailAdapter, DevEmailAdapter, SesEmailAdapter } from './internal/ses-adapter.js';

// D13 compliance gate — the can_contact() engine + write path (brand-scoped callers).
export {
  buildCanContactEngine,
  CanContactEngine,
  ConsentWriter,
  PgSuppressionQuery,
  StubDltRegistry,
  StubNcprRegistry,
  EnvSaltPort,
  FunctionSaltPort,
  evaluateSendWindow,
} from './internal/compliance/index.js';
export { PendingWindowFlushHandler } from './internal/pending-window.handler.js';
