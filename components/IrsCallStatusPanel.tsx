'use client';

import { useState, useEffect, useCallback } from 'react';

interface CallEntity {
  id: string;
  taxpayer_name: string;
  outcome: string | null;
  outcome_notes: string | null;
}

interface CallSession {
  id: string;
  status: string;
  initiated_at: string;
  elapsed_seconds: number;
  running_cost: number;
  hold_duration_seconds: number | null;
  irs_agent_name: string | null;
  irs_call_entities: CallEntity[];
}

interface IrsCallStatusPanelProps {
  sessionId: string;
  onCallEnded: () => void;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string; animate: boolean }> = {
  initiating: { label: 'Connecting...', color: 'text-blue-600 bg-blue-50', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', animate: true },
  ringing: { label: 'Ringing IRS...', color: 'text-blue-600 bg-blue-50', icon: 'M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z', animate: true },
  navigating_ivr: { label: 'Navigating phone tree...', color: 'text-indigo-600 bg-indigo-50', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2', animate: true },
  on_hold: { label: 'On Hold', color: 'text-amber-600 bg-amber-50', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', animate: true },
  speaking_to_agent: { label: 'Speaking to IRS Agent', color: 'text-green-600 bg-green-50', icon: 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z', animate: true },
  completed: { label: 'Call Completed', color: 'text-green-700 bg-green-50', icon: 'M5 13l4 4L19 7', animate: false },
  failed: { label: 'Call Failed', color: 'text-red-600 bg-red-50', icon: 'M6 18L18 6M6 6l12 12', animate: false },
  cancelled: { label: 'Call Cancelled', color: 'text-gray-600 bg-gray-50', icon: 'M6 18L18 6M6 6l12 12', animate: false },
};

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function IrsCallStatusPanel({ sessionId, onCallEnded }: IrsCallStatusPanelProps) {
  const [session, setSession] = useState<CallSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [localElapsed, setLocalElapsed] = useState(0);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/expert/irs-call/status?sessionId=${sessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      setSession(data.session);
      setLocalElapsed(data.session.elapsed_seconds || 0);

      // Check if call ended
      if (['completed', 'failed', 'cancelled'].includes(data.session.status)) {
        onCallEnded();
      }
    } catch (err) {
      console.error('Status poll failed:', err);
    } finally {
      setLoading(false);
    }
  }, [sessionId, onCallEnded]);

  // Poll for status every 15 seconds
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Local elapsed timer (updates every second for smooth display)
  useEffect(() => {
    if (!session) return;
    const activeStatuses = ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent'];
    if (!activeStatuses.includes(session.status)) return;

    const interval = setInterval(() => {
      setLocalElapsed(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [session?.status]);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      const res = await fetch('/api/expert/irs-call/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        fetchStatus();
      }
    } catch (err) {
      console.error('Cancel failed:', err);
    } finally {
      setCancelling(false);
    }
  };

  if (loading || !session) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6 animate-pulse">
        <div className="h-4 bg-blue-200 rounded w-48" />
      </div>
    );
  }

  const config = STATUS_CONFIG[session.status] || STATUS_CONFIG.initiating;
  const isActive = ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent'].includes(session.status);
  const runningCost = (localElapsed / 60 * 0.09).toFixed(2);

  if (minimized && isActive) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className={`w-full ${config.color} border rounded-lg p-3 mb-6 flex items-center justify-between cursor-pointer hover:opacity-90`}
      >
        <div className="flex items-center gap-2">
          {config.animate && (
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-current" />
            </span>
          )}
          <span className="text-sm font-medium">{config.label}</span>
          <span className="text-xs opacity-75">{formatDuration(localElapsed)}</span>
        </div>
        <span className="text-xs">Expand</span>
      </button>
    );
  }

  return (
    <div className={`${config.color} border rounded-lg p-4 mb-6`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          {config.animate && (
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-current" />
            </span>
          )}
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={config.icon} />
          </svg>
          <div>
            <h3 className="text-sm font-bold">{config.label}</h3>
            {session.irs_agent_name && (
              <p className="text-xs opacity-75">Agent: {session.irs_agent_name}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isActive && (
            <>
              <button
                onClick={() => setMinimized(true)}
                className="p-1 rounded hover:bg-black/5"
                title="Minimize"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                </svg>
              </button>
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="px-3 py-1 text-xs font-medium bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50"
              >
                {cancelling ? 'Cancelling...' : 'End Call'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="bg-white/50 rounded-lg p-2 text-center">
          <div className="text-lg font-bold font-mono">{formatDuration(localElapsed)}</div>
          <div className="text-[10px] uppercase tracking-wide opacity-60">Duration</div>
        </div>
        <div className="bg-white/50 rounded-lg p-2 text-center">
          <div className="text-lg font-bold font-mono">
            {session.status === 'on_hold'
              ? formatDuration(localElapsed - (session.hold_duration_seconds ? 0 : 30))
              : session.hold_duration_seconds
                ? formatDuration(session.hold_duration_seconds)
                : '--:--'}
          </div>
          <div className="text-[10px] uppercase tracking-wide opacity-60">Hold Time</div>
        </div>
        <div className="bg-white/50 rounded-lg p-2 text-center">
          <div className="text-lg font-bold font-mono">${isActive ? runningCost : (session.running_cost?.toFixed(2) || '0.00')}</div>
          <div className="text-[10px] uppercase tracking-wide opacity-60">Cost</div>
        </div>
      </div>

      {/* Entity Progress */}
      {session.irs_call_entities && session.irs_call_entities.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium opacity-75">Entities ({session.irs_call_entities.length})</p>
          {session.irs_call_entities.map((entity, i) => (
            <div key={entity.id} className="flex items-center gap-2 bg-white/40 rounded px-2 py-1.5">
              <span className="w-5 h-5 rounded-full bg-white/60 flex items-center justify-center text-xs font-bold">
                {i + 1}
              </span>
              <span className="text-xs font-medium flex-1 truncate">{entity.taxpayer_name}</span>
              {entity.outcome ? (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                  entity.outcome === 'transcripts_requested'
                    ? 'bg-green-100 text-green-800'
                    : entity.outcome === 'skipped'
                      ? 'bg-gray-100 text-gray-600'
                      : 'bg-red-100 text-red-700'
                }`}>
                  {entity.outcome.replace(/_/g, ' ')}
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/50 text-gray-500">pending</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
