import { OnboardingIntegrationsStep } from '@/components/onboarding/onboarding-integrations-step';
import { OnboardingGate } from '@/components/onboarding/onboarding-gate';

export const metadata = { title: 'Connect Integrations — Brain' };

export default function OnboardingIntegrationsPage() {
  return (
    <OnboardingGate step="brand_created">
      <div>
        <div className="mb-8">
          <p
            className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-1"
            aria-label="Step 2 of 3"
            data-testid="step-indicator"
          >
            Step 2 of 3
          </p>
          <h2 className="text-2xl font-bold text-foreground">Connect your integrations</h2>
          <p className="text-muted-foreground mt-1">
            Connect Shopify to start syncing order data. You can skip this and connect later.
          </p>
        </div>
        <OnboardingIntegrationsStep />
      </div>
    </OnboardingGate>
  );
}
