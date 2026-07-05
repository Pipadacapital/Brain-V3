/**
 * Server-side workspace slug derivation (feat-onboarding-ux, Deliverable 4).
 *
 * Slug is an implementation detail — the frontend never sends or shows it. This
 * helper is the SINGLE source of the slug rule, shared by WorkspaceService.create
 * (standalone route) and OnboardingService.provisionWorkspaceAndBrand (merged step).
 *
 * Mirrors the logic the frontend previously did at create-workspace-form.tsx:34-45,
 * MOVED to the server (the frontend version is deleted).
 */

import { randomUUID } from 'node:crypto';

/** Lowercase, non-alphanumeric → hyphen, trim hyphens, ≤55 chars (leaves room for the suffix). */
function slugifyBase(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 55)
    .replace(/-+$/g, ''); // re-trim a trailing hyphen the slice may have created
  // Guard: an all-symbol name slugifies to '' → fall back to 'workspace' so the
  // final slug is always a valid [a-z0-9-]+ token (matches WorkspaceSchema regex).
  return base.length > 0 ? base : 'workspace';
}

/** A short collision-resistant suffix (6 hex chars from a UUID). */
function slugSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(-6);
}

/**
 * Derive a unique-ish workspace slug from a display name: `slugify(name)-<suffix>`.
 * The suffix makes practical collisions near-zero; callers retry once on the
 * residual unique-violation race.
 */
export function deriveSlug(name: string, suffix: string = slugSuffix()): string {
  return `${slugifyBase(name)}-${suffix}`;
}
