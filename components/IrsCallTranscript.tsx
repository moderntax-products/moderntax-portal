'use client';

import { useState, useEffect } from 'react';

interface TranscriptEntry {
  role: string;
  text: string;
  timestamp: number;
}

interface CallEntity {
  id: string;
  taxpayer_name: string;
  form_type: string;
  tax_years: string[];
  outcome: string | null;
  outcome_notes: string | null;
}

interface CallSessionData {
  id: string;
  status: string;
  call_summary: string | null;
  transcript_json: TranscriptEntry[] | null;
  concatenated_transcript: string | null;
  recording_url: string | null;
  recording_storage_path: string | null;
  duration_seconds: number | null;
  hold_duration_seconds: number | null;
  estimated_cost: number | null;
  irs_agent_name: string | null;
  irs_agent_badge: string | null;
  initiated_at: string;
  ended_at: string | null;
  coaching_tags: string[] | null;
  coaching_notes: string | null;
  irs_call_entities: CallEntity[];
}

interface IrsCallTranscriptProps {
  sessionId: string;
}

const OUTCOME_LABELS: Record<string, { label: string; color: string }> = {
  transcripts_requested: { label: 'Transcripts Requested', color: 'bg-green-100 text-green-800' },
  transcripts_verbal: { label: 'Verbal Info Received', color: 'bg-blue-100 text-blue-800' },
  caf_not_on_file: { label: 'CAF Not on File', color: 'bg-red-100 text-red-800' },
  no_8821_on_file: { label: 'No 8821 on File', color: 'bg-red-100 text-red-800' },
  '8821_esig_rejected': { label: 'E-Sig Rejected (Wet Required)', color: 'bg-orange-100 text-orange-800' },
  name_mismatch: { label: 'Name Mismatch', color: 'bg-orange-100 text-orange-800' },
  taxpayer_not_found: { label: 'Taxpayer Not Found', color: 'bg-red-100 text-red-800' },
  fax_sent: { label: 'Fax Sent', color: 'bg-blue-100 text-blue-800' },
  pending_callback: { label: 'Pending Callback', color: 'bg-amber-100 text-amber-800' },
  skipped: { label: 'Skipped', color: 'bg-gray-100 text-gray-600' },
  other: { label: 'Other', color: 'bg-gray-100 text-gray-600' },
};

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function IrsCallTranscript({ sessionId }: IrsCallTranscriptProps) {
  const [session, setSession] = useState<CallSessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'summary' | 'transcript' | 'entities'>('summary');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch(`/api/expert/irs-call/status?sessionId=${sessionId}`);
        if (res.ok) {
          const data = await res.json();
          setSession(data.session);
        }
      } catch (err) {
        console.error('Failed to fetch call data:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchSession();
  }, [sessionId]);

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-32 mb-4" />
        <div className="h-3 bg-gray-200 rounded w-full mb-2" />
        <div className="h-3 bg-gray-200 rounded w-3/4" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-gray-500 text-sm">
        Call data not available
      </div>
    );
  }

  const filteredTranscript = session.transcript_json?.filter(entry =>
    !searchQuery || entry.text.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-gray-900">
              IRS PPS Call — {new Date(session.initiated_at).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              })}
            </h3>
            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
              {session.duration_seconds && (
                <span>{Math.round(session.duration_seconds / 60)} min</span>
              )}
              {session.hold_duration_seconds && (
                <span>Hold: {Math.round(session.hold_duration_seconds / 60)} min</span>
              )}
              {session.estimated_cost && (
                <span>${session.estimated_cost.toFixed(2)}</span>
              )}
              {session.irs_agent_name && (
                <span>Agent: {session.irs_agent_name}</span>
              )}
              {session.irs_agent_badge && (
                <span>Badge: {session.irs_agent_badge}</span>
              )}
            </div>
          </div>

          {/* Recording player */}
          {session.recording_url && (
            <audio controls className="h-8" src={session.recording_url}>
              <track kind="captions" />
            </audio>
          )}
        </div>

        {/* Coaching tags */}
        {session.coaching_tags && session.coaching_tags.length > 0 && (
          <div className="flex gap-1 mt-2">
            {session.coaching_tags.map(tag => (
              <span key={tag} className="px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded text-[10px] font-medium">
                {tag.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        {(['summary', 'transcript', 'entities'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-xs font-medium capitalize border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="p-4">
        {/* Summary Tab */}
        {activeTab === 'summary' && (
          <div className="space-y-4">
            {session.call_summary ? (
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">AI Summary</h4>
                <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
                  {session.call_summary}
                </p>
              </div>
            ) : session.concatenated_transcript ? (
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Call Transcript (Plain Text)</h4>
                <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto">
                  {session.concatenated_transcript}
                </p>
              </div>
            ) : (
              <p className="text-sm text-gray-400">No summary available yet.</p>
            )}

            {session.coaching_notes && (
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Coaching Notes</h4>
                <p className="text-sm text-gray-700">{session.coaching_notes}</p>
              </div>
            )}
          </div>
        )}

        {/* Transcript Tab */}
        {activeTab === 'transcript' && (
          <div>
            {session.transcript_json && session.transcript_json.length > 0 ? (
              <>
                <div className="mb-3">
                  <input
                    type="text"
                    placeholder="Search transcript..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-300"
                  />
                </div>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {(filteredTranscript || []).map((entry, i) => (
                    <div key={i} className={`flex gap-2 ${entry.role === 'assistant' ? '' : 'flex-row-reverse'}`}>
                      <div className={`max-w-[80%] rounded-lg px-3 py-2 ${
                        entry.role === 'assistant'
                          ? 'bg-blue-50 text-blue-900'
                          : 'bg-gray-100 text-gray-900'
                      }`}>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[10px] font-bold uppercase opacity-60">
                            {entry.role === 'assistant' ? 'AI (You)' : 'IRS Agent'}
                          </span>
                          <span className="text-[10px] opacity-40">{formatTimestamp(entry.timestamp)}</span>
                        </div>
                        <p className="text-xs leading-relaxed">{entry.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-400 text-center py-4">No transcript data available.</p>
            )}
          </div>
        )}

        {/* Entities Tab */}
        {activeTab === 'entities' && (
          <div className="space-y-3">
            {session.irs_call_entities.map((entity, i) => {
              const outcomeInfo = entity.outcome ? OUTCOME_LABELS[entity.outcome] : null;
              return (
                <div key={entity.id} className="border border-gray-100 rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-600">
                        {i + 1}
                      </span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{entity.taxpayer_name}</p>
                        <p className="text-xs text-gray-500">
                          {entity.form_type} · {entity.tax_years.join(', ')}
                        </p>
                      </div>
                    </div>
                    {outcomeInfo && (
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${outcomeInfo.color}`}>
                        {outcomeInfo.label}
                      </span>
                    )}
                  </div>
                  {entity.outcome_notes && (
                    <p className="text-xs text-gray-600 mt-2 pl-8">{entity.outcome_notes}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
