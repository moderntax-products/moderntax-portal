'use client';

/**
 * ExpertOnboardingTour — interactive walk-through for newly-onboarded
 * tax experts. Scales to any new expert hire.
 * Mirrors the structure of components/OnboardingTour.tsx
 * (manager/processor tour) but with expert-specific steps:
 *
 *   1. Welcome — what the role is
 *   2. Profile credentials (name, CAF, PTIN, address, phone)
 *   3. IRS PPS credentials (encrypted SSN/DOB for identity verify)
 *   4. Local timezone (drives SLA clock)
 *   5. Assignments view (where work shows up)
 *   6. Multi-call orchestration (up to 3 concurrent AI calls)
 *   7. Take-over UX (when AI needs you to step in)
 *   8. Upload transcripts (IRS Direct Upload bookmarklet)
 *   9. Schedule availability (for callback mode)
 *   10. Call history + coaching (review + feedback loop)
 *   11. SLA clock rules (Mon-Fri 7am-7pm local, weekend skip)
 *   12. Finish — fire a test call
 *
 * Completion: hits POST /api/expert/mark-onboarded with mode='completed'
 * (same endpoint the manager/processor tour uses — already in place).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Step {
  id: string;
  title: string;
  description: string;
  detail: string[];
  illustration: React.ReactNode;
  cta: { label: string; href: string };
}

const STEPS: Step[] = [
  {
    id: 'welcome',
    title: 'Welcome to ModernTax — your expert workspace',
    description: 'You\'re here to help our customers verify IRS tax records. We do the heavy lifting; you bring your expertise and give us feedback.',
    detail: [
      'ModernTax serves customers across mortgage lending, SBA underwriting, state licensing, employment verification, insurance, and any other use case where tax records need to be verified.',
      'Customers submit verification requests on the portal. Admin assigns each request to an expert (you) based on availability and use case.',
      'You make the IRS Practitioner Priority Service call (or supervise the AI agent) to authorize the transcript pull from the IRS.',
      'AI assistants now run most of the call for you — you take over only when the AI gets stuck and provide feedback so we improve.',
      'Click Next to set up your account.',
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
    id: 'credentials',
    title: 'Step 1 — Add your CAF, PTIN, name, address, phone',
    description: 'These get auto-stamped onto every 8821 the IRS receives for your assignments. They never leave the portal — encrypted at rest.',
    detail: [
      'Open /expert/profile and fill in: full name (as it appears on your EFIN/CAF), CAF number, PTIN, business address, phone, optional fax.',
      'These are public-record details — they show on IRS form 8821 in the appointee section. The IRS already knows your CAF/PTIN.',
      'You can\'t take any assignments until your profile is complete — the dashboard auto-redirects to setup if anything\'s missing.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>
    ),
    cta: { label: 'Open profile setup →', href: '/expert/profile' },
  },
  {
    id: 'irs-credentials',
    title: 'Step 2 — Add your IRS identity verification details',
    description: 'The IRS verifies the practitioner identity on every Practitioner Priority Service call. We collect your full SSN and date of birth so the AI agent can complete that verification on your behalf.',
    detail: [
      'Why we need it: the IRS agent at the start of every PPS call asks for your name, CAF number, last 4 of SSN, and date of birth. Without these, the call cannot proceed and we cannot pull transcripts on the customer\'s behalf.',
      'Where it goes: the same /expert/profile page has an "IRS Identity Verification" section. The fields are kept separate from your other profile data and write to a dedicated encrypted column.',
      'How it\'s protected: AES-256-GCM encryption at rest using a per-environment key (EXPERT_CREDENTIALS_KEY) that is not shared with the application database. The encrypted blob is only decrypted server-side at the moment a call is initiated.',
      'How it\'s used: at call time, the agent reads only what the IRS asks for — typically your name, CAF, last 4 of SSN, and DOB. The full SSN is never logged, never displayed in the portal UI, and never transmitted in plain text outside the call.',
      'Your right to revoke: you can clear these fields at any time from /expert/profile. Doing so makes you ineligible for new assignments until you re-enter them.',
      'Note: this is the same identifying information you would otherwise read aloud yourself on a PPS call — we are simply securely automating that step.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    cta: { label: 'Add IRS creds →', href: '/expert/profile' },
  },
  {
    id: 'timezone',
    title: 'Step 3 — Set your local timezone',
    description: 'Your SLA clock only runs Mon–Fri, 7am–7pm in YOUR local time. Make sure we have the right one set.',
    detail: [
      'Profile setup has a timezone dropdown — pick the IANA zone you actually work in (America/Los_Angeles, America/New_York, etc.).',
      'A 24-hour SLA = 12 business hours/day × 2 weekdays. So an assignment landing Friday at 5pm doesn\'t go overdue until Tuesday 5pm.',
      'No clock runs on Saturday or Sunday at all.',
      'No clock runs from 7pm-7am local time, even on weekdays.',
      'Wrong timezone = phantom-overdue alerts. Fix it once and it stays right.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    cta: { label: 'Set timezone →', href: '/expert/profile' },
  },
  {
    id: 'assignments',
    title: 'Step 4 — Where your work shows up',
    description: 'Once admin assigns transcripts to you, they appear on /expert with an SLA countdown.',
    detail: [
      'The dashboard at /expert shows every active assignment as a card.',
      'Each card shows entity name, TID (masked), tax form, years requested, and the SLA deadline (in business hours).',
      'Click an assignment\'s checkbox to add it to a "next call" batch — up to 5 entities per call, since they all use the same expert credentials.',
      'Once you have your batch, click "Start IRS PPS call" and the AI dials.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
    cta: { label: 'Open dashboard →', href: '/expert' },
  },
  {
    id: 'multi-call',
    title: 'Step 5 — Run up to 3 calls at once',
    description: 'You\'re not stuck waiting on hold. The AI runs up to 3 IRS calls in parallel; you orchestrate.',
    detail: [
      'Pick a batch, fire a call. While that call is on hold or being navigated by the AI, you can pick another batch and fire a second call.',
      'The dashboard shows each active call as a numbered panel (1, 2, 3) with its own live status, transcript stream, and take-over button.',
      'Cap is 3 concurrent — keeps cognitive load manageable. Once one finishes, you can start the next.',
      'Throughput target: ~20 calls/hr per expert with up to 5 entities per call (= 100 entities/hr at peak).',
    ],
    illustration: (
      <svg className="w-20 h-20 text-cyan-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
      </svg>
    ),
    cta: { label: 'See dashboard →', href: '/expert' },
  },
  {
    id: 'takeover',
    title: 'Step 6 — Take over when the AI needs you',
    description: 'AI handles the call until something it can\'t do — then you bridge in and finish manually.',
    detail: [
      'When the AI gets to a step it can\'t complete (faxing transcripts to the SOR inbox, an unusual IVR menu, an IRS agent question we haven\'t scripted yet), you step in.',
      'Each active call panel has a "Take over" button. Click it and you\'re bridged into the live call — speaking directly to the IRS agent.',
      'The AI mutes when you take over. Push the button again to give control back.',
      'Common reasons to take over: AI says "I apologize" multiple times, fax send fails, IRS agent asks for an unusual confirmation.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
      </svg>
    ),
    cta: { label: 'Open dashboard →', href: '/expert' },
  },
  {
    id: 'upload',
    title: 'Step 7 — Pull transcripts from your SOR inbox in one click',
    description: 'After the IRS posts transcripts to your Secure Object Repository (SOR) inbox, run the IRS Direct Sync script. It downloads each transcript, matches it to your assignments, and lands them on the portal automatically. No manual uploading.',
    detail: [
      'Open your IRS SOR inbox in a new tab.',
      'Copy the script from the "IRS Direct Sync" panel on your /expert dashboard and paste it into the browser console (F12 → Console tab).',
      'Sign in with your ModernTax credentials when prompted — that\'s it. A progress panel shows each transcript matching and syncing in real time.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
      </svg>
    ),
    cta: { label: 'See the sync script →', href: '/expert' },
  },
  {
    id: 'schedule',
    title: 'Step 8 — Set your availability for callback mode',
    description: 'Some calls use "irs_callback" mode where the IRS calls you back. Tell us when you\'ll pick up.',
    detail: [
      'Open /expert/schedule to add availability slots — date + time window + your preferred phone.',
      'Used when expected hold times are >30 min — the AI keeps the place in line, hangs up, and triggers a callback when an IRS agent is on the line.',
      'You don\'t have to use callback mode for every call — "hold and transfer" is the default and works for most.',
      'Most flexible mode: "ai_full" — AI handles the entire call without you, used for repeat / low-complexity entities.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-pink-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
      </svg>
    ),
    cta: { label: 'Set availability →', href: '/expert/schedule' },
  },
  {
    id: 'history',
    title: 'Step 9 — Call history + coaching',
    description: 'Every call is recorded + transcribed. Review your own and admin can leave coaching notes.',
    detail: [
      'Click "IRS Call History" tab on /expert to see every call you\'ve handled.',
      'Each row shows date, duration, hold time, IRS agent name, outcomes per entity, and the recording.',
      'Admin can tag calls with coaching notes ("nice handoff at 3:42", "watch for the IVR menu change").',
      'Use this to debug stuck assignments, learn the IRS scripts, and improve your throughput over time.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
      </svg>
    ),
    cta: { label: 'Open call history →', href: '/expert' },
  },
  {
    id: 'sla',
    title: 'Step 10 — Understand the SLA clock',
    description: 'Default SLA is 24 business hours. Business hours = Mon–Fri 7am–7pm in your local timezone.',
    detail: [
      'Clock starts when the borrower\'s 8821 is signed AND verified to carry your specific credentials (CAF, name, address, PTIN, phone).',
      'The clock pauses entirely on Saturday and Sunday.',
      'The clock pauses every weeknight from 7pm to 7am local time.',
      'So 24 hours of SLA = 12 hours/day × 2 weekdays. An assignment landing Friday at 5pm has 2 hours of clock that day, then jumps to Monday 7am for the rest.',
      'Admin will see overdue assignments highlighted in red on their dashboard. Stay ahead of the queue.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
    ),
    cta: { label: 'Open dashboard →', href: '/expert' },
  },
  {
    id: 'finish',
    title: 'You\'re ready',
    description: 'That\'s the workflow. Click "Finish Tour" to mark this complete — you can re-take it any time from /expert/onboarding.',
    detail: [
      'Questions? Reply to any portal email — they all route to a real human (matt@moderntax.io).',
      'Live coaching during your first calls is on the table — DM Matt and we\'ll hop on a Zoom while you handle one.',
      'When admin assigns your first request, it\'ll show up on /expert with an SLA countdown.',
    ],
    illustration: (
      <svg className="w-20 h-20 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" />
      </svg>
    ),
    cta: { label: 'Open dashboard →', href: '/expert' },
  },
];

interface Props {
  expertName: string | null;
  alreadyCompleted: boolean;
}

export function ExpertOnboardingTour({ expertName, alreadyCompleted }: Props) {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [completing, setCompleting] = useState(false);

  const step = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;
  const progressPct = Math.round(((stepIndex + 1) / STEPS.length) * 100);

  const handleNext = () => { if (!isLast) setStepIndex(stepIndex + 1); };
  const handlePrev = () => { if (!isFirst) setStepIndex(stepIndex - 1); };

  const handleFinish = async (mode: 'completed' | 'dismissed') => {
    setCompleting(true);
    try {
      await fetch('/api/expert/mark-onboarded', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      router.push('/expert');
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
              Step {stepIndex + 1} of {STEPS.length}
              {expertName && <span className="text-gray-400 ml-2">· {expertName}</span>}
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
            <div className="h-full bg-mt-green transition-all duration-300" style={{ width: `${progressPct}%` }} />
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

          {step.cta.href !== '#' && stepIndex !== STEPS.length - 1 && (
            <div className="text-center mb-6">
              {/* Plain <a> instead of Next.js <Link> — the Link component
                  has historically intercepted clicks for client-side
                  routing even when target="_blank" is set, which can
                  cause the new tab to silently no-op. <a target="_blank">
                  is unambiguous and matches what the browser expects. */}
              <a
                href={step.cta.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-mt-green border-2 border-mt-green rounded-lg hover:bg-mt-green hover:text-white transition-colors"
              >
                {step.cta.label}
              </a>
              <p className="text-xs text-gray-500 mt-1">Opens in a new tab so you can come back here</p>
            </div>
          )}

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
              <button onClick={handleNext} className="px-6 py-2 text-sm font-bold text-white bg-mt-green rounded-lg hover:bg-mt-green/90">
                Next →
              </button>
            )}
          </div>
        </div>

        {/* Step dot navigation — quick jump */}
        <div className="flex justify-center gap-1.5 mt-6 flex-wrap">
          {STEPS.map((_, i) => (
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
            You completed this tour previously. Re-take it any time — the dashboard banner is hidden once you finish or dismiss.
          </p>
        )}
      </div>
    </div>
  );
}
