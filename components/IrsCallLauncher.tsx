'use client';

import { useState } from 'react';

interface IrsCallLauncherProps {
  selectedAssignments: { id: string; entityName: string; entityId: string }[];
  onCallStarted: (sessionId: string) => void;
  onClearSelection: () => void;
  activeCallSessionId: string | null;
}

export function IrsCallLauncher({
  selectedAssignments,
  onCallStarted,
  onClearSelection,
  activeCallSessionId,
}: IrsCallLauncherProps) {
  const [initiating, setInitiating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [mode, setMode] = useState<'immediate' | 'schedule'>('immediate');
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

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to initiate call');
        setShowConfirm(false);
        return;
      }

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
      setError('Network error. Please try again.');
    } finally {
      setInitiating(false);
    }
  };

  // Generate next 5 weekdays for quick scheduling
  const getNextWeekdays = () => {
    const days: { label: string; value: string }[] = [];
    const d = new Date();
    while (days.length < 5) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && d.getDay() !== 6) {
        days.push({
          label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
          value: d.toISOString().split('T')[0],
        });
      }
    }
    return days;
  };

  if (activeCallSessionId) {
    return null; // Status panel handles active calls
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
                    {Array.from({ length: 12 }, (_, i) => {
                      const hour = i + 7; // 7 AM to 6 PM (last slot before 7 PM)
                      const ampm = hour < 12 ? 'AM' : 'PM';
                      const displayHour = hour > 12 ? hour - 12 : hour;
                      return [
                        <option key={`${hour}:00`} value={`${String(hour).padStart(2, '0')}:00`}>
                          {displayHour}:00 {ampm}
                        </option>,
                        <option key={`${hour}:30`} value={`${String(hour).padStart(2, '0')}:30`}>
                          {displayHour}:30 {ampm}
                        </option>,
                      ];
                    })}
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
                This will place a live call to the IRS Practitioner Priority Service.
                Hold times can be 15-90 minutes (~$0.09/min). The AI will speak as you.
              </p>
              <p className="text-xs text-amber-700 mt-1">
                Estimated max cost: ${(90 * 0.09).toFixed(2)} (90 min cap)
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
