'use client';

/**
 * OnboardingTour — interactive 8-step click-through tour for processors
 * and managers. Each step has:
 *
 *   - title + description
 *   - illustrated SVG icon (no image dependencies)
 *   - role gate: 'all' | 'manager' | 'processor' (manager-only steps
 *     are skipped automatically when a processor takes the tour)
 *   - try-it CTA: an internal link to the actual feature surface
 *   - completion gate: final step calls /api/expert/mark-onboarded
 *
 * State is local — step index in React state, completion in DB. No
 * persistence between sessions for partial progress (tour is short
 * enough to complete in one sitting). User can re-take any time via
 * the Help link in nav.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Step {
  id: string;
  title: string;
  description: string;
  detail: string[];
  illustration: React.ReactNode;
  cta: { label: string; href: string };
  role: 'all' | 'manager' | 'processor';
}

const STEPS: Step[] = [
  {
    id: 'welcome',
    role: 'all',
    title: 'Welcome to ModernTax',
    description: 'Let\'s walk you through the portal in five minutes.',
    detail: [
      'You can submit IRS transcript verification requests three ways: CSV/Excel upload, signed 8821 PDF upload, or manual entry.',
      'Once you submit, our team handles the IRS Practitioner Priority Service call — no faxes, no hold music, no per-borrower phone calls on your end.',
      'Transcripts arrive in your portal in 24-48 hours and email you when they\'re ready.',
      'Click Next to see the three submission paths.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
      </svg>
    ),
    cta: { label: 'Start the tour', href: '#' },
  },
  {
    id: 'csv-upload',
    role: 'all',
    title: 'Submit a batch via CSV / Excel',
    description: 'The fastest path when you have multiple borrowers — upload your spreadsheet once, we generate signed 8821s automatically.',
    detail: [
      'Required columns: legal_name, tid, signer_email, address, city, state, zip_code, years.',
      'Or use a slim format if you only have repeat borrowers — we auto-fill the rest from existing 8821s.',
      'Repeat borrowers (TIDs already in our system) get a "↻ Repeat borrower" badge in the preview — no new signature needed.',
      'After upload, review the preview table, fix any flagged rows, and click Submit.',
      'Each new entity\'s borrower gets an 8821 signature request via Dropbox Sign.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
      </svg>
    ),
    cta: { label: 'Try CSV upload →', href: '/new' },
  },
  {
    id: 'pdf-upload',
    role: 'all',
    title: 'Already have a signed 8821? Upload the PDF.',
    description: 'Skip the signature step entirely when the borrower has already e-signed an 8821 elsewhere.',
    detail: [
      'Open /new and switch to the PDF tab.',
      'Drop in the signed 8821 PDF — we extract the borrower\'s name, TID, and address automatically.',
      'Confirm the parsed details, add a loan number, and submit.',
      'Goes straight to status 8821_signed and queues for IRS pulling within minutes.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
    cta: { label: 'Try PDF upload →', href: '/new' },
  },
  {
    id: 'manual-entry',
    role: 'all',
    title: 'One borrower? Use manual entry.',
    description: 'Quickest path for a single transcript request — type the borrower\'s details directly into the form.',
    detail: [
      'Open /new and switch to the Manual tab.',
      'Add the borrower\'s name, TID, form type (1040 / 1120 / 1120-S / 1065), and tax years.',
      'You can add multiple entities to the same loan number if you have a parent + subsidiary or multiple owners.',
      'Submit — same downstream flow: 8821 signature → IRS pull → portal delivery.',
      'Built-in duplicate guard: if you double-click submit by mistake, we redirect you to the original instead of creating a duplicate.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
      </svg>
    ),
    cta: { label: 'Try manual entry →', href: '/new' },
  },
  {
    id: 'cross-team-search',
    role: 'all',
    title: 'See the whole team\'s work',
    description: 'Search across every request your team has submitted, even ones a teammate created.',
    detail: [
      'The dashboard shows ALL your team\'s requests by default. Use the "Mine Only" toggle to narrow to your own.',
      'Search bar matches loan number, borrower name, OR last 4 digits of TID.',
      'Click any request to open the full timeline — works even if a teammate created it.',
      'Useful when answering borrower questions on a coworker\'s loan or picking up cover work.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
      </svg>
    ),
    cta: { label: 'Open dashboard →', href: '/' },
  },
  {
    id: 'transcripts-arrive',
    role: 'all',
    title: 'Working with completed transcripts',
    description: 'Once an entity completes, you get an email and the transcripts appear in the request page — ready to download.',
    detail: [
      'Each entity has individual download links for each transcript file.',
      'Use "Download All (N files)" at the top of the request to grab everything in one ZIP.',
      'Compliance flags appear automatically — if a borrower has an unfiled return, lien, or balance due, the system surfaces it on the entity row.',
      'The first transcript ever delivered to your team triggers a special celebration email so you know the platform is working.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
      </svg>
    ),
    cta: { label: 'See sample request →', href: '/' },
  },
  {
    id: 'compliance',
    role: 'all',
    title: 'Resolve compliance issues with one click',
    description: 'When IRS records show problems (unfiled return, lien, audit), surface them and email the borrower a guided resolution.',
    detail: [
      'Open Compliance from the nav to see every flagged borrower across your team.',
      'Each row shows the flag type (UNFILED, LIEN, BALANCE_DUE, AUDIT, etc.) and the IRS exposure amount.',
      'Click "Send Template →" to fire a pre-written email to the borrower explaining the issue and offering a 15-min call with our team.',
      'The borrower books via Calendly — we resolve. You stay in the loop because the email\'s reply-to is your address.',
      'Templates exist for: unfiled returns, S-Corp election issues, balance due, lien/levy, audit, and a generic no-record-found case.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
    ),
    cta: { label: 'Open Compliance →', href: '/compliance' },
  },
  {
    id: 'monitoring',
    role: 'all',
    title: 'Continuous monitoring for active loans',
    description: 'Auto-pull fresh transcripts on a cadence (weekly, monthly, quarterly) — perfect for SBA loans that need ongoing audit defense.',
    detail: [
      'On any completed request, expand an entity and click "Enroll in Monitoring".',
      'Pricing: $19.99 one-time enrollment + $59.98 per pull when a new transcript is delivered. No-record-found pulls are NOT billed.',
      'Each cadence-due pull spawns a new request automatically — visible in the dashboard, billed at the per-pull rate.',
      'The full pull history (including no-record-found attempts) is logged for SBA audit defense.',
      'Cancel monitoring any time from the entity\'s monitoring panel.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-cyan-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
      </svg>
    ),
    cta: { label: 'Open a request →', href: '/' },
  },
  {
    id: 'mistakes',
    role: 'all',
    title: 'Cancel a mistake — no support ticket needed',
    description: 'Submitted the wrong borrower? Cancel the request directly from the request page.',
    detail: [
      'Open the request and click "Cancel Request" in the top right.',
      'Add an optional reason for the audit log.',
      'Cancellation works while status is submitted, 8821_sent, or 8821_signed — once an expert is actively pulling, contact support instead.',
      'All pending entities and assignments are cleaned up automatically. Active monitoring on the request is also cancelled.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    cta: { label: 'Open dashboard →', href: '/' },
  },
  {
    id: 'manager-billing',
    role: 'manager',
    title: 'Track usage and pay invoices',
    description: 'As a manager, you have live visibility into this month\'s usage and can pay invoices in one click via Mercury.',
    detail: [
      'Open Invoicing from the nav.',
      'The "This Month So Far" card shows live billable count, dollars billed, projected month-end total, and the date the next Mercury invoice fires (always the 1st).',
      'The Invoice History table shows every prior invoice — click "Pay →" to open Mercury\'s pay page (ACH or wire), or "PDF" to download the formal invoice.',
      'Trial-progress banner on the dashboard tracks your free entities — when you hit 3, the banner becomes a "Set up billing" CTA.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
      </svg>
    ),
    cta: { label: 'Open Invoicing →', href: '/invoicing' },
  },
  {
    id: 'manager-team',
    role: 'manager',
    title: 'Invite your team',
    description: 'Add processors and other managers to your account directly — no need to email Matt.',
    detail: [
      'Open Team from the nav.',
      'Click "Invite Loan Officer" and enter their name + email.',
      'They get an invitation email with login credentials and start using the portal immediately.',
      'You can promote any processor to manager from the same page.',
      'Each new processor on your team multiplies how fast you can clear transcripts for your loan pipeline.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
      </svg>
    ),
    cta: { label: 'Open Team →', href: '/team' },
  },
  {
    id: 'finish',
    role: 'all',
    title: 'You\'re ready',
    description: 'That\'s everything. Click "Finish Tour" to mark this complete — you can re-take it anytime from the Help link in nav.',
    detail: [
      'Questions? Reply to any email from us — replies route to a real human (matt@moderntax.io).',
      'Have a borrower with a complex compliance issue? The Send Template flow on /compliance handles 90% of cases.',
      'Submit your first real request from /new whenever you\'re ready.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" />
      </svg>
    ),
    cta: { label: 'Submit your first request →', href: '/new' },
  },
];

interface Props {
  userRole: 'manager' | 'processor' | 'admin' | 'expert';
  alreadyCompleted: boolean;
}

export function OnboardingTour({ userRole, alreadyCompleted }: Props) {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [completing, setCompleting] = useState(false);

  // Filter steps by role — processor takes the manager-only steps out
  const visibleSteps = STEPS.filter(s => {
    if (s.role === 'all') return true;
    if (s.role === 'manager' && userRole === 'manager') return true;
    if (s.role === 'manager' && userRole === 'admin') return true;
    if (s.role === 'processor' && userRole === 'processor') return true;
    return false;
  });

  const step = visibleSteps[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === visibleSteps.length - 1;
  const progressPct = Math.round(((stepIndex + 1) / visibleSteps.length) * 100);

  const handleNext = () => {
    if (!isLast) setStepIndex(stepIndex + 1);
  };

  const handlePrev = () => {
    if (!isFirst) setStepIndex(stepIndex - 1);
  };

  const handleFinish = async (mode: 'completed' | 'dismissed') => {
    setCompleting(true);
    try {
      await fetch('/api/expert/mark-onboarded', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      router.push('/');
      router.refresh();
    } catch {
      setCompleting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 py-12 px-4">
      <div className="max-w-3xl mx-auto">
        {/* Progress bar + step counter */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
              Step {stepIndex + 1} of {visibleSteps.length}
            </span>
            {!alreadyCompleted && (
              <button
                onClick={() => handleFinish('dismissed')}
                disabled={completing}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Skip tour
              </button>
            )}
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-mt-green transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* Step card */}
        <div className="bg-white rounded-2xl shadow-xl p-8 sm:p-10 border border-gray-200">
          <div className="flex flex-col items-center text-center mb-6">
            {step.illustration}
            <h2 className="text-2xl sm:text-3xl font-bold text-mt-dark mt-4">{step.title}</h2>
            <p className="text-gray-600 mt-2">{step.description}</p>
          </div>

          <ul className="space-y-2 text-sm text-gray-700 mb-6 bg-gray-50 rounded-lg p-4">
            {step.detail.map((line, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-mt-green mt-0.5 flex-shrink-0">•</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>

          {/* Try-it CTA — opens the relevant feature in a new tab so the
              tour stays open. Skipped on welcome + finish steps. */}
          {step.cta.href !== '#' && stepIndex !== visibleSteps.length - 1 && (
            <div className="text-center mb-6">
              <Link
                href={step.cta.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-mt-green border-2 border-mt-green rounded-lg hover:bg-mt-green hover:text-white transition-colors"
              >
                {step.cta.label}
              </Link>
              <p className="text-xs text-gray-500 mt-1">Opens in a new tab so you can come back here</p>
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between border-t border-gray-200 pt-6">
            <button
              onClick={handlePrev}
              disabled={isFirst || completing}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ← Previous
            </button>

            {isLast ? (
              <button
                onClick={() => handleFinish('completed')}
                disabled={completing}
                className="px-6 py-2 text-sm font-bold text-white bg-mt-green rounded-lg hover:bg-mt-green/90 disabled:opacity-50"
              >
                {completing ? 'Saving…' : 'Finish Tour →'}
              </button>
            ) : (
              <button
                onClick={handleNext}
                className="px-6 py-2 text-sm font-bold text-white bg-mt-green rounded-lg hover:bg-mt-green/90"
              >
                Next →
              </button>
            )}
          </div>
        </div>

        {/* Step dot navigation — quick jump */}
        <div className="flex justify-center gap-1.5 mt-6">
          {visibleSteps.map((_, i) => (
            <button
              key={i}
              onClick={() => setStepIndex(i)}
              className={`h-2 rounded-full transition-all ${
                i === stepIndex
                  ? 'w-8 bg-mt-green'
                  : i < stepIndex
                    ? 'w-2 bg-mt-green/50'
                    : 'w-2 bg-gray-300 hover:bg-gray-400'
              }`}
              aria-label={`Go to step ${i + 1}`}
            />
          ))}
        </div>

        {alreadyCompleted && (
          <p className="text-center text-xs text-gray-500 mt-4">
            You completed this tour previously. Re-take it any time — it won&apos;t affect your dashboard banner.
          </p>
        )}
      </div>
    </div>
  );
}
