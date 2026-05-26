'use client';

/**
 * Admin button for entities that don't yet have a signed 8821 on file.
 * Use case: API intake (Clearfirm, partner channels) that arrived without
 * an accompanying signed 8821 (e.g. Affinitifi CF-affinitifi-321 2026-05-23).
 *
 * One click → modal with:
 *   - Expert designee picker (CAF/PTIN/address/phone preview)
 *   - Signer email input (defaults to entity.signer_email if present)
 *   - Optional first/last name override for the borrower signer
 *
 * Submit → POST /api/admin/entity/send-8821-for-signature →
 *   generates 8821 PDF with selected expert as Section 2 designee →
 *   fires Dropbox Sign envelope to borrower → flips entity to 8821_sent →
 *   auto-creates expert_assignment so the entity is routed when signed.
 *
 * Mounted on /admin/requests/[id] where the previous "Upload a signed 8821
 * above before assigning to an expert" dead-end message lived.
 */

import { useState, useEffect } from 'react';

interface ExpertOption {
  id: string;
  full_name: string | null;
  email: string;
  // The /api/admin/expert/list endpoint deliberately strips raw
  // CAF/PTIN/address/phone from the response for privacy (smaller
  // client payload, no PII leaking to admin UI). It returns these two
  // pre-computed flags instead — single source of truth via the same
  // validateExpertDesigneeCreds() the server uses on the actual send.
  designee_creds_complete: boolean;
  missing_designee_fields: string[];
}

interface Props {
  entityId: string;
  entityName: string;
  defaultSignerEmail?: string | null;
  defaultSignerFirstName?: string | null;
  defaultSignerLastName?: string | null;
}

