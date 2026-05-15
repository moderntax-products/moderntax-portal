/**
 * Token-gated intake form for ERC Check Reissue engagement.
 * Captures everything we need to file Form 3911 with the IRS Business &
 * Specialty Tax Line — new mailing address, certification box per quarter,
 * authorized officer signature.
 *
 * Built for the Mento engagement (2026-05-15) but generic by token.
 */

import { createClient } from '@supabase/supabase-js';
import { notFound } from 'next/navigation';
import ErcIntakeForm from './ErcIntakeForm';
import { formatUsdAmount } from '@/lib/erc-reissue';

interface PageProps {
  params: { token: string };
}

export const dynamic = 'force-dynamic';

export default async function ErcIntakePage({ params }: PageProps) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: entity, error } = await supabase
    .from('request_entities')
    .select('id, entity_name, tid, erc_intake_data, erc_intake_submitted_at')
    .eq('erc_intake_token', params.token)
    .maybeSingle();

  if (error || !entity) {
    notFound();
  }

  const { data: reissues } = await supabase
    .from('erc_check_reissues')
    .select('id, tax_quarter, tax_period_end_date, original_check_amount, original_check_issued_date, certification_box')
    .eq('entity_id', entity.id)
    .order('tax_quarter', { ascending: true });

  const alreadySubmitted = Boolean(entity.erc_intake_submitted_at);
  const totalRecoverable = (reissues || []).reduce((sum, r) => sum + Number(r.original_check_amount || 0), 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-12">
        <div className="mb-8 text-center">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">ModernTax</div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">ERC Check Reissue Intake</h1>
          <p className="text-gray-600">{entity.entity_name}</p>
        </div>

        {/* Recoverable summary */}
        <div className="bg-white border rounded-lg p-6 mb-6 shadow-sm">
          <div className="flex justify-between items-start mb-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Recoverable from IRS</div>
              <div className="text-3xl font-bold text-emerald-600">{formatUsdAmount(totalRecoverable)}</div>
            </div>
            <div className="text-right text-xs text-gray-500">
              {reissues?.length || 0} check{reissues?.length === 1 ? '' : 's'} to reissue
            </div>
          </div>
          <div className="space-y-2">
            {(reissues || []).map(r => (
              <div key={r.id} className="flex justify-between items-center py-2 border-t text-sm">
                <div>
                  <div className="font-medium text-gray-900">{r.tax_quarter} — Form {(r as any).form_type || '941'}</div>
                  <div className="text-xs text-gray-500">
                    Period ending {r.tax_period_end_date} · Check issued {r.original_check_issued_date} · Returned to IRS
                  </div>
                </div>
                <div className="font-semibold text-gray-900">{formatUsdAmount(Number(r.original_check_amount))}</div>
              </div>
            ))}
          </div>
        </div>

        {alreadySubmitted ? (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-6 text-center">
            <h2 className="text-lg font-semibold text-emerald-900 mb-2">Intake already received ✓</h2>
            <p className="text-emerald-800 text-sm">
              We received your form on {new Date(entity.erc_intake_submitted_at!).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}. Your ModernTax expert is taking it from here.
            </p>
            <a
              href={`/erc-reissue/${params.token}`}
              className="inline-block mt-4 px-5 py-2 bg-emerald-600 text-white text-sm font-medium rounded hover:bg-emerald-700 transition"
            >
              View status tracker →
            </a>
          </div>
        ) : (
          <ErcIntakeForm
            token={params.token}
            entityName={entity.entity_name}
            existingTid={entity.tid}
            reissues={(reissues || []).map(r => ({
              id: r.id,
              taxQuarter: r.tax_quarter,
              originalCheckAmount: Number(r.original_check_amount),
              originalCheckIssuedDate: r.original_check_issued_date,
            }))}
          />
        )}

        <div className="mt-8 text-center text-xs text-gray-500">
          Questions? Reply to the email from <strong>matt@moderntax.io</strong> or text Matt directly.
        </div>
      </div>
    </div>
  );
}
