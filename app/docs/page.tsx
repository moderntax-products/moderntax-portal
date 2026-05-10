/**
 * Docs index — currently a thin landing that points to /docs/api.
 *
 * Kept as a separate route (vs. just redirecting) so we can grow this
 * over time: additional pages for guides, recipe / quickstart, SDK
 * downloads, changelog, etc. without breaking the /docs URL.
 *
 * Indexable so partners can find this via Google.
 */

import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ModernTax Documentation',
  description:
    'API reference, integration guides, and SOC 2 documentation for the ModernTax partner platform.',
  robots: { index: true, follow: true },
};

export default function DocsIndex() {
  const sections = [
    {
      title: 'Partner API Reference',
      href: '/docs/api',
      blurb:
        'Five endpoints for transcript intake, signed-8821 PDF upload, monitoring enrollment, and result polling. x-api-key auth, JSON in / JSON out.',
      cta: 'Read the API reference →',
      featured: true,
    },
    {
      title: 'Pricing & plans',
      href: '/plans',
      blurb:
        'PAYG, deposit, and platform tiers. API setup fees, monitoring rates, and volume pricing thresholds.',
      cta: 'See pricing →',
    },
    {
      title: 'IRS PPS status',
      href: '/status',
      blurb:
        'Real-time view of IRS Practitioner Priority Service hold times. We surface this so you know what wait to expect on a same-day pull.',
      cta: 'Check status →',
    },
    {
      title: 'Sample request + transcripts',
      href: '/sample-request',
      blurb:
        'Walks through an end-to-end transcript order: 8821 collection, IRS retrieval, compliance summary, transcript delivery.',
      cta: 'See a sample →',
    },
  ];

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-mt-green font-extrabold text-xl tracking-tight">
              ModernTax
            </span>
            <span className="text-gray-400 text-sm">/ Docs</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <a
              href="https://moderntax.io/docs"
              className="text-gray-600 hover:text-gray-900"
            >
              Marketing site
            </a>
            <Link
              href="/login"
              className="px-3 py-1.5 text-white bg-mt-dark rounded-lg hover:bg-mt-navy transition-colors"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-20">
        <div className="max-w-2xl">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-mt-dark tracking-tight">
            ModernTax Documentation
          </h1>
          <p className="mt-4 text-lg text-gray-600">
            Everything you need to integrate the ModernTax partner platform.
            For account provisioning or SOC 2 evidence, email{' '}
            <a className="text-mt-green hover:underline" href="mailto:matt@moderntax.io">
              matt@moderntax.io
            </a>
            .
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-6">
          {sections.map(s => (
            <Link
              key={s.href}
              href={s.href}
              className={`block p-6 rounded-lg border transition-all ${
                s.featured
                  ? 'border-mt-green/40 bg-mt-green/5 hover:border-mt-green hover:shadow-md sm:col-span-2'
                  : 'border-gray-200 bg-white hover:border-mt-green/40 hover:shadow-sm'
              }`}
            >
              <h2 className="text-xl font-bold text-mt-dark">{s.title}</h2>
              <p className="mt-2 text-sm text-gray-600 leading-relaxed">{s.blurb}</p>
              <p className="mt-4 text-sm font-medium text-mt-green">{s.cta}</p>
            </Link>
          ))}
        </div>

        <div className="mt-16 border-t border-gray-200 pt-8">
          <h3 className="text-sm font-semibold text-mt-dark uppercase tracking-wide">
            Compliance & security
          </h3>
          <p className="mt-2 text-sm text-gray-600">
            SOC 2 Type I complete. Type II audit in progress (target Q3 2026).
            For evidence requests, vendor questionnaires, or pen-test reports,
            email{' '}
            <a className="text-mt-green hover:underline" href="mailto:security@moderntax.io">
              security@moderntax.io
            </a>
            .
          </p>
        </div>
      </main>
    </div>
  );
}
