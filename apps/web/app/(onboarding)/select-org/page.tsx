import { SelectOrgForm } from '@/components/onboarding/select-org-form';

export const metadata = { title: 'Select Workspace — Brain' };

export default function SelectOrgPage() {
  return (
    <div>
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-foreground">Your workspaces</h2>
        <p className="text-muted-foreground mt-1">
          Choose which workspace you want to open.
        </p>
      </div>
      <SelectOrgForm />
    </div>
  );
}
