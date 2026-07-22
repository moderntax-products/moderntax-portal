/**
 * /sample-transcripts — standalone, no-login evaluation page for lender
 * prospects comparing ModernTax IRS-verified transcript output against
 * their current transcript vendor (built for a ClearFirm-referred credit
 * team evaluating us against their incumbent, 2026-07-22 — but written
 * generically: no prospect names, no competitor names).
 *
 * Everything on this page and the linked sample artifacts is FICTIONAL
 * (Atlantic Shore Bakery LLC) — same dummy borrower as /sample-request.
 * The four artifact links reuse /sample-transcripts/[type], which is the
 * exact rendering a real completed order produces.
 *
 * Ordering paths shown match reality:
 *  - Through ClearFirm: the integration already routes orders to us by
 *    request_token; signed 8821s POST to /api/intake/8821-pdf; results
 *    come back via webhook + /api/v1/transcripts/{id}/structured.
 *  - Direct portal ordering for teams that want the UI.
 *
 * Public by design (middleware PUBLIC_PREFIXES already includes this
 * path) — it doubles as sales collateral, and it contains no customer
 * data whatsoever.
 */

import Link from 'next/link';

export const metadata = {
  title: 'Sample IRS-Verified Transcript Reports — ModernTax',
  description:
    'Exactly what a completed ModernTax transcript order delivers: IRS return transcripts, record of account, civil penalty modules, and a lender-ready compliance report. Fictional sample data.',
};

const ARTIFACTS = [
  {
    type: 'tax-return',
    title: '1120-S Tax Return Transcript',
    desc: 'Line-level return data as filed with the IRS: income statement, deductions, Schedule L balance sheet (assets & liabilities), and Schedule K-1 shareholders — owner names with exact ownership percentages.',
    tags: ['Income statement', 'Balance sheet (Sch. L)', 'Owners + ownership % (K-1)'],
  },
  {
    type: 'record-of-account',
    title: 'Record of Account',
    desc: 'Assessed balances with penalties and interest, filing dates, and the full IRS transaction-code history for the module — what actually posted, when.',
    tags: ['Balances + accruals', 'Filed dates', 'Transaction codes'],
  },
  {
    type: 'civil-penalties',
    title: 'Civil Penalties Account Transcript',
    desc: 'The CIVPEN module most summary vendors miss entirely — trust-fund recovery and other assessed civil penalties, with amounts and dates.',
    tags: ['CIVPEN', 'Penalty assessments'],
  },
  {
    type: 'compliance-report',
    title: 'ModernTax Compliance Report',
    desc: 'The lender-ready synthesis: filed vs. unfiled by year and form, total liabilities across modules, installment-agreement status, liens, and plain-English findings with severity.',
    tags: ['Filed / unfiled by form', 'Liability summary', 'Payment-plan status', 'Liens'],
  },
];

/**
 * The comparison checklist, ordered to a credit team's evaluation. The
 * "hard to get elsewhere" markers are the fields lenders repeatedly tell
 * us their current vendors omit — owner names, ownership percentages,
 * and balance-sheet detail are the three that otherwise force collecting
 * the borrower's actual return.
 */
const CHECKLIST: Array<{ field: string; where: string; rare?: boolean }> = [
  { field: 'Filed / unfiled status by year and form (941, 1120-S, 1065, 1040)', where: 'Compliance report' },
  { field: 'Liability by form and period, with penalties + interest', where: 'Record of account · Compliance report' },
  { field: 'Installment agreement / payment-plan status', where: 'Compliance report' },
  { field: 'Federal tax liens', where: 'Compliance report' },
  { field: 'Civil penalty (CIVPEN) assessments', where: 'Civil penalties transcript' },
  { field: 'Income statement detail (gross receipts → net income)', where: 'Return transcript' },
  { field: 'Last-filed dates per module', where: 'Record of account' },
  { field: 'Owner names', where: 'Return transcript (Schedule K-1)', rare: true },
  { field: 'Ownership percentages (beneficial-ownership checks)', where: 'Return transcript (Schedule K-1)', rare: true },
  { field: 'Balance sheet — assets, liabilities, equity (Schedule L)', where: 'Return transcript', rare: true },
];

