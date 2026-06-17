/**
 * catalog/index.ts — catalog helpers (ADR-CM-1).
 *
 * getDefinition(type)        — look up a connector by id, null if unknown.
 * isConnectable(def)         — true iff availability === 'available' (runtime gate).
 * mapHealthToSafety(state)   — 7-state → 3-state recommendation safety mapping.
 *
 * The server-side connect gate keys off isConnectable:
 *   - coming_soon availability ⇒ 422, regardless of connectMethod
 *   - This is the authoritative check; client-side disabled button is UX only.
 *
 * Scale note (Scale-C4): InProcessOAuthStateStore stores nonces in memory.
 * Single-pod only — a Redis impl is needed before horizontal scale.
 * Reserved: IOAuthStateStore seam exists; wire Redis as the production impl when needed.
 */
export { CONNECTOR_CATALOG } from './registry.js';
export type { ConnectorDefinition, ConnectorCategory, ConnectMethod } from './registry.js';
export { mapHealthToSafety, HEALTH_TO_SAFETY } from './healthSafety.js';
export type { HealthState, SafetyRating } from './healthSafety.js';

import { CONNECTOR_CATALOG } from './registry.js';
import type { ConnectorDefinition } from './registry.js';

/**
 * Look up a connector definition by its canonical id.
 * Returns null for unknown type (caller should 400).
 */
export function getDefinition(type: string): ConnectorDefinition | null {
  return CONNECTOR_CATALOG.find((d) => d.id === type) ?? null;
}

/**
 * True iff the connector is connectable right now (M1 gate: availability === 'available').
 * A definition with availability:'coming_soon' is treated as un-connectable (422)
 * regardless of its connectMethod — so oauth-but-coming-soon (meta) is rejected.
 */
export function isConnectable(def: ConnectorDefinition): boolean {
  return def.availability === 'available';
}
