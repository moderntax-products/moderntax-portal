/**
 * NewRequestHeader — shared header for the three /new/* workflow pages.
 * Renders the page title + a tab strip linking to the sibling workflows
 * so users can switch between CSV / PDF / Manual without losing the
 * "I'm in the middle of submitting" mental model.
 *
 * Server component (no state) — each /new/[type] route is a separate
 * URL so analytics tracks workflow popularity independently.
 */

import Link from 'next/link';

type Mode = 'csv' | 'pdf' | 'manual' | 'convert';

interface Props {
  mode: Mode;
}

const TABS: { mode: Mode; href: string; label: string; icon: string; tagline: string }[] = [
  { mode: 'csv', href: '/new/csv', label: 'CSV / Excel Upload', icon: '📊', tagline: 'Multiple borrowers at once' },
  { mode: 'pdf', href: '/new/pdf', label: 'Signed 8821 PDF', icon: '📄', tagline: 'Signature already collected' },
  { mode: 'manual', href: '/new/manual', label: 'Manual Entry', icon: '✏️', tagline: 'One borrower, fastest path' },
  { mode: 'convert', href: '/new/convert', label: 'Convert Vendor 8821', icon: '🔄', tagline: 'Re-designate a Tax Guard / other vendor 8821 to ModernTax' },
];

export function NewRequestHeader({ mode }: Props) {
  const active = TABS.find(t => t.mode === mode);
  return (
    <>
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
              <Link href="/" className="hover:text-gray-900">Dashboard</Link>
              <span>/</span>
              <Link href="/new" className="hover:text-gray-900">New Request</Link>
              <span>/</span>
              <span className="text-gray-700 font-medium">{active?.label}</span>
            </div>
            <h1 className="text-3xl font-bold text-mt-dark">{active?.icon} {active?.label}</h1>
            <p className="text-gray-600 mt-1">{active?.tagline}</p>
          </div>
          <Link href="/new" className="text-gray-600 hover:text-gray-900 font-medium text-sm">
            &larr; All workflows
          </Link>
        </div>
      </div>

      {/* Cross-workflow tab strip — each tab is a unique URL so analytics
          tracks usage per path. Active tab has the green underline; the
          others are clickable to switch workflows. */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">
        <div className="flex border-b border-gray-200 overflow-x-auto">
          {TABS.map((t) => {
            const isActive = t.mode === mode;
            return (
              <Link
                key={t.mode}
                href={t.href}
                className={`px-6 py-3 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? 'border-mt-green text-mt-green'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <span className="mr-2">{t.icon}</span>
                {t.label}
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