export default function SampleTranscriptsIndex() {
  return (
    <div className="min-h-screen bg-gray-100">
      {/* Sample banner — same treatment as the artifact pages */}
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2">
        <p className="text-xs font-semibold text-amber-900 max-w-5xl mx-auto">
          🧪 SAMPLE — every document here uses fictional borrower data (Atlantic Shore Bakery LLC).
          The formatting and fields are exactly what a real completed order delivers.
        </p>
      </div>

      <div className="max-w-5xl mx-auto py-10 px-4">
        <header className="mb-10">
          <p className="text-sm font-bold tracking-wide text-mt-green uppercase mb-2">ModernTax</p>
          <h1 className="text-3xl font-bold text-mt-dark mb-3">
            Sample IRS-Verified Transcript Reports
          </h1>
          <p className="text-gray-600 max-w-3xl">
            This is the full artifact set from one completed transcript order — real IRS data
            pulled under a signed Form 8821, not modeled estimates. Open each document below and
            compare it line-by-line against what your current transcript vendor returns.
            Express orders deliver within 24 hours.
          </p>
        </header>

        {/* The four artifacts */}
        <div className="grid sm:grid-cols-2 gap-4 mb-12">
          {ARTIFACTS.map((a) => (
            <Link
              key={a.type}
              href={`/sample-transcripts/${a.type}`}
              className="block bg-white rounded-lg shadow hover:shadow-md transition-shadow p-6 border border-transparent hover:border-mt-green/40"
            >
              <h2 className="font-bold text-mt-dark mb-2">{a.title}</h2>
              <p className="text-sm text-gray-600 mb-3">{a.desc}</p>
              <div className="flex flex-wrap gap-1.5">
                {a.tags.map((t) => (
                  <span key={t} className="text-[11px] font-medium bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">
                    {t}
                  </span>
                ))}
              </div>
              <p className="text-sm font-semibold text-mt-green mt-4">View sample →</p>
            </Link>
          ))}
        </div>

        {/* Field checklist */}
        <section className="bg-white rounded-lg shadow p-6 mb-12">
          <h2 className="text-xl font-bold text-mt-dark mb-1">What&apos;s in every order</h2>
          <p className="text-sm text-gray-500 mb-5">
            Fields marked <span className="font-semibold text-mt-green">●</span> are the ones credit
            teams most often can&apos;t get from summary-data vendors without collecting the
            borrower&apos;s actual return.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-2 pr-4 font-medium">Field</th>
                  <th className="py-2 font-medium">Where it appears</th>
                </tr>
              </thead>
              <tbody>
                {CHECKLIST.map((row) => (
                  <tr key={row.field} className="border-b last:border-0">
                    <td className="py-2.5 pr-4 text-mt-dark">
                      {row.rare && <span className="text-mt-green font-semibold mr-1.5">●</span>}
                      {row.field}
                    </td>
                    <td className="py-2.5 text-gray-500">{row.where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* How ordering works */}
        <section className="bg-white rounded-lg shadow p-6 mb-12">
          <h2 className="text-xl font-bold text-mt-dark mb-4">How ordering works</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="border border-gray-200 rounded-lg p-5">
              <h3 className="font-semibold text-mt-dark mb-2">Already using ClearFirm reports?</h3>
              <p className="text-sm text-gray-600 mb-3">
                Order IRS-verified transcripts through the same integration. Your existing request
                routes to ModernTax under your request token; when the borrower signs the 8821,
                your system POSTs the PDF to our partner API and the pull starts automatically —
                no portal login, no manual handoff.
              </p>
              <ol className="text-sm text-gray-600 space-y-1.5 list-decimal pl-5 mb-3">
                <li>Create the request with your existing request token</li>
                <li>Collect the borrower&apos;s 8821 signature in your own flow (DocuSign, wet-sign — either works)</li>
                <li><code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">POST /api/intake/8821-pdf</code> with the signed PDF</li>
                <li>Results return via webhook + structured JSON endpoints</li>
              </ol>
              <Link href="/docs/api" className="text-sm font-semibold text-mt-green hover:underline">
                API reference →
              </Link>
            </div>
            <div className="border border-gray-200 rounded-lg p-5">
              <h3 className="font-semibold text-mt-dark mb-2">Ordering directly</h3>
              <p className="text-sm text-gray-600 mb-3">
                Enter the taxpayer once in the portal — a pre-filled Form 8821 downloads and lands
                in your inbox. Email the signed copy back and it attaches itself to the order.
                Most orders complete within 24 hours; entity verification is included free, and
                you&apos;re never billed for a rejected pull.
              </p>
              <p className="text-sm text-gray-600">
                Flat per-entity express pricing, quoted for your volume.
              </p>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="text-center pb-8">
          <p className="text-gray-600 mb-4">
            Want to run this against live files? We&apos;ll set your team up to compare on your own
            borrowers.
          </p>
          <a
            href="mailto:matt@moderntax.io?subject=Transcript%20comparison%20evaluation"
            className="inline-block bg-mt-green text-white px-8 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors"
          >
            Talk to us — matt@moderntax.io
          </a>
        </section>
      </div>
    </div>
  );
}
