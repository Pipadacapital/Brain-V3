import { OnboardingIntegrationsStep } from '@/components/onboarding/onboarding-integrations-step';
import { OnboardingGate } from '@/components/onboarding/onboarding-gate';
import { WizardSteps, WizardHeader } from '@/components/onboarding/wizard-steps';

export const metadata = { title: 'Connect your store — Brain' };

export default function OnboardingIntegrationsPage() {
  return (
    <OnboardingGate step="brand_created">
      <div className="space-y-8">
        <WizardSteps current={2} />
        <WizardHeader
          title="Connect your store"
          description="Link your storefront so Brain can start capturing order truth. You can skip this and connect later from Settings."
        />
        <OnboardingIntegrationsStep />
      </div>
    </OnboardingGate>
  );
}
