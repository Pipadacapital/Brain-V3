/**
 * Behaviour — "What are people doing on my site?" (server shell).
 * Top-level tab #5. Consolidates analytics/behavior + funnel + abandoned-cart + engagement.
 * Honors ?tab= (funnel | abandoned-cart | engagement | overview).
 */
import { BehaviourContent } from './behaviour-content';

export const metadata = { title: 'Behaviour — Brain' };

export default async function BehaviourPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return <BehaviourContent initialTab={typeof tab === 'string' ? tab : undefined} />;
}
