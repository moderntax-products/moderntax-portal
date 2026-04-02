'use client';

import { useState } from 'react';

interface ExpertFlagIssueProps {
  assignmentId: string;
  onComplete: () => void;
}

const MISS_REASONS = [
  { value: 'irs_line_busy', label: 'IRS Line Busy / Disconnected' },
  { value: 'form_error', label: 'Form 8821 Error (name, EIN, etc.)' },
  { value: 'tds_down', label: 'TDS System Down' },
  { value: 'wrong_ein', label: 'Wrong EIN / Entity Mismatch' },
  { value: 'scheduling', label: 'Scheduling Conflict' },
  { value: 'irs_rejected', label: 'IRS Rejected Signature (wet ink required)' },
  { value: 'other', label: 'Other' },
];

export function ExpertFlagIssue({ assignmentId, onComplete }: ExpertFlagIssueProps) {
  const [missReason, setMissReason] = useState('');
  const [notes, setNotes] = useState('');
  const [markFailed, setMarkFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [faxEmailSent, setFaxEmailSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!missReason) {
      setError('Please select a reason');
      return;
    }

    setLoading(true);
    setError('');
    setFaxEmailSent(false);

    try {
      const res = await fetch('/api/expert/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'flag_issue',
          assignmentId,
          missReason,
          notes: notes || null,
          markFailed,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to flag issue');
        return;
      }

      if (data.fax_email_sent) {
        setFaxEmailSent(true);
        // Show success message briefly before closing
        setTimeout(() => onComplete(), 3000);
        return;
      }

      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to flag issue');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-4 bg-red-50 border border-red-200 rounded-lg">
      <h4 className="text-sm font-semibold text-red-800">Flag Issue</h4>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Reason</label>
        <select
          value={missReason}
          onChange={(e) => setMissReason(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-red-400"
        >
          <option value="">Select a reason...</option>
          {MISS_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Describe the issue..."
          rows={2}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-red-700">
        <input
          type="checkbox"
          checked={markFailed}
          onChange={(e) => setMarkFailed(e.target.checked)}
          className="rounded border-gray-300"
        />
        Mark as failed (cannot be completed)
      </label>

      {missReason === 'irs_rejected' && (
        <div className="text-xs text-blue-700 bg-blue-50 border border-blue-200 p-2 rounded">
          <strong>Auto-action:</strong> A fax-back email with wet signature instructions will be automatically sent to the entity signer. The entity will be reset to pending until the wet-signed 8821 is received.
        </div>
      )}

      {faxEmailSent && (
        <div className="text-xs text-green-700 bg-green-50 border border-green-200 p-2 rounded">
          Fax-back email sent to signer with wet signature instructions. Entity reset to pending.
        </div>
      )}

      {error && (
        <p className="text-xs text-red-600">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading || faxEmailSent}
          className="px-4 py-2 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 disabled:opacity-50"
        >
          {loading ? 'Submitting...' : faxEmailSent ? 'Submitted' : 'Submit Issue'}
        </button>
        <button
          type="button"
          onClick={onComplete}
          className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
