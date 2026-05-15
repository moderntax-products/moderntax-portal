/**
 * Token-gated tracking page for ERC Check Reissue engagement.
 * Merchant-facing timeline view — shows progress through the 10-stage
 * pipeline + merchant-visible notes per status transition.
 */

import { createClient } from '@supabase/supabase-js';
import { notFound } from 'next/navigation';
import {
  ERC_REISSUE_PIPELINE,
  pipelineIndex,
  ErcReissueStatus,
  ErcReissueStatusHistoryEntry,
  formatUsdAmount,
} from '@/lib/erc-reissue';

interface PageProps {
  params: { token: string };
}

export const dynamic = 'force-dynamic';

export default async function ErcTrackingPage({ params }: PageProps) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: entity, error } = await supabase
    .from('request_entities')
    .select('id, entity_name, erc_intake_submitted_at, erc_intake_data')
    .eq('erc_intake_token', params.token)
    .maybeSingle();

  if (error || !entity) notFound();

  const { data: reissues } = await supabase
    .from('erc_check_reissues')
    .select('id, tax_quarter, tax_period_end_date, original_check_amount, original_check_issued_date, filing_status, status_history, expected_check_arrival_date, check_received_at, irs_trace_filed_at')
    .eq('entity_id', entity.id)
    .order('tax_quarter');

  const totalRecoverable = (reissues || []).reduce((sum, r) => sum + Number(r.original_check_amount || 0), 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-12">
        <div className="mb-8 text-center">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">ModernTax</div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">ERC Refund Status</h1>
          <p className="text-gray-600">{entity.entity_name}</p>
        </div>

        {/* Summary */}
        <div className="bg-white border rounded-lg p-6 mb-6 shadow-sm">
          <div className="flex justify-between items-start">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Recoverable from IRS</div>
              <div className="text-3xl font-bold text-emerald-600">{formatUsdAmount(totalRecoverable)}</div>
              <div className="text-xs text-gray-500 mt-1">{reissues?.length || 0} check{reissues?.length === 1 ? '' : 's'} in process</div>
            </div>
            {!entity.erc_intake_submitted_at && (
              <a
                href={`/erc-reissue/intake/${params.token}`}
                className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded hover:bg-emerald-700 transition"
              >
                Complete intake →
              </a>
            )}
          </div>
        </div>

        {/* Per-check progress */}
        {(reissues || []).map(r => {
          const history = (r.status_history as ErcReissueStatusHistoryEntry[]) || [];
          const currentIdx = pipelineIndex(r.filing_status as ErcReissueStatus);
          return (
            <div key={r.id} className="bg-white border rounded-lg p-6 mb-4 shadow-sm">
              <div className="flex justify-between items-start mb-4 pb-4 border-b">
                <div>
                  <div className="font-semibold text-gray-900">{r.tax_quarter} — Form 941</div>
                  <div className="text-xs text-gray-500">
                    Original check: {formatUsdAmount(Number(r.original_check_amount))} issued {r.original_check_issued_date}
                  </div>
                </div>
                <StatusBadge status={r.filing_status as ErcReissueStatus} />
              </div>

              {/* Pipeline progress */}
              <div className="mb-4">
                <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                  <span>Started</span>
                  <span>Check in mail</span>
                </div>
                <div className="relative h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 bg-emerald-500 transition-all"
                    style={{
                      width: `${Math.max(8, ((currentIdx + 1) / ERC_REISSUE_PIPELINE.length) * 100)}%`,
                    }}
                  />
                </div>
              </div>

              {/* Timeline (merchant-visible only) */}
              <div className="space-y-3">
                {history
                  .filter(h => h.note_merchant_visible)
                  .map((h, i) => (
                    <div key={i} className="flex gap-3 text-sm">
                      <div className="text-gray-400 text-xs flex-shrink-0 w-32">
                        {new Date(h.changed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' })}
                      </div>
                      <div className="flex-1">
                        <div className="font-medium text-gray-900">{labelFor(h.status)}</div>
                        <div className="text-gray-600 text-xs">{h.note_merchant_visible}</div>
                      </div>
                    </div>
                  ))}
              </div>

              {r.expected_check_arrival_date && (
                <div className="mt-4 pt-4 border-t bg-emerald-50 -mx-6 -mb-6 px-6 py-3 rounded-b-lg">
                  <div className="text-xs font-semibold text-emerald-900">Expected arrival</div>
                  <div className="text-sm text-emerald-800">{new Date(r.expected_check_arrival_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
                </div>
              )}
            </div>
          );
        })}

        <div className="mt-8 text-center text-xs text-gray-500">
          We email you on every status change. Reply to any email to reach <strong>matt@moderntax.io</strong>.
        </div>
      </div>
    </div>
  );
}

function labelFor(status: ErcReissueStatus): string {
  return ERC_REISSUE_PIPELINE.find(s => s.status === status)?.label || status;
}

function StatusBadge({ status }: { status: ErcReissueStatus }) {
  const idx = pipelineIndex(status);
  const colors = idx >= 8
    ? 'bg-emerald-100 text-emerald-800'
    : idx >= 5
    ? 'bg-blue-100 text-blue-800'
    : idx >= 2
    ? 'bg-amber-100 text-amber-800'
    : 'bg-gray-100 text-gray-800';
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${colors}`}>
      {labelFor(status)}
    </span>
  );
}
