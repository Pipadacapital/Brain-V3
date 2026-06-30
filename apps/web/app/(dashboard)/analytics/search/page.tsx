/**
 * /analytics/search — "What are shoppers searching for, and do my forms convert?" (server shell).
 *
 * P2 page. Two sections under one route:
 *   - Search  → on-site search volume + reach + per-day trend (useSearchBehavior) and the
 *               top search terms (from the storefront-behaviour overview).
 *   - Forms   → lead-form submission counts/rates + per-form table + per-day trend (useFormConversion).
 *
 * Honors ?tab= (search | forms).
 */
import { SearchContent } from './search-content';

export const metadata = { title: 'Search & Forms — Brain' };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return <SearchContent initialTab={typeof tab === 'string' ? tab : undefined} />;
}
