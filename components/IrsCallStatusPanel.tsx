'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

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
  callback_status: string | null;
  callback_phone: string | null;
  agent_answered_at: string | null;
  /** Rolling transcript from Bland — used for the Live Transcript panel. */
  concatenated_transcript: string | null;
}

interface DialDirectInfo {
  phone: string;
  ivr_path: string[];
  caf_number: string | null;
  expert_name: string | null;
  expert_fax: string | null;
  sor_inbox: string | null;
  entities: {
    taxpayer_name: string;
    taxpayer_tid: string;
    form_type: string;
    tax_years: string[];
  }[];
}

/**
 * Keywords that suggest a live IRS agent has picked up the phone. Used to
 * highlight the live transcript and fire a visual alert. These have to be
 * tight enough to avoid false positives on the PPS recorded greeting.
 */
const AGENT_GREETING_PATTERNS: RegExp[] = [
  /thank you for calling[^.]*practitioner/i,
  /this is (mr|ms|mrs|miss)\.?\s+\w+/i,
  /\bmy (id|badge) (number )?is\b/i,
  /how (can|may) i help/i,
  /may i have your (name|caf)/i,
];

function highlightTranscript(text: string): { html: string; agentDetected: boolean } {
  // Escape then highlight the tail (last ~800 chars) so the freshest content
  // is visible without scrolling. Marks agent-greeting matches in red.
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const tail = escaped.slice(-1200);
  let agentDetected = false;
  let html = tail;
  for (const pattern of AGENT_GREETING_PATTERNS) {
    if (pattern.test(tail)) {
      agentDetected = true;
      html = html.replace(pattern, m => `<mark class="bg-red-200 text-red-900 px-1 rounded">${m}</mark>`);
    }
  }
  return { html, agentDetected };
}

