/**
 * humanize — turn raw backend enums into operator-friendly labels (content review, Tier 3).
 *
 * Internal enum values (trigger_reason, lifecycle_state, identifier_type, …) must never reach the DOM
 * verbatim — a raw 'shared_email_hash' as a card title breaks the very judgement the screen asks the
 * operator to make. Known values get a curated label; anything unknown falls back to Title Case so a
 * new enum still renders cleanly instead of as snake_case.
 */

const ENUM_LABELS: Record<string, string> = {
  // identity merge — why two profiles were flagged as the same person
  probabilistic_email_match: 'Possible match — same email',
  probabilistic_phone_match: 'Possible match — same phone',
  shared_email_hash: 'Same email',
  shared_phone_hash: 'Same phone',
  shared_device: 'Same device',
  shared_order: 'Same order',
  // customer lifecycle
  active: 'Active',
  merged: 'Merged',
  split: 'Split',
  erased: 'Erased',
  // identifier types
  email: 'Email',
  phone: 'Phone',
  storefront_customer_id: 'Store customer ID',
  brain_anon_id: 'Anonymous ID',
};

/** humanize — curated label for a known enum, else Title Case of the snake_case value. */
export function humanize(value: string | null | undefined): string {
  if (!value) return '';
  const known = ENUM_LABELS[value];
  if (known) return known;
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
