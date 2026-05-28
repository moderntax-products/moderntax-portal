'use client';

import { useState, useEffect } from 'react';

interface IrsCallLauncherProps {
  selectedAssignments: { id: string; entityName: string; entityId: string }[];
  onCallStarted: (sessionId: string) => void;
  onClearSelection: () => void;
  /** How many calls this expert currently has active (running or on hold). */
  activeCallCount: number;
  /** Hard cap on concurrent active calls per expert (multi-call orchestration). */
  maxConcurrent: number;
}

export function IrsCallLauncher({
  selectedAssignments,
  onCallStarted,
  onClearSelection,
  activeCallCount,
  maxConcurrent,
}: IrsCallLauncherProps) {
  const atCapacity = activeCallCount >= maxConcurrent;
  const [initiating, setInitiating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [mode, setMode] = useState<'immediate' | 'schedule'>('immediate');
  const [callMode, setCallMode] = useState<'hold_and_transfer' | 'ai_full' | 'irs_callback'>('hold_and_transfer');
  const [callbackPhone, setCallbackPhone] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('09:00');
  const [scheduledTimezone, setScheduledTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles'
  );
  const [scheduleSuccess, setScheduleSuccess] = useState<string | null>(null);

  const handleInitiateCall = async () => {
    if (selectedAssignments.length === 0) return;
    setInitiating(true);
    setError(null);
    setScheduleSuccess(null);

    try {
      const payload: Record<string, unknown> = {
        assignmentIds: selectedAssignments.map(a => a.id),
        callMode,
        ...(callbackPhone && { callbackPhone }),
      };

      if (mode === 'schedule' && scheduledDate && scheduledTime) {
        // Build ISO timestamp from date + time + timezone
        const dateTimeStr = `${scheduledDate}T${scheduledTime}:00`;
        // Create date in the selected timezone
        const scheduledFor = new Date(dateTimeStr).toISOString();
        payload.scheduledFor = scheduledFor;
        payload.timezone = scheduledTimezone;
      }

      const res = await fetch('/api/expert/irs-call/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let errorMsg = `Server error (${res.status})`;
        try {
          const errData = await res.json();
          errorMsg = errData.error || errorMsg;
        } catch {
          // Response wasn't JSON (e.g. Vercel error page)
          const text = await res.text().catch(() => '');
          if (text.length > 0) {
            errorMsg = `Server error (${res.status}): non-JSON response`;
          }
        }
        setError(errorMsg);
        setShowConfirm(false);
        return;
      }

      const data = await res.json();

      if (data.status === 'scheduled') {
        setScheduleSuccess(`Call scheduled for ${new Date(data.scheduledFor).toLocaleString()}`);
        setShowConfirm(false);
        onClearSelection();
      } else {
        onCallStarted(data.sessionId);
        setShowConfirm(false);
        onClearSelection();
      }
    } catch (err) {
      console.error('IRS call error:', err);
      setError(err instanceof Error ? `Network error: ${err.message}` : 'Network error. Please try again.');
    } finally {
      setInitiating(false);
    }
  };

  // When the user selects Today and the existing scheduledTime is already in
  // the past, auto-bump the time to the next available 30-min slot so the
  // form doesn't show a clearly-invalid pre-selection.
  useEffect(() => {
    if (!scheduledDate) return;
    const now = new Date();
    const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (scheduledDate !== todayLocal) return;

    const [hh, mm] = scheduledTime.split(':').map(Number);
    const slotMinutes = hh * 60 + mm;
    const minMinutes = now.getHours() * 60 + now.getMinutes() + 15;
    if (slotMinutes >= minMinutes) return;

    // Round up to the next :00 or :30 boundary that's at/past minMinutes,
    // capped at 6:30 PM (the last slot before IRS PPS closes at 7 PM).
    const candidate = Math.min(
      Math.ceil(minMinutes / 30) * 30,
      18 * 60 + 30,
    );
    const newH = Math.floor(candidate / 60);
    const newM = candidate % 60;
    setScheduledTime(`${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`);
    // Don't include scheduledTime in deps — the bump should only fire when
    // the date changes, not on every time edit (would create a feedback loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduledDate]);

  // Generate up to 5 quick-pick weekdays. Includes TODAY as the first option
  // when it's a weekday and the IRS PPS window (7 AM – 7 PM local) hasn't
  // closed yet — leaves at least 30 minutes of runway so the user can pick a
  // valid future time slot. The previous implementation always skipped today,
  // which was confusing when a Wednesday-morning call needed scheduling later
  // the same day.
  const getNextWeekdays = () => {
    const days: { label: string; value: string }[] = [];
    const today = new Date();
    const cursor = new Date(today);

    // Format helper — generates the YYYY-MM-DD value in LOCAL time, not UTC,
    // because toISOString().split('T')[0] silently shifts to UTC and produces
    // the wrong date for users west of UTC late in the day.
    const localDateValue = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    // Today gets a "Today" prefix in the label so it's visually distinct.
    const todayDow = today.getDay();
    const todayMinutes = today.getHours() * 60 + today.getMinutes();
    const PPS_CLOSE_MINUTES = 19 * 60 - 30; // 6:30 PM local — last allowed time slot
    const todayIsBookable = todayDow !== 0 && todayDow !== 6 && todayMinutes < PPS_CLOSE_MINUTES;
    if (todayIsBookable) {
      days.push({
        label: `Today, ${today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).split(', ').slice(1).join(', ')}`,
        value: localDateValue(today),
      });
    }

    while (days.length < 5) {
      cursor.setDate(cursor.getDate() + 1);
      if (cursor.getDay() !== 0 && cursor.getDay() !== 6) {
        days.push({
          label: cursor.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
          value: localDateValue(cursor),
        });
      }
    }
    return days;
  };

  // Concurrency cap reached — show a "you're at the limit" hint instead
  // of hiding the launcher entirely. Lets the expert know they CAN start
  // another call once one of the current ones finishes.
  if (atCapacity) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 flex items-center gap-3">
        <svg className="w-5 h-5 text-amber-700 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
        <div className="flex-1 text-sm">
          <p className="font-semibold text-amber-900">At concurrent-call cap ({activeCallCount} / {maxConcurrent})</p>
          <p className="text-amber-800 text-xs mt-0.5">Finish or transfer one of the active calls below to free up a slot. Multi-call orchestration is capped per expert to keep cognitive load manageable.</p>
        </div>
      </div>
    );
  }

  if (selectedAssignments.length === 0) {
    return (
      <div className="bg-white border border-dashed border-gray-300 rounded-lg p-4 mb-6 text-center">
        <div className="flex items-center justify-center gap-2 text-gray-400">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
          </svg>
          <span className="text-sm">Select assignments below to start an IRS PPS call</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4 mb-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-green-900">
              IRS PPS Call — {selectedAssignments.length} {selectedAssignments.length === 1 ? 'entity' : 'entities'}
            </h3>
            <p className="text-xs text-green-700 mt-0.5">
              {selectedAssignments.map(a => a.entityName).join(', ')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onClearSelection}
            className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Clear
          </button>
          {!showConfirm ? (
            <button
              onClick={() => setShowConfirm(true)}
              className="px-4 py-2 text-sm font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
              </svg>
              Call IRS PPS
            </button>
          ) : (
            <button
              onClick={handleInitiateCall}
              disabled={initiating || (mode === 'schedule' && !scheduledDate)}
              className={`px-4 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-50 flex items-center gap-2 ${
                mode === 'schedule' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {initiating ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  {mode === 'schedule' ? 'Scheduling...' : 'Connecting...'}
                </>
              ) : mode === 'schedule' ? (
                'Confirm — Schedule Call'
              ) : (
                'Confirm — Start Call'
              )}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          {error}
        </div>
      )}

      {scheduleSuccess && (
        <div className="mt-3 p-2 bg-green-50 border border-green-200 rounded text-xs text-green-700 flex items-center gap-2">
          <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {scheduleSuccess}
        </div>
      )}

      {showConfirm && !initiating && (
        <div className="mt-3 space-y-3">
          {/* Mode toggle */}
          <div className="flex gap-2">
            <button
              onClick={() => setMode('immediate')}
              className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                mode === 'immediate'
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              📞 Call Now
            </button>
            <button
              onClick={() => setMode('schedule')}
              className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                mode === 'schedule'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              🕐 Schedule for Later
            </button>
          </div>

          {/* Call mode selector */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-700">Call Mode</p>
            <div className="flex gap-2">
              <button
                onClick={() => setCallMode('hold_and_transfer')}
                className={`flex-1 px-2 py-2 text-xs font-medium rounded-lg border transition-colors ${
                  callMode === 'hold_and_transfer'
                    ? 'bg-purple-600 text-white border-purple-600'
                    : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                }`}
              >
                Hold & Transfer
                <span className="block text-[10px] mt-0.5 opacity-80">AI holds, transfers to you</span>
              </button>
              <button
                onClick={() => setCallMode('irs_callback')}
                className={`flex-1 px-2 py-2 text-xs font-medium rounded-lg border transition-colors ${
                  callMode === 'irs_callback'
                    ? 'bg-purple-600 text-white border-purple-600'
                    : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                }`}
              >
                IRS Callback
                <span className="block text-[10px] mt-0.5 opacity-80">IRS calls you back</span>
              </button>
              <button
                onClick={() => setCallMode('ai_full')}
                className={`flex-1 px-2 py-2 text-xs font-medium rounded-lg border transition-colors ${
                  callMode === 'ai_full'
                    ? 'bg-purple-600 text-white border-purple-600'
                    : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                }`}
              >
                AI Full
                <span className="block text-[10px] mt-0.5 opacity-80">AI handles everything</span>
              </button>
            </div>

            {callMode !== 'ai_full' && (
              <div>
                <label className="block text-xs text-gray-600 mb-1">
                  Your phone number {callMode === 'hold_and_transfer' ? '(for transfer)' : '(for IRS callback)'}
                </label>
                <input
                  type="tel"
                  value={callbackPhone}
                  onChange={e => setCallbackPhone(e.target.value)}
                  placeholder="(555) 123-4567 — leave blank to use profile phone"
                  className="w-full text-xs border border-gray-300 rounded-md px-2.5 py-1.5 bg-white placeholder:text-gray-400"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">Leave blank to use your profile phone number</p>
              </div>
            )}
          </div>

          {mode === 'schedule' && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-3">
              <p className="text-xs font-medium text-blue-800">Pick a date & time (IRS PPS: 7 AM – 7 PM, Mon–Fri)</p>

              {/* Quick date buttons */}
              <div className="flex flex-wrap gap-1.5">
                {getNextWeekdays().map(d => (
                  <button
                    key={d.value}
                    onClick={() => setScheduledDate(d.value)}
                    className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors ${
                      scheduledDate === d.value
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>

              {/* Time & timezone */}
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs text-blue-700 mb-1">Time</label>
                  <select
                    value={scheduledTime}
                    onChange={e => setScheduledTime(e.target.value)}
                    className="w-full text-xs border border-blue-200 rounded-md px-2 py-1.5 bg-white"
                  >
                    {(() => {
                      // When the user picks Today, hide time slots already past
                      // (and pad ~15 minutes so the chosen slot is at least
                      // slightly in the future — the server enforces this too).
                      // For other dates, show every slot 7 AM – 6:30 PM.
                      const todayLocal = (() => {
                        const t = new Date();
                        return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
                      })();
                      const isToday = scheduledDate === todayLocal;
                      const now = new Date();
                      const minMinutes = isToday ? now.getHours() * 60 + now.getMinutes() + 15 : 0;

                      const slots: React.ReactNode[] = [];
                      for (let i = 0; i < 12; i++) {
                        const hour = i + 7; // 7 AM to 6 PM
                        const ampm = hour < 12 ? 'AM' : 'PM';
                        const displayHour = hour > 12 ? hour - 12 : hour;
                        for (const minute of [0, 30]) {
                          const slotMinutes = hour * 60 + minute;
                          if (slotMinutes < minMinutes) continue;
                          const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
                          slots.push(
                            <option key={value} value={value}>
                              {displayHour}:{String(minute).padStart(2, '0')} {ampm}
                            </option>
                          );
                        }
                      }
                      // If "today" is so late we'd have no slots, surface a hint.
                      if (slots.length === 0) {
                        slots.push(
                          <option key="none" value="" disabled>
                            No slots remaining today — pick another date
                          </option>
                        );
                      }
                      return slots;
                    })()}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-blue-700 mb-1">Timezone</label>
                  <select
                    value={scheduledTimezone}
                    onChange={e => setScheduledTimezone(e.target.value)}
                    className="w-full text-xs border border-blue-200 rounded-md px-2 py-1.5 bg-white"
                  >
                    <option value="America/New_York">Eastern</option>
                    <option value="America/Chicago">Central</option>
                    <option value="America/Denver">Mountain</option>
                    <option value="America/Los_Angeles">Pacific</option>
                  </select>
                </div>
              </div>

              {scheduledDate && (
                <p className="text-xs text-blue-700">
                  Call will fire at {scheduledTime.replace(/^0/, '')} {
                    scheduledTimezone === 'America/New_York' ? 'ET' :
                    scheduledTimezone === 'America/Chicago' ? 'CT' :
                    scheduledTimezone === 'America/Denver' ? 'MT' : 'PT'
                  } on {new Date(scheduledDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </p>
              )}
            </div>
          )}

          {mode === 'immediate' && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-xs text-amber-800 font-medium">
                {callMode === 'hold_and_transfer'
                  ? 'AI will call IRS, navigate the phone tree, and wait on hold. When an agent answers, the call transfers to your phone.'
                  : callMode === 'irs_callback'
                  ? 'AI will call IRS, navigate the phone tree, and request a callback to your phone number.'
                  : 'AI will call IRS, navigate the phone tree, wait on hold, and speak to the agent as you.'}
              </p>
              <p className="text-xs text-amber-700 mt-1">
                {callMode === 'irs_callback'
                  ? 'Estimated cost: ~$0.50 (short call to set up callback)'
                  : `Hold times can be 15-90 min (~$0.09/min). Max cost: $${(90 * 0.09).toFixed(2)}`}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
