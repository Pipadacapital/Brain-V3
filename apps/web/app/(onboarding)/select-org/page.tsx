import { SelectOrgForm } from '@/components/onboarding/select-org-form';
import { WizardHeader } from '@/components/onboarding/wizard-steps';

export const metadata = { title: 'Select Workspace — Brain' };

export default function SelectOrgPage() {
  return (
    <div className="space-y-8">
      <WizardHeader
        title="Your workspaces"
        description="Choose which workspace you want to open."
      />
      <SelectOrgForm />
    </div>
  );
}
