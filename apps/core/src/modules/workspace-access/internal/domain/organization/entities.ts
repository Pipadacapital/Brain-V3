/**
 * Organization (Workspace) domain entities.
 *
 * Product term "Workspace" maps to database table "organization" (D0.3).
 */

// MA-09 Option A (BINDING): onboarding_status tracks FIRST-brand onboarding only.
// After 'complete', adding a second brand does NOT reset the wizard.
// Multi-brand onboarding post-M1 routes via dashboard onboarding-progress widget.
export type OnboardingStatus =
  | 'pending'
  | 'org_created'
  | 'brand_created'
  | 'integration_selected'
  | 'complete';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  regionCode: string;
  onboardingStatus: OnboardingStatus;
  onboardingStep: number;
  createdAt: Date;
  updatedAt: Date;
}
