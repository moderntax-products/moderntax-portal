import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase';
import type { RequestStatus, RequestEntity } from '@/lib/types';
import Link from 'next/link';

interface Props {
  params: {
    id: string;
  };
}

const TIMELINE_STEPS: { status: RequestStatus; label: string; description: string }[] = [
  {
    status: 'submitted',
    label: 'Submitted',
    description: 'Request received and queued for processing',
  },
  {
    status: 'form_8821_sent',
    label: 'Form 8821 Sent',
    description: 'Authorization form sent to entity',
  },
  {
    status: 'form_8821_signed',
    label: 'Form 8821 Signed',
    description: 'Authorization form received and signed',
  },
  {
    status: 'irs_queue',
    label: 'IRS Queue',
    description: 'Request submitted to IRS',
  },
  {
    status: 'processing',
    label: 'Processing',
    description: 'IRS is processing the request',
  },
  {
    status: 'completed',
    label: 'Completed',
    description: 'Transcripts received and ready',
  },
];

export default async function RequestDetailPage({ params }: Props) {
  const supabase = await createServerComponentClient();

  // Check authentication
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Fetch request with entities
  const { data: request, error: requestError } = await supabase
    .from('requests')
    .select('*, request_entities(*)')
    .eq('id', params.id)
    .single();

  if (requestError || !request) {
    redirect('/');
  }

  // Verify user has access to this request (same client)
  const { data: profile } = await supabase
    .from('profiles')
    .select('client_id')
    .eq('id', user.id)
    .single();

  if (!profile || profile.client_id !== request.client_id) {
    redirect('/');
  }

  const getStatusBadgeColor = (status: RequestStatus) => {
    switch (status) {
      case 'submitted':
      case 'form_8821_sent':
        return 'bg-blue-100 text-blue-800';
      case 'form_8821_signed':
      case 'irs_queue':
        return 'bg-yellow-100 text-yellow-800';
      case 'processing':
        return 'bg-purple-100 text-purple-800';
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const formatStatus = (status: string) => {
    return status
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getTimelineStatus = (status: RequestStatus) => {
    const statusOrder: Record<RequestStatus, number> = {
      submitted: 0,
      form_8821_sent: 1,
      form_8821_signed: 2,
      irs_queue: 3,
      processing: 4,
      completed: 5,
      failed: 6,
    };
    return statusOrder[status] ?? -1;
  };

  const currentStepIndex = getTimelineStatus(request.status as RequestStatus);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="text-3xl font-bold text-mt-dark">Request Details</h1>
              <p className="text-gray-600 mt-1">Account: <code className="font-mono">{request.account_number}</code></p>
            </div>
            <Link
              href="/"
              className="text-gray-600 hover:text-gray-900 font-medium"
            >
              ← Back to Dashboard
            </Link>
          </div>
          <div className="flex items-center gap-4">
            <span className={`inline-block px-4 py-2 rounded-full text-sm font-semibold ${getStatusBadgeColor(request.status as RequestStatus)}`}>
              {formatStatus(request.status)}
            </span>
            <span className="text-sm text-gray-600">
              Submitted: {formatDate(request.created_at)}
            </span>
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
                    {/* Timeline Dot */}
                    <div className="flex flex-col items-center">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-semibold text-sm ${
                          isFailed
                            ? 'bg-red-500'
                            : isCompleted
                            ? 'bg-mt-green'
                            : isActive
                            ? 'bg-blue-500 animate-pulse'
                            : 'bg-gray-300'
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

                    {/* Timeline Content */}
                    <div className={`pb-6 ${index === TIMELINE_STEPS.length - 1 ? '' : ''}`}>
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
            <h2 className="text-xl font-bold text-mt-dark">Entities ({request.request_entities?.length || 0})</h2>

            {request.request_entities && request.request_entities.length > 0 ? (
              <div className="grid gap-6">
                {(request.request_entities as RequestEntity[]).map((entity) => (
                  <div key={entity.id} className="bg-white rounded-lg shadow p-8">
                    <div className="flex justify-between items-start mb-6">
                      <div>
                        <h3 className="text-lg font-semibold text-mt-dark">{entity.entity_name}</h3>
                        <div className="flex items-center gap-4 mt-2">
                          <div>
                            <p className="text-xs text-gray-500 uppercase tracking-wide">EIN</p>
                            <code className="text-sm font-mono text-gray-700">{entity.ein}</code>
                          </div>
                          <div>
                            <p className="text-xs text-gray-500 uppercase tracking-wide">Form Type</p>
                            <p className="text-sm text-gray-700">{entity.form_type}</p>
                          </div>
                          <div>
                            <p className="text-xs text-gray-500 uppercase tracking-wide">Tax Years</p>
                            <p className="text-sm text-gray-700">{entity.years.join(', ')}</p>
                          </div>
                        </div>
                      </div>
                      <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getStatusBadgeColor(entity.status as RequestStatus)}`}>
                        {formatStatus(entity.status)}
                      </span>
                    </div>

                    {/* Financial Data */}
                    {entity.gross_receipts && (
                      <div className="bg-gray-50 rounded-lg p-6 mb-6">
                        <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">
                          Financial Data
                        </h4>
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
                    {entity.compliance_score !== null && (
                      <div className="bg-green-50 rounded-lg p-6 mb-6 border border-green-200">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
                              Compliance Score
                            </p>
                            <p className="text-3xl font-bold text-green-600 mt-1">
                              {entity.compliance_score}%
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-gray-600 uppercase tracking-wide mb-2">Status</p>
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded-full bg-green-500"></div>
                              <p className="text-sm font-semibold text-green-700">Compliant</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Download Transcripts */}
                    {entity.transcript_urls && entity.transcript_urls.length > 0 && (
                      <div className="border-t border-gray-200 pt-6">
                        <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">
                          Transcript Downloads
                        </h4>
                        <div className="space-y-2">
                          {entity.transcript_urls.map((url, idx) => (
                            <a
                              key={idx}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
                            >
                              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                              <div className="flex-1">
                                <p className="text-sm font-medium text-blue-600">
                                  Transcript {idx + 1}
                                </p>
                                <p className="text-xs text-blue-500">{url.split('/').pop()}</p>
                              </div>
                              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                              </svg>
                            </a>
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

          {/* Notes Section */}
          {request.notes && (
            <div className="bg-white rounded-lg shadow p-8">
              <h2 className="text-lg font-bold text-mt-dark mb-4">Notes</h2>
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-gray-700 whitespace-pre-wrap">{request.notes}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
