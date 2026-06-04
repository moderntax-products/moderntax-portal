'use client';

/**
 * Mandatory time-zone setup gate (MOD-229 / onboarding).
 *
 * Rendered on the main dashboard for processors / managers / admins. If the
 * user has no `iana_timezone` set, a blocking modal asks them to pick one
 * (pre-selected to the browser-detected zone) before they can use the app —
 * so every time and SLA window they see matches where they actually are.
 * Experts are gated separately on the /expert profile page.
 */

import { useState } from 'react';
import { createClient } from '@/lib/supabase';

const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Phoenix', label: 'Mountain — no DST (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
  { value: 'America/Puerto_Rico', label: 'Atlantic (Puerto Rico)' },
];

export function TimezoneSetupGate({ userId, currentTimezone }: { userId: string; currentTimezone: string | null }) {
  const detected = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';
  const [tz, setTz] = useState(currentTimezone || detected || '');
  const [done, setDone] = useState(!!currentTimezone);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  if (done) return null;

  const save = async () => {
    if (!tz) { setErr('Please select your time zone.'); return; }
    setSaving(true); setErr('');
    try {
      const sb = createClient();
      const { error } = await (sb.from('profiles').update({ iana_timezone: tz } as any).eq('id', userId) as any);
      if (error) { setErr(error.message); setSaving(false); return; }
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
      setSaving(false);
    }
  };

  const localNow = tz
    ? new Date().toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    : '';

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
        <h2 className="text-lg font-bold text-mt-dark">Set your time zone</h2>
        <p className="text-sm text-gray-600 mt-1.5">
          One quick thing before you start — pick your time zone so every date, deadline, and SLA window you see matches where you are.
        </p>
        <div className="mt-4">
          <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Time zone</label>
          <select
            value={tz}
            onChange={(e) => { setTz(e.target.value); setErr(''); }}
            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-mt-green"
          >
            <option value="" disabled>Select your time zone…</option>
            {TIMEZONE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          {localNow && <p className="text-xs text-gray-500 mt-1.5">It&rsquo;s currently <strong>{localNow}</strong> for you.</p>}
        </div>
        {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
        <button
          onClick={save}
          disabled={saving || !tz}
          className="mt-5 w-full bg-mt-green text-white py-2.5 rounded-lg font-semibold text-sm hover:bg-opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save & continue'}
        </button>
      </div>
    </div>
  );
}
