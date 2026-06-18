/**
 * Default-closed registry stubs — the DEV-HONESTY boundary.
 *
 * These are the SHIPPED adapters for the DLT and NCPR ports. They BLOCK, they never
 * fake an approval:
 *   - StubDltRegistry  → templateApproved = false  (no real TRAI/Meta-BSP registration yet)
 *   - StubNcprRegistry → dndStatus = 'unknown'     (no real NCPR/DND registry yet)
 *
 * Real TRAI DLT template registration and the NCPR/DND registry are platform
 * follow-ups (req §Dev-honesty). When they land, a real adapter replaces these
 * behind the SAME port — the engine does not change. NEVER replace these with a
 * `return true` placeholder: that would fake compliance.
 */

import type { DltRegistryPort, NcprRegistryPort, DndStatus } from './ports.js';

/** DLT: no approved template exists until real registration lands → block. */
export class StubDltRegistry implements DltRegistryPort {
  async isTemplateApproved(): Promise<boolean> {
    // DEV-HONEST: no real DLT registry — default-closed. Never returns true.
    return false;
  }
}

/** NCPR: DND status is unknowable without the real registry → unknown → block. */
export class StubNcprRegistry implements NcprRegistryPort {
  async dndStatus(): Promise<DndStatus> {
    // DEV-HONEST: no real NCPR registry — fail-closed 'unknown'. Never 'not_on_dnd'.
    return 'unknown';
  }
}
