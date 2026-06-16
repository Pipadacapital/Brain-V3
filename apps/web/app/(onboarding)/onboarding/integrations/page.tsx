import { OnboardingIntegrationsStep } from '@/components/onboarding/onboarding-integrations-step';

export const metadata = { title: 'Connect Integrations — Brain' };

export default function OnboardingIntegrationsPage() {
  return (
    <div>
      <div className="mb-8">
        <p
          className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-1"
          aria-label="Step 3 of 4"
          data-testid="step-indicator"
        >
          Step 3 of 4
        </p>
        <h2 className="text-2xl font-bold text-foreground">Connect your integrations</h2>
        <p className="text-muted-foreground mt-1">
          Connect Shopify to start syncing order data. You can skip this and connect later.
        </p>
      </div>
      <OnboardingIntegrationsStep />
    </div>
  );
}
