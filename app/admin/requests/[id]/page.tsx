import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import type { RequestEntity, ExpertAssignment } from '@/lib/types';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';
import Link from 'next/link';
import { RequestStatusUpdate, EntityStatusUpdate } from '@/components/AdminRequestActions';
import { AdminExpertAssign } from '@/components/AdminExpertAssign';
import { Admin8821Upload } from '@/components/Admin8821Upload';
import { TranscriptDownloadLink } from '@/components/TranscriptDownloadLink';
import { Entity8821Info } from '@/components/Entity8821Info';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminRequestManagePage({ params }: Props) {
  const { id } = await params;
  const supabase = await createServerComponentClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  // Check admin role
  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null; error: any };

  if (!adminProfile || adminProfile.role !== 'admin') redirect('/');

  // Fetch request with entities (admin can see all)
  const { data: request, error: requestError } = await supabase
    .from('requests')
    .select('*, request_entities(*), clients(name, slug)')
    .eq('id', id)
    .single() as { data: any; error: any };

  if (requestError || !request) redirect('/admin');

  // Fetch expert assignments for all entities in this request
  const entityIds = (request.request_entities || []).map((e: any) => e.id);
  let assignmentsByEntity: Record<string, (ExpertAssignment & { expert_profile?: { full_name: string | null; email: string } })[]> = {};
  if (entityIds.length > 0) {
    const { data: assignments } = await supabase
      .from('expert_assignments')
      .select('*, expert_profile:profiles!expert_assignments_expert_id_fkey(full_name, email)')
      .in('entity_id', entityIds)
      .order('assigned_at', { ascending: false }) as { data: any[] | null; error: any };

    if (assignments) {
      assignments.forEach((a: any) => {
        if (!assignmentsByEntity[a.entity_id]) assignmentsByEntity[a.entity_id] = [];
        assignmentsByEntity[a.entity_id].push(a);
      });
    }
  }

  // Fetch the requesting user profile
  const { data: requestedByProfile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', request.requested_by)
    .single() as { data: { full_name: string | null; email: string } | null; error: any };

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

  const formatStatus = (status: string) =>
    status.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });

  const intakeLabel = (m: string) => {
    switch (m) { case 'csv': return 'CSV Upload'; case 'pdf': return 'PDF Upload'; case 'api': return 'API'; default: return 'Manual Entry'; }
  };

  const isEmployment = request.product_type === 'employment';

  return (
    <div className="min-h-screen bg-gray-50">
      {/* SOC 2 Data Classification Banner */}
      <div className={`border-b px-4 py-2 text-center text-xs font-semibold tracking-wide ${getClassificationColor('restricted')}`}>
        🔒 {getClassificationLabel('restricted')}
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex justify-between items-start mb-4">
            <div className="flex items-center gap-4">
              <Link href="/admin" className="text-gray-400 hover:text-gray-600 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </Link>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-bold text-mt-dark">Manage Request</h1>
                  <span className="px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">Admin</span>
                  {isEmployment && (
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-700">Employment</span>
                  )}
                </div>
                <p className="text-gray-600 mt-1">
                  Loan #: <code className="font-mono">{request.loan_number}</code>
                  <span className="mx-2 text-gray-300">|</span>
                  <span className="text-gray-500">{request.clients?.name || 'Unknown Client'}</span>
                  <span className="mx-2 text-gray-300">|</span>
                  <span className="text-gray-500">{intakeLabel(request.intake_method)}</span>
                </p>
              </div>
            </div>
            <Link
              href={`/request/${request.id}`}
              className="text-sm text-gray-500 hover:text-gray-700 border border-gray-300 rounded-lg px-3 py-1.5"
            >
              Client View →
            </Link>
          </div>
          <div className="flex items-center gap-4">
            <span className={`inline-block px-4 py-2 rounded-full text-sm font-semibold ${getStatusBadgeColor(request.status)}`}>
              {formatStatus(request.status)}
            </span>
            <span className="text-sm text-gray-600">
              Submitted: {formatDate(request.created_at)}
            </span>
            {requestedByProfile && (
              <span className="text-sm text-gray-500">
                by {requestedByProfile.full_name || requestedByProfile.email}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">

        {/* Request Status & Notes Management */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-mt-dark mb-4">Update Request</h2>
          <RequestStatusUpdate
            requestId={request.id}
            currentStatus={request.status}
            currentNotes={request.notes}
          />
        </div>

        {/* Request Info */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-mt-dark mb-4">Request Details</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-gray-500 mb-1">Request ID</p>
              <p className="font-mono text-xs text-gray-700">{request.id}</p>
            </div>
            <div>
              <p className="text-gray-500 mb-1">Loan Number</p>
              <p className="font-medium text-gray-900">{request.loan_number}</p>
            </div>
            <div>
              <p className="text-gray-500 mb-1">Intake Method</p>
              <p className="font-medium text-gray-900">{intakeLabel(request.intake_method)}</p>
            </div>
            <div>
              <p className="text-gray-500 mb-1">Entities</p>
              <p className="font-medium text-gray-900">{request.request_entities?.length || 0}</p>
            </div>
            <div>
              <p className="text-gray-500 mb-1">Submitted</p>
              <p className="font-medium text-gray-900">{formatDate(request.created_at)}</p>
            </div>
            <div>
              <p className="text-gray-500 mb-1">Last Updated</p>
              <p className="font-medium text-gray-900">{formatDate(request.updated_at)}</p>
            </div>
            {request.completed_at && (
              <div>
                <p className="text-gray-500 mb-1">Completed</p>
                <p className="font-medium text-green-600">{formatDate(request.completed_at)}</p>
              </div>
            )}
            {request.product_type && request.product_type !== 'transcript' && (
              <div>
                <p className="text-gray-500 mb-1">Product Type</p>
                <p className="font-medium text-indigo-600 capitalize">{request.product_type}</p>
              </div>
            )}
            {request.external_request_token && (
              <div>
                <p className="text-gray-500 mb-1">External Token</p>
                <p className="font-mono text-xs text-gray-700">{request.external_request_token}</p>
              </div>
            )}
            {request.batch_id && (
              <div>
                <p className="text-gray-500 mb-1">Batch ID</p>
                <p className="font-mono text-xs text-gray-700">{request.batch_id}</p>
              </div>
            )}
          </div>
        </div>

        {/* Entity Management */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-mt-dark">
            Manage Entities ({request.request_entities?.length || 0})
          </h2>

          {request.request_entities && request.request_entities.length > 0 ? (
            <div className="space-y-4">
              {(request.request_entities as RequestEntity[]).map((entity) => (
                <div key={entity.id} className="bg-white rounded-lg shadow p-6">
                  {/* Entity info header */}
                  <div className="flex flex-wrap items-center gap-4 mb-4 pb-4 border-b border-gray-100">
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wide">Name</p>
                      <p className="text-sm font-semibold text-gray-900">{entity.entity_name}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wide">{entity.tid_kind}</p>
                      <code className="text-sm font-mono text-gray-700">{entity.tid}</code>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wide">Form</p>
                      <p className="text-sm text-gray-700">{entity.form_type === 'W2_INCOME' ? 'W-2 / Wage & Income' : entity.form_type}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wide">Years</p>
                      <p className="text-sm text-gray-700">{Array.isArray(entity.years) ? entity.years.join(', ') : entity.years || '—'}</p>
                    </div>
                    {entity.signer_first_name && (
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide">Signer</p>
                        <p className="text-sm text-gray-700">{entity.signer_first_name} {entity.signer_last_name}</p>
                      </div>
                    )}
                    {entity.signer_email && (
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide">Signer Email</p>
                        <p className="text-sm text-blue-600">{entity.signer_email}</p>
                      </div>
                    )}
                    <div className="ml-auto">
                      <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getStatusBadgeColor(entity.status)}`}>
                        {formatStatus(entity.status)}
                      </span>
                    </div>
                  </div>

                  {/* 8821 Reference Card — full PII for admin to populate 8821 */}
                  <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-4">
                    <h4 className="text-sm font-semibold text-amber-800 mb-3">8821 Form Information</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide">Taxpayer Name</p>
                        <p className="font-medium text-gray-900">{entity.entity_name}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide">Taxpayer {entity.tid_kind}</p>
                        <p className="font-mono font-medium text-gray-900">{entity.tid}</p>
                      </div>
                      {(entity.address || entity.city || entity.state || entity.zip_code) && (
                        <div className="sm:col-span-2">
                          <p className="text-xs text-gray-500 uppercase tracking-wide">Taxpayer Address</p>
                          <p className="font-medium text-gray-900">
                            {[entity.address, entity.city, entity.state, entity.zip_code].filter(Boolean).join(', ')}
                          </p>
                        </div>
                      )}
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide">Tax Form Number</p>
                        <p className="font-medium text-gray-900">
                          {entity.form_type === 'W2_INCOME' ? 'W2, 1040, Wage and Income' : entity.form_type}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide">Year(s) or Period(s)</p>
                        <p className="font-medium text-gray-900">{Array.isArray(entity.years) ? entity.years.join(', ') : entity.years || '—'}</p>
                      </div>
                      {(entity.signer_first_name || entity.signer_email) && (
                        <div className="sm:col-span-2 pt-2 mt-2 border-t border-amber-200">
                          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Signer / Designee</p>
                          <div className="flex flex-wrap gap-4">
                            {entity.signer_first_name && (
                              <p className="font-medium text-gray-900">{entity.signer_first_name} {entity.signer_last_name}</p>
                            )}
                            {entity.signer_email && (
                              <p className="font-medium text-blue-700">{entity.signer_email}</p>
                            )}
                          </div>
                        </div>
                      )}
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide">Type of Tax Information</p>
                        <p className="font-medium text-gray-900">Income</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide">Specific Tax Matters</p>
                        <p className="font-medium text-gray-900">Federal Tax</p>
                      </div>
                    </div>
                  </div>

                  {/* Entity management controls */}
                  <EntityStatusUpdate
                    entityId={entity.id}
                    entityName={entity.entity_name}
                    currentStatus={entity.status}
                    currentTranscriptUrls={entity.transcript_urls}
                    currentComplianceScore={entity.compliance_score}
                  />

                  {/* Uploaded Transcripts */}
                  {entity.transcript_urls && entity.transcript_urls.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-gray-100">
                      <h4 className="text-sm font-semibold text-gray-700 mb-3">Uploaded Transcripts ({entity.transcript_urls.length})</h4>
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

                  {/* Employment Data Card (for completed employment entities) */}
                  {entity.form_type === 'W2_INCOME' && entity.employment_data && (
                    <div className="mt-4 pt-4 border-t border-gray-100">
                      <h4 className="text-sm font-semibold text-indigo-700 mb-3">Employment Verification Result</h4>
                      <div className="bg-indigo-50 rounded-lg p-4 text-sm space-y-3">
                        {(() => {
                          const empData = entity.employment_data as any;
                          return (
                            <>
                              {empData.taxpayer && (
                                <div className="flex gap-6">
                                  <div><span className="text-gray-500">Name:</span> <span className="font-medium">{empData.taxpayer.name}</span></div>
                                  <div><span className="text-gray-500">SSN:</span> <span className="font-mono">***-**-{empData.taxpayer.ssn_last_four}</span></div>
                                </div>
                              )}
                              {empData.summary && (
                                <div className="flex gap-6">
                                  <div><span className="text-gray-500">Employers:</span> <span className="font-medium">{empData.summary.total_employers}</span></div>
                                  {empData.summary.total_w2_income !== undefined && (
                                    <div><span className="text-gray-500">Total W-2 Income:</span> <span className="font-medium">${empData.summary.total_w2_income?.toLocaleString()}</span></div>
                                  )}
                                  {empData.summary.years_covered && (
                                    <div><span className="text-gray-500">Years:</span> <span className="font-medium">{empData.summary.years_covered.join(', ')}</span></div>
                                  )}
                                </div>
                              )}
                              {empData.employment_by_year && Object.entries(empData.employment_by_year).map(([year, yearData]: [string, any]) => (
                                <div key={year} className="border-t border-indigo-200 pt-2">
                                  <p className="font-semibold text-indigo-800 mb-1">{year}</p>
                                  {yearData.employers?.map((emp: any, i: number) => (
                                    <div key={i} className="ml-4 flex gap-4 text-xs text-gray-700">
                                      <span className="font-medium">{emp.name}</span>
                                      <span>EIN: {emp.ein}</span>
                                      <span>${emp.gross_earnings?.toLocaleString()}</span>
                                      {emp.is_peo && <span className="text-amber-600 font-semibold">PEO</span>}
                                    </div>
                                  ))}
                                </div>
                              ))}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}

                  {/* 8821 Info Copy Card (for filling out 8821 forms) */}
                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <Entity8821Info entity={entity} />
                  </div>

                  {/* 8821 Upload & Expert Assignment Section */}
                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <h4 className="text-sm font-semibold text-gray-700 mb-3">8821 & Expert Assignment</h4>

                    {/* 8821 Upload */}
                    <div className="mb-4">
                      <Admin8821Upload
                        entityId={entity.id}
                        entityName={entity.entity_name}
                        currentUrl={entity.signed_8821_url}
                      />
                    </div>

                    {/* Show current/past assignments */}
                    {assignmentsByEntity[entity.id] && assignmentsByEntity[entity.id].length > 0 && (
                      <div className="mb-3 space-y-2">
                        {assignmentsByEntity[entity.id].map((a) => (
                          <div key={a.id} className={`flex items-center justify-between text-sm px-3 py-2 rounded ${
                            a.status === 'completed' ? 'bg-green-50' :
                            a.status === 'failed' ? 'bg-red-50' :
                            a.status === 'reassigned' ? 'bg-gray-50' :
                            'bg-blue-50'
                          }`}>
                            <div>
                              <span className="font-medium">{a.expert_profile?.full_name || a.expert_profile?.email || 'Unknown'}</span>
                              <span className="mx-2 text-gray-400">|</span>
                              <span className={`text-xs font-semibold ${
                                a.status === 'completed' ? 'text-green-700' :
                                a.status === 'failed' ? 'text-red-700' :
                                a.status === 'reassigned' ? 'text-gray-500' :
                                'text-blue-700'
                              }`}>
                                {a.status.charAt(0).toUpperCase() + a.status.slice(1).replace('_', ' ')}
                              </span>
                              {a.sla_met !== null && (
                                <span className={`ml-2 text-xs ${a.sla_met ? 'text-green-600' : 'text-red-600'}`}>
                                  {a.sla_met ? 'SLA Met' : 'SLA Missed'}
                                </span>
                              )}
                            </div>
                            <span className="text-xs text-gray-500">
                              {new Date(a.assigned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        ))}
                        {assignmentsByEntity[entity.id][0]?.miss_reason && (
                          <p className="text-xs text-red-600 px-3">
                            Issue: {assignmentsByEntity[entity.id][0].miss_reason}
                            {assignmentsByEntity[entity.id][0].expert_notes && ` — ${assignmentsByEntity[entity.id][0].expert_notes}`}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Require signed 8821 before assigning to expert */}
                    {entity.signed_8821_url ? (
                      <AdminExpertAssign
                        entityId={entity.id}
                        entityName={entity.entity_name}
                        currentAssignment={(() => {
                          const active = assignmentsByEntity[entity.id]?.find((a) =>
                            ['assigned', 'in_progress'].includes(a.status)
                          );
                          if (!active) return undefined;
                          return {
                            id: active.id,
                            expert_id: active.expert_id,
                            status: active.status,
                            sla_deadline: active.sla_deadline,
                            expert_notes: active.expert_notes,
                            miss_reason: active.miss_reason,
                            profiles: active.expert_profile || undefined,
                          };
                        })()}
                      />
                    ) : (
                      <p className="text-xs text-amber-600">
                        Upload a signed 8821 above before assigning to an expert
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow p-12 text-center">
              <p className="text-gray-500">No entities in this request</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
