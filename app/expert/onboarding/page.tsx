/**
 * /expert/onboarding — interactive tutorial for newly-onboarded experts.
 *
 * Server component shell that fetches the expert's profile (full_name +
 * onboarding_completed_at) and renders <ExpertOnboardingTour />.
 *
 * Linked from:
 *   - /expert dashboard "Take the tour" banner (new experts only)
 *   - Any time via /expert/onboarding direct URL
 */

import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import { ExpertOnboardingTour } from '@/components/ExpertOnboardingTour';

export const metadata = {
  title: 'Welcome — Expert Onboarding | ModernTax',
  description: 'Five-minute walk-through for new ModernTax experts.',
};

export default async function ExpertOnboardingPage() {
  const supabase = await createServerComponentClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name, onboarding_completed_at, onboarding_dismissed_at')
    .eq('id', user.id)
    .single() as { data: { role: string; full_name: string | null; onboarding_completed_at: string | null; onboarding_dismissed_at: string | null } | null; error: any };

  if (!profile) redirect('/login');

  // Expert-specific tour. Admins can preview it for QA / support
  // walkthroughs (they see the same content as a new expert would).
  // Other roles get redirected to the manager/processor tour.
  if (!['expert', 'admin'].includes(profile.role)) redirect('/onboarding');

  const alreadyCompleted = !!(profile.onboarding_completed_at || profile.onboarding_dismissed_at);

  return (
    <ExpertOnboardingTour
      expertName={profile.full_name}
      alreadyCompleted={alreadyCompleted}
    />
  );
}
