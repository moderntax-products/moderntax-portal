'use client';

/**
 * Admin "Fire PPS callback call" page.
 *
 * Picks an expert + a forced TZ (ET / CT / MT / PT) + fires a callback-
 * mode IRS PPS call right now. Use case (2026-05-26): default picker
 * keeps choosing PT and all PT-originated calls overflow_rejected; admin
 * wants to force ET routing to land in a different IRS regional queue.
 *
 * Hits POST /api/admin/pps-quick-call which:
 *   1. Pulls the expert's callable assignments (irs_queue + signed 8821)
 *   2. Creates irs_call_sessions row + irs_call_entities children
 *   3. Fires via fireScheduledCall with the forced TZ override
 *   4. Returns session id + provider call id + from-number used
 */

import { useEffect, useState } from 'react';

interface Expert {
  id: string;
  full_name: string | null;
  email: string;
  phone_number: string | null;
  designee_creds_complete: boolean;
  missing_designee_fields: string[];
}

interface FireResult {
  session_id: string;
  provider: string;
  provider_call_id: string;
  from_number: string;
  forced_tz: string | null;
  expert_name: string;
  entities_attached: number;
  entity_names: string[];
}

const TZS = [
  { value: '',   label: 'Auto (default picker — most-remaining-window)' },
  { value: 'ET', label: 'ET — New York (try when PT is dead)' },
  { value: 'CT', label: 'CT — Chicago' },
  { value: 'MT', label: 'MT — Denver' },
  { value: 'PT', label: 'PT — Los Angeles (current default)' },
];

export default function PpsQuickCallPage() {
  const [experts, setExperts] = useState<Expert[]>([]);
  const [loading, setLoading] = useState(true);
  const [expertId, setExpertId] = useState('');
  const [forceTz, setForceTz] = useState('');
  const [callbackPhone, setCallbackPhone] = useState('');
  const [firing, setFiring] = useState(false);
  const [result, setResult] = useState<FireResult | null>(null);
  const [error, setError] = useState<{ msg: string; detail?: string } | null>(null);

  useEffect(() => {
    fetch('/api/admin/expert/list', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        const data = await r.json();
        const list: Expert[] = (data.experts || []).map((e: any) => ({
          id: e.id,
          full_name: e.full_name,
          email: e.email,
          phone_number: e.phone_number || null,
          designee_creds_complete: !!e.designee_creds_complete,
          missing_designee_fields: e.missing_designee_fields || [],
        }));
        setExperts(list);
        const firstReady = list.find((e) => e.designee_creds_complete);
        if (firstReady) setExpertId(firstReady.id);
      })
      .catch((err) => setError({ msg: `Couldn't load experts: ${err.message}` }))
      .finally(() => setLoading(false));
  }, []);

  const fire = async () => {
    setError(null);
    setResult(null);
    if (!expertId) { setError({ msg: 'Select an expert.' }); return; }
    setFiring(true);
    try {
      const res = await fetch('/api/admin/pps-quick-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expertId,
          forceTz: forceTz || null,
          callbackPhone: callbackPhone.trim() || undefined,
        }),
      });
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch {
        setError({ msg: `Server returned non-JSON (HTTP ${res.status})`, detail: text.slice(0, 200) });
        return;
      }
      if (!res.ok) {
        setError({ msg: data?.error || `HTTP ${res.status}`, detail: data?.detail });
        return;
      }
      setResult(data);
    } catch (err: any) {
      setError({ msg: err?.message || 'Network error' });
    } finally {
      setFiring(false);
    }
  };

  const chosen = experts.find((e) => e.id === expertId);

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Fire PPS Callback Call</h1>
        <p className="text-sm text-gray-600 mb-6">
          Manual one-shot fire to IRS PPS — choose an expert + TZ pool entry to route from. Use when the default picker&apos;s
          choice is dead (e.g., all PT calls overflow-rejecting).
        </p>

        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Expert</label>
            {loading ? (
              <div className="text-xs text-gray-500">Loading…</div>
            ) : (
              <select
                value={expertId}
                onChange={(e) => setExpertId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white"
              >
                <option value="">— Select expert —</option>
                {experts.map((e) => (
                  <option key={e.id} value={e.id} disabled={!e.designee_creds_complete}>
                    {e.full_name || e.email}
                    {!e.designee_creds_complete ? ` (missing: ${e.missing_designee_fields.join(', ')})` : ''}
                  </option>
                ))}
              </select>
            )}
            {chosen && (
              <p className="text-xs text-gray-500 mt-1">
                Default callback phone: <code className="font-mono">{chosen.phone_number || '(none)'}</code>
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Force routing from TZ</label>
            <select
              value={forceTz}
              onChange={(e) => setForceTz(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white"
            >
              {TZS.map((tz) => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Forces the call&apos;s from-number to be in the selected timezone&apos;s pool entry. Use to land in a different IRS regional queue.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Callback phone override <span className="text-gray-400 font-normal">(optional — defaults to expert&apos;s profile.phone)</span>
            </label>
            <input
              type="tel"
              value={callbackPhone}
              onChange={(e) => setCallbackPhone(e.target.value)}
              placeholder="650-741-1085"
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono"
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded p-3 text-sm">
              <p className="font-medium text-red-800">{error.msg}</p>
              {error.detail && <p className="text-red-700 mt-1 font-mono text-xs">{error.detail}</p>}
            </div>
          )}

          {result && (
            <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-sm space-y-1">
              <p className="font-semibold text-emerald-900">✅ Call fired</p>
              <p className="text-xs text-emerald-800">
                <strong>{result.expert_name}</strong> · {result.entities_attached} entit{result.entities_attached === 1 ? 'y' : 'ies'} attached
              </p>
              <p className="text-xs text-emerald-800">
                Provider: <code className="font-mono">{result.provider}</code> · From: <code className="font-mono">{result.from_number}</code> · TZ: <code className="font-mono">{result.forced_tz || 'auto'}</code>
              </p>
              <p className="text-xs text-emerald-700 mt-1">
                Session: <code className="font-mono">{result.session_id}</code>
              </p>
              <p className="text-xs text-emerald-700">
                Entities: {result.entity_names.join(', ')}
              </p>
            </div>
          )}

          <button
            onClick={fire}
            disabled={firing || !expertId}
            className="w-full px-4 py-2.5 bg-indigo-600 text-white font-semibold rounded hover:bg-indigo-700 disabled:opacity-50"
          >
            {firing ? 'Firing…' : '📞 Fire PPS callback call now'}
          </button>
        </div>

        <div className="mt-6 text-xs text-gray-500 space-y-1">
          <p>· Uses the expert&apos;s open assignments where entity.status=irs_queue + signed_8821_url is set</p>
          <p>· Caps at 5 entities per call (Retell agent max)</p>
          <p>· Live call status visible in <a href="/admin/irs-call-stats" className="text-indigo-600 underline">/admin/irs-call-stats</a></p>
        </div>
      </div>
    </div>
  );
}
