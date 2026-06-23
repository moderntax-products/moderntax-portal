'use client';

/**
 * PendingSignupRow — single pending sign-up entry on the admin queue.
 *
 * Two actions: Approve (with client picker — existing or create new) and
 * Reject (with optional reason). On success, the row slides into a "done"
 * state and stops accepting input.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface PendingProfile {
  id: string;
  email: string;
  full_name: string | null;
  title: string | null;
  created_at: string;
  referral_source: string | null;
  use_case: string | null;
  use_case_other: string | null;
  approval_status: string;
}

interface AuditDetails {
  company_name?: string;
  company_domain?: string;
  existing_client_id?: string | null;
  existing_client_name?: string | null;
}

interface ClientOption { id: string; name: string; domain: string | null; slug: string | null }

interface Props {
  profile: PendingProfile;
  audit: AuditDetails;
  clients: ClientOption[];
}

export function PendingSignupRow({ profile, audit, clients }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [doneState, setDoneState] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default the client picker to the existing-domain match if there is one;
  // otherwise default to "create new client" with the typed company info.
  const initialClientChoice = audit.existing_client_id || '__new__';
  const [clientChoice, setClientChoice] = useState<string>(initialClientChoice);
  const [newClientName, setNewClientName] = useState(audit.company_name || '');
  const [newClientDomain, setNewClientDomain] = useState(audit.company_domain || '');
  const [role, setRole] = useState<'manager' | 'processor' | 'direct_user'>('manager');
  const [showRejectBox, setShowRejectBox] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const useCaseDisplay = !profile.use_case
    ? '—'
    : profile.use_case === 'other'
      ? `Other — ${profile.use_case_other || '(no description)'}`
      : profile.use_case.toUpperCase();

  const handleApprove = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        user_id: profile.id,
        action: 'approve',
        role,
      };
      if (clientChoice === '__new__') {
        if (!newClientName.trim() || !newClientDomain.trim()) {
          setError('Provide name + domain for the new client.');
          setSubmitting(false);
          return;
        }
        body.new_client = { name: newClientName.trim(), domain: newClientDomain.trim() };
      } else {
        body.client_id = clientChoice;
      }

      const res = await fetch('/api/admin/approve-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || data.error || 'Failed to approve');
        setSubmitting(false);
        return;
      }
      setDoneState('approved');
      // Refresh the page so the row drops out of the list naturally.
      setTimeout(() => router.refresh(), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve');
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/approve-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: profile.id,
          action: 'reject',
          reject_reason: rejectReason.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || data.error || 'Failed to reject');
        setSubmitting(false);
        return;
      }
      setDoneState('rejected');
      setTimeout(() => router.refresh(), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject');
      setSubmitting(false);
    }
  };

  if (doneState === 'approved') {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-sm text-emerald-900">
        ✓ Approved — {profile.email}
      </div>
    );
  }
  if (doneState === 'rejected') {
    return (
      <div className="bg-gray-100 border border-gray-200 rounded-lg p-4 text-sm text-gray-700">
        Rejected — {profile.email}
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="p-5">
        {/* Top row: identity */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-4">
          <h3 className="text-base font-bold text-mt-dark">{profile.full_name || '—'}</h3>
          <a href={`mailto:${profile.email}`} className="text-sm text-blue-600 hover:underline">{profile.email}</a>
          {profile.title && <span className="text-xs text-gray-500">· {profile.title}</span>}
          <span className="text-xs text-gray-400 ml-auto">Submitted {new Date(profile.created_at).toLocaleDateString()}</span>
        </div>

        {/* Qualification grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 text-sm">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-gray-500 font-bold">Company</p>
            <p className="text-mt-dark font-semibold">{audit.company_name || '—'}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-gray-500 font-bold">Domain</p>
            <p className="text-gray-700 font-mono text-xs">{audit.company_domain || '—'}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-gray-500 font-bold">Use case</p>
            <p className="text-mt-dark">{useCaseDisplay}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-gray-500 font-bold">Found us via</p>
            <p className="text-mt-dark">{profile.referral_source || '—'}</p>
          </div>
        </div>

        {/* Client assignment */}
        {!showRejectBox && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wide text-gray-700 mb-1">Assign to client</label>
              <select
                value={clientChoice}
                onChange={(e) => setClientChoice(e.target.value)}
                disabled={submitting}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
              >
                <option value="__new__">+ Create new client (using their typed info)</option>
                {audit.existing_client_id && (
                  <option value={audit.existing_client_id}>
                    ⚡ Existing match: {audit.existing_client_name}
                  </option>
                )}
                <optgroup label="All clients">
                  {clients.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.domain ? ` (${c.domain})` : ''}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>

            {clientChoice === '__new__' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">New client name</label>
                  <input
                    type="text"
                    value={newClientName}
                    onChange={(e) => setNewClientName(e.target.value)}
                    disabled={submitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Domain</label>
                  <input
                    type="text"
                    value={newClientDomain}
                    onChange={(e) => setNewClientDomain(e.target.value)}
                    disabled={submitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                  />
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <label className="text-xs font-bold uppercase tracking-wide text-gray-700">Role</label>
              <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setRole('manager')}
                  disabled={submitting}
                  className={`px-3 py-1.5 font-semibold ${role === 'manager' ? 'bg-mt-dark text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  Manager
                </button>
                <button
                  type="button"
                  onClick={() => setRole('processor')}
                  disabled={submitting}
                  className={`px-3 py-1.5 font-semibold border-l border-gray-300 ${role === 'processor' ? 'bg-mt-dark text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  Processor
                </button>
                <button
                  type="button"
                  onClick={() => setRole('direct_user')}
                  disabled={submitting}
                  className={`px-3 py-1.5 font-semibold border-l border-gray-300 ${role === 'direct_user' ? 'bg-mt-dark text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  Direct user
                </button>
              </div>
              <p className="text-xs text-gray-500 ml-2">Manager = invite + billing · Processor = submit/manage requests · Direct user = own case only (status, intake, pay, chat).</p>
            </div>
          </div>
        )}

        {/* Reject reason input */}
        {showRejectBox && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <label className="block text-xs font-bold uppercase tracking-wide text-amber-900 mb-1">Reject reason (optional)</label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Internal note — not sent to the user."
              rows={2}
              disabled={submitting}
              className="w-full px-3 py-2 border border-amber-300 rounded-lg text-sm bg-white"
            />
          </div>
        )}

        {error && <p className="text-xs text-red-600 mt-3">{error}</p>}

        {/* Actions */}
        <div className="flex items-center gap-3 mt-4">
          {!showRejectBox ? (
            <>
              <button
                type="button"
                onClick={handleApprove}
                disabled={submitting}
                className="px-5 py-2 bg-mt-green text-white text-sm font-bold rounded-lg hover:bg-mt-green/90 disabled:opacity-50"
              >
                {submitting ? 'Approving…' : 'Approve & assign'}
              </button>
              <button
                type="button"
                onClick={() => setShowRejectBox(true)}
                disabled={submitting}
                className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Reject
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleReject}
                disabled={submitting}
                className="px-5 py-2 bg-red-600 text-white text-sm font-bold rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {submitting ? 'Rejecting…' : 'Confirm reject'}
              </button>
              <button
                type="button"
                onClick={() => { setShowRejectBox(false); setRejectReason(''); }}
                disabled={submitting}
                className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
