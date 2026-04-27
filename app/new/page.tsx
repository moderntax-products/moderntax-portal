/**
 * /new — Chooser landing page for the three submission workflows.
 *
 * Each workflow lives at its own URL (/new/csv, /new/pdf, /new/manual)
 * so we can track popularity, bug reports, and conversion separately
 * in Vercel analytics. This page is the funnel entry point.
 *
 * Server component (no DB calls — just a static three-card grid).
 */

import Link from 'next/link';

export const metadata = {
  title: 'New Request — Choose Workflow',
  description: 'Pick how you want to submit IRS transcript verification requests: CSV upload, signed 8821 PDF, or manual entry.',
};

export default function NewRequestChooserPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-mt-dark">New Request</h1>
            <p className="text-gray-600 mt-1">Pick the workflow that fits your batch — each opens its own form.</p>
          </div>
          <Link href="/" className="text-gray-600 hover:text-gray-900 font-medium text-sm">
            &larr; Back to Dashboard
          </Link>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* CSV / Excel */}
          <Link
            href="/new/csv"
            className="group bg-white rounded-2xl border-2 border-gray-200 hover:border-mt-green hover:shadow-lg transition-all p-7 flex flex-col"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="p-3 rounded-xl bg-blue-50 text-blue-600 group-hover:bg-blue-100 transition-colors">
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-mt-dark">CSV / Excel Upload</h2>
            </div>
            <p className="text-sm text-gray-600 flex-1 mb-4">
              Multiple borrowers at once. Upload a spreadsheet — we auto-generate signed 8821s and send them for signature.
            </p>
            <ul className="text-xs text-gray-500 space-y-1.5 mb-4">
              <li className="flex items-start gap-2"><span className="text-mt-green mt-0.5">✓</span><span>Bulk preview with validation before submit</span></li>
              <li className="flex items-start gap-2"><span className="text-mt-green mt-0.5">✓</span><span>Repeat-borrower auto-fill from prior 8821s</span></li>
              <li className="flex items-start gap-2"><span className="text-mt-green mt-0.5">✓</span><span>Optional Entity Transcript add-on per row</span></li>
            </ul>
            <div className="flex items-center justify-between pt-3 border-t border-gray-100">
              <span className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">Recommended for batches</span>
              <span className="text-mt-green font-semibold text-sm group-hover:translate-x-0.5 transition-transform">Open →</span>
            </div>
          </Link>

          {/* Signed 8821 PDF */}
          <Link
            href="/new/pdf"
            className="group bg-white rounded-2xl border-2 border-gray-200 hover:border-mt-green hover:shadow-lg transition-all p-7 flex flex-col"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="p-3 rounded-xl bg-amber-50 text-amber-600 group-hover:bg-amber-100 transition-colors">
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-mt-dark">Signed 8821 PDF</h2>
            </div>
            <p className="text-sm text-gray-600 flex-1 mb-4">
              Already collected the borrower&apos;s signature elsewhere? Upload the PDF and we go straight to IRS pulling.
            </p>
            <ul className="text-xs text-gray-500 space-y-1.5 mb-4">
              <li className="flex items-start gap-2"><span className="text-mt-green mt-0.5">✓</span><span>Multiple PDFs per submit</span></li>
              <li className="flex items-start gap-2"><span className="text-mt-green mt-0.5">✓</span><span>No Dropbox Sign round-trip needed</span></li>
              <li className="flex items-start gap-2"><span className="text-mt-green mt-0.5">✓</span><span>Queues for IRS pull within minutes</span></li>
            </ul>
            <div className="flex items-center justify-between pt-3 border-t border-gray-100">
              <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold">Skips signature step</span>
              <span className="text-mt-green font-semibold text-sm group-hover:translate-x-0.5 transition-transform">Open →</span>
            </div>
          </Link>

          {/* Manual Entry */}
          <Link
            href="/new/manual"
            className="group bg-white rounded-2xl border-2 border-gray-200 hover:border-mt-green hover:shadow-lg transition-all p-7 flex flex-col"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="p-3 rounded-xl bg-purple-50 text-purple-600 group-hover:bg-purple-100 transition-colors">
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-mt-dark">Manual Entry</h2>
            </div>
            <p className="text-sm text-gray-600 flex-1 mb-4">
              One borrower? Type the details directly into a form — fastest path for a single transcript request.
            </p>
            <ul className="text-xs text-gray-500 space-y-1.5 mb-4">
              <li className="flex items-start gap-2"><span className="text-mt-green mt-0.5">✓</span><span>Add multiple entities to one loan</span></li>
              <li className="flex items-start gap-2"><span className="text-mt-green mt-0.5">✓</span><span>Built-in double-click guard</span></li>
              <li className="flex items-start gap-2"><span className="text-mt-green mt-0.5">✓</span><span>Auto-sends 8821 via Dropbox Sign</span></li>
            </ul>
            <div className="flex items-center justify-between pt-3 border-t border-gray-100">
              <span className="text-xs px-2 py-0.5 rounded bg-purple-50 text-purple-700 font-semibold">~30 seconds</span>
              <span className="text-mt-green font-semibold text-sm group-hover:translate-x-0.5 transition-transform">Open →</span>
            </div>
          </Link>
        </div>

        <div className="mt-10 bg-blue-50 border border-blue-200 rounded-lg p-5 text-sm">
          <p className="font-semibold text-blue-900 mb-1">Not sure which path to use?</p>
          <p className="text-blue-800 text-xs">
            Pick <strong>CSV / Excel</strong> when you have 2+ borrowers in a spreadsheet. Pick <strong>Signed 8821 PDF</strong> when the borrower already e-signed an 8821 elsewhere (DocuSign, Adobe Sign, paper). Pick <strong>Manual Entry</strong> for a single borrower or when typing details is faster than building a spreadsheet.
          </p>
        </div>
      </div>
    </div>
  );
}
