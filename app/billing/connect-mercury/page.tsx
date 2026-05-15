/**
 * Mercury connect-billing landing page.
 *
 * Where the 402 paywall response from `lib/payment-paywall.ts` directs
 * users when they try to submit a request without a payment method on file.
 * Public route — no auth required so it works as a graceful redirect target
 * even from external API consumers.
 */

import Link from 'next/link';

export const metadata = {
  title: 'Connect your Mercury account · ModernTax',
};

export default function ConnectMercuryPage() {
  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto bg-white rounded-lg shadow border border-gray-200 p-8">
        <h1 className="text-2xl font-bold text-mt-dark mb-2">Connect your Mercury account</h1>
        <p className="text-sm text-gray-600 mb-8">
          A one-time setup so we can invoice your future ModernTax requests via Mercury ACH.
          You won&apos;t need to enter payment info per request — invoices land in your Mercury inbox monthly.
        </p>

        <div className="bg-amber-50 border border-amber-200 rounded p-4 mb-8">
          <p className="text-sm text-amber-900">
            <strong>Why this is required:</strong> we&apos;re routing all new client billing through Mercury ACH while
            our Stripe processing balance gets settled. Existing in-flight requests are unaffected — only new submissions
            are gated until you&apos;re connected.
          </p>
        </div>

        <h2 className="text-lg font-semibold text-mt-dark mb-3">Two-minute setup</h2>
        <ol className="space-y-4 text-sm text-gray-700 mb-8">
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center">1</span>
            <span>
              Email <a href="mailto:billing@moderntax.io?subject=Connect%20Mercury%20account" className="text-emerald-700 font-medium underline">billing@moderntax.io</a>{' '}
              with the email address tied to your Mercury business account.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center">2</span>
            <span>
              We link your Mercury customer record on our side (5-10 min during business hours, next morning otherwise).
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center">3</span>
            <span>
              You&apos;ll get a confirmation email — at that point new requests submit cleanly. No further action needed
              from your team.
            </span>
          </li>
        </ol>

        <h2 className="text-lg font-semibold text-mt-dark mb-3">FAQ</h2>
        <dl className="space-y-4 text-sm text-gray-700 mb-8">
          <div>
            <dt className="font-semibold text-mt-dark">Do I need a Mercury account already?</dt>
            <dd className="mt-1">
              Yes — Mercury is a free business banking platform (<a href="https://mercury.com" className="text-emerald-700 underline" target="_blank" rel="noopener noreferrer">mercury.com</a>).
              If your business doesn&apos;t have one yet, signup takes ~10 minutes and is free.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-mt-dark">When do I actually pay?</dt>
            <dd className="mt-1">
              Mercury invoices are issued monthly (by the 5th) for the prior month&apos;s ModernTax requests, with
              Net-15 terms. ACH payment from your Mercury account, no fees.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-mt-dark">Are my existing in-flight requests affected?</dt>
            <dd className="mt-1">
              No. Anything already submitted continues to process normally. The gate only applies to NEW request submissions.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-mt-dark">Why not Stripe / credit card?</dt>
            <dd className="mt-1">
              We&apos;re consolidating receivables through Mercury ACH for clean cashflow this quarter. Stripe will be
              re-enabled later this year — until then, Mercury is the only option.
            </dd>
          </div>
        </dl>

        <div className="border-t border-gray-200 pt-6 flex justify-between text-sm">
          <Link href="/dashboard" className="text-gray-500 hover:text-gray-700">← Back to dashboard</Link>
          <a href="mailto:billing@moderntax.io?subject=Connect%20Mercury%20account" className="font-semibold text-emerald-700 hover:text-emerald-800">
            Email billing@moderntax.io →
          </a>
        </div>
      </div>
    </main>
  );
}
