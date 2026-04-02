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

interface Props {
  params: Promise<{ id: string }>;
}

const TIMELINE_STEPS: { status: string; label: string; description: string }[] = [
  { status: 'submitted', label: 'Submitted', description: 'Request received and queued for processing' },
  { status: '8821_sent', label: 'Form 8821 Sent', description: 'Authorization form sent to entity' },
  { status: '8821_signed', label: 'Form 8821 Signed', description: 'Authorization form received and signed' },
  { status: 'irs_queue', label: 'IRS Queue', description: 'Request submitted to IRS' },
  { status: 'processing', label: 'Processing', description: 'IRS is processing the request' },
  { status: 'completed', label: 'Completed', description: 'Transcripts received and ready' },
];

export default async function RequestDetailPage({ params }: Props) {
  const { id } = await params;
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

  // Admins can access any request; other roles must belong to the same client
  if (profile.role !== 'admin' && profile.client_id !== request.client_id) redirect('/');

  // Processors can only view their own requests
  if (profile.role === 'processor' && request.requested_by !== user.id) redirect('/');

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
    switch (m) { case 'csv': return 'CSV Upload'; case 'pdf': return 'PDF Upload'; default: return 'Manual Entry'; }
  };

  return (
    <div className="min-h-screen bg-gray-50">
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
            <Link href="/" className="text-gray-600 hover:text-gray-900 font-medium">
              &larr; Back to Dashboard
            </Link>
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
                  (request.request_entities || []).reduce((sum: number, e: any) =>
                    sum + (e.transcript_urls?.length || 0) + (e.signed_8821_url ? 1 : 0), 0)
                }
              />
            </div>

            {request.request_entities && request.request_entities.length > 0 ? (
              <div className="grid gap-6">
                {(request.request_entities as RequestEntity[]).map((entity) => (
                  <div key={entity.id} className="bg-white rounded-lg shadow p-8">
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
                        <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getStatusBadgeColor(entity.status)}`}>
                          {formatStatus(entity.status)}
                        </span>
                      </div>
                    </div>

                    {/* Processor 8821 Panel — template downloads + upload */}
                    <Processor8821Panel
                      entity={{
                        id: entity.id,
                        entity_name: entity.entity_name,
                        form_type: entity.form_type,
                        status: entity.status,
                        signed_8821_url: entity.signed_8821_url,
                        signer_email: entity.signer_email,
                      }}
                      requestId={request.id}
                    />

                    {/* Signed 8821 */}
                    {entity.signed_8821_url && (
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

                    {/* Financial Data */}
                    {entity.gross_receipts && typeof entity.gross_receipts === 'object' && (
                      <div className="bg-gray-50 rounded-lg p-6 mb-4">
                        <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Financial Data</h4>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          {Object.entries(entity.gross_receipts as Record<string, unknown>).map(([key, value]) => (
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
                    {entity.compliance_score !== null && entity.compliance_score !== undefined && (
                      <div className="bg-green-50 rounded-lg p-6 mb-4 border border-green-200">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Compliance Score</p>
                            <p className="text-3xl font-bold text-green-600 mt-1">{entity.compliance_score}%</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Transcripts */}
                    {entity.transcript_urls && entity.transcript_urls.length > 0 && (
                      <div className="border-t border-gray-200 pt-6">
                        <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Transcript Downloads</h4>
                        <div className="space-y-2">
                          {entity.transcript_urls.map((url: string, idx: number) => (
                            <TranscriptDownloadLink
                              key={idx}
                              storagePath={url}
                              label={`Transcript ${idx + 1}`}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-white rounded-lg shadow p-12 text-center">
                <p className="text-gray-500">No entities added</p>
              </div>
            )}
          </div>

          {/* Transcript Monitoring */}
          <MonitoringPanel
            requestId={request.id}
            entities={(request.request_entities || []).map((e: RequestEntity) => ({
              id: e.id,
              entity_name: e.entity_name,
              status: e.status,
              form_type: e.form_type,
              signed_8821_url: e.signed_8821_url,
            }))}
          />

          {/* Notes */}
          {request.notes && (
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
