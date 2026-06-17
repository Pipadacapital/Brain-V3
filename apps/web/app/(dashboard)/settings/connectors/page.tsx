/**
 * Integration Marketplace page (feat-connector-marketplace B1).
 *
 * Rebuilt from the previous DataConnectors page to the category-organized marketplace.
 * Server Component (default) — client interactivity lives inside MarketplaceView.
 *
 * Skip For Now (B3): the marketplace is NEVER a gate. A brand with zero connections
 * sees a complete, navigable page. The "Skip For Now" CTA appears in the onboarding
 * flow (onboarding-integrations-step.tsx); on the settings page it links back to
 * the dashboard so users can always bypass without a blocking modal.
 */

import Link from 'next/link';
import { MarketplaceView } from '@/components/connectors/marketplace-view';

export const metadata = { title: 'Integration Marketplace — Brain' };

export default function ConnectorsPage() {
  return (
    <div className="space-y-6" data-testid="marketplace-page">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Integration Marketplace</h1>
          <p className="text-muted-foreground mt-1">
            Connect your data sources to Brain. You can skip for now and connect later.
          </p>
        </div>
        {/* B3: Skip For Now is first-class — never a gate */}
        <Link
          href="/dashboard"
          className="shrink-0 text-sm text-muted-foreground underline-offset-4 hover:underline hover:text-foreground transition-colors"
          data-testid="btn-skip-for-now"
          aria-label="Skip integrations and go to dashboard"
        >
          Skip for now
        </Link>
      </div>

      {/* Marketplace tiles, grouped by category */}
      <MarketplaceView />
    </div>
  );
}
