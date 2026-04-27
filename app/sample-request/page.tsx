/**
 * /sample-request — fully-rendered mockup of a COMPLETED transcript order.
 *
 * Linked from the OnboardingTour "transcripts-arrive" step so a new
 * processor can see exactly what their request page looks like once an
 * entity completes — without needing to wait 24-48h for a real pull.
 *
 * The mockup uses a fictional borrower (ATLANTIC SHORE BAKERY LLC) and
 * shows the full set of artifacts a real completed request includes:
 *
 *   1. Tax Return Transcript (1120-S, 2023)
 *   2. Record of Account (1120-S, 2023) — with TC transactions + balance
 *   3. Civil Penalties Account Transcript (2022) — with a CIVPEN assessment
 *   4. ModernTax Compliance Report — our synthesis PDF that explains
 *      what the IRS data means in plain English for the lender
 *
 * Plus the compliance-flag chips and the timeline showing all 6 steps
 * complete. Fully static — no DB, no auth scoping, no side effects.
 *
 * The "downloads" route to /sample-transcripts/[type] which renders
 * styled HTML approximating an IRS transcript output.
 */

import Link from 'next/link';

const SAMPLE = {
  loanNumber: 'SBA-7A-2026-04412',
  borrower: {
    name: 'ATLANTIC SHORE BAKERY LLC',
    tidMasked: 'XX-XXX9056',
    tidKind: 'EIN',
    formType: '1120-S',
    years: [2021, 2022, 2023],
    signer: { firstName: 'Maria', lastName: 'Chen', email: 'maria@atlanticshorebakery.com' },
    address: '4827 Ocean Pkwy', city: 'Brooklyn', state: 'NY', zip: '11230',
  },
  flags: [
    { type: 'BALANCE_DUE', severity: 'CRITICAL', message: 'Outstanding balance of $4,287.21 on Form 1120-S for tax year 2023 (assessed Apr 15 2024)' },
    { type: 'LATE_FILING_PENALTY', severity: 'WARNING', message: 'Late filing penalty of $843.00 assessed for tax year 2023 (TC 166)' },
    { type: 'CIVPEN', severity: 'CRITICAL', message: 'Civil Penalty of $1,250.00 for failure to file information returns (Form 1099) for tax year 2022' },
  ],
  exposure: 4287.21 + 843.00 + 1250.00,
  submittedAt: '2026-04-23T10:14:00Z',
  completedAt: '2026-04-25T16:42:00Z',
  transcripts: [
    {
      type: 'tax-return',
      label: '1120-S Tax Return Transcript',
      year: 2023,
      ext: 'HTML',
      sizeBytes: 28500,
    },
    {
      type: 'record-of-account',
      label: '1120-S Record of Account',
      year: 2023,
      ext: 'HTML',
      sizeBytes: 41200,
    },
    {
      type: 'civil-penalties',
      label: 'Civil Penalties Account Transcript',
      year: 2022,
      ext: 'HTML',
      sizeBytes: 18900,
    },
    {
      type: 'compliance-report',
      label: 'ModernTax Compliance Report',
      year: 2023,
      ext: 'PDF',
      sizeBytes: 92400,
      featured: true,
    },
  ],
};

