/**
 * /welcome — public post-payment confirmation page
 *
 * Where Stripe drops self-serve buyers after a successful checkout from
 * the public ERC sample. We don't have a portal account for them yet
 * (this is the WHOLE point of the no-auth flow), so this page is
 * intentionally stateless: read the session_id from the URL, fetch the
 * Stripe session for receipt details, show a "what happens next" panel.
 *
 * The webhook does the actual work — emails Matt with the customer
 * info so he can onboard them off-platform.
 */

import Link from 'next/link';
import { getStripe } from '@/lib/stripe';
import type { Metadata } from 'next';

interface PageProps {
  searchParams: Promise<{ session_id?: string }>;
}

export const metadata: Metadata = {
  title: 'Thanks for your purchase — ModernTax',
  robots: { index: false, follow: false },  // post-payment URL, don't index
};

export default async function WelcomePage({ searchParams }: PageProps) {
  const { session_id } = await searchParams;

  // Look up the Stripe session for the receipt (best-effort — if the
  // session is missing or fails, we still render a friendly fallback).
  let session: any = null;
  let amountUsd = 0;
  let packName = 'your purchase';
  let customerEmail: string | null = null;
  let lookupError: string | null = null;

  if (session_id) {
    try {
      const stripe = getStripe();
      session = await stripe.checkout.sessions.retrieve(session_id);
      amountUsd = (session.amount_total || 0) / 100;
      packName = session.metadata?.pack_name || packName;
      customerEmail = session.customer_details?.email || null;
    } catch (err) {
      lookupError = err instanceof Error ? err.message : 'Stripe lookup failed';
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-mt-green font-extrabold text-xl tracking-tight">ModernTax</span>
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            <Link href="/docs/api" className="text-gray-600 hover:text-gray-900">Docs</Link>
            <Link href="/plans" className="text-gray-600 hover:text-gray-900">Pricing</Link>
          </nav>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-20">
        {/* Big confirmation card */}
        <div className="bg-white rounded-xl shadow-sm border border-emerald-200 p-8 mb-6">
          <div className="flex items-start gap-4">
            <div className="shrink-0 w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="flex-1">
              <h1 className="text-2xl sm:text-3xl font-extrabold text-mt-dark">Thanks — payment received</h1>
              <p className="text-gray-600 mt-2">
                {session_id ? (
                  <>
                    {amountUsd > 0 && <>Your $<strong>{amountUsd.toFixed(2)}</strong> purchase of <strong>{packName}</strong> is confirmed.</>}
                    {!amountUsd && <>Your purchase is confirmed.</>}
                    {customerEmail && <> A receipt is on its way to <strong>{customerEmail}</strong>.</>}
                  </>
                ) : (
                  <>Your purchase is confirmed.</>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* What happens next */}
        <div className="bg-white rounded-xl border border-gray-200 p-8 mb-6">
          <h2 className="text-lg font-bold text-mt-dark mb-4">What happens next</h2>
          <ol className="space-y-4 text-sm text-gray-700">
            <li className="flex items-start gap-3">
              <span className="shrink-0 w-6 h-6 bg-mt-dark text-white rounded-full flex items-center justify-center text-xs font-bold">1</span>
              <div>
                <p className="font-semibold text-mt-dark">Within 1 business day</p>
                <p className="mt-1">Matt (CEO of ModernTax) emails you to confirm onboarding details and set up your portal account. Reply with the EINs you want pulled and any signed 8821s you already have.</p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="shrink-0 w-6 h-6 bg-mt-dark text-white rounded-full flex items-center justify-center text-xs font-bold">2</span>
              <div>
                <p className="font-semibold text-mt-dark">Same-day 8821 collection (if needed)</p>
                <p className="mt-1">If you don&apos;t have signed 8821s on file, we generate them and route to your client signers via Dropbox Sign — typically signed within hours.</p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="shrink-0 w-6 h-6 bg-mt-dark text-white rounded-full flex items-center justify-center text-xs font-bold">3</span>
              <div>
                <p className="font-semibold text-mt-dark">24-hour transcript delivery</p>
                <p className="mt-1">We pull 941 Account Transcripts from the IRS via PPS line, run the ERC analysis, and deliver the per-quarter status report to your portal.</p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="shrink-0 w-6 h-6 bg-emerald-600 text-white rounded-full flex items-center justify-center text-xs font-bold">$</span>
              <div>
                <p className="font-semibold text-mt-dark">If we find a returned-undelivered refund</p>
                <p className="mt-1">You can click <strong>Request Check Reissue ($1,000)</strong> directly from the report to recover the IRS check. We file Form 8822-B + call the Business &amp; Specialty Tax line on the client&apos;s behalf.</p>
              </div>
            </li>
          </ol>
        </div>

        {/* Quick links */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-sm font-bold text-mt-dark mb-3">In the meantime</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <Link href="/docs/api" className="block p-3 rounded border border-gray-200 hover:border-mt-green/40 hover:shadow-sm">
              <p className="font-semibold text-mt-dark">API reference</p>
              <p className="text-xs text-gray-500 mt-0.5">If you&apos;re wiring this into your own ops stack.</p>
            </Link>
            <Link href="/plans" className="block p-3 rounded border border-gray-200 hover:border-mt-green/40 hover:shadow-sm">
              <p className="font-semibold text-mt-dark">Full pricing</p>
              <p className="text-xs text-gray-500 mt-0.5">Monthly tiers, monitoring, cash-flow pack.</p>
            </Link>
            <a href="mailto:matt@moderntax.io?subject=Onboarding%20follow-up" className="block p-3 rounded border border-gray-200 hover:border-mt-green/40 hover:shadow-sm">
              <p className="font-semibold text-mt-dark">Email Matt directly</p>
              <p className="text-xs text-gray-500 mt-0.5">For anything time-sensitive.</p>
            </a>
          </div>
        </div>

        {lookupError && (
          <div className="mt-6 text-xs text-gray-500 text-center">
            (Receipt details unavailable — payment is still confirmed. Lookup error: {lookupError})
          </div>
        )}
      </main>
    </div>
  );
}
