import { ArchivedBrandsClient } from './archived-brands-client';

export const metadata = { title: 'Archived Brands — Brain' };

/**
 * Archived Brands settings page — static shell (Server Component for metadata).
 * Listing + restore happen in the client component (BFF reads/mutations live there).
 */
export default function ArchivedBrandsPage() {
  return <ArchivedBrandsClient />;
}
