/**
 * NCPR/DND policy — maps a DND-registry status to a fail-closed gate outcome.
 *
 * COMPLIANCE.md: a number on the NCPR must NEVER receive a commercial communication.
 * Therefore both 'on_dnd' AND 'unknown' block — only an affirmatively-cleared
 * 'not_on_dnd' passes. The shipped adapter (StubNcprRegistry) returns 'unknown', so
 * this policy blocks until the real registry lands (platform follow-up).
 */

import type { DndStatus } from '../ports.js';

export type NcprOutcome =
  | { blocked: false }
  | { blocked: true; reason: 'ncpr_dnd' | 'unknown' };

export function evaluateNcpr(status: DndStatus): NcprOutcome {
  if (status === 'not_on_dnd') return { blocked: false };
  // on_dnd → explicit DND; unknown → fail-closed (cannot clear the number).
  return {
    blocked: true,
    reason: status === 'on_dnd' ? 'ncpr_dnd' : 'unknown',
  };
}
