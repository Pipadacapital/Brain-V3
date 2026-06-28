/**
 * Marketing — "Which campaigns/channels work?" (server shell).
 * Top-level tab #4. Folds analytics/attribution + spend + conversion-feedback.
 * Honors ?tab= (e.g. /marketing?tab=spend) like the existing Orders page.
 */
import { MarketingContent } from './marketing-content';

export const metadata = { title: 'Marketing — Brain' };

export default async function MarketingPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return <MarketingContent initialTab={typeof tab === 'string' ? tab : undefined} />;
}
