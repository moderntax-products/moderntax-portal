'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, Suspense } from 'react';

function ScheduleContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const preselectedTime = searchParams.get('time');

  const [selectedTime, setSelectedTime] = useState(preselectedTime || '');
  const [callMode, setCallMode] = useState<'hold_and_transfer' | 'irs_callback'>('hold_and_transfer');
  const [callbackPhone, setCallbackPhone] = useState('');
  const [status, setStatus] = useState<'idle' | 'confirming' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [scheduleInfo, setScheduleInfo] = useState<any>(null);

  // Load token info
  useEffect(() => {
    if (!token) return;
    fetch(`/api/expert/schedule/verify?token=${token}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setStatus('error');
          setErrorMsg(data.error);
        } else {
          setScheduleInfo(data);
          if (data.callbackPhone) setCallbackPhone(data.callbackPhone);
          // If time was preselected from email, go straight to confirming
          if (preselectedTime) setStatus('confirming');
        }
      })
      .catch(() => {
        setStatus('error');
        setErrorMsg('Failed to verify schedule link.');
      });
  }, [token, preselectedTime]);

  const handleConfirm = async () => {
    if (!token || !selectedTime) return;
    setStatus('submitting');
    setErrorMsg('');

    try {
      const res = await fetch('/api/expert/schedule/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          time: selectedTime,
          callMode,
          callbackPhone: callbackPhone || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setStatus('error');
        setErrorMsg(data.error || 'Failed to schedule call');
        return;
      }

      setStatus('success');
      setScheduleInfo(data);
    } catch {
      setStatus('error');
      setErrorMsg('Network error. Please try again.');
    }
  };

  const timeSlots = [
    { label: '7:00 AM', value: '07:00' },
    { label: '8:00 AM', value: '08:00' },
    { label: '9:00 AM', value: '09:00' },
    { label: '10:00 AM', value: '10:00' },
    { label: '11:00 AM', value: '11:00' },
    { label: '12:00 PM', value: '12:00' },
    { label: '1:00 PM', value: '13:00' },
    { label: '2:00 PM', value: '14:00' },
    { label: '3:00 PM', value: '15:00' },
    { label: '4:00 PM', value: '16:00' },
    { label: '5:00 PM', value: '17:00' },
    { label: '6:00 PM', value: '18:00' },
  ];

  // Filter out past time slots for today
  const now = new Date();
  const etHour = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(now)
  );
  const availableSlots = timeSlots.filter((s) => {
    const slotHour = parseInt(s.value.split(':')[0]);
    return slotHour > etHour; // only future slots
  });

  if (!token) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg p-8 max-w-md text-center">
          <h1 className="text-xl font-bold text-red-600 mb-2">Invalid Link</h1>
          <p className="text-gray-600">This schedule link is missing a token. Please use the link from your email.</p>
        </div>
      </div>
    );
  }

  if (status === 'error' && !scheduleInfo) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg p-8 max-w-md text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
            <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Link Expired</h1>
          <p className="text-gray-600">{errorMsg}</p>
        </div>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg p-8 max-w-lg text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 flex items-center justify-center">
            <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Call Scheduled!</h1>
          <p className="text-gray-600 mb-6">
            Our AI will call the IRS at <strong>{timeSlots.find(t => t.value === selectedTime)?.label} ET</strong> and
            {callMode === 'hold_and_transfer'
              ? ' transfer the call to your phone when an agent answers.'
              : ' request a callback to your phone number.'}
          </p>
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-left text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-600">Phone:</span>
              <span className="font-medium">{callbackPhone || scheduleInfo?.callbackPhone}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Mode:</span>
              <span className="font-medium">{callMode === 'hold_and_transfer' ? 'Hold & Transfer' : 'IRS Callback'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Entities:</span>
              <span className="font-medium">{scheduleInfo?.entityCount || '—'}</span>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-4">
            Keep your phone nearby. When the IRS agent answers, you&apos;ll get a call.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-lg p-6 sm:p-8 max-w-lg w-full">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-1">ModernTax</div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Schedule Your IRS Call</h1>
          {scheduleInfo && (
            <p className="text-sm text-gray-500 mt-1">
              {scheduleInfo.entityCount} {scheduleInfo.entityCount === 1 ? 'entity' : 'entities'} to process
            </p>
          )}
        </div>

        {/* Entities list */}
        {scheduleInfo?.entities && (
          <div className="bg-gray-50 rounded-lg p-3 mb-6 text-sm">
            <p className="font-medium text-gray-700 mb-2">Pending entities:</p>
            {scheduleInfo.entities.map((e: any, i: number) => (
              <div key={i} className="flex justify-between py-1 border-b border-gray-200 last:border-0">
                <span className="font-medium text-gray-900">{e.entityName}</span>
                <span className="text-gray-500">{e.tidKind} &middot; {e.formType}</span>
              </div>
            ))}
          </div>
        )}

        {/* Time selection */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-3">
            When are you available today? <span className="text-gray-400 font-normal">(ET)</span>
          </label>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {availableSlots.length > 0 ? (
              availableSlots.map((slot) => (
                <button
                  key={slot.value}
                  onClick={() => { setSelectedTime(slot.value); setStatus('confirming'); }}
                  className={`px-3 py-2.5 text-sm font-medium rounded-lg border-2 transition-all ${
                    selectedTime === slot.value
                      ? 'bg-green-600 text-white border-green-600 shadow-md'
                      : 'bg-white text-gray-700 border-gray-200 hover:border-green-400 hover:bg-green-50'
                  }`}
                >
                  {slot.label}
                </button>
              ))
            ) : (
              <p className="col-span-full text-sm text-gray-500 text-center py-4">
                No more time slots available today. Check back tomorrow morning.
              </p>
            )}
          </div>
        </div>

        {/* Confirmation section */}
        {(status === 'confirming' || status === 'submitting') && selectedTime && (
          <div className="border-t pt-5 space-y-4">
            {/* Call mode */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Call mode</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setCallMode('hold_and_transfer')}
                  className={`p-3 text-xs rounded-lg border-2 transition-all ${
                    callMode === 'hold_and_transfer'
                      ? 'bg-purple-50 border-purple-500 text-purple-700'
                      : 'bg-white border-gray-200 text-gray-600 hover:border-purple-300'
                  }`}
                >
                  <div className="font-semibold">Hold & Transfer</div>
                  <div className="mt-0.5 opacity-70">AI holds, transfers to you</div>
                </button>
                <button
                  onClick={() => setCallMode('irs_callback')}
                  className={`p-3 text-xs rounded-lg border-2 transition-all ${
                    callMode === 'irs_callback'
                      ? 'bg-purple-50 border-purple-500 text-purple-700'
                      : 'bg-white border-gray-200 text-gray-600 hover:border-purple-300'
                  }`}
                >
                  <div className="font-semibold">IRS Callback</div>
                  <div className="mt-0.5 opacity-70">IRS calls you back</div>
                </button>
              </div>
            </div>

            {/* Phone override */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Your phone number</label>
              <input
                type="tel"
                value={callbackPhone}
                onChange={(e) => setCallbackPhone(e.target.value)}
                placeholder={scheduleInfo?.callbackPhone || '(555) 123-4567'}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
              />
              <p className="text-xs text-gray-400 mt-1">Leave blank to use your profile phone</p>
            </div>

            {/* Confirm button */}
            <button
              onClick={handleConfirm}
              disabled={status === 'submitting'}
              className="w-full py-3 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2 transition-colors"
            >
              {status === 'submitting' ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Scheduling...
                </>
              ) : (
                <>
                  Confirm — {timeSlots.find(t => t.value === selectedTime)?.label} ET
                </>
              )}
            </button>

            {errorMsg && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {errorMsg}
              </div>
            )}

            <p className="text-xs text-center text-gray-400">
              AI will call IRS PPS at {timeSlots.find(t => t.value === selectedTime)?.label} ET.
              When an agent answers, your phone will ring.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ExpertSchedulePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full" />
      </div>
    }>
      <ScheduleContent />
    </Suspense>
  );
}
