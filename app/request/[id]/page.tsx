import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import type { RequestEntity } from '@/lib/types';
import { maskTid } from '@/lib/mask';
import Link from 'next/link';
import { TranscriptDownloadLink } from '@/components/TranscriptDownloadLink';
import { DownloadAllTranscripts } from '@/components/DownloadAllTranscripts';
import { EditEntityButton } from '@/components/EditEntityButton';
import { MonitoringPanel } from '@/components/MonitoringPanel';
import { Processor8821Panel } from '@/components/Processor8821Panel';
import { SupportTicketPanel } from '@/components/SupportTicketPanel';
import { FilingIntakeForm } from '@/components/FilingIntakeForm';
import { FilingFeePayment } from '@/components/FilingFeePayment';
import { DirectResolutionRoadmap } from '@/components/DirectResolutionRoadmap';
import { CancelRequestButton } from '@/components/CancelRequestButton';
import { LogoutButton } from '@/components/LogoutButton';
import { PrePortalDeliveryBanner } from '@/components/PrePortalDeliveryBanner';
import { filterRequestedTranscripts, formatInternalPullsNote } from '@/lib/transcript-filter';

interface Props {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ gen8821?: string }>;
}

const TIMELINE_STEPS: { status: string; label: string; description: string }[] = [
  { status: 'submitted', label: 'Submitted', description: 'Request received and queued for processing' },
  { status: '8821_sent', label: 'Form 8821 Sent', description: 'Authorization form sent to entity' },
  { status: '8821_signed', label: 'Form 8821 Signed', description: 'Authorization form received and signed' },
  { status: 'irs_queue', label: 'IRS Queue', description: 'Request submitted to IRS' },
  { status: 'processing', label: 'Processing', description: 'IRS is processing the request' },
  { status: 'completed', label: 'Completed', description: 'Transcripts received and ready' },
];

