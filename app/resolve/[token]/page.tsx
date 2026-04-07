import { createClient } from '@supabase/supabase-js';

interface ResolvePageProps {
  params: { token: string };
  searchParams: { unsubscribe?: string };
}

export default async function ResolvePage({ params, searchParams }: ResolvePageProps) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Look up drip record by token
  const { data: drip, error } = await supabase
    .from('compliance_drip')
    .select('*')
    .eq('resolve_token', params.token)
    .single() as { data: any; error: any };

  if (error || !drip) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-sm border max-w-md text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-2">Link Expired</h1>
          <p className="text-gray-500">This compliance review link is no longer valid. Please contact support@moderntax.io for assistance.</p>
        </div>
      </div>
    );
  }

  // Handle unsubscribe
  if (searchParams.unsubscribe === '1') {
    await supabase
      .from('compliance_drip')
      .update({ unsubscribed: true, unsubscribed_at: new Date().toISOString() })
      .eq('id', drip.id);

    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-sm border max-w-md text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-2">Unsubscribed</h1>
          <p className="text-gray-500">You&apos;ve been removed from compliance notifications for {drip.entity_name}. If you change your mind, contact support@moderntax.io.</p>
        </div>
      </div>
    );
  }

  // Track landing page visit
  await supabase
    .from('compliance_drip')
    .update({
      landing_page_visited_at: new Date().toISOString(),
      landing_page_visit_count: (drip.landing_page_visit_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', drip.id);

  // Fetch entity flags
  const { data: entity } = await supabase
    .from('request_entities')
    .select('gross_receipts, entity_name, form_type, years')
    .eq('id', drip.entity_id)
    .single() as { data: any; error: any };

  // Parse flags
  const allFlags: { message: string; severity: string; year?: string }[] = [];
  let financials: any = {};

  if (entity?.gross_receipts) {
    for (const [key, val] of Object.entries(entity.gross_receipts) as [string, any][]) {
      if (!val?.severity) continue;
      for (const flag of (val.flags || [])) {
        allFlags.push({ ...flag, year: key });
      }
      if (val.financials) {
        // Merge financials, summing amounts
        financials.accountBalance = (financials.accountBalance || 0) + Math.abs(val.financials.accountBalance || 0);
        financials.accruedPenalty = (financials.accruedPenalty || 0) + Math.abs(val.financials.accruedPenalty || 0);
        financials.accruedInterest = (financials.accruedInterest || 0) + Math.abs(val.financials.accruedInterest || 0);
        financials.totalTax = (financials.totalTax || 0) + (val.financials.totalTax || 0);
        financials.grossReceipts = (financials.grossReceipts || 0) + (val.financials.grossReceipts || 0);
      }
    }
  }

  const totalExposure = (financials.accountBalance || 0) + (financials.accruedPenalty || 0) + (financials.accruedInterest || 0);
  const criticalFlags = allFlags.filter(f => f.severity === 'CRITICAL');
  const warningFlags = allFlags.filter(f => f.severity === 'WARNING');
  const bookingUrl = 'https://meetings.hubspot.com/matt-moderntax/moderntax-intro';

  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(n);

  const categoryLabels: Record<string, string> = {
    balance_due: 'Outstanding Balance',
    unfiled_returns: 'Unfiled Returns',
    penalties: 'IRS Penalties',
    mixed: 'Multiple Compliance Issues',
    other: 'Compliance Review',
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800">
      {/* Header */}
      <div className="border-b border-slate-700">
        <div className="max-w-3xl mx-auto px-4 py-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center">
              <span className="text-white text-xs font-bold font-mono">&lt;/&gt;</span>
            </div>
            <span className="text-white font-semibold">ModernTax</span>
          </div>
          <span className="text-slate-400 text-sm">Tax Compliance & Resolution</span>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-12">
        {/* Title */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center px-3 py-1 rounded-full bg-red-500/20 text-red-300 text-xs font-medium mb-4">
            {drip.flag_severity} — {categoryLabels[drip.flag_category] || 'Compliance Review'}
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">
            Compliance Review: {drip.entity_name}
          </h1>
          <p className="text-slate-400">
            The following items were identified during IRS transcript verification.
          </p>
        </div>

        {/* Exposure Card */}
        {totalExposure > 0 && (
          <div className="bg-white rounded-xl shadow-lg p-8 mb-6">
            <div className="text-center">
              <div className="text-sm text-gray-500 uppercase tracking-wide mb-2">Total IRS Exposure</div>
              <div className="text-5xl font-bold text-red-600 mb-4">{fmt(totalExposure)}</div>
              <div className="flex justify-center gap-8 text-sm">
                {financials.accountBalance > 0 && (
                  <div>
                    <div className="text-gray-500">Balance Due</div>
                    <div className="font-semibold text-red-600">{fmt(financials.accountBalance)}</div>
                  </div>
                )}
                {financials.accruedPenalty > 0 && (
                  <div>
                    <div className="text-gray-500">Penalties</div>
                    <div className="font-semibold text-amber-600">{fmt(financials.accruedPenalty)}</div>
                  </div>
                )}
                {financials.accruedInterest > 0 && (
                  <div>
                    <div className="text-gray-500">Interest</div>
                    <div className="font-semibold text-amber-600">{fmt(financials.accruedInterest)}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Flags */}
        <div className="bg-white rounded-xl shadow-lg p-8 mb-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Issues Identified</h2>

          {criticalFlags.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-red-700 mb-2">Critical</h3>
              <ul className="space-y-1">
                {criticalFlags.map((f, i) => (
                  <li key={i} className="text-sm text-red-700 flex items-start gap-2">
                    <span className="text-red-500 mt-0.5">&#9679;</span>
                    {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {warningFlags.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-amber-700 mb-2">Warnings</h3>
              <ul className="space-y-1">
                {warningFlags.map((f, i) => (
                  <li key={i} className="text-sm text-amber-700 flex items-start gap-2">
                    <span className="text-amber-500 mt-0.5">&#9679;</span>
                    {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Resolution Options */}
        <div className="bg-white rounded-xl shadow-lg p-8 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">How We Can Help</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
              <div className="text-2xl mb-2">&#9878;</div>
              <h3 className="font-semibold text-emerald-800 text-sm mb-1">Penalty Abatement</h3>
              <p className="text-xs text-emerald-700">First-time penalty relief can eliminate penalties entirely. We handle the IRS filing on your behalf.</p>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="text-2xl mb-2">&#128197;</div>
              <h3 className="font-semibold text-blue-800 text-sm mb-1">Payment Plans</h3>
              <p className="text-xs text-blue-700">Installment agreements to spread payments over time and prevent levies or garnishments.</p>
            </div>
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
              <div className="text-2xl mb-2">&#128176;</div>
              <h3 className="font-semibold text-purple-800 text-sm mb-1">Offer in Compromise</h3>
              <p className="text-xs text-purple-700">Negotiate with the IRS to settle for less than the full amount owed based on your ability to pay.</p>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="bg-gradient-to-r from-emerald-600 to-emerald-700 rounded-xl shadow-lg p-8 text-center">
          <h2 className="text-xl font-bold text-white mb-2">Ready to Resolve This?</h2>
          <p className="text-emerald-100 mb-6">Schedule a free 15-minute consultation. No obligation, no pressure — just clarity on your options.</p>
          <a
            href={bookingUrl}
            className="inline-block bg-white text-emerald-700 font-bold px-8 py-4 rounded-lg text-lg hover:bg-emerald-50 transition-colors shadow-md"
          >
            Book Free Consultation
          </a>
          <p className="text-emerald-200 text-xs mt-4">Or call us directly: (855) 907-3847</p>
        </div>

        {/* Trust Badges */}
        <div className="mt-8 flex justify-center gap-8 text-slate-500 text-xs">
          <div className="flex items-center gap-1">
            <span>&#128274;</span> SOC 2 Compliant
          </div>
          <div className="flex items-center gap-1">
            <span>&#128272;</span> 256-bit Encryption
          </div>
          <div className="flex items-center gap-1">
            <span>&#9989;</span> IRS Authorized
          </div>
        </div>

        <div className="mt-8 text-center text-slate-600 text-xs">
          <p>&copy; 2026 ModernTax. All rights reserved.</p>
          <p className="mt-1">
            <a href={`/resolve/${params.token}?unsubscribe=1`} className="text-slate-500 hover:text-slate-400 underline">
              Unsubscribe from these notifications
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
