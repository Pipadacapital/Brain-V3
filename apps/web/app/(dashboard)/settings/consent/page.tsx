/**
 * Consent / Compliance page — server-component shell (D13, feat-d13-consent-cancontact
 * Track C).
 *
 * The per-brand consent/compliance surface: consent coverage, marketing suppression,
 * the read-only 9–9 IST send window, and the can_contact() gate-activity feed. All
 * reads go through the BFF (the client component owns the data fetching via react-query).
 * This shell only sets the document title and mounts the client content.
 */
import { ConsentComplianceContent } from './consent-compliance-content';

export const metadata = { title: 'Consent & Compliance — Brain' };

export default function ConsentCompliancePage() {
  return <ConsentComplianceContent />;
}
