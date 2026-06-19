/**
 * PII Vault page — server-component shell (identity control-plane, P0-C slice 2).
 * BFF-only (I-ST01): coverage is read via /api/v1/identity/vault-coverage (counts only).
 */
import { PiiVaultContent } from './pii-vault-content';

export const metadata = { title: 'PII Vault — Brain Identity' };

export default function PiiVaultPage() {
  return <PiiVaultContent />;
}
