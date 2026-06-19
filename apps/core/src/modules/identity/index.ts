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
export type {
  Customer360,
  Customer360Profile,
  Customer360Identifier,
  Customer360Merge,
  Customer360Deps,
} from './internal/application/queries/get-customer-360.js';

// PII vault (P0-C slice 2) — encrypted contact_pii read/write + MatchPiiPort + coverage.
export { ContactPiiVaultRepository } from './internal/infrastructure/contact-pii-vault.repository.js';
export type { VaultPiiType } from './internal/infrastructure/contact-pii-vault.repository.js';
export {
  ContactPiiVaultService,
  DevVaultKeyProvider,
  UnwiredProdVaultKeyProvider,
} from './internal/application/contact-pii-vault.service.js';
export type {
  VaultMatchPii,
  VaultCoverage,
  VaultKeyProvider,
} from './internal/application/contact-pii-vault.service.js';
export {
  KmsVaultKeyProvider,
  AwsKmsDecryptAdapter,
} from './internal/infrastructure/kms-vault-key-provider.js';
export type { KmsDecryptPort } from './internal/infrastructure/kms-vault-key-provider.js';