export function Send8821ForSignatureButton(props: Props) {
  const [open, setOpen] = useState(false);
  const [experts, setExperts] = useState<ExpertOption[]>([]);
  const [expertsLoading, setExpertsLoading] = useState(false);
  const [selectedExpertId, setSelectedExpertId] = useState('');
  const [signerEmail, setSignerEmail] = useState(props.defaultSignerEmail || '');
  const [signerFirstName, setSignerFirstName] = useState(props.defaultSignerFirstName || '');
  const [signerLastName, setSignerLastName] = useState(props.defaultSignerLastName || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ msg: string; hint?: string; missing?: string[] } | null>(null);
  const [done, setDone] = useState<{ expertName: string; expertCaf: string; sigId: string; signerEmail: string } | null>(null);

  // Load active experts the first time the modal opens
  useEffect(() => {
    if (!open || experts.length > 0) return;
    setExpertsLoading(true);
    fetch('/api/admin/expert/list', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        const data = await r.json();
        const list: ExpertOption[] = (data.experts || []).map((e: any) => ({
          id: e.id,
          full_name: e.full_name,
          email: e.email,
          designee_creds_complete: !!e.designee_creds_complete,
          missing_designee_fields: e.missing_designee_fields || [],
        }));
        setExperts(list);
        // Auto-select the first complete expert
        const firstComplete = list.find((e) => e.designee_creds_complete);
        if (firstComplete) setSelectedExpertId(firstComplete.id);
      })
      .catch((err) => setError({ msg: `Couldn't load experts: ${err.message}` }))
      .finally(() => setExpertsLoading(false));
  }, [open, experts.length]);

  const submit = async () => {
    setError(null);
    if (!selectedExpertId) { setError({ msg: 'Select an expert designee.' }); return; }
    if (!signerEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail.trim())) {
      setError({ msg: 'Valid signer email required — Dropbox Sign will deliver to this address.' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/entity/send-8821-for-signature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId: props.entityId,
          expertId: selectedExpertId,
          signerEmail: signerEmail.trim(),
          signerFirstName: signerFirstName.trim() || undefined,
          signerLastName: signerLastName.trim() || undefined,
        }),
      });
      // Read as text first so we can produce a useful error when the
      // server returns HTML (Next.js error page) instead of JSON. Naive
      // res.json() throws "Unexpected token '<'" in that case which
      // tells the user nothing.
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch {
        // Server returned HTML (likely Next.js error page) — surface
        // status + a snippet of the body so we can diagnose.
        const snippet = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        setError({
          msg: `Server returned non-JSON (HTTP ${res.status}). Check Vercel logs for the throw.`,
          hint: snippet || '(empty response body)',
        });
        return;
      }
      if (!res.ok) {
        setError({
          msg: data?.error || `Failed (HTTP ${res.status})`,
          hint: data?.detail || data?.admin_hint,
          missing: data?.missing_fields,
        });
        return;
      }
      setDone({
        expertName: data.expertName,
        expertCaf: data.expertCaf,
        sigId: data.signatureRequestId,
        signerEmail: data.signerEmail,
      });
    } catch (err: any) {
      setError({ msg: err?.message || 'Network error' });
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 mt-2 text-sm">
        <p className="font-semibold text-emerald-900">✓ 8821 sent for signature</p>
        <p className="text-xs text-emerald-800 mt-1">
          Designee: <strong>{done.expertName}</strong> (CAF {done.expertCaf})<br />
          Sent to: <span className="font-mono">{done.signerEmail}</span><br />
          Signature request ID: <code className="font-mono text-[10px]">{done.sigId}</code>
        </p>
        <p className="text-xs text-emerald-700 mt-2">
          When the borrower signs, the entity will auto-flip to <code>8821_signed</code> and be ready for the IRS call queue.
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded hover:bg-indigo-700"
      >
        ✉ Send 8821 for signature
      </button>
    );
  }

  const chosen = experts.find((e) => e.id === selectedExpertId);

  return (
    <div className="mt-2 p-4 bg-white border border-indigo-300 rounded-lg shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-gray-900">Send 8821 for signature — {props.entityName}</h4>
        <button onClick={() => { setOpen(false); setError(null); }} className="text-gray-400 hover:text-gray-700 text-lg leading-none" disabled={submitting}>×</button>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Expert designee (stamped on Section 2 of the 8821)</label>
          {expertsLoading ? (
            <div className="text-xs text-gray-500">Loading experts…</div>
          ) : (
            <select
              value={selectedExpertId}
              onChange={(e) => setSelectedExpertId(e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
            >
              <option value="">— Select expert —</option>
              {experts.map((e) => (
                <option key={e.id} value={e.id} disabled={!e.designee_creds_complete}>
                  {e.full_name || e.email}
                  {!e.designee_creds_complete ? ` (missing: ${e.missing_designee_fields.join(', ')})` : ' — ready'}
                </option>
              ))}
            </select>
          )}
          {chosen && !chosen.designee_creds_complete && (
            <div className="text-[11px] text-amber-700 mt-1">
              Cannot designate — missing: {chosen.missing_designee_fields.join(', ')}. Have the expert complete their profile at /expert/profile.
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Borrower signer email</label>
          <input
            type="email"
            value={signerEmail}
            onChange={(e) => setSignerEmail(e.target.value)}
            placeholder="contact@borrower.com"
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
          />
          <p className="text-[11px] text-gray-500 mt-0.5">Dropbox Sign will deliver the envelope here. CC: matt@moderntax.io.</p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Signer first name <span className="font-normal text-gray-400">(optional)</span></label>
            <input
              type="text"
              value={signerFirstName}
              onChange={(e) => setSignerFirstName(e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Signer last name <span className="font-normal text-gray-400">(optional)</span></label>
            <input
              type="text"
              value={signerLastName}
              onChange={(e) => setSignerLastName(e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
            />
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded p-2 text-xs">
            <p className="font-medium text-red-800">{error.msg}</p>
            {error.missing && error.missing.length > 0 && (
              <p className="text-red-700 mt-0.5 font-mono">Missing: {error.missing.join(', ')}</p>
            )}
            {error.hint && <p className="text-red-700 mt-0.5 italic">{error.hint}</p>}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button onClick={submit} disabled={submitting || !selectedExpertId || !signerEmail.trim()}
            className="px-4 py-1.5 bg-indigo-600 text-white text-sm font-semibold rounded hover:bg-indigo-700 disabled:opacity-50">
            {submitting ? 'Sending…' : 'Generate + send 8821'}
          </button>
          <button onClick={() => { setOpen(false); setError(null); }} disabled={submitting}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
