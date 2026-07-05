/**
 * Public interface for the `identity` module (core monolith bounded context).
 * RULE: only this file may be imported by other modules — enforced by the ESLint
 * boundary rule. All implementation lives under ./internal/ and is private.
 * Spec: docs/05_Brain_Implementation_Build_Plan.md §3.
 *
 * Identity owns the customer/identity-graph control-plane (Customer 360 read here;
 * merge/unmerge admin + the PII vault follow in later slices).
 */
export { getCustomer360 } from './internal/application/queries/get-customer-360.js';
export { getIdentityTimeline } from './internal/application/queries/get-identity-timeline.js';
export type {
  IdentityTimelineEntry,
  IdentityTimelineResult,
  IdentityTimelineDeps,
} from './internal/application/queries/get-identity-timeline.js';
export { PgIdentityTimelineReader } from './internal/infrastructure/identity-timeline-reader.js';
export type {
  IdentityTimelineReader,
  IdentityTimelineEventRow,
} from './internal/infrastructure/identity-timeline-reader.js';
export { listCustomers } from './internal/application/queries/list-customers.js';
export type {
  CustomerList,
  CustomerListItem,
  CustomerScoreEnrichment,
  ListCustomersParams,
  ListCustomersDeps,
} from './internal/application/queries/list-customers.js';
export { eraseCustomer } from './internal/application/erase-customer.js';
export type { ErasureResult } from './internal/application/erase-customer.js';
export {
  listMergeReviews,
  resolveMergeReview,
  unmergeCustomer,
} from './internal/application/merge-admin.js';
export type {
  MergeReview,
  MergeReviewList,
  MergeDecision,
  MergeResolveResult,
  UnmergeResult,
} from './internal/application/merge-admin.js';
export type {
  Customer360,
  Customer360Profile,
  Customer360Identifier,
  Customer360Merge,
  Customer360Order,
  Customer360Deps,
} from './internal/application/queries/get-customer-360.js';

// DIP port (AV-2/DZ-1): the PUBLIC read/admin abstraction over the identity SoR. Consumers
// (the BFF, main.ts wiring) depend on this interface; the concrete Neo4jIdentityReader stays
// internal. Defined alongside the implementation so the class can `implements IdentityReader`.
export type { IdentityReader } from './internal/infrastructure/neo4j-identity-reader.js';

// PII vault (P0-C slice 2) — encrypted contact_pii read/write + MatchPiiPort + coverage.
export { ContactPiiVaultRepository } from './internal/infrastructure/contact-pii-vault.repository.js';
export type { VaultPiiType } from './internal/infrastructure/contact-pii-vault.repository.js';
export { ContactPiiVaultService } from './internal/application/contact-pii-vault.service.js';
export type {
  VaultMatchPii,
  VaultCoverage,
} from './internal/application/contact-pii-vault.service.js';
// Per-brand DEK providers live in @brain/pii-vault (shared with the stream-worker write path);
// re-exported here so the core wiring keeps importing them via the identity barrel.
export {
  DevVaultKeyProvider,
  KmsVaultKeyProvider,
  AwsKmsDecryptAdapter,
  AwsKmsEncryptAdapter,
  KmsBrandSaltProvider,
  DevBrandSaltProvider,
  BrandCryptoProvisioner,
} from '@brain/pii-vault';
/**
 * @public PR #284 deferred seam (honest DISABLED-throw): the default-closed guard for the
 * unwired prod KMS path — it throws rather than encrypt/decrypt with a non-KMS key. Kept
 * exported so the prod wiring can drop it in without reopening the identity barrel.
 */
export { UnwiredProdVaultKeyProvider } from '@brain/pii-vault';
export type { VaultKeyProvider, KmsDecryptPort, KmsEncryptPort, BrandSaltSource } from '@brain/pii-vault';
