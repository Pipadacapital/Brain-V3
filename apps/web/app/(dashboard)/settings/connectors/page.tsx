/**
 * Integration Marketplace page (feat-connector-marketplace B1).
 *
 * Rebuilt from the previous DataConnectors page to the category-organized marketplace.
 * Server Component (default) — client interactivity lives inside MarketplaceView.
 *
 * Skip For Now (B3): the marketplace is NEVER a gate. A brand with zero connections
 * sees a complete, navigable page. The "Skip For Now" CTA appears in the onboarding
 * flow (onboarding-integrations-step.tsx); on the settings page it links to the
 * dashboard so users can always bypass without a blocking modal.
 */

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { MarketplaceView } from '@/components/connectors/marketplace-view';

export const metadata = { title: 'Integrations — Brain' };

// Auth-gated, data-driven, and reads the OAuth callback's ?connected/?connect_error query
// param (useSearchParams) — render dynamically (no static prerender / Suspense requirement).
export const dynamic = 'force-dynamic';

export default function ConnectorsPage() {
  return (
    <div className="space-y-6" data-testid="marketplace-page">
      <PageHeader
        eyebrow="Settings"
        title="Integrations"
        description="Connect your stores, ad platforms, payments and logistics so Brain can capture the truth behind every order. You can skip for now and connect later."
        actions={
          // B3: Skip For Now is first-class — never a gate.
          <Button asChild variant="ghost" size="sm">
            <Link
              href="/dashboard"
              data-testid="btn-skip-for-now"
              aria-label="Skip integrations and go to dashboard"
            >
              Skip for now
            </Link>
          </Button>
        }
      />

      {/* Marketplace tiles, grouped by category */}
      <MarketplaceView />
    </div>
  );
}
