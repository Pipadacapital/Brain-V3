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

export type { NotificationService } from './service.js';
export { NotificationServiceImpl } from './internal/notification.service.impl.js';
export { createEmailAdapter, DevEmailAdapter, SesEmailAdapter } from './internal/ses-adapter.js';
