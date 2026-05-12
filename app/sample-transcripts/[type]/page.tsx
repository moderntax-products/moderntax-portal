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
import { SelfServePackButton } from '@/components/SelfServePackButton';
import { CheckReissueRequestForm } from '@/components/CheckReissueRequestForm';

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

  if (!['tax-return', 'record-of-account', 'civil-penalties', 'compliance-report', 'erc-report'].includes(type)) {
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

      <div className={type === 'erc-report' ? '' : 'max-w-4xl mx-auto py-8 px-4'}>
        {type === 'tax-return' && <TaxReturnTranscript />}
        {type === 'record-of-account' && <RecordOfAccount />}
        {type === 'civil-penalties' && <CivilPenalties />}
        {type === 'compliance-report' && <ComplianceReport />}
        {type === 'erc-report' && <ERCReportSample />}
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

        {/* Filing Compliance — required for lender underwriting (Banc of California feedback,
            Tax Guard parity: surface every filing the IRS expects from this entity vs. what's
            actually on file). Pulled from Entity Transcript filing requirements + Account
            Transcript filing history. */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200 flex items-center gap-2">
            <svg className="w-5 h-5 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Filing Compliance
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
              <p className="text-xs uppercase tracking-wide font-bold text-emerald-700 mb-2">Filed &amp; on file ✓</p>
              <ul className="space-y-1.5 text-emerald-900">
                <li className="flex justify-between"><span>1120-S — 2021</span><span className="text-xs text-emerald-700">filed 3/14/2022</span></li>
                <li className="flex justify-between"><span>1120-S — 2022</span><span className="text-xs text-emerald-700">filed 3/12/2023</span></li>
                <li className="flex justify-between"><span>1120-S — 2023</span><span className="text-xs text-emerald-700">filed 3/15/2024</span></li>
                <li className="flex justify-between"><span>941 — 2023 Q1-Q4</span><span className="text-xs text-emerald-700">all filed</span></li>
                <li className="flex justify-between"><span>940 — 2023</span><span className="text-xs text-emerald-700">filed 1/30/2024</span></li>
              </ul>
            </div>
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
              <p className="text-xs uppercase tracking-wide font-bold text-amber-800 mb-2">Unfiled / late ⚠</p>
              <ul className="space-y-2 text-amber-900">
                <li>
                  <div className="flex justify-between font-semibold"><span>941 — 2024 Q1</span><span className="text-xs">overdue</span></div>
                  <p className="text-xs text-amber-800 mt-0.5">Required by 4/30/2024. No TC 150 on this period — return not filed. Filing requirement comes from Entity Transcript (941 quarterly).</p>
                </li>
                <li>
                  <div className="flex justify-between font-semibold"><span>1099-MISC × 25 — 2022</span><span className="text-xs">filed late</span></div>
                  <p className="text-xs text-amber-800 mt-0.5">Filed 6 months after the 1/31/2023 deadline. Triggered the $1,250 CIVPEN below.</p>
                </li>
              </ul>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-3 italic">
            Source: Entity Transcript (filing requirements: 1120-S annual, 941 quarterly, 940 annual, 1099 information returns) cross-referenced with Account Transcript filing history (TC 150 entries).
          </p>
        </section>

        {/* Tax Liabilities by period — itemized balance breakdown. Tax Guard parity. */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200 flex items-center gap-2">
            <svg className="w-5 h-5 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Tax Liabilities by Period
          </h2>
          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-2 text-left">Form / Period</th>
                  <th className="px-4 py-2 text-right">Assessed</th>
                  <th className="px-4 py-2 text-right">Paid</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                  <th className="px-4 py-2 text-right">Accrued Int/Pen</th>
                  <th className="px-4 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                <tr>
                  <td className="px-4 py-2.5 font-semibold">1120-S — 2023</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">$5,130.42</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">$843.21</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold text-red-700">$4,287.21</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-amber-700">$143.21</td>
                  <td className="px-4 py-2.5"><span className="inline-block px-2 py-0.5 rounded text-xs font-semibold border bg-red-50 border-red-300 text-red-800">Open · Collection</span></td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-semibold">CIVPEN (MFT 13) — 2022</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">$1,250.00</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">$0.00</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold text-red-700">$1,250.00</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-amber-700">$67.50</td>
                  <td className="px-4 py-2.5"><span className="inline-block px-2 py-0.5 rounded text-xs font-semibold border bg-red-50 border-red-300 text-red-800">Open · CP215 issued</span></td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-semibold">1120-S — 2021 &amp; 2022</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">—</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">—</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-emerald-700">$0.00</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-400">—</td>
                  <td className="px-4 py-2.5"><span className="inline-block px-2 py-0.5 rounded text-xs font-semibold border bg-emerald-50 border-emerald-300 text-emerald-800">Closed · Zero balance</span></td>
                </tr>
                <tr className="bg-gray-50 font-semibold">
                  <td className="px-4 py-3">Total exposure</td>
                  <td className="px-4 py-3 text-right font-mono text-xs">$6,380.42</td>
                  <td className="px-4 py-3 text-right font-mono text-xs">$843.21</td>
                  <td className="px-4 py-3 text-right font-mono font-bold text-red-700 text-base">$5,537.21</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-amber-700">$210.71</td>
                  <td className="px-4 py-3 text-xs text-gray-600">includes accruing interest</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-3 italic">
            Sources: Record of Account (1120-S 2023, account balance + TC 196 interest + TC 276 failure-to-pay penalty); CIVPEN Account Transcript (MFT 13, TC 240 + TC 196). Per-period totals reconcile to the sum on each underlying transcript.
          </p>
        </section>

        {/* Repayment Plan Status — Tax Guard parity. Surfaces installment agreement,
            offer in compromise, currently-not-collectible status, or none. */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-mt-dark mb-4 pb-2 border-b border-gray-200 flex items-center gap-2">
            <svg className="w-5 h-5 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
            </svg>
            Repayment Plan Status
          </h2>
          <div className="bg-amber-50 border-l-4 border-amber-500 rounded-r p-5">
            <p className="text-base font-bold text-amber-900 mb-1">⚠ No active repayment plan on file</p>
            <p className="text-sm text-amber-900 mt-2">
              The IRS account shows <strong>no installment agreement (TC 480)</strong>, <strong>no offer in compromise (TC 481)</strong>, and <strong>no currently-not-collectible status (TC 530)</strong>. The borrower is in standard collection status with the open balance and is exposed to lien/levy action if unresolved.
            </p>
            <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              <div className="bg-white border border-amber-200 rounded p-3">
                <p className="font-bold text-amber-900">Installment Agreement</p>
                <p className="text-gray-600 mt-1">Not on file. Eligible: balance &lt; $50K → Online Payment Agreement, ~24h approval.</p>
              </div>
              <div className="bg-white border border-amber-200 rounded p-3">
                <p className="font-bold text-amber-900">Offer in Compromise</p>
                <p className="text-gray-600 mt-1">Not on file. Generally inappropriate for balance this size; OIC is for cases where IA isn&apos;t viable.</p>
              </div>
              <div className="bg-white border border-amber-200 rounded p-3">
                <p className="font-bold text-amber-900">Currently Not Collectible</p>
                <p className="text-gray-600 mt-1">Not on file. Reserved for hardship cases — not applicable to an operating SBA-eligible business.</p>
              </div>
            </div>
            <p className="text-sm text-amber-900 mt-4">
              <strong>Recommended path:</strong> Online Payment Agreement (OPA) on the IRS portal. For balances under $50K the IRS typically approves within 24 hours. Once active, this satisfies the SBA &quot;active resolution&quot; requirement and underwriting can proceed.
            </p>
          </div>
          <p className="text-xs text-gray-500 mt-3 italic">
            Sources: Full Account Transcript transaction-code scan (TC 480, 481, 482, 520, 530, 971 with installment action codes). Absence of these codes confirms no plan is active.
          </p>
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

// ─────────────────────────────────────────────────────────────────────
// ERC STATUS REPORT — sample for the ERC / 941 product (TaxTaker POC)
// Mirrors /admin/erc-report/[entityId] but with hand-crafted dummy data
// so we can showcase every status in one screen.
// ─────────────────────────────────────────────────────────────────────

const SAMPLE_ERC_ENTITY = {
  name: 'Coastal Software Labs, Inc.',
  ein: '84-2917846',
  client: 'TaxTaker — Sample',
  loanNumber: 'SAMPLE-ERC-001',
};

interface SampleQuarter {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  status: 'refund_returned_undelivered' | 'refund_paid' | 'claim_pending_irs_review' | 'claim_denied_or_reduced' | 'amendment_received_no_action' | 'no_claim_filed' | 'unknown';
  ercCreditAmount: number | null;
  refundIssuedAmount: number | null;
  refundIssuedDate: string | null;
  refundReturnedDate: string | null;
  totalRecoverable: number;
  deadlinePassed: boolean;
  filingDeadline: string;
  eligibilityNote?: string;
  actionRequired: string | null;
  notes: string[];
}

const SAMPLE_ERC_QUARTERS: SampleQuarter[] = [
  {
    year: 2020,
    quarter: 2,
    status: 'refund_paid',
    ercCreditAmount: -28430.12,
    refundIssuedAmount: 30217.45,
    refundIssuedDate: '2022-03-15',
    refundReturnedDate: null,
    totalRecoverable: 0,
    deadlinePassed: true,
    filingDeadline: '2024-04-15',
    actionRequired: null,
    notes: ['Refund of $30,217.45 was issued on 2022-03-15. Should be in client’s account.'],
  },
  {
    year: 2020,
    quarter: 3,
    status: 'refund_paid',
    ercCreditAmount: -41882.50,
    refundIssuedAmount: 44721.30,
    refundIssuedDate: '2022-04-08',
    refundReturnedDate: null,
    totalRecoverable: 0,
    deadlinePassed: true,
    filingDeadline: '2024-04-15',
    actionRequired: null,
    notes: ['Refund of $44,721.30 was issued on 2022-04-08. Should be in client’s account.'],
  },
  {
    year: 2020,
    quarter: 4,
    status: 'refund_returned_undelivered',
    ercCreditAmount: -36904.81,
    refundIssuedAmount: 39612.07,
    refundIssuedDate: '2022-06-21',
    refundReturnedDate: '2022-07-08',
    totalRecoverable: 39612.07,
    deadlinePassed: true,
    filingDeadline: '2024-04-15',
    actionRequired: 'Update mailing address with IRS (Form 8822-B for business). Once updated, the IRS will reissue the check. May also call PPS and request reissue once address is updated.',
    notes: [
      'TC 960 present — a Power of Attorney / 8821 is on record at the IRS.',
      'Refund of $39,612.07 was issued on 2022-06-21 but TC 740 shows the check was returned undelivered on 2022-07-08.',
      'The returned amount matches the refund amount exactly — the entire check came back, not a partial.',
    ],
  },
  {
    year: 2021,
    quarter: 1,
    status: 'claim_pending_irs_review',
    ercCreditAmount: -52108.20,
    refundIssuedAmount: null,
    refundIssuedDate: null,
    refundReturnedDate: null,
    totalRecoverable: 52108.20,
    deadlinePassed: true,
    filingDeadline: '2025-04-15',
    actionRequired: 'Wait for IRS review to complete. The IRS may request additional documentation; respond promptly if so. Approx 41K claims remain under examination as of early 2026.',
    notes: ['TC 470 indicates the claim is pending IRS review.', '941-X filed 2023-02-18, currently in pre-payment review queue.'],
  },
  {
    year: 2021,
    quarter: 2,
    status: 'amendment_received_no_action',
    ercCreditAmount: -48791.04,
    refundIssuedAmount: null,
    refundIssuedDate: null,
    refundReturnedDate: null,
    totalRecoverable: 48791.04,
    deadlinePassed: true,
    filingDeadline: '2025-04-15',
    actionRequired: 'Amendment received by IRS but no refund decision yet. Average processing is 4-8 months but has stretched to 12-18 months for ERC claims. Monitor monthly.',
    notes: ['TC 977 (amendment filed) posted 2023-08-14. No subsequent transaction codes — still in IRS processing queue.'],
  },
  {
    year: 2021,
    quarter: 3,
    status: 'claim_denied_or_reduced',
    ercCreditAmount: null,
    refundIssuedAmount: null,
    refundIssuedDate: null,
    refundReturnedDate: null,
    totalRecoverable: 0,
    deadlinePassed: true,
    filingDeadline: '2025-04-15',
    actionRequired: 'Check for IRS Letter 105-C (disallowance notice) in client mail. If received, evaluate appeal — must be filed within 2 years of disallowance. If not received, request transcripts of notices issued.',
    notes: [
      'TC 290 posted with positive amount (no offsetting TC 766 credit) — claim was likely denied or significantly reduced.',
      'TC 971 with action code 057 suggests Letter 105-C was issued. Confirm with client.',
    ],
  },
  {
    year: 2021,
    quarter: 4,
    status: 'no_claim_filed',
    ercCreditAmount: null,
    refundIssuedAmount: null,
    refundIssuedDate: null,
    refundReturnedDate: null,
    totalRecoverable: 0,
    deadlinePassed: true,
    filingDeadline: '2025-04-15',
    eligibilityNote: 'Q4 2021 eligible only for Recovery Startup Businesses (RSBs). All other businesses are NOT eligible for Q4 2021.',
    actionRequired: null,
    notes: ['No TC 971/976/977 (amendment receipt) or TC 766/846 (credit / refund) on this transcript — appears no ERC claim was ever filed for this quarter.'],
  },
];

function ercStatusChipSample(s: SampleQuarter['status']): { bg: string; border: string; text: string; label: string } {
  switch (s) {
    case 'refund_returned_undelivered': return { bg: 'bg-amber-50',   border: 'border-amber-300',  text: 'text-amber-900',  label: '$$$ Returned' };
    case 'refund_paid':                  return { bg: 'bg-emerald-50', border: 'border-emerald-300', text: 'text-emerald-800', label: 'Paid' };
    case 'claim_pending_irs_review':     return { bg: 'bg-blue-50',    border: 'border-blue-300',   text: 'text-blue-800',   label: 'Pending' };
    case 'claim_denied_or_reduced':      return { bg: 'bg-red-50',     border: 'border-red-300',    text: 'text-red-800',    label: 'Denied' };
    case 'amendment_received_no_action': return { bg: 'bg-indigo-50',  border: 'border-indigo-300', text: 'text-indigo-800', label: 'Filed, waiting' };
    case 'no_claim_filed':               return { bg: 'bg-gray-50',    border: 'border-gray-200',   text: 'text-gray-600',   label: 'No claim' };
    case 'unknown':                      return { bg: 'bg-gray-50',    border: 'border-gray-200',   text: 'text-gray-500',   label: 'No data' };
  }
}

function ercStatusLabelSample(s: SampleQuarter['status']): string {
  switch (s) {
    case 'refund_returned_undelivered': return 'Refund returned undelivered';
    case 'refund_paid':                  return 'Refund paid';
    case 'claim_pending_irs_review':     return 'Claim pending IRS review';
    case 'claim_denied_or_reduced':      return 'Claim denied or reduced';
    case 'amendment_received_no_action': return 'Amendment received, no action yet';
    case 'no_claim_filed':               return 'No claim filed';
    case 'unknown':                      return 'Unknown / transcript missing';
  }
}

function fmtUsdSample(n: number | null): string {
  if (n === null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ERCReportSample() {
  const totalRecoverable = SAMPLE_ERC_QUARTERS.reduce((s, q) => s + q.totalRecoverable, 0);
  const quartersPaid = SAMPLE_ERC_QUARTERS.filter(q => q.status === 'refund_paid').length;
  const quartersPending = SAMPLE_ERC_QUARTERS.filter(q => q.status === 'claim_pending_irs_review' || q.status === 'amendment_received_no_action').length;
  const quartersUndelivered = SAMPLE_ERC_QUARTERS.filter(q => q.status === 'refund_returned_undelivered').length;
  const actionItems = SAMPLE_ERC_QUARTERS.filter(q => q.actionRequired);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <Link href="/sample-request" className="text-xs text-gray-500 hover:text-gray-700">← Back to sample tour</Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark mt-1">
            ERC Status Report — {SAMPLE_ERC_ENTITY.name}
          </h1>
          <p className="text-gray-600 text-sm mt-1">
            {SAMPLE_ERC_ENTITY.client} · EIN {SAMPLE_ERC_ENTITY.ein} · Form 941 Account Transcripts · generated from 7 transcripts on file
          </p>
        </div>

        {/* Demo banner explaining what this is + how to act */}
        <div className="mb-6 bg-blue-50 border-l-4 border-blue-500 rounded-r p-4">
          <p className="text-sm font-bold text-blue-900">What you&apos;re looking at</p>
          <p className="text-sm text-blue-900 mt-1">
            This is the full ERC analysis we deliver after pulling a customer&apos;s 941 Account Transcripts.
            Every IRS transaction code (TC 150, 766, 846, 740, 290, 470, 971, 976, 977) is parsed and
            mapped to per-quarter status: paid, returned, pending, denied, or no claim filed. The
            &ldquo;Request Check Reissue&rdquo; CTA below offers two ways to pay: <strong>Stripe Checkout
            for $999.99</strong> (pay-now-with-card, instant) or a <strong>Mercury ACH invoice for $1,000</strong>
            (net-15 friendly). Either way, we then file Form 8822-B and call the IRS Business &amp;
            Specialty Tax line to recover the check on the client&apos;s behalf.
          </p>
          <p className="text-sm text-blue-900 mt-2">
            <Link href="/login" className="font-semibold underline">Sign in</Link>{' '}
            to view the real report for entities you&apos;ve ordered, or contact{' '}
            <a className="font-semibold underline" href="mailto:matt@moderntax.io">matt@moderntax.io</a> for a free first 941 pull.
          </p>
        </div>

        {/* Summary */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-bold text-mt-dark mb-4">Recoverable summary</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg p-4 border bg-amber-50 border-amber-300">
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Total recoverable</p>
              <p className="text-2xl font-bold mt-1 text-amber-700">{fmtUsdSample(totalRecoverable)}</p>
            </div>
            <div className="rounded-lg p-4 border bg-amber-50 border-amber-300">
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Returned</p>
              <p className="text-2xl font-bold mt-1 text-amber-700">{quartersUndelivered}</p>
              <p className="text-[11px] text-gray-500">refund check returned undelivered</p>
            </div>
            <div className="rounded-lg p-4 border bg-blue-50 border-blue-300">
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Pending</p>
              <p className="text-2xl font-bold mt-1 text-blue-700">{quartersPending}</p>
              <p className="text-[11px] text-gray-500">at the IRS, awaiting decision</p>
            </div>
            <div className="rounded-lg p-4 border bg-emerald-50 border-emerald-300">
              <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Already paid</p>
              <p className="text-2xl font-bold mt-1 text-emerald-700">{quartersPaid}</p>
              <p className="text-[11px] text-gray-500">in client&apos;s account</p>
            </div>
          </div>
        </div>

        {/* Per-quarter table */}
        <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-gray-200 bg-gray-50">
            <h2 className="text-base font-bold text-mt-dark">Per-quarter detail</h2>
            <p className="text-xs text-gray-500 mt-0.5">Eligible quarters per IRS guidance: 2020 Q2–Q4 + 2021 Q1–Q3 (most businesses). Q4 2021 only for Recovery Startup Businesses.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-2 text-left">Quarter</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-right">ERC Credit</th>
                  <th className="px-4 py-2 text-right">Refund Issued</th>
                  <th className="px-4 py-2 text-right">Recoverable</th>
                  <th className="px-4 py-2 text-left">Deadline</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {SAMPLE_ERC_QUARTERS.map(q => {
                  const c = ercStatusChipSample(q.status);
                  return (
                    <tr key={`${q.year}-Q${q.quarter}`} className="hover:bg-gray-50 align-top">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-mt-dark">{q.year} Q{q.quarter}</div>
                        <div className="text-xs text-gray-500">period ending {q.year}-{['03-31','06-30','09-30','12-31'][q.quarter - 1]}</div>
                        {q.eligibilityNote && <div className="text-[11px] text-amber-700 mt-1">⚠ {q.eligibilityNote}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${c.bg} ${c.border} ${c.text}`}>{c.label}</span>
                        <div className="text-[11px] text-gray-500 mt-1">{ercStatusLabelSample(q.status)}</div>
                        {q.notes.length > 0 && (
                          <ul className="mt-2 space-y-0.5 text-[11px] text-gray-600 list-disc list-inside max-w-xs">
                            {q.notes.map((n, i) => <li key={i}>{n}</li>)}
                          </ul>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {q.ercCreditAmount !== null ? fmtUsdSample(Math.abs(q.ercCreditAmount)) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {q.refundIssuedAmount !== null ? (
                          <>
                            <div className="font-semibold">{fmtUsdSample(q.refundIssuedAmount)}</div>
                            {q.refundIssuedDate && <div className="text-[11px] text-gray-500">{q.refundIssuedDate}</div>}
                            {q.refundReturnedDate && <div className="text-[11px] text-amber-700">returned {q.refundReturnedDate}</div>}
                          </>
                        ) : '—'}
                      </td>
                      <td className={`px-4 py-3 text-right font-mono ${q.totalRecoverable > 0 ? 'text-amber-700 font-bold' : 'text-gray-400'}`}>
                        {q.totalRecoverable > 0 ? fmtUsdSample(q.totalRecoverable) : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className={q.deadlinePassed ? 'text-red-700 font-semibold' : 'text-gray-700'}>{q.filingDeadline}</div>
                        <div className="text-[11px] text-gray-500">{q.deadlinePassed ? 'passed' : 'open'}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Action items with "demo" payment CTAs */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5 mb-6">
          <h2 className="text-base font-bold text-mt-dark mb-3">
            Action items ({actionItems.length})
          </h2>
          <ul className="space-y-3">
            {actionItems.map(q => (
              <li key={`action-${q.year}-${q.quarter}`} className="border-l-4 border-amber-400 bg-amber-50 px-4 py-3 rounded-r">
                <p className="text-sm font-semibold text-amber-900">
                  {q.year} Q{q.quarter} ({fmtUsdSample(q.totalRecoverable)} at stake)
                </p>
                <p className="text-sm text-amber-900 mt-1">{q.actionRequired}</p>
                {q.status === 'refund_returned_undelivered' && (
                  <div className="mt-3 pt-3 border-t border-amber-300 flex flex-col items-start gap-2">
                    <CheckReissueRequestForm
                      prefill={{
                        refundQuarter: `${q.year} Q${q.quarter}`,
                        refundAmount: q.refundIssuedAmount ?? undefined,
                      }}
                    />
                    <span className="text-[11px] text-amber-800">
                      Pick your billing path — Stripe Checkout ($999.99, instant card charge) or Mercury ACH invoice ($1,000, net-15). Either way we file Form 8822-B + call the IRS Business &amp; Specialty Tax line on the client&apos;s behalf. No portal account required.
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>

        {/* CTA footer — direct purchase, no portal account required */}
        <div className="bg-gradient-to-r from-mt-dark to-mt-navy rounded-xl p-6 text-white">
          <h3 className="text-lg font-bold mb-2">Buy ERC pulls for your portfolio — no account needed</h3>
          <p className="text-sm text-gray-200 mb-5 max-w-2xl">
            For ERC-recovery firms, R&amp;D credit shops, and tax-services partners. Pay via Stripe in
            under a minute, then we&apos;ll email you to confirm onboarding details and the EINs you want
            pulled. First report typically delivered within 24 hours of receiving 8821s.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            <div className="bg-white/10 rounded-lg p-4">
              <p className="text-[11px] uppercase tracking-wide text-gray-300">Starter</p>
              <p className="text-xl font-bold mt-1">$239.94</p>
              <p className="text-[11px] text-gray-300 mb-3">3 ERC entity pulls · up to 3 quarters each</p>
              <SelfServePackButton
                pack="erc-3-pack"
                label="Buy 3-pack →"
                className="inline-flex w-full justify-center items-center px-3 py-2 bg-mt-green text-white rounded font-semibold hover:bg-mt-green/90 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              />
            </div>
            <div className="bg-white/10 rounded-lg p-4 ring-1 ring-mt-green/40">
              <p className="text-[11px] uppercase tracking-wide text-mt-green font-semibold">Best value</p>
              <p className="text-xl font-bold mt-1">$379.99</p>
              <p className="text-[11px] text-gray-300 mb-3">5 ERC entity pulls · ~5% volume discount</p>
              <SelfServePackButton
                pack="erc-5-pack"
                label="Buy 5-pack →"
                className="inline-flex w-full justify-center items-center px-3 py-2 bg-mt-green text-white rounded font-semibold hover:bg-mt-green/90 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              />
            </div>
            <div className="bg-white/10 rounded-lg p-4">
              <p className="text-[11px] uppercase tracking-wide text-gray-300">Single full sweep</p>
              <p className="text-xl font-bold mt-1">$159.96</p>
              <p className="text-[11px] text-gray-300 mb-3">1 entity · ALL 6–7 ERC quarters</p>
              <SelfServePackButton
                pack="erc-full-sweep"
                label="Buy full sweep →"
                className="inline-flex w-full justify-center items-center px-3 py-2 bg-mt-green text-white rounded font-semibold hover:bg-mt-green/90 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link href="/plans" className="px-4 py-2 border border-white/30 rounded-lg text-white hover:bg-white/10">
              See full pricing
            </Link>
            <a href="mailto:matt@moderntax.io?subject=ERC%20pulls%20for%20our%20portfolio" className="px-4 py-2 border border-white/30 rounded-lg text-white hover:bg-white/10">
              Talk to Matt first
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
