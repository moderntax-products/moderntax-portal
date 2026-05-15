/**
 * Merchant-facing ERC Refund Recovery status page.
 *
 * Mirrors the visual style of /admin/compliance-status/[entityId] but
 * scrubbed for direct merchant viewing — no admin chrome, no internal
 * data, token-gated (no login required).
 *
 * Two main sections:
 *   1. ERC Refund Delivery Status — what we found in the IRS account
 *   2. Step-by-Step Recovery Process — the 10-stage pipeline with
 *      current-stage highlighted, so the merchant always knows what
 *      we're doing for them right now.
 *
 * No DB migration required for MVP — reads from gross_receipts.erc_recovery
 * (seeded by scripts/seed-mento-erc-recovery.mjs).
 */

import { createClient } from '@supabase/supabase-js';
import { notFound } from 'next/navigation';

interface PageProps {
  params: { token: string };
}

interface ErcEvent {
  tax_quarter: string;
  period_ending: string;
  form_type: string;
  issued_on: string;
  amount: number;
  status: 'undelivered' | 'delivered';
  returned_on: string | null;
  notes?: string;
}

interface ErcRecoveryData {
  engagement_created_at: string;
  total_recoverable: number;
  total_issued: number;
  total_delivered: number;
  total_undelivered: number;
  events: ErcEvent[];
  current_stage: string;
  stage_history: { stage: string; at: string; actor: string; merchant_visible_note: string }[];
  invoice?: { mercury_invoice_number: string; amount: number; pay_url: string };
}

const STAGES: { key: string; label: string; merchantCopy: string }[] = [
  { key: 'engagement_created',        label: 'Engagement created',           merchantCopy: 'We confirmed the recoverable amount and sent your invoice + this status page.' },
  { key: 'awaiting_payment',          label: 'Awaiting payment',             merchantCopy: 'Once the Mercury invoice clears, we kick off the IRS call.' },
  { key: 'awaiting_intake',           label: 'Awaiting intake form',         merchantCopy: 'We need your new mailing address + Form 3911 signature before we call the IRS.' },
  { key: 'intake_complete',           label: 'Ready to file',                merchantCopy: 'All required info received — call to IRS scheduled.' },
  { key: 'irs_contact_in_progress',   label: 'On the line with IRS',         merchantCopy: 'Our expert is on the phone with the IRS Business & Specialty Tax Line.' },
  { key: 'trace_filed',               label: 'Refund trace filed',           merchantCopy: 'IRS has logged the trace request. Bureau of Fiscal Service verification begins.' },
  { key: 'irs_verifying',             label: 'IRS verifying',                merchantCopy: 'BFS confirming neither check was cashed before we get reissue authorization.' },
  { key: 'check_in_mail',             label: 'Replacement checks in mail',   merchantCopy: 'IRS issued replacement checks — should arrive in ~1 week.' },
  { key: 'check_received',            label: 'Check received',               merchantCopy: 'You confirmed receipt of both checks. Engagement complete!' },
];

export const dynamic = 'force-dynamic';

