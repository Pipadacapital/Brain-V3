/**
 * workspace-access infrastructure — shared repository helpers.
 *
 * Cursor pagination helpers shared across the per-aggregate repository modules
 * in this directory.
 */

// ── Cursor pagination helper ──────────────────────────────────────────────────

export function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf-8');
}
