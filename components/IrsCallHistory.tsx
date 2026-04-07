'use client';

import { useState, useEffect } from 'react';
import { IrsCallTranscript } from './IrsCallTranscript';

interface CallEntity {
  id: string;
  taxpayer_name: string;
  outcome: string | null;
}

interface CallSession {
  id: string;
  status: string;
  initiated_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  hold_duration_seconds: number | null;
  estimated_cost: number | null;
  irs_agent_name: string | null;
  irs_agent_badge: string | null;
  coaching_tags: string[] | null;
  irs_call_entities: CallEntity[];
}

interface CallStats {
  totalCalls: number;
  completedCalls: number;
  totalCost: number;
  avgDurationMinutes: number;
  avgHoldMinutes: number;
}

export function IrsCallHistory() {
  const [sessions, setSessions] = useState<CallSession[]>([]);
  const [stats, setStats] = useState<CallStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterOutcome, setFilterOutcome] = useState<string>('all');

  useEffect(() => {
    async function fetchHistory() {
      try {
        const res = await fetch('/api/expert/irs-call/history?limit=50');
        if (res.ok) {
          const data = await res.json();
          setSessions(data.sessions || []);
          setStats(data.stats || null);
        }
      } catch (err) {
        console.error('Failed to fetch call history:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchHistory();
  }, []);

  if (loading) {
    return (
      <div className="space-y-3 animate-pulse">
        {[1, 2, 3].map(i => (
          <div key={i} className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="h-4 bg-gray-200 rounded w-48 mb-2" />
            <div className="h-3 bg-gray-200 rounded w-32" />
          </div>
        ))}
      </div>
    );
  }

  const STATUS_COLORS: Record<string, string> = {
    completed: 'text-green-700 bg-green-50',
    failed: 'text-red-600 bg-red-50',
    cancelled: 'text-gray-500 bg-gray-50',
  };

  // Filter sessions
  const filteredSessions = filterOutcome === 'all'
    ? sessions
    : sessions.filter(s => {
        if (filterOutcome === 'success') {
          return s.irs_call_entities.some(e => e.outcome === 'transcripts_requested');
        }
        if (filterOutcome === 'failed') {
          return s.status === 'failed' || s.irs_call_entities.some(e =>
            ['caf_not_on_file', 'no_8821_on_file', '8821_esig_rejected', 'name_mismatch', 'taxpayer_not_found'].includes(e.outcome || '')
          );
        }
        return true;
      });

  // Group by date
  const groupedByDate: Record<string, CallSession[]> = {};
  filteredSessions.forEach(s => {
    const dateKey = new Date(s.initiated_at).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    if (!groupedByDate[dateKey]) groupedByDate[dateKey] = [];
    groupedByDate[dateKey].push(s);
  });

  return (
    <div className="space-y-6">
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-5 gap-3">
          <div className="bg-white p-3 rounded-lg border border-gray-200 text-center">
            <div className="text-xl font-bold text-gray-900">{stats.totalCalls}</div>
            <div className="text-[10px] text-gray-500 uppercase">Total Calls</div>
          </div>
          <div className="bg-white p-3 rounded-lg border border-gray-200 text-center">
            <div className="text-xl font-bold text-green-600">{stats.completedCalls}</div>
            <div className="text-[10px] text-gray-500 uppercase">Completed</div>
          </div>
          <div className="bg-white p-3 rounded-lg border border-gray-200 text-center">
            <div className="text-xl font-bold text-blue-600">${stats.totalCost.toFixed(2)}</div>
            <div className="text-[10px] text-gray-500 uppercase">Total Cost</div>
          </div>
          <div className="bg-white p-3 rounded-lg border border-gray-200 text-center">
            <div className="text-xl font-bold text-gray-700">{stats.avgDurationMinutes}m</div>
            <div className="text-[10px] text-gray-500 uppercase">Avg Duration</div>
          </div>
          <div className="bg-white p-3 rounded-lg border border-gray-200 text-center">
            <div className="text-xl font-bold text-amber-600">{stats.avgHoldMinutes}m</div>
            <div className="text-[10px] text-gray-500 uppercase">Avg Hold</div>
          </div>
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Filter:</span>
        {['all', 'success', 'failed'].map(filter => (
          <button
            key={filter}
            onClick={() => setFilterOutcome(filter)}
            className={`px-2 py-1 text-xs rounded-full capitalize ${
              filterOutcome === filter
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {filter}
          </button>
        ))}
      </div>

      {/* Sessions grouped by date */}
      {Object.entries(groupedByDate).map(([date, daySessions]) => (
        <div key={date}>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{date}</h3>
          <div className="space-y-2">
            {daySessions.map(session => (
              <div key={session.id}>
                <button
                  onClick={() => setExpandedId(expandedId === session.id ? null : session.id)}
                  className="w-full bg-white border border-gray-200 rounded-lg p-3 hover:bg-gray-50 text-left transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_COLORS[session.status] || 'bg-gray-100 text-gray-600'}`}>
                        {session.status}
                      </span>
                      <div>
                        <p className="text-xs font-medium text-gray-900">
                          {session.irs_call_entities.map(e => e.taxpayer_name).join(', ')}
                        </p>
                        <div className="flex items-center gap-2 text-[10px] text-gray-500 mt-0.5">
                          <span>{new Date(session.initiated_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                          {session.duration_seconds && <span>{Math.round(session.duration_seconds / 60)}m</span>}
                          {session.hold_duration_seconds && <span>Hold: {Math.round(session.hold_duration_seconds / 60)}m</span>}
                          {session.estimated_cost && <span>${session.estimated_cost.toFixed(2)}</span>}
                          {session.irs_agent_name && <span>Agent: {session.irs_agent_name}</span>}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      {session.irs_call_entities.map(e => {
                        const success = e.outcome === 'transcripts_requested';
                        return (
                          <span
                            key={e.id}
                            className={`w-2 h-2 rounded-full ${
                              success ? 'bg-green-500' : e.outcome ? 'bg-red-400' : 'bg-gray-300'
                            }`}
                            title={`${e.taxpayer_name}: ${e.outcome || 'pending'}`}
                          />
                        );
                      })}
                      <svg className={`w-4 h-4 ml-2 text-gray-400 transition-transform ${expandedId === session.id ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>
                </button>

                {expandedId === session.id && (
                  <div className="mt-2 ml-4">
                    <IrsCallTranscript sessionId={session.id} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {filteredSessions.length === 0 && (
        <div className="text-center py-8 text-gray-400 text-sm">
          No calls found. Start a call from your active assignments.
        </div>
      )}
    </div>
  );
}
