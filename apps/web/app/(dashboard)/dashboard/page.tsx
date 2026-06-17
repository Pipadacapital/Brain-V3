/**
 * Dashboard shell — widgets, all Postgres-only reads per arch plan §6.4.
 * NO OLAP, NO StarRocks, NO fake metrics, NO charts.
 * Empty state = "No Data Yet" — honest about missing data.
 */
import { BrandSummaryCard } from '@/components/dashboard/brand-summary-card';
import { ConnectionStatusCard } from '@/components/dashboard/connection-status-card';
import { DataStatusCard } from '@/components/dashboard/data-status-card';
import { OnboardingProgressCard } from '@/components/dashboard/onboarding-progress-card';
import { RealizedRevenueCard } from '@/components/dashboard/realized-revenue-card';

export const metadata = { title: 'Dashboard — Brain' };

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-1">
          Your brand intelligence command center.
        </p>
      </div>

      {/* Top row: Brand Summary + Connection Status + Data Status */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <BrandSummaryCard />
        <ConnectionStatusCard />
        <DataStatusCard />
      </div>

      {/* Realized Revenue — M1 Analytics API (D-1..D-4, §4 contract) */}
      <div className="max-w-md">
        <RealizedRevenueCard />
      </div>

      {/* Onboarding progress */}
      <div className="max-w-md">
        <OnboardingProgressCard />
      </div>
    </div>
  );
}