interface IrsCallStatusPanelProps {
  sessionId: string;
  onCallEnded: () => void;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string; animate: boolean }> = {
  initiating: { label: 'Connecting...', color: 'text-blue-600 bg-blue-50', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', animate: true },
  ringing: { label: 'Ringing IRS...', color: 'text-blue-600 bg-blue-50', icon: 'M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z', animate: true },
  navigating_ivr: { label: 'Navigating phone tree...', color: 'text-indigo-600 bg-indigo-50', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2', animate: true },
  on_hold: { label: 'On Hold — Listen for Agent', color: 'text-amber-600 bg-amber-50', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', animate: true },
  speaking_to_agent: { label: 'IRS Agent on Line!', color: 'text-green-600 bg-green-50', icon: 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z', animate: true },
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

/**
 * Pending fax request — when the AI fires send_fax mid-call, the IRS
 * agent expects a fax in 2-5 min. The expert (listening live) is the
 * one who actually sends it from their fax machine / eFax until we
 * integrate a real fax API. This banner surfaces the request the moment
 * the AI calls the tool.
 */
interface PendingFax {
  call_entity_id: string;
  entity_id: string;
  taxpayer_name: string;
  fax_number: string;
  signed_8821_url: string | null;
  requested_notes: string;
}

export function IrsCallStatusPanel({ sessionId, onCallEnded }: IrsCallStatusPanelProps) {
  const [session, setSession] = useState<CallSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [localElapsed, setLocalElapsed] = useState(0);
  const [pendingFaxes, setPendingFaxes] = useState<PendingFax[]>([]);
  const [markingFaxId, setMarkingFaxId] = useState<string | null>(null);

  // Transfer state — transferSuccess stays for auto-bridge visual; transferInfo
  // carries the "auto-transfer is armed" message surfaced by the server route.
  const [transferSuccess] = useState(false);
  const [transferInfo] = useState<string | null>(null);

  // End-and-dial handoff state
  const [endingAndDialing, setEndingAndDialing] = useState(false);
  const [dialDirectInfo, setDialDirectInfo] = useState<DialDirectInfo | null>(null);
  const [endError, setEndError] = useState<string | null>(null);

  // Cancel confirmation state — End Call is destructive (drops the IRS line),
  // so it requires an explicit confirmation step.
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  // Audio refs retained for the disabled live-audio path (re-enabled on Bland
  // plan upgrade). Safe to remove if we commit to no-audio permanently.
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/expert/irs-call/status?sessionId=${sessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      setSession(data.session);
      setLocalElapsed(data.session.elapsed_seconds || 0);
      setPendingFaxes(Array.isArray(data.pendingFaxes) ? data.pendingFaxes : []);

      if (['completed', 'failed', 'cancelled'].includes(data.session.status)) {
        onCallEnded();
      }
    } catch (err) {
      console.error('Status poll failed:', err);
    } finally {
      setLoading(false);
    }
  }, [sessionId, onCallEnded]);

  // Mark a manual fax as actually sent — flips the entity outcome and
  // clears the banner. Called from the "Mark Sent" button below.
  const markFaxSent = useCallback(async (callEntityId: string) => {
    setMarkingFaxId(callEntityId);
    try {
      const res = await fetch('/api/expert/irs-call/mark-fax-sent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_entity_id: callEntityId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert('Failed to mark fax sent: ' + (err.error || res.status));
        return;
      }
      // Optimistically clear locally — next poll will confirm.
      setPendingFaxes(prev => prev.filter(f => f.call_entity_id !== callEntityId));
    } finally {
      setMarkingFaxId(null);
    }
  }, []);

  // Adaptive polling — slow during early call setup, fast once we're close to a live agent.
  // The transfer trigger window is only ~5 seconds wide, so 15s polling is way too slow
  // when status is on_hold or speaking_to_agent.
  useEffect(() => {
    fetchStatus();
    const fastStatuses = ['on_hold', 'speaking_to_agent'];
    const isFast = session && fastStatuses.includes(session.status);
    const intervalMs = isFast ? 1500 : 10000;
    const interval = setInterval(fetchStatus, intervalMs);
    return () => clearInterval(interval);
  }, [fetchStatus, session?.status]);

  // Local elapsed timer
  useEffect(() => {
    if (!session) return;
    const activeStatuses = ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent'];
    if (!activeStatuses.includes(session.status)) return;

    const interval = setInterval(() => {
      setLocalElapsed(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [session?.status]);

  // --- Live Audio WebSocket —— DISABLED (Bland plan-gated) ---
  // Kept intentionally as a stub so restoring audio is a one-line toggle if
  // the Bland plan gets upgraded. Today /v1/calls/{id}/listen returns
  // INVALID_ORG_PREFERENCES, so we replaced the audio panel with a live
  // transcript viewer (highlightTranscript + AGENT_GREETING_PATTERNS above).
  const disconnectAudio = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
  }, []);

  // Clean up any lingering audio context on unmount or call end.
  useEffect(() => {
    return () => disconnectAudio();
  }, [disconnectAudio]);
  useEffect(() => {
    if (session && ['completed', 'failed', 'cancelled'].includes(session.status)) {
      disconnectAudio();
    }
  }, [session?.status, disconnectAudio]);

  // --- Agent-picked-up alert ---
  // Plays a loud, repeating browser alert the moment the AI flips status to
  // speaking_to_agent (or callback_status to "transferring"). The AI's bridging script
  // buys ~10 seconds before the IRS rep gives up — this gets the expert's attention
  // immediately so they can pick up their phone before the bridge.
  const alertedRef = useRef(false);
  const alertTimerRef = useRef<number | null>(null);
  const stopAlert = useCallback(() => {
    if (alertTimerRef.current !== null) {
      window.clearInterval(alertTimerRef.current);
      alertTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    const agentLive =
      session.status === 'speaking_to_agent' ||
      session.callback_status === 'transferring' ||
      !!session.agent_answered_at;

    if (agentLive && !alertedRef.current) {
      alertedRef.current = true;
      setMinimized(false); // force-expand the panel

      // Audible alert via WebAudio — repeating two-tone beep for 20 seconds or until
      // the call leaves an active state (whichever comes first).
      try {
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const playBeep = () => {
          const now = ctx.currentTime;
          [880, 660].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, now + i * 0.18);
            gain.gain.linearRampToValueAtTime(0.4, now + i * 0.18 + 0.02);
            gain.gain.linearRampToValueAtTime(0, now + i * 0.18 + 0.16);
            osc.connect(gain).connect(ctx.destination);
            osc.start(now + i * 0.18);
            osc.stop(now + i * 0.18 + 0.18);
          });
        };
        playBeep();
        alertTimerRef.current = window.setInterval(playBeep, 1200);
        window.setTimeout(() => stopAlert(), 20000);
      } catch (err) {
        console.warn('Could not play agent-on-line alert tone:', err);
      }

      // Vibrate on mobile (no-op on desktop)
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate?.([200, 100, 200, 100, 400]); } catch { /* ignore */ }
      }

      // Browser notification — works if the user previously granted permission
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification('IRS agent on the line!', {
            body: 'Pick up your phone — bridge is connecting now.',
            tag: 'irs-agent-live',
            requireInteraction: true,
          });
        } catch { /* ignore */ }
      }

      // Page-title flash so it's visible from another tab
      const originalTitle = document.title;
      let flash = true;
      const titleTimer = window.setInterval(() => {
        document.title = flash ? '🔔 IRS AGENT ON LINE — PICK UP' : originalTitle;
        flash = !flash;
      }, 700);
      window.setTimeout(() => {
        window.clearInterval(titleTimer);
        document.title = originalTitle;
      }, 20000);
    }

    // Reset the alert latch once the call ends — allows a future re-trigger if a new
    // session begins in the same panel mount.
    if (session && ['completed', 'failed', 'cancelled'].includes(session.status)) {
      stopAlert();
    }
  }, [session?.status, session?.callback_status, session?.agent_answered_at, stopAlert]);

  useEffect(() => () => stopAlert(), [stopAlert]);

  // Request notification permission on mount so the browser alert can fire later.
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      // Best-effort — don't block on the user's response.
      Notification.requestPermission().catch(() => { /* ignore */ });
    }
  }, []);

  const handleCancel = async () => {
    setShowCancelConfirm(false);
    setCancelling(true);
    try {
      const res = await fetch('/api/expert/irs-call/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        disconnectAudio();
        fetchStatus();
      }
    } catch (err) {
      console.error('Cancel failed:', err);
    } finally {
      setCancelling(false);
    }
  };

  // NOTE: The old handleTransfer() was removed — Bland retired the
  // /v1/calls/{id}/transfer endpoint (now 404). Auto-bridge via
  // transfer_phone_number is set at call-init time; the button above just
  // explains that. When the AI misses, handleEndAndDial below is the
  // reliable recovery path.

  /**
   * Real replacement for the deprecated transfer: end the Bland AI call and
   * hand the expert a ready-to-dial block (IRS PPS number + IVR path + CAF
   * + queued entities). Used when the AI is stuck or the expert wants to
   * take the call over personally.
   */
  const handleEndAndDial = async () => {
    if (!confirm('End the Bland AI call and dial IRS directly? You will lose the queue position but retain all context.')) {
      return;
    }
    setEndingAndDialing(true);
    setEndError(null);
    try {
      const res = await fetch('/api/expert/irs-call/end-and-dial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to end call');
      setDialDirectInfo(data.dialDirect);
      // Call status update will flip to cancelled via the usual poll.
      fetchStatus();
    } catch (err) {
      setEndError(err instanceof Error ? err.message : 'Failed to end call');
    } finally {
      setEndingAndDialing(false);
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
  const canListen = ['navigating_ivr', 'on_hold', 'speaking_to_agent'].includes(session.status);
  const canTransfer = ['on_hold', 'speaking_to_agent'].includes(session.status);

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
                onClick={() => setShowCancelConfirm(true)}
                disabled={cancelling}
                className="px-3 py-1 text-xs font-medium bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50"
              >
                {cancelling ? 'Ending...' : 'End Call'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* FAX NEEDED banner — appears when the AI fires send_fax mid-call.
          Until we integrate a real fax API (Phaxio / Twilio Fax), the
          listening expert manually fires the fax to the IRS-supplied number
          and clicks "Mark Sent" to clear the banner. The AI on the call
          has already optimistically told IRS "Sent successfully" and is
          silently waiting for the agent to confirm receipt. */}
      {pendingFaxes.length > 0 && (
        <div className="border-2 border-amber-500 bg-amber-50 rounded-lg p-4 mb-3 animate-pulse">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="font-bold text-amber-900 text-sm uppercase tracking-wide">Fax Needed Now</span>
            <span className="text-xs text-amber-700">IRS agent is waiting</span>
          </div>
          {pendingFaxes.map(fax => (
            <div key={fax.call_entity_id} className="bg-white rounded p-3 border border-amber-300 mb-2 last:mb-0">
              <div className="text-sm font-semibold text-mt-dark mb-1">{fax.taxpayer_name}</div>
              <div className="text-xs text-gray-600 mb-2">
                Fax 8821 to: <span className="font-mono font-bold text-amber-900">{fax.fax_number}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {fax.signed_8821_url && (
                  <a
                    href={`/api/expert/download-8821?path=${encodeURIComponent(fax.signed_8821_url)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700"
                  >
                    Open 8821 PDF
                  </a>
                )}
                <button
                  onClick={() => markFaxSent(fax.call_entity_id)}
                  disabled={markingFaxId === fax.call_entity_id}
                  className="px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded hover:bg-emerald-700 disabled:opacity-50"
                >
                  {markingFaxId === fax.call_entity_id ? 'Marking...' : '✓ Mark Sent'}
                </button>
              </div>
              <div className="text-[10px] text-gray-500 mt-2">{fax.requested_notes}</div>
            </div>
          ))}
        </div>
      )}

      {/* Live Audio Panel */}
      {/* Live Transcript — replaces the plan-gated Live Audio feature.
          Polls every 1.5-3s (adaptive) via /status and highlights agent-greeting
          keywords in red so the expert can catch a missed transfer instantly. */}
      {canListen && (() => {
        const transcript = session.concatenated_transcript || '';
        const { html: highlightedHtml, agentDetected } = highlightTranscript(transcript);
        return (
          <div className={`border rounded-lg p-3 mb-3 ${agentDetected ? 'bg-red-50 border-red-300' : 'bg-white/60 border-black/10'}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <span className="text-xs font-semibold">Live Transcript</span>
                <span className="flex items-center gap-1">
                  <span className={`w-2 h-2 rounded-full ${transcript ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`} />
                  <span className="text-[10px] text-gray-600">
                    {transcript ? 'Streaming' : 'Waiting for audio…'}
                  </span>
                </span>
              </div>
              {agentDetected && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-red-600 text-white animate-pulse">
                  AGENT DETECTED
                </span>
              )}
            </div>

            {transcript ? (
              <div
                className="text-[11px] text-gray-700 font-mono leading-relaxed max-h-40 overflow-y-auto whitespace-pre-wrap bg-white/70 rounded p-2"
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            ) : (
              <p className="text-[11px] text-gray-500 italic">
                Transcript will appear as the AI progresses through the IVR.
              </p>
            )}

            <p className="mt-2 text-[10px] text-gray-500">
              Live audio is gated behind a Bland plan upgrade. Live transcript + agent-keyword detection
              is running instead — if the AI misses the agent, you&apos;ll see the red alert and can use
              <strong> End Call &amp; Dial Direct</strong> below.
            </p>
          </div>
        );
      })()}

      {/* Agent answered alert */}
      {session.status === 'speaking_to_agent' && (
        <div className="bg-green-100 border-2 border-green-400 rounded-lg p-3 mb-3 animate-pulse">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-green-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
            <div>
              <p className="text-sm font-bold text-green-800">IRS Agent Answered!</p>
              <p className="text-xs text-green-700">
                {transferSuccess
                  ? 'Call is being transferred to your phone — answer the incoming call!'
                  : session.irs_agent_name
                    ? `Agent ${session.irs_agent_name} is on the line.`
                    : 'An agent is on the line.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Transfer bail-out — real fix for the plan-gated "Transfer to My Phone".
          Auto-bridge still runs (AI detects agent greeting → dials callback phone).
          If that misses, this button kills Bland's call and hands the expert a
          ready-to-dial block with IRS PPS number + CAF + queued entities. */}
      {canTransfer && !transferSuccess && !dialDirectInfo && (
        <div className="mb-3 space-y-2">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-xs text-blue-900">
              <strong>Auto-transfer is armed.</strong> The AI is configured to bridge this call to{' '}
              <span className="font-mono">{session.callback_phone || 'your phone'}</span> the moment it
              detects an IRS agent greeting. Keep this tab open and watch for your phone to ring.
            </p>
            {transferInfo && <p className="mt-2 text-xs text-amber-700">{transferInfo}</p>}
          </div>
          <button
            onClick={handleEndAndDial}
            disabled={endingAndDialing}
            className="w-full px-4 py-2.5 text-sm font-bold bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.05 12.55l3.182-3.182a2 2 0 012.828 0l.07.07a2 2 0 010 2.829l-3.182 3.182m-2.828 0l-3.182 3.182a2 2 0 01-2.828 0l-.07-.07a2 2 0 010-2.829l3.182-3.182m9.9-9.9L3 20.999" />
            </svg>
            {endingAndDialing ? 'Ending call…' : 'End Call & Dial Direct'}
          </button>
          {endError && (
            <p className="text-xs text-red-600">{endError}</p>
          )}
          <p className="text-[10px] text-gray-500 text-center">
            Use this if the AI is stuck or misses the agent greeting. The Bland call ends, and you get
            the IRS PPS number + your CAF + queued entities to dial yourself.
          </p>
          {/* Legacy disabled button — kept for audit surface with the limitation explicit */}
          <details className="text-[10px] text-gray-500">
            <summary className="cursor-pointer hover:text-gray-700">Why is &ldquo;Transfer to My Phone&rdquo; not a button?</summary>
            <p className="mt-1 pl-3 border-l-2 border-gray-300">
              Bland AI retired the programmatic mid-call transfer endpoint (all
              <code className="mx-1">/calls/&#123;id&#125;/transfer</code> variants now return 404). The
              only supported transfer path is the AI triggering itself on agent detection, which is what
              the auto-bridge above does. If Bland restores the endpoint, this button comes back.
            </p>
          </details>
        </div>
      )}

      {/* Dial-direct handoff block — rendered after End Call & Dial Direct */}
      {dialDirectInfo && (
        <div className="mb-3 border-2 border-emerald-400 bg-emerald-50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
            <h3 className="text-sm font-bold text-emerald-900">Dial IRS PPS Directly</h3>
          </div>
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between bg-white rounded p-2">
              <span className="text-gray-600">Phone</span>
              <a href={`tel:${dialDirectInfo.phone}`} className="font-mono font-bold text-mt-dark text-lg">
                {dialDirectInfo.phone}
              </a>
            </div>
            <div className="bg-white rounded p-2">
              <p className="text-gray-600 mb-1">IVR path</p>
              <ol className="list-decimal ml-4 text-mt-dark">
                {dialDirectInfo.ivr_path.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {dialDirectInfo.caf_number && (
                <div className="bg-white rounded p-2">
                  <p className="text-gray-600">CAF</p>
                  <p className="font-mono font-bold text-mt-dark">{dialDirectInfo.caf_number}</p>
                </div>
              )}
              {dialDirectInfo.sor_inbox && (
                <div className="bg-white rounded p-2">
                  <p className="text-gray-600">SOR inbox</p>
                  <p className="font-mono font-bold text-mt-dark">{dialDirectInfo.sor_inbox}</p>
                </div>
              )}
            </div>
            {dialDirectInfo.entities.length > 0 && (
              <div className="bg-white rounded p-2">
                <p className="text-gray-600 mb-1">Entities queued ({dialDirectInfo.entities.length})</p>
                <ul className="space-y-1">
                  {dialDirectInfo.entities.map((e, i) => (
                    <li key={i} className="text-mt-dark">
                      <span className="font-semibold">{e.taxpayer_name}</span>
                      <span className="text-gray-500"> · {e.taxpayer_tid} · {e.form_type} · {e.tax_years.join(', ')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {transferSuccess && session.status !== 'speaking_to_agent' && (
        <div className="bg-blue-100 border border-blue-300 rounded-lg p-2 mb-3 text-center">
          <p className="text-xs font-medium text-blue-800">
            Call transfer initiated — answer your phone!
          </p>
        </div>
      )}

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

      {/* End Call confirmation modal — destructive action, requires explicit confirm */}
      {showCancelConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="end-call-title"
          onClick={(e) => { if (e.target === e.currentTarget) setShowCancelConfirm(false); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border-2 border-red-200">
            <div className="flex items-start gap-3 mb-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 id="end-call-title" className="text-base font-bold text-gray-900">End this IRS call now?</h3>
                <p className="text-xs text-gray-500 mt-0.5">This action cannot be undone.</p>
              </div>
            </div>

            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 space-y-2">
              <div className="flex items-start gap-2">
                <span className="text-red-600 mt-0.5">•</span>
                <p className="text-xs text-red-800">
                  <strong>The call will hang up immediately.</strong>
                  {session.status === 'speaking_to_agent'
                    ? ' An IRS agent is currently on the line — they will be disconnected.'
                    : session.status === 'on_hold'
                      ? ' You are currently on hold in the PPS queue. Your place in line will be lost.'
                      : ' Any progress on this call will be lost.'}
                </p>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-red-600 mt-0.5">•</span>
                <p className="text-xs text-red-800">
                  Estimated wait if you re-call: <strong>15-60 minutes</strong> (PPS hold queue).
                </p>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-red-600 mt-0.5">•</span>
                <p className="text-xs text-red-800">
                  Current call: <strong>{formatDuration(localElapsed)}</strong> · ${runningCost} billed.
                </p>
              </div>
            </div>

            <p className="text-xs text-gray-600 mb-4">
              If you just want to step away, you can <strong>minimize</strong> this panel and let the AI keep holding for you.
              Only end the call if you no longer need it.
            </p>

            <div className="flex gap-2">
              <button
                onClick={() => setShowCancelConfirm(false)}
                className="flex-1 px-4 py-2.5 text-sm font-semibold bg-gray-100 text-gray-800 rounded-lg hover:bg-gray-200"
                autoFocus
              >
                Keep Call Active
              </button>
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="flex-1 px-4 py-2.5 text-sm font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {cancelling ? 'Ending...' : 'End Call Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