const TIMELINE_STEPS = [
  { label: 'Submitted', description: 'Request received and queued for processing', when: 'Apr 23, 10:14 AM' },
  { label: 'Form 8821 Sent', description: 'Authorization form sent to entity', when: 'Apr 23, 10:18 AM' },
  { label: 'Form 8821 Signed', description: 'Authorization form received and signed', when: 'Apr 23, 2:31 PM' },
  { label: 'IRS Queue', description: 'Request submitted to IRS', when: 'Apr 24, 9:02 AM' },
  { label: 'Processing', description: 'IRS Practitioner Priority Service call in progress', when: 'Apr 25, 11:47 AM' },
  { label: 'Completed', description: 'Transcripts received and ready', when: 'Apr 25, 4:42 PM' },
];

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtMoney(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const metadata = {
  title: 'Sample Completed Request',
  description: 'Mock-up of a completed IRS transcript verification with compliance findings.',
};

export default function SampleRequestPage() {
  const totalFiles = SAMPLE.transcripts.length;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Sample Banner */}
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 text-center">
        <p className="text-xs font-semibold text-amber-900">
          🧪 SAMPLE REQUEST — fictional borrower, illustrative data. Explore freely; downloads open sample HTML/PDF previews.
        </p>
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="text-3xl font-bold text-mt-dark">Request Details</h1>
              <p className="text-gray-600 mt-1">
                Loan #: <code className="font-mono">{SAMPLE.loanNumber}</code>
                <span className="ml-3 inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                  CSV Upload
                </span>
              </p>
            </div>
            <Link href="/" className="text-gray-600 hover:text-gray-900 font-medium">
              &larr; Back to Dashboard
            </Link>
          </div>
          <div className="flex items-center gap-4">
            <span className="inline-block px-4 py-2 rounded-full text-sm font-semibold bg-green-100 text-green-800">
              Completed
            </span>
            <span className="text-sm text-gray-600">
              Submitted Apr 23, 2026 • Completed Apr 25, 2026 (2-day turnaround)
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="space-y-8">

          {/* COMPLIANCE SUMMARY — promoted to top because it's the
              actionable output a processor cares about most. */}
          <div className="bg-white rounded-lg shadow-md border-2 border-red-200 overflow-hidden">
            <div className="bg-gradient-to-r from-red-50 to-amber-50 px-6 py-4 border-b border-red-200">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <h2 className="text-lg font-bold text-mt-dark">Compliance findings: {SAMPLE.flags.length} issue{SAMPLE.flags.length === 1 ? '' : 's'} detected</h2>
                  </div>
                  <p className="text-sm text-gray-600">
                    Total IRS exposure: <span className="font-bold text-red-700">{fmtMoney(SAMPLE.exposure)}</span>
                    {' '}— resolve before SBA closing.
                  </p>
                </div>
                <Link
                  href="/compliance"
                  className="shrink-0 inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-mt-green text-white rounded-lg hover:bg-mt-green/90"
                >
                  Send borrower template →
                </Link>
              </div>
            </div>
            <div className="divide-y divide-gray-100">
              {SAMPLE.flags.map((f, i) => (
                <div key={i} className="px-6 py-4 flex items-start gap-3">
                  <span className={`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold ${
                    f.severity === 'CRITICAL' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                  }`}>
                    {f.severity === 'CRITICAL' ? '!' : '⚠'}
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
                        f.severity === 'CRITICAL' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
                      }`}>
                        {f.type}
                      </span>
                      <span className="text-xs text-gray-500">{f.severity}</span>
                    </div>
                    <p className="text-sm text-gray-800">{f.message}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* DOWNLOAD ALL — prominent, top-right of artifacts */}
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-mt-dark">Entities (1)</h2>
            <span
              title="Sample only — Download All packages every artifact (raw transcripts + ModernTax Compliance Report) into a ZIP in real requests."
              className="inline-flex items-center gap-2 px-4 py-2 bg-mt-dark text-white text-sm font-semibold rounded-lg cursor-help"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Download All ({totalFiles} files)
            </span>
          </div>

          {/* ENTITY CARD */}
          <div className="bg-white rounded-lg shadow p-8">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h3 className="text-lg font-semibold text-mt-dark">{SAMPLE.borrower.name}</h3>
                <div className="flex flex-wrap items-center gap-4 mt-2">
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wide">{SAMPLE.borrower.tidKind}</p>
                    <code className="text-sm font-mono text-gray-700">{SAMPLE.borrower.tidMasked}</code>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Form</p>
                    <p className="text-sm text-gray-700">{SAMPLE.borrower.formType}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Years</p>
                    <p className="text-sm text-gray-700">{SAMPLE.borrower.years.join(', ')}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Signer</p>
                    <p className="text-sm text-gray-700">{SAMPLE.borrower.signer.firstName} {SAMPLE.borrower.signer.lastName}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Signer Email</p>
                    <p className="text-sm text-blue-600">{SAMPLE.borrower.signer.email}</p>
                  </div>
                </div>
                <p className="text-sm text-gray-500 mt-2">
                  {SAMPLE.borrower.address}, {SAMPLE.borrower.city}, {SAMPLE.borrower.state} {SAMPLE.borrower.zip}
                </p>
              </div>
              <span className="inline-block px-3 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                Completed
              </span>
            </div>

            {/* Signed 8821 chip */}
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3 mb-6">
              <svg className="w-5 h-5 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-sm text-green-700 font-medium">Signed 8821 on file</span>
              <span className="text-xs text-green-600 font-mono ml-auto">Sig: c7e4f2a8…</span>
            </div>

            {/* Featured ModernTax Compliance Report */}
            {SAMPLE.transcripts.filter(t => t.featured).map((t) => (
              <Link
                key={t.type}
                href={`/sample-transcripts/${t.type}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block mb-6 group"
              >
                <div className="bg-gradient-to-r from-emerald-50 to-emerald-100 border-2 border-emerald-300 rounded-lg p-5 hover:shadow-md transition-shadow">
                  <div className="flex items-center gap-4">
                    <div className="shrink-0 p-3 bg-white rounded-lg border border-emerald-200">
                      <svg className="w-7 h-7 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-mt-dark">{t.label}</h4>
                        <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-200 text-emerald-900">Featured</span>
                      </div>
                      <p className="text-xs text-gray-700 mt-0.5">
                        Plain-English summary of every IRS finding, ready to forward to underwriting. {t.ext} • {fmtBytes(t.sizeBytes)}
                      </p>
                    </div>
                    <div className="shrink-0 text-emerald-700 font-semibold text-sm group-hover:translate-x-0.5 transition-transform">
                      Open →
                    </div>
                  </div>
                </div>
              </Link>
            ))}

            {/* Raw IRS Transcripts */}
            <div className="border-t border-gray-200 pt-6">
              <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">IRS Transcript Downloads</h4>
              <div className="space-y-2">
                {SAMPLE.transcripts.filter(t => !t.featured).map((t) => (
                  <Link
                    key={t.type}
                    href={`/sample-transcripts/${t.type}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-mt-green hover:bg-gray-50 transition-colors group"
                  >
                    <div className={`shrink-0 p-2 rounded ${t.ext === 'HTML' ? 'bg-blue-50' : 'bg-red-50'}`}>
                      <svg className={`w-5 h-5 ${t.ext === 'HTML' ? 'text-blue-600' : 'text-red-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-mt-dark">{t.label} — {t.year}</p>
                      <p className="text-xs text-gray-500">{t.ext} • {fmtBytes(t.sizeBytes)}</p>
                    </div>
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
                      t.ext === 'HTML' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'
                    }`}>
                      {t.ext}
                    </span>
                    <span className="text-mt-green text-sm font-semibold opacity-0 group-hover:opacity-100 transition-opacity">
                      Open →
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          </div>

          {/* TIMELINE — collapsed under entities since the actionable info
              (compliance + downloads) is what processors read first. */}
          <details className="bg-white rounded-lg shadow">
            <summary className="px-8 py-5 cursor-pointer hover:bg-gray-50 rounded-lg flex items-center justify-between">
              <h2 className="text-xl font-bold text-mt-dark">Request Timeline</h2>
              <span className="text-sm text-gray-500">All 6 steps complete</span>
            </summary>
            <div className="px-8 pb-8 pt-2">
              <div className="space-y-6">
                {TIMELINE_STEPS.map((step, index) => (
                  <div key={step.label} className="flex gap-6">
                    <div className="flex flex-col items-center">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-white font-semibold text-sm bg-mt-green">
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      </div>
                      {index < TIMELINE_STEPS.length - 1 && (
                        <div className="w-1 h-12 bg-mt-green" />
                      )}
                    </div>
                    <div className="pb-6">
                      <h3 className="text-lg font-semibold text-mt-green">{step.label}</h3>
                      <p className="text-gray-600 text-sm mt-1">{step.description}</p>
                      <p className="text-xs text-gray-400 mt-1">{step.when}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </details>

          {/* Footer — back to tour */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-blue-900">That&apos;s a real-shaped request.</p>
              <p className="text-xs text-blue-700 mt-0.5">Every completed order in your portal looks just like this — with your borrowers&apos; data and IRS findings.</p>
            </div>
            <Link
              href="/onboarding"
              className="shrink-0 px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              ← Back to tour
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
