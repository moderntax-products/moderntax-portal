/**
 * /onboarding — interactive product tour for processors and managers.
 *
 * Server component shell that fetches the current user's profile to
 * determine role gating + whether they've already completed the tour
 * (so the "Skip tour" CTA doesn't show on re-takes).
 *
 * Renders <OnboardingTour /> client component for the actual stepper.
 *
 * Routes:
 *   - Unauthenticated → /login
 *   - Expert role → /expert (experts have a different onboarding flow)
 *   - Everyone else → render the tour
 *
 * Linked from:
 *   - Dashboard "Take the tour" banner (new users only)
 *   - Dashboard nav "Help" link (always visible)
 *   - Welcome email after first login (future)
 */

import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import { OnboardingTour } from '@/components/OnboardingTour';

export const metadata = {
  title: 'Welcome to ModernTax',
  description: 'Five-minute product tour for new users.',
};

export default async function OnboardingPage() {
  const supabase = await createServerComponentClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, onboarding_completed_at, onboarding_dismissed_at')
    .eq('id', user.id)
    .single() as { data: { role: string; onboarding_completed_at: string | null; onboarding_dismissed_at: string | null } | null; error: any };

  if (!profile) redirect('/login');
  if (profile.role === 'expert') redirect('/expert');

  // Only manager / processor / admin take this tour. Everyone else lands
  // back on the dashboard.
  if (!['manager', 'processor', 'admin'].includes(profile.role)) {
    redirect('/');
  }

  const alreadyCompleted = !!(profile.onboarding_completed_at || profile.onboarding_dismissed_at);

  return (
    <OnboardingTour
      userRole={profile.role as 'manager' | 'processor' | 'admin'}
      alreadyCompleted={alreadyCompleted}
    />
  );
}
