/**
 * Compliance ports — the seams the can_contact() engine depends on.
 *
 * Each is an interface (dependency inversion): the engine (domain) talks to the
 * port; infrastructure provides the concrete adapter. This is what lets Phase-3
 * SMS (DLT) and Phase-6 CAPI (NCPR) slot in behind the same gate with zero redesign.
 *
 * DEV-HONESTY BOUNDARY: real TRAI DLT template registration and the NCPR/DND
 * registry are platform follow-ups. The shipped adapters (see stubs.ts) are
 * DEFAULT-CLOSED — they BLOCK, they never fake an approval. The seam is real; the
 * registry integration is the documented follow-up.
 */

import type { ConsentCategory, SuppressionQuery } from '@brain/contracts';
import type { ContactChannel } from './contact-types.js';

export type { SuppressionQuery, ConsentCategory };

/**
 * Salt seam — per-brand identity salt as a 64-hex string, for identity-core hashing.
 * Implemented in core's notification infra (mirrors the webhook getSaltHex pattern).
 * MUST hard-crash (throw) on fetch/length failure — never returns an empty/default
 * salt (D-2). The engine treats a throw here as a HARD CRASH, never a silent allow.
 */
export interface SaltPort {
  saltHexForBrand(brandId: string): Promise<string>;
}

/**
 * DLT template-approval seam (TRAI / Meta-BSP). Applies to SMS / WhatsApp.
 *
 * `isTemplateApproved` returns true ONLY when a real, registered, approved
 * template exists. The shipped stub returns false (default-closed) until real
 * registration lands.
 */
export interface DltRegistryPort {
  isTemplateApproved(args: {
    brandId: string;
    channel: ContactChannel;
    templateId?: string;
  }): Promise<boolean>;
}

/** NCPR/DND lookup result. `unknown` is FAIL-CLOSED — treated as do-not-contact. */
export type DndStatus = 'on_dnd' | 'not_on_dnd' | 'unknown';

/**
 * NCPR/DND registry seam (telecom — applies to phone channels: SMS / WhatsApp).
 *
 * The shipped stub returns `unknown` (default-closed) — a number whose DND status
 * cannot be affirmatively cleared is NEVER contacted (COMPLIANCE.md: a number on
 * the NCPR must never receive a commercial communication).
 */
export interface NcprRegistryPort {
  dndStatus(args: { brandId: string; subjectHash: string }): Promise<DndStatus>;
}