export default async function ErcStatusPage({ params }: PageProps) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Look up entity by gross_receipts.erc_recovery_token
  const { data: entity, error } = await supabase
    .from('request_entities')
    .select('id, entity_name, tid, form_type, gross_receipts, requests(loan_number, clients(name))')
    .eq('gross_receipts->>erc_recovery_token', params.token)
    .maybeSingle();

  if (error || !entity) notFound();

  const recovery = entity.gross_receipts?.erc_recovery as ErcRecoveryData | undefined;
  if (!recovery) notFound();

  const currentStageIdx = STAGES.findIndex(s => s.key === recovery.current_stage);
  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="mb-6">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">ModernTax · ERC Refund Recovery</div>
          <h1 className="text-3xl font-bold text-gray-900 mb-1">{entity.entity_name}</h1>
          <div className="text-sm text-gray-500">EIN {entity.tid}</div>
        </div>

        {/* Headline banner */}
        <div className="rounded-r border-l-4 border-amber-400 bg-amber-50 p-5 mb-6">
          <p className="text-xs font-bold uppercase tracking-wide mb-1 text-amber-800">Refund Recovery Opportunity</p>
          <p className="text-base font-bold text-amber-900">
            {fmt(recovery.total_undelivered)} in {recovery.events.filter(e => e.status === 'undelivered').length} undelivered ERC refund checks sitting at the IRS — recoverable via Form 3911 reissue.
          </p>
        </div>

        {/* Section 1: ERC Refund Delivery Status (mirrors admin compliance page) */}
        <section className="rounded-lg shadow border border-amber-300 bg-amber-50 p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-900 mb-2 pb-2 border-b border-gray-200 flex items-center justify-between">
            <span>ERC Refund Delivery Status</span>
            <span className="text-xs font-normal px-2 py-1 rounded bg-amber-200 text-amber-900">RECOVERABLE</span>
          </h2>
          <p className="text-sm text-amber-900 font-medium mb-4">
            🚨 The IRS issued {recovery.events.length} ERC refund checks but they were returned undelivered. The funds remain credited to your IRS account and are recoverable.
          </p>
          <div className="grid grid-cols-3 gap-3 mb-4 text-sm">
            <div className="bg-white rounded border border-gray-200 p-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Total ERC issued</div>
              <div className="text-base font-bold text-gray-900 mt-1">{fmt(recovery.total_issued)}</div>
            </div>
            <div className="bg-white rounded border border-gray-200 p-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Successfully delivered</div>
              <div className="text-base font-bold text-emerald-700 mt-1">{fmt(recovery.total_delivered)}</div>
            </div>
            <div className="bg-amber-100 rounded border border-amber-300 p-3">
              <div className="text-xs uppercase tracking-wide text-gray-500">Undelivered, at IRS</div>
              <div className="text-base font-bold text-amber-900 mt-1">{fmt(recovery.total_undelivered)}</div>
            </div>
          </div>
          <div className="bg-white border border-gray-200 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-600">
                <tr>
                  <th className="text-left px-4 py-2">Period</th>
                  <th className="text-left px-4 py-2">Form</th>
                  <th className="text-left px-4 py-2">Refund issued</th>
                  <th className="text-right px-4 py-2">Amount</th>
                  <th className="text-left px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {recovery.events.map((e, i) => (
                  <tr key={i} className="border-b border-gray-100 last:border-b-0">
                    <td className="px-4 py-2.5 font-mono text-xs">{e.period_ending}</td>
                    <td className="px-4 py-2.5 text-xs">{e.form_type}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{e.issued_on}</td>
                    <td className="px-4 py-2.5 text-right font-semibold">{fmt(e.amount)}</td>
                    <td className="px-4 py-2.5">
                      {e.status === 'undelivered' ? (
                        <span className="inline-flex items-center gap-1 text-amber-900 font-medium text-xs">
                          <span className="inline-block w-2 h-2 rounded-full bg-amber-500"></span>
                          Returned to IRS
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-emerald-800 font-medium text-xs">
                          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>
                          Delivered
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-600 mt-3 italic">
            Sourced from IRS Account Transcripts — TC 846 (refund issued) paired with TC 740 (refund returned undelivered).
            Undelivered refunds remain credited to your IRS account. Recovery requires Form 3911 (Taxpayer Statement Regarding Refund) filed with a corrected mailing address, or a POA-authorized PPS reissue call.
          </p>
        </section>

        {/* Section 2: Step-by-Step Recovery Process */}
        <section className="bg-white rounded-lg shadow border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-900 mb-1 pb-2 border-b border-gray-200">
            Step-by-Step Recovery Process
          </h2>
          <p className="text-sm text-gray-600 mb-5">
            We handle the entire IRS process end-to-end. You&apos;ll see this timeline update in real time — and you&apos;ll get an email at every stage change.
          </p>
          <div className="space-y-3">
            {STAGES.map((stage, idx) => {
              const isPast = idx < currentStageIdx;
              const isCurrent = idx === currentStageIdx;
              const isFuture = idx > currentStageIdx;
              return (
                <div
                  key={stage.key}
                  className={`flex gap-4 p-4 rounded-lg border ${
                    isCurrent ? 'bg-emerald-50 border-emerald-300' :
                    isPast ? 'bg-gray-50 border-gray-200' :
                    'bg-white border-gray-100'
                  }`}
                >
                  <div className="flex-shrink-0 w-8 flex flex-col items-center">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                      isCurrent ? 'bg-emerald-500 border-emerald-500 text-white' :
                      isPast ? 'bg-emerald-100 border-emerald-300 text-emerald-700' :
                      'bg-white border-gray-300 text-gray-400'
                    }`}>
                      {isPast ? '✓' : idx + 1}
                    </div>
                    {idx < STAGES.length - 1 && (
                      <div className={`flex-1 w-px mt-2 ${isPast ? 'bg-emerald-300' : 'bg-gray-200'}`} style={{ minHeight: '20px' }} />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <div className={`font-semibold text-sm ${
                        isCurrent ? 'text-emerald-900' :
                        isPast ? 'text-gray-700' :
                        'text-gray-400'
                      }`}>
                        {stage.label}
                      </div>
                      {isCurrent && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500 text-white font-semibold uppercase tracking-wide">Current</span>
                      )}
                    </div>
                    <div className={`text-xs ${isCurrent ? 'text-emerald-800' : isPast ? 'text-gray-600' : 'text-gray-400'}`}>
                      {stage.merchantCopy}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Section 3: What we need from you (only show if before intake) */}
        {currentStageIdx <= 2 && (
          <section className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-bold text-blue-900 mb-3">What we need from you</h2>
            <ol className="space-y-2 text-sm text-blue-900 list-decimal list-inside">
              <li>
                <strong>Pay the invoice</strong> — covers our work end-to-end (recovery bundle + both check reissues).
                {recovery.invoice && (
                  <span className="ml-1">
                    <a href={recovery.invoice.pay_url} className="text-blue-600 underline hover:text-blue-700" target="_blank" rel="noreferrer">
                      Pay {fmt(recovery.invoice.amount)} →
                    </a>
                  </span>
                )}
              </li>
              <li>
                <strong>Send Matt your updated mailing address</strong> — the address the IRS has on file is what caused the returns. Use any address you can physically check (business, residence, or trusted recipient). Reply to the email you got, or text directly.
              </li>
            </ol>
            <p className="text-xs text-blue-800 mt-3 italic">
              Both done before Monday morning = we call the IRS Business &amp; Specialty Tax Line at 7 AM ET to initiate the trace. Replacement checks typically arrive in 3–6 weeks for returned checks.
            </p>
          </section>
        )}

        {/* Recent activity */}
        {recovery.stage_history && recovery.stage_history.length > 0 && (
          <section className="bg-white rounded-lg shadow border border-gray-200 p-6">
            <h2 className="text-base font-bold text-gray-900 mb-3 pb-2 border-b border-gray-200">Recent activity</h2>
            <div className="space-y-3">
              {recovery.stage_history.slice().reverse().map((h, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <div className="text-gray-400 text-xs flex-shrink-0 w-32">
                    {new Date(h.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' })}
                  </div>
                  <div className="flex-1 text-gray-700">{h.merchant_visible_note}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="mt-8 text-center text-xs text-gray-500">
          Questions? Reply to the email from <strong>matt@moderntax.io</strong> or text Matt directly.
          <br />
          This page updates in real time. Bookmark it.
        </div>
      </div>
    </div>
  );
}
