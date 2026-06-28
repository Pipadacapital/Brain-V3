/**
 * /identity/pii-vault — permanent redirect to /identity?tab=pii-vault.
 * The PII vault became a sub-tab of the consolidated Identity tab.
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'PII Vault — Brain Identity' };

export default function PiiVaultPage() {
  redirect('/identity?tab=pii-vault');
}
