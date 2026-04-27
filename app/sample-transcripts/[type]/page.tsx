/**
 * /sample-transcripts/[type] — styled HTML approximations of IRS
 * transcript output. Linked from /sample-request as the "download" target.
 *
 * Four types:
 *   - tax-return         → 1120-S Tax Return Transcript
 *   - record-of-account  → 1120-S Record of Account (with TC transactions)
 *   - civil-penalties    → Account Transcript with CIVPEN module
 *   - compliance-report  → ModernTax-branded compliance synthesis (the
 *                          processor's actual deliverable)
 *
 * The first three mimic IRS HTML transcript styling — monospace, sparse,
 * dense data. The compliance report is the value-add layer: plain English,
 * lender-ready, with explicit next steps per finding.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';

const SAMPLE_BORROWER = {
  name: 'ATLANTIC SHORE BAKERY LLC',
  ein: '87-3429056',
  address: '4827 OCEAN PKWY, BROOKLYN NY 11230',
  formType: '1120-S',
  taxYear: 2023,
};

interface Props {
  params: Promise<{ type: string }>;
}

export const metadata = {
  title: 'Sample IRS Transcript',
};

export default async function SampleTranscriptPage({ params }: Props) {
  const { type } = await params;

  if (!['tax-return', 'record-of-account', 'civil-penalties', 'compliance-report'].includes(type)) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Sample banner */}
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-amber-900">
          🧪 SAMPLE — fictional borrower data for demonstration
        </p>
        <Link href="/sample-request" className="text-xs text-amber-900 hover:underline font-semibold">
          ← Back to sample request
        </Link>
      </div>

      <div className="max-w-4xl mx-auto py-8 px-4">
        {type === 'tax-return' && <TaxReturnTranscript />}
        {type === 'record-of-account' && <RecordOfAccount />}
        {type === 'civil-penalties' && <CivilPenalties />}
        {type === 'compliance-report' && <ComplianceReport />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 1120-S TAX RETURN TRANSCRIPT
// Real format: monospace, label : value pairs, sparse layout
// ─────────────────────────────────────────────────────────────────────
function TaxReturnTranscript() {
  return (
    <div className="bg-white shadow-lg p-10 font-mono text-xs text-gray-800 leading-relaxed">
      <div className="text-center mb-8">
        <p className="text-sm font-bold">This Product Contains Sensitive Taxpayer Data</p>
        <p className="mt-2">Tax Return Transcript</p>
      </div>

      <div className="space-y-1 mb-6">
        <Row label="Request Date" value="04-25-2026" />
        <Row label="Response Date" value="04-25-2026" />
        <Row label="Tracking Number" value="100782394812" />
      </div>

      <div className="border-t border-b border-gray-400 py-4 my-6 space-y-1">
        <Row label="EIN" value={SAMPLE_BORROWER.ein} />
        <Row label="Tax Period Ending" value="Dec. 31, 2023" />
        <p className="mt-3 font-bold">The following items reflect the amount as shown on the return (PR), and the amount as adjusted (PC), if applicable. They do not show subsequent activity on the account.</p>
      </div>

      <div className="space-y-1">
        <Row label="Form Number" value="1120-S" />
        <Row label="Name(s) Shown on Return" value={SAMPLE_BORROWER.name} />
        <Row label="Address" value={SAMPLE_BORROWER.address} />
        <Row label="Filing Status" value="S Corporation" />
        <Row label="Accounting Method" value="Accrual" />
        <Row label="Date Incorporated" value="03-14-2018" />
        <Row label="Date Election Effective" value="01-01-2019" />
      </div>

      <h3 className="font-bold mt-8 mb-2">— INCOME —</h3>
      <div className="space-y-1">
        <Row label="Gross Receipts or Sales (PR)" value="$1,847,329.00" />
        <Row label="Returns and Allowances (PR)" value="$24,108.00" />
        <Row label="Net Receipts" value="$1,823,221.00" />
        <Row label="Cost of Goods Sold (PR)" value="$1,098,743.00" />
        <Row label="Gross Profit" value="$724,478.00" />
        <Row label="Other Income (PR)" value="$3,212.00" />
        <Row label="Total Income (Loss) (PR)" value="$727,690.00" />
      </div>

      <h3 className="font-bold mt-8 mb-2">— DEDUCTIONS —</h3>
      <div className="space-y-1">
        <Row label="Compensation of Officers (PR)" value="$185,000.00" />
        <Row label="Salaries and Wages (PR)" value="$284,612.00" />
        <Row label="Repairs and Maintenance" value="$18,402.00" />
        <Row label="Bad Debts" value="$0.00" />
        <Row label="Rents" value="$96,000.00" />
        <Row label="Taxes and Licenses" value="$41,827.00" />
        <Row label="Interest" value="$12,408.00" />
        <Row label="Depreciation" value="$28,712.00" />
        <Row label="Advertising" value="$22,148.00" />
        <Row label="Pension/Profit Sharing" value="$14,800.00" />
        <Row label="Employee Benefit Programs" value="$31,205.00" />
        <Row label="Other Deductions (PR)" value="$67,491.00" />
        <Row label="Total Deductions (PR)" value="$802,605.00" />
      </div>

      <h3 className="font-bold mt-8 mb-2">— ORDINARY BUSINESS INCOME (LOSS) —</h3>
      <div className="space-y-1">
        <Row label="Ordinary Business Income (Loss) (PR)" value="-$74,915.00" />
      </div>

      <h3 className="font-bold mt-8 mb-2">— SCHEDULE K — SHAREHOLDERS&apos; PRO RATA SHARE ITEMS —</h3>
      <div className="space-y-1">
        <Row label="Ordinary Business Income (Loss)" value="-$74,915.00" />
        <Row label="Net Rental Real Estate Income (Loss)" value="$0.00" />
        <Row label="Other Net Rental Income (Loss)" value="$0.00" />
        <Row label="Interest Income" value="$2,148.00" />
        <Row label="Ordinary Dividends" value="$0.00" />
        <Row label="Section 179 Deduction" value="$8,500.00" />
      </div>

      <p className="mt-10 text-[10px] italic text-gray-600">
        This Product Contains Sensitive Taxpayer Data
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// RECORD OF ACCOUNT — return data + transactions + balance
// ─────────────────────────────────────────────────────────────────────
function RecordOfAccount() {
  return (
    <div className="bg-white shadow-lg p-10 font-mono text-xs text-gray-800 leading-relaxed">
      <div className="text-center mb-8">
        <p className="text-sm font-bold">This Product Contains Sensitive Taxpayer Data</p>
        <p className="mt-2">Record of Account Transcript</p>
      </div>

      <div className="space-y-1 mb-6">
        <Row label="Request Date" value="04-25-2026" />
        <Row label="Response Date" value="04-25-2026" />
        <Row label="Tracking Number" value="100782394813" />
      </div>

      <div className="border-t border-b border-gray-400 py-4 my-6 space-y-1">
        <Row label="EIN" value={SAMPLE_BORROWER.ein} />
        <Row label="Form" value="1120-S" />
        <Row label="Tax Period" value="Dec. 31, 2023" />
        <Row label="Taxpayer" value={SAMPLE_BORROWER.name} />
        <Row label="Address" value={SAMPLE_BORROWER.address} />
      </div>

      <h3 className="font-bold mt-6 mb-2">— ACCOUNT BALANCE —</h3>
      <div className="space-y-1">
        <Row label="Account Balance" value="$4,287.21" />
        <Row label="Accrued Interest" value="$143.21 As of: May. 15, 2026" />
        <Row label="Accrued Penalty" value="$0.00 As of: May. 15, 2026" />
        <Row label="Account Balance Plus Accruals" value="$4,430.42" />
      </div>

      <h3 className="font-bold mt-6 mb-2">— INFORMATION FROM THE RETURN OR AS ADJUSTED —</h3>
      <div className="space-y-1">
        <Row label="Tax Per Return" value="$3,444.00" />
        <Row label="Total Tax Liability" value="$3,444.00" />
        <Row label="Taxable Income" value="$0.00 (S Corp pass-through)" />
      </div>

      <h3 className="font-bold mt-8 mb-3">— TRANSACTIONS —</h3>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-gray-400">
            <th className="text-left py-1 pr-2">CODE</th>
            <th className="text-left py-1 pr-2">EXPLANATION OF TRANSACTION</th>
            <th className="text-left py-1 pr-2">CYCLE</th>
            <th className="text-left py-1 pr-2">DATE</th>
            <th className="text-right py-1">AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          <Tx code="150" expl="Tax return filed" cycle="20241405" date="04-15-2024" amount="$3,444.00" />
          <Tx code="166" expl="Penalty for not pre-paying tax" cycle="20241405" date="04-15-2024" amount="$843.00" />
          <Tx code="196" expl="Interest assessed" cycle="20241405" date="04-15-2024" amount="$112.00" />
          <Tx code="276" expl="Failure to pay tax penalty" cycle="20241608" date="06-17-2024" amount="$172.21" />
          <Tx code="670" expl="Subsequent payment" cycle="20242214" date="08-12-2024" amount="-$284.00" />
        </tbody>
      </table>

      <div className="mt-6 p-3 bg-yellow-50 border border-yellow-200 rounded">
        <p className="text-[11px] font-bold text-yellow-900 not-italic">⚠ KEY OBSERVATION FOR LENDER REVIEW</p>
        <p className="text-[11px] text-yellow-900 mt-1">
          Account shows positive balance owed to IRS of $4,287.21 plus accruing interest. TC 166 and TC 276 indicate late payment of estimated tax liability. SBA underwriting will require resolution (payoff or IA) before closing.
        </p>
      </div>

      <p className="mt-10 text-[10px] italic text-gray-600">
        This Product Contains Sensitive Taxpayer Data
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// CIVIL PENALTIES — account transcript variant for CIVPEN modules
// ─────────────────────────────────────────────────────────────────────
function CivilPenalties() {
  return (
    <div className="bg-white shadow-lg p-10 font-mono text-xs text-gray-800 leading-relaxed">
      <div className="text-center mb-8">
        <p className="text-sm font-bold">This Product Contains Sensitive Taxpayer Data</p>
        <p className="mt-2">Account Transcript — Civil Penalty (CIVPEN) Module</p>
      </div>

      <div className="space-y-1 mb-6">
        <Row label="Request Date" value="04-25-2026" />
        <Row label="Response Date" value="04-25-2026" />
        <Row label="Tracking Number" value="100782394814" />
      </div>

      <div className="border-t border-b border-gray-400 py-4 my-6 space-y-1">
        <Row label="EIN" value={SAMPLE_BORROWER.ein} />
        <Row label="Form" value="CIVPEN (Civil Penalty)" />
        <Row label="MFT" value="13" />
        <Row label="Tax Period" value="Dec. 31, 2022" />
        <Row label="Taxpayer" value={SAMPLE_BORROWER.name} />
      </div>

      <h3 className="font-bold mt-6 mb-2">— ACCOUNT BALANCE —</h3>
      <div className="space-y-1">
        <Row label="Account Balance" value="$1,250.00" />
        <Row label="Accrued Interest" value="$87.42 As of: May. 15, 2026" />
        <Row label="Accrued Penalty" value="$0.00 As of: May. 15, 2026" />
      </div>

      <h3 className="font-bold mt-8 mb-3">— TRANSACTIONS —</h3>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-gray-400">
            <th className="text-left py-1 pr-2">CODE</th>
            <th className="text-left py-1 pr-2">EXPLANATION OF TRANSACTION</th>
            <th className="text-left py-1 pr-2">CYCLE</th>
            <th className="text-left py-1 pr-2">DATE</th>
            <th className="text-right py-1">AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          <Tx code="234" expl="Civil penalty assessed — failure to file information returns (Form 1099, IRC §6721)" cycle="20240903" date="03-04-2024" amount="$1,250.00" />
          <Tx code="196" expl="Interest assessed" cycle="20240903" date="03-04-2024" amount="$87.42" />
          <Tx code="971" expl="Notice issued — CP215 Civil Penalty Notice" cycle="20240903" date="03-11-2024" amount="$0.00" />
        </tbody>
      </table>

      <div className="mt-6 p-3 bg-red-50 border border-red-300 rounded">
        <p className="text-[11px] font-bold text-red-900 not-italic">🛑 CRITICAL — CIVIL PENALTY ASSESSMENT</p>
        <p className="text-[11px] text-red-900 mt-1">
          IRC §6721 penalty of $1,250 was assessed for failure to file 25 Forms 1099 by the Jan 31, 2023 deadline ($50 per return). Borrower received CP215 notice on Mar 11, 2024 and has not made a payment or requested abatement. This penalty is currently outstanding and accruing interest.
        </p>
        <p className="text-[11px] text-red-900 mt-2">
          <strong>Resolution path:</strong> Borrower may request first-time penalty abatement (FTA) if they have a clean compliance history for the prior 3 years — this is often granted automatically. If FTA is denied, an installment agreement can address the balance.
        </p>
      </div>

      <p className="mt-10 text-[10px] italic text-gray-600">
        This Product Contains Sensitive Taxpayer Data
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// MODERNTAX COMPLIANCE REPORT — branded, plain-English deliverable
// ─────────────────────────────────────────────────────────────────────
function ComplianceReport() {
  return (
    <div className="bg-white shadow-lg overflow-hidden">
      {/* Branded Header */}
      <div className="bg-gradient-to-br from-mt-dark to-mt-green px-10 py-8 text-white">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest opacity-80 mb-1">ModernTax</p>
            <h1 className="text-2xl font-bold">Compliance Report</h1>
            <p className="text-sm opacity-90 mt-1">Lender-ready synthesis of IRS findings for SBA underwriting</p>
          </div>
          <svg className="w-16 h-16 opacity-90" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" />
          </svg>
        </div>
      </div>

      <div className="p-10 text-gray-800">
        {/* Summary block */}
        <section className="mb-8">
          <div className="grid grid-cols-2 gap-4 text-sm mb-6">
            <div>
              <p className="text-xs text-gray-500 uppercase">Borrower</p>
              <p className="font-semibold text-mt-dark">{SAMPLE_BORROWER.name}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase">EIN</p>
              <p className="font-mono text-mt-dark">XX-XXX9056</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase">Loan #</p>
              <p className="font-mono text-mt-dark">SBA-7A-2026-04412</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase">Report Date</p>
              <p className="text-mt-dark">April 25, 2026</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase">Years Reviewed</p>
              <p className="text-mt-dark">2021, 2022, 2023</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase">Form Type</p>
              <p className="text-mt-dark">1120-S</p>
            </div>
          </div>

          <div className="bg-red-50 border-l-4 border-red-500 rounded-r p-5">
            <p className="text-xs font-bold uppercase tracking-wide text-red-900 mb-1">Overall Assessment</p>
            <p className="text-base font-bold text-red-900 mb-2">⚠ Borrower has 3 active compliance issues totaling <span className="text-xl">$6,380.21</span> in IRS exposure.</p>
            <p className="text-sm text-red-800">
              All 3 items must be resolved before SBA closing. Two are critical (balance due + civil penalty); one is a warning-level late filing penalty. Recommended: send the borrower the &quot;Balance owed to IRS&quot; outreach template to start resolution.
            </p>
          </div>
        </section>

        {/* Findings */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200">Findings</h2>

          <Finding
            severity="CRITICAL"
            title="Balance Due — $4,287.21"
            source="Record of Account, Form 1120-S, Tax Year 2023"
            whatItMeans="The IRS shows an outstanding tax liability of $4,287.21 on the borrower's 2023 1120-S return. Accrued interest brings the total to $4,430.42 as of May 15, 2026 and continues to grow."
            whyItMatters="SBA loan underwriting will not approve a borrower with an unaddressed federal tax balance. The lender's funding partner requires either full payment or an active IRS installment agreement before disbursement."
            nextStep="Send the &quot;Balance owed to IRS&quot; outreach template (15-min Calendly call). For balances under $50K, the IRS approves an installment agreement within ~30 days."
          />

          <Finding
            severity="CRITICAL"
            title="Civil Penalty — $1,250.00"
            source="CIVPEN Account Transcript, MFT 13, Tax Year 2022"
            whatItMeans="An IRC §6721 civil penalty was assessed in March 2024 for failure to file 25 Forms 1099 by the January 31, 2023 deadline ($50 per return). The borrower received CP215 notice but has not responded; the balance is accruing interest."
            whyItMatters="A civil penalty in collection status raises an SBA character/responsibility flag. Most lenders require the underlying issue (information returns) to be addressed even after the dollar amount is paid."
            nextStep="Borrower should request First-Time Abatement (FTA) — if they have a clean 3-year compliance history, this is often automatic. Otherwise, address via installment agreement. Both paths handled in the outreach call."
          />

          <Finding
            severity="WARNING"
            title="Late Filing Penalty — $843.00"
            source="Record of Account, Form 1120-S, Tax Year 2023, TC 166"
            whatItMeans="The IRS assessed an $843 late-filing penalty on the 2023 1120-S. The penalty is included in the Account Balance figure above (it's the same liability, not separate)."
            whyItMatters="This is informational once the underlying balance is resolved. We're flagging it so you have full visibility on what the borrower owes."
            nextStep="Resolved automatically when the Balance Due is addressed. No separate action needed."
          />
        </section>

        {/* Documents */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200">Source Documents</h2>
          <ul className="space-y-2 text-sm">
            <li className="flex items-center gap-2 text-gray-700">
              <span className="w-2 h-2 rounded-full bg-mt-green" />
              Tax Return Transcript — 1120-S, Tax Year 2023
            </li>
            <li className="flex items-center gap-2 text-gray-700">
              <span className="w-2 h-2 rounded-full bg-mt-green" />
              Record of Account — 1120-S, Tax Year 2023
            </li>
            <li className="flex items-center gap-2 text-gray-700">
              <span className="w-2 h-2 rounded-full bg-mt-green" />
              Civil Penalty Account Transcript — MFT 13, Tax Year 2022
            </li>
            <li className="flex items-center gap-2 text-gray-700">
              <span className="w-2 h-2 rounded-full bg-mt-green" />
              Form 8821 (signed) — authorization on file
            </li>
          </ul>
        </section>

        {/* Recommended Action */}
        <section className="mb-2">
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-5">
            <h3 className="font-bold text-mt-dark mb-2">Recommended Next Step</h3>
            <p className="text-sm text-gray-800 mb-3">
              Open the borrower&apos;s row in <span className="font-mono">/compliance</span> and click <strong>&quot;Send Template&quot;</strong>. We pre-select the &quot;Balance owed to IRS&quot; template (covers both the balance and civil penalty in one outreach), pre-fill the borrower&apos;s email, and include a Calendly link so they can book a 15-min call with our resolution team.
            </p>
            <p className="text-xs text-gray-600">
              You stay in the loop because the email&apos;s reply-to is your address. The borrower books, we resolve, your loan moves forward.
            </p>
          </div>
        </section>

        <div className="mt-10 pt-6 border-t border-gray-200 text-[11px] text-gray-500 leading-relaxed">
          <p className="mb-1"><strong>About this report:</strong> The ModernTax Compliance Report is generated from raw IRS transcript data pulled via Practitioner Priority Service (PPS) on April 25, 2026. All findings cite their source transcript and transaction code (TC) for audit defense. This document is part of the lender&apos;s permanent loan file.</p>
          <p>Questions? Reply to your delivery email or write to <span className="font-semibold">support@moderntax.io</span>.</p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex">
      <span className="font-bold pr-2">{label}:</span>
      <span>{value}</span>
    </div>
  );
}

function Tx({ code, expl, cycle, date, amount }: { code: string; expl: string; cycle: string; date: string; amount: string }) {
  return (
    <tr className="border-b border-gray-200">
      <td className="py-1 pr-2 font-bold align-top">{code}</td>
      <td className="py-1 pr-2 align-top">{expl}</td>
      <td className="py-1 pr-2 align-top">{cycle}</td>
      <td className="py-1 pr-2 align-top">{date}</td>
      <td className="py-1 text-right align-top">{amount}</td>
    </tr>
  );
}

function Finding({
  severity, title, source, whatItMeans, whyItMatters, nextStep,
}: {
  severity: 'CRITICAL' | 'WARNING';
  title: string;
  source: string;
  whatItMeans: string;
  whyItMatters: string;
  nextStep: string;
}) {
  const isCritical = severity === 'CRITICAL';
  return (
    <div className={`mb-5 rounded-lg border-l-4 ${isCritical ? 'border-red-500 bg-red-50/40' : 'border-amber-400 bg-amber-50/40'} p-4`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${isCritical ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>
          {severity}
        </span>
        <h3 className="font-bold text-mt-dark">{title}</h3>
      </div>
      <p className="text-[11px] text-gray-500 mb-2">Source: {source}</p>
      <div className="space-y-2 text-sm text-gray-800">
        <p><span className="font-semibold">What it means:</span> {whatItMeans}</p>
        <p><span className="font-semibold">Why it matters for the loan:</span> {whyItMatters}</p>
        <p><span className="font-semibold">Next step:</span> {nextStep}</p>
      </div>
    </div>
  );
}