export default async function RequestDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const supabase = await createServerComponentClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: request, error: requestError } = await supabase
    .from('requests')
    .select('*, request_entities(*)')
    .eq('id', id)
    .single() as { data: any; error: any };

  if (requestError || !request) redirect('/');

  const { data: profile } = await supabase
    .from('profiles')
    .select('client_id, role')
    .eq('id', user.id)
    .single() as { data: { client_id: string | null; role: string } | null; error: any };

  if (!profile) redirect('/');

  // Admins can access any request; other roles must belong to the same client.
  // Cross-team visibility (B3.1 MVP, Apr 27 Robert/Enterprise Bank): every
  // team member on the same client can VIEW any request from their org so
  // they can answer borrower questions / pick up co-worker work. Submission
  // ownership is still enforced for edit/cancel actions via /api/expert/cancel-request.
  if (profile.role !== 'admin' && profile.client_id !== request.client_id) redirect('/');

  // Per-client flag: hide monitoring UI surfaces from processor experience
  // when client.disable_monitoring = true (Centerstone post-2026-05-27).
  // Their re-pulls go through a fresh full-price new request instead.
  const { data: clientCfg } = await supabase
    .from('clients')
    .select('disable_monitoring, credit_balance')
    .eq('id', request.client_id)
    .single() as { data: { disable_monitoring: boolean | null; credit_balance: number | null } | null };
  const hideMonitoringUi = !!clientCfg?.disable_monitoring;
  const accountCredit = Number(clientCfg?.credit_balance) || 0;

  // ModernTax Direct taxpayer: a limited, client-facing view. They see status,
  // the resolution roadmap, the filing intake, the filing-fee payment, and the
  // support chat — NOTHING internal. So we hide every operator/processor panel
  // (entity edit, 8821/2848 generator, signed-8821 download, raw Financial Data
  // dump, transcript-monitoring upsell) and the internal Notes (which carry our
  // master CAF + resolution strategy). They also can't reach the dashboard, so
  // the header gives them a Sign Out instead of a looping "Back to Dashboard".
  const isDirectUser = profile.role === 'direct_user';

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'submitted': case '8821_sent': return 'bg-blue-100 text-blue-800';
      case '8821_signed': case 'irs_queue': return 'bg-yellow-100 text-yellow-800';
      case 'processing': return 'bg-purple-100 text-purple-800';
      case 'completed': return 'bg-green-100 text-green-800';
      case 'failed': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const formatStatus = (status: string) => {
    const labels: Record<string, string> = {
      irs_queue: 'IRS Queue',
      '8821_sent': '8821 Sent',
      '8821_signed': '8821 Signed',
    };
    if (labels[status]) return labels[status];
    return status.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  };

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });

  const statusOrder: Record<string, number> = {
    submitted: 0, '8821_sent': 1, '8821_signed': 2, irs_queue: 3, processing: 4, completed: 5, failed: 6,
  };
  const currentStepIndex = statusOrder[request.status] ?? -1;

  const intakeLabel = (m: string) => {
    switch (m) {
      case 'csv': return 'CSV Upload';
      case 'pdf': return 'PDF Upload';
      case 'reorder': return 'Reorder from history';
      default: return 'Manual Entry';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Post-submit confirmation: populated 8821s were auto-generated +
          emailed to the ordering party (manual-entry flow redirects here
          with ?gen8821=1). */}
      {sp.gen8821 === '1' && (
        <div className="bg-green-50 border-b border-green-200">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 text-sm text-green-900">
            <span className="font-semibold">📧 Signature-ready 8821s are on their way to your inbox.</span>{' '}
            We generated a populated Form 8821 for each entity on this request and emailed the PDFs to you.
            Send them to your client to sign, then upload the signed copies here. Each form is also available
            for download on its entity below.
          </div>
        </div>
      )}
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="text-3xl font-bold text-mt-dark">Request Details</h1>
              <p className="text-gray-600 mt-1">
                Loan #: <code className="font-mono">{request.loan_number}</code>
                <span className="ml-3 inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                  {intakeLabel(request.intake_method)}
                </span>
              </p>
            </div>
            <div className="flex items-center gap-3">
              {isDirectUser ? (
                // Direct taxpayer: no dashboard to go back to (they'd just be
                // redirected here), and no cancel — just a way to sign out.
                <LogoutButton />
              ) : (
                <>
                  <CancelRequestButton
                    requestId={request.id}
                    loanNumber={request.loan_number}
                    status={request.status}
                    isAdmin={profile.role === 'admin'}
                  />
                  <Link href="/" className="text-gray-600 hover:text-gray-900 font-medium">
                    &larr; Back to Dashboard
                  </Link>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className={`inline-block px-4 py-2 rounded-full text-sm font-semibold ${getStatusBadgeColor(request.status)}`}>
              {formatStatus(request.status)}
            </span>
            <span className="text-sm text-gray-600">Submitted: {formatDate(request.created_at)}</span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <PrePortalDeliveryBanner
          isPrePortal={!!request.loan_number?.startsWith('HIST-')}
          loanNumber={request.loan_number}
        />
        <div className="space-y-12">
          {/* Timeline */}
          <div className="bg-white rounded-lg shadow p-8">
            <h2 className="text-xl font-bold text-mt-dark mb-8">Request Timeline</h2>
            <div className="space-y-6">
              {TIMELINE_STEPS.map((step, index) => {
                const isCompleted = index <= currentStepIndex && request.status !== 'failed';
                const isActive = index === currentStepIndex;
                const isFailed = request.status === 'failed' && index === currentStepIndex;

                return (
                  <div key={step.status} className="flex gap-6">
                    <div className="flex flex-col items-center">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-semibold text-sm ${
                          isFailed ? 'bg-red-500' : isCompleted ? 'bg-mt-green' : isActive ? 'bg-blue-500 animate-pulse' : 'bg-gray-300'
                        }`}
                      >
                        {isCompleted && !isFailed ? (
                          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        ) : (
                          index + 1
                        )}
                      </div>
                      {index < TIMELINE_STEPS.length - 1 && (
                        <div className={`w-1 h-12 ${isCompleted && !isFailed ? 'bg-mt-green' : 'bg-gray-300'}`} />
                      )}
                    </div>
                    <div className="pb-6">
                      <h3 className={`text-lg font-semibold ${isFailed ? 'text-red-600' : isCompleted ? 'text-mt-green' : isActive ? 'text-blue-600' : 'text-gray-400'}`}>
                        {step.label}
                      </h3>
                      <p className="text-gray-600 text-sm mt-1">{step.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Entities */}
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-mt-dark">
                Entities ({request.request_entities?.length || 0})
              </h2>
              <DownloadAllTranscripts
                requestId={request.id}
                loanNumber={request.loan_number}
                totalFiles={
                  // Count only the transcripts the processor actually
                  // requested (filtered by form + years), not internal-
                  // discovery bonus pulls. Keeps the header count matching
                  // what shows in the per-entity Downloads list below.
                  (request.request_entities || []).reduce((sum: number, e: any) => {
                    // Filing-Compliance Report orders don't expose transcripts.
                    if ((e.gross_receipts as any)?.product_type === 'filing_compliance') return sum;
                    const allUrls = [
                      ...(e.transcript_urls || []),
                      ...(e.transcript_html_urls || []),
                    ];
                    const filtered = filterRequestedTranscripts(
                      allUrls, e.form_type, e.years,
                    );
                    // De-duplicate (same URL may appear in both arrays)
                    const unique = new Set(filtered.requested);
                    return sum + unique.size + (e.signed_8821_url ? 1 : 0);
                  }, 0)
                }
              />
            </div>

            {request.request_entities && request.request_entities.length > 0 ? (
              <div className="grid gap-6">
                {(request.request_entities as RequestEntity[]).map((entity) => (
                  <div key={entity.id}>
                    {(entity.gross_receipts as any)?.resolution && (
                      <DirectResolutionRoadmap resolution={(entity.gross_receipts as any).resolution} />
                    )}
                    <div className="bg-white rounded-lg shadow p-8">
                    <div className="flex justify-between items-start mb-6">
                      <div>
                        <h3 className="text-lg font-semibold text-mt-dark">{entity.entity_name}</h3>
                        <div className="flex flex-wrap items-center gap-4 mt-2">
                          <div>
                            <p className="text-xs text-gray-500 uppercase tracking-wide">{entity.tid_kind}</p>
                            <code className="text-sm font-mono text-gray-700">{maskTid(entity.tid, entity.tid_kind)}</code>
                          </div>
                          <div>
                            <p className="text-xs text-gray-500 uppercase tracking-wide">Form</p>
                            <p className="text-sm text-gray-700">{entity.form_type}</p>
                          </div>
                          <div>
                            <p className="text-xs text-gray-500 uppercase tracking-wide">Years</p>
                            <p className="text-sm text-gray-700">{Array.isArray(entity.years) ? entity.years.join(', ') : entity.years || '—'}</p>
                          </div>
                          {entity.signer_first_name && (
                            <div>
                              <p className="text-xs text-gray-500 uppercase tracking-wide">Signer</p>
                              <p className="text-sm text-gray-700">
                                {entity.signer_first_name} {entity.signer_last_name}
                              </p>
                            </div>
                          )}
                          {entity.signer_email && (
                            <div>
                              <p className="text-xs text-gray-500 uppercase tracking-wide">Signer Email</p>
                              <p className="text-sm text-blue-600">{entity.signer_email}</p>
                            </div>
                          )}
                        </div>
                        {/* Address */}
                        {entity.address && (
                          <p className="text-sm text-gray-500 mt-2">
                            {entity.address}, {entity.city}, {entity.state} {entity.zip_code}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        {!isDirectUser && (
                          <EditEntityButton
                            entityId={entity.id}
                            entityName={entity.entity_name}
                            currentSignerEmail={entity.signer_email}
                            currentAddress={entity.address}
                            currentCity={entity.city}
                            currentState={entity.state}
                            currentZipCode={entity.zip_code}
                            status={entity.status}
                          />
                        )}
                        <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getStatusBadgeColor(entity.status)}`}>
                          {formatStatus(entity.status)}
                        </span>
                      </div>
                    </div>

                    {/* ModernTax Direct — taxpayer filing intake + authorization */}
                    {(() => {
                      const fs = (entity.gross_receipts as any)?.filing_seed;
                      if (!fs?.years?.length) return null;
                      const fi = (entity.gross_receipts as any)?.filing_intake || {};
                      return (
                        <FilingIntakeForm
                          entityId={entity.id}
                          seed={{
                            name: entity.entity_name,
                            email: entity.signer_email || '',
                            ssnMask: maskTid(entity.tid, entity.tid_kind),
                            address: [entity.address, entity.city, entity.state, entity.zip_code].filter(Boolean).join(', '),
                            years: fs.years,
                            states: fs.states || [],
                          }}
                          saved={fi.answers || null}
                          authorized={!!fi.authorized}
                          authorizedAt={fi.authorized_at || null}
                        />
                      );
                    })()}

                    {/* Processor 8821 Panel — template downloads + upload */}
                    {!isDirectUser && (
                      <Processor8821Panel
                        entity={{
                          id: entity.id,
                          entity_name: entity.entity_name,
                          form_type: entity.form_type,
                          status: entity.status,
                          signed_8821_url: entity.signed_8821_url,
                          signer_email: entity.signer_email,
                          years: entity.years,
                          tid_kind: entity.tid_kind,
                        }}
                        requestId={request.id}
                      />
                    )}

                    {/* Signed 8821 */}
                    {!isDirectUser && entity.signed_8821_url && (
                      <div className="mb-4">
                        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3 mb-2">
                          <svg className="w-5 h-5 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          <span className="text-sm text-green-700 font-medium">Signed 8821 on file</span>
                          {entity.signature_id && (
                            <span className="text-xs text-green-600 font-mono ml-auto">
                              Sig: {entity.signature_id}
                            </span>
                          )}
                        </div>
                        <TranscriptDownloadLink
                          storagePath={entity.signed_8821_url}
                          label="Download Signed 8821"
                        />
                      </div>
                    )}

                    {/* Entity Transcript Order */}
                    {!isDirectUser && entity.gross_receipts && (entity.gross_receipts as any)?.entity_transcript_order?.requested && (
                      <div className={`rounded-lg p-4 mb-4 border ${(entity.gross_receipts as any)?.entity_transcript?.filingRequirements ? 'bg-green-50 border-green-200' : 'bg-blue-50 border-blue-200'}`}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">{(entity.gross_receipts as any)?.entity_transcript?.filingRequirements ? '✅' : '📋'}</span>
                            <div>
                              <p className="text-sm font-semibold text-mt-dark">Entity Transcript {(entity.gross_receipts as any)?.entity_transcript?.filingRequirements ? 'Complete' : 'Ordered'}</p>
                              {(entity.gross_receipts as any)?.entity_transcript?.filingRequirements && (
                                <p className="text-xs text-gray-600 mt-0.5">
                                  Filing Requirements: <span className="font-mono font-medium">{(entity.gross_receipts as any).entity_transcript.filingRequirements}</span>
                                </p>
                              )}
                              {(entity.gross_receipts as any)?.entity_transcript?.naicsCode && (
                                <p className="text-xs text-gray-500">NAICS: {(entity.gross_receipts as any).entity_transcript.naicsCode}</p>
                              )}
                            </div>
                          </div>
                          <span className="text-sm font-bold text-blue-600">$19.99</span>
                        </div>
                      </div>
                    )}

                    {/* Financial Data — internal raw gross_receipts dump; never shown to the taxpayer */}
                    {!isDirectUser && entity.gross_receipts && typeof entity.gross_receipts === 'object' && !(entity.gross_receipts as any)?.entity_transcript_order && (
                      <div className="bg-gray-50 rounded-lg p-6 mb-4">
                        <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Financial Data</h4>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          {Object.entries(entity.gross_receipts as Record<string, unknown>)
                            .filter(([key]) => !['entity_transcript_order', 'entity_transcript'].includes(key))
                            .map(([key, value]) => (
                            <div key={key}>
                              <p className="text-xs text-gray-600 uppercase tracking-wide">{key}</p>
                              <p className="text-lg font-semibold text-mt-dark">
                                {typeof value === 'number' ? `$${value.toLocaleString()}` : String(value)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Compliance Score */}
                    {!isDirectUser && entity.compliance_score !== null && entity.compliance_score !== undefined && (
                      <div className="bg-green-50 rounded-lg p-6 mb-4 border border-green-200">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Compliance Score</p>
                            <p className="text-3xl font-bold text-green-600 mt-1">{entity.compliance_score}%</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Transcripts — processor view filters to ONLY what was
                        requested (form_type + years on the entity row). Bonus
                        pulls (e.g., 941 ERC discovery sweep on a 1065 entity)
                        stay on the entity record but live in the admin view
                        only. The small note below tells the processor the
                        team did extra work without revealing the files. */}
                    {(() => {
                      // Filing-Compliance Report orders deliver the REPORT, not
                      // the raw IRS transcripts. Show the report links and hide
                      // the underlying transcript downloads entirely.
                      const isFilingCompliance = (entity.gross_receipts as any)?.product_type === 'filing_compliance';
                      if (isFilingCompliance) {
                        if (entity.status !== 'completed') return null;
                        return (
                          <div className="border-t border-gray-200 pt-6">
                            <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Tax Compliance Report</h4>
                            <div className="flex flex-wrap gap-2">
                              <a
                                href={`/admin/filing-compliance-report/${entity.id}`}
                                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-mt-green text-white hover:bg-opacity-90"
                              >
                                View Tax Compliance Report →
                              </a>
                              <a
                                href={`/api/admin/filing-compliance-report-pdf?entityId=${entity.id}`}
                                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                              >
                                ↓ Download PDF
                              </a>
                            </div>
                            <p className="mt-2.5 text-xs text-gray-500">
                              This order delivers the Filing-Compliance Report (civil-penalty + filed/unfiled status). The underlying IRS transcripts are not included with this product.
                            </p>
                          </div>
                        );
                      }
                      const allUrls = [
                        ...(entity.transcript_urls || []),
                        ...(entity.transcript_html_urls || []),
                      ];
                      const filtered = filterRequestedTranscripts(
                        allUrls,
                        entity.form_type as string | null,
                        entity.years as string[] | null,
                      );
                      const internalNote = formatInternalPullsNote(filtered.internalSummary);
                      if (filtered.requested.length === 0 && !internalNote) return null;
                      // De-duplicate while preserving order (a URL may appear in both arrays).
                      const dedup: string[] = [];
                      const seen = new Set<string>();
                      for (const u of filtered.requested) {
                        if (!seen.has(u)) { seen.add(u); dedup.push(u); }
                      }
                      return (
                        <div className="border-t border-gray-200 pt-6">
                          <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">
                            Transcript Downloads
                            <span className="ml-2 text-xs font-normal text-gray-500 normal-case tracking-normal">
                              {dedup.length} file{dedup.length === 1 ? '' : 's'} matching your request
                              ({entity.form_type} for {(entity.years || []).join(', ')})
                            </span>
                          </h4>
                          <div className="space-y-2">
                            {dedup.map((url: string, idx: number) => {
                              const ext = url.endsWith('.html') ? 'HTML' : 'PDF';
                              return (
                                <div key={idx} className="flex items-center gap-2">
                                  <TranscriptDownloadLink
                                    storagePath={url}
                                    label={`Transcript ${idx + 1}`}
                                  />
                                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${ext === 'HTML' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'}`}>
                                    {ext}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                          {!isDirectUser && internalNote && (
                            <p className="mt-4 text-xs text-gray-500 italic border-t border-gray-100 pt-3">
                              {internalNote}
                            </p>
                          )}
                        </div>
                      );
                    })()}

                    {/* Back-year filing fee — shown after the returns are completed */}
                    {(() => {
                      const f = (entity.gross_receipts as any)?.filing;
                      const completed = entity.status === 'completed' || request.status === 'completed';
                      if (!f?.years_filed || !completed) return null;
                      return (
                        <FilingFeePayment
                          entityId={entity.id}
                          entityName={entity.entity_name}
                          yearsFiled={Number(f.years_filed)}
                          feePerYear={Number(f.fee_per_year) || 50}
                          creditApplied={accountCredit}
                          paid={!!f.fee_paid}
                        />
                      );
                    })()}

                    {/* Customer-service channel — processor ↔ ModernTax Support */}
                    <SupportTicketPanel entityId={entity.id} entityName={entity.entity_name} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-white rounded-lg shadow p-12 text-center">
                <p className="text-gray-500">No entities added</p>
              </div>
            )}
          </div>

          {/* Transcript Monitoring — hidden for clients with
              disable_monitoring=true (Centerstone-style flat-rate
              contracts where re-pulls go through full new requests). */}
          {!hideMonitoringUi && !isDirectUser && <MonitoringPanel
            requestId={request.id}
            entities={(request.request_entities || []).map((e: RequestEntity) => ({
              id: e.id,
              entity_name: e.entity_name,
              status: e.status,
              form_type: e.form_type,
              signed_8821_url: e.signed_8821_url,
            }))}
          />}

          {/* Notes — internal (carries master CAF + resolution strategy); never shown to the taxpayer */}
          {!isDirectUser && request.notes && (
            <div className="bg-white rounded-lg shadow p-8">
              <h2 className="text-lg font-bold text-mt-dark mb-4">Notes</h2>
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-gray-700 whitespace-pre-wrap">{request.notes}</p>
              </div>
            </div>
          )}

          {/* Data Retention & Compliance Notice */}
          <div className="bg-gray-100 rounded-lg border border-gray-200 p-6">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-gray-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-1">Data Retention & Security Notice</h4>
                <p className="text-xs text-gray-500 leading-relaxed">
                  This request contains IRS tax data protected under ModernTax&apos;s SOC 2 security controls.
                  Tax IDs are masked for display. All data is encrypted in transit (TLS 1.2+) and at rest (AES-256).
                  Data is retained per our retention policy and securely deleted upon request or after the retention period.
                  Access to this data is logged and audited. Contact{' '}
                  <a href="mailto:support@moderntax.io" className="text-mt-green hover:underline">support@moderntax.io</a>{' '}
                  for data deletion requests.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
