import { BrandsClient } from './brands-client';

export const metadata = { title: 'Brands — Brain' };

/**
 * Brands settings page — static shell (Server Component for metadata).
 * Listing + delete (archive) happen in the client component (BFF reads/mutations live there).
 */
export default function BrandsPage() {
  return <BrandsClient />;
}
