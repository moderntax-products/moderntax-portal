'use client';

import { useState, useCallback } from 'react';

// ---- Status Update Component ----
interface StatusUpdateProps {
  requestId: string;
  currentStatus: string;
  currentNotes: string | null;
}

const REQUEST_STATUSES = [
  { value: 'submitted', label: 'Submitted' },
  { value: '8821_sent', label: '8821 Sent' },
  { value: '8821_signed', label: '8821 Signed' },
  { value: 'irs_queue', label: 'IRS Queue' },
  { value: 'processing', label: 'Processing' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

export function RequestStatusUpdate({ requestId, currentStatus, currentNotes }: StatusUpdateProps) {
  const [status, setStatus] = useState(currentStatus);
  const [notes, setNotes] = useState(currentNotes || '');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleUpdate = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/update-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_request_status',
          requestId,
          status,
          notes: notes || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Update failed' });
      } else {
        setMessage({ type: 'success', text: 'Request status updated successfully' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setLoading(false);
    }
  }, [requestId, status, notes]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Request Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green text-sm bg-white"
          >
            {REQUEST_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Add internal notes about this request..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green text-sm resize-none"
        />
      </div>

      {message && (
        <div className={`text-sm px-4 py-2 rounded-lg ${
          message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {message.text}
        </div>
      )}

      <button
        onClick={handleUpdate}
        disabled={loading}
        className="px-5 py-2 bg-mt-green text-white rounded-lg font-semibold text-sm hover:bg-opacity-90 disabled:opacity-50 transition-colors"
      >
        {loading ? 'Updating...' : 'Update Request'}
      </button>
    </div>
  );
}

// ---- Entity Status Update Component ----
interface EntityStatusUpdateProps {
  entityId: string;
  entityName: string;
  currentStatus: string;
  currentTranscriptUrls: string[] | null;
  currentComplianceScore: number | null;
}

const ENTITY_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'submitted', label: 'Submitted' },
  { value: '8821_sent', label: '8821 Sent' },
  { value: '8821_signed', label: '8821 Signed' },
  { value: 'irs_queue', label: 'IRS Queue' },
  { value: 'processing', label: 'Processing' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

export function EntityStatusUpdate({
  entityId,
  entityName,
  currentStatus,
  currentTranscriptUrls,
  currentComplianceScore,
}: EntityStatusUpdateProps) {
  const [status, setStatus] = useState(currentStatus);
  const [transcriptUrls, setTranscriptUrls] = useState<string>(
    currentTranscriptUrls ? currentTranscriptUrls.join('\n') : ''
  );
  const [complianceScore, setComplianceScore] = useState<string>(
    currentComplianceScore !== null ? String(currentComplianceScore) : ''
  );
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleStatusUpdate = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/update-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_entity_status',
          entityId,
          status,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Update failed' });
      } else {
        setMessage({ type: 'success', text: 'Entity status updated' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setLoading(false);
    }
  }, [entityId, status]);

  const handleTranscriptUpdate = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const urls = transcriptUrls.split('\n').map((u) => u.trim()).filter(Boolean);
      const score = complianceScore ? parseInt(complianceScore, 10) : undefined;

      const res = await fetch('/api/admin/update-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_entity_transcripts',
          entityId,
          transcriptUrls: urls.length > 0 ? urls : null,
          complianceScore: score !== undefined && !isNaN(score) ? score : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Update failed' });
      } else {
        setMessage({ type: 'success', text: 'Transcript data updated' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setLoading(false);
    }
  }, [entityId, transcriptUrls, complianceScore]);

  return (
    <div className="border border-gray-200 rounded-lg p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-mt-dark">{entityName}</h4>
        <span className="text-xs text-gray-400 font-mono">{entityId.slice(0, 8)}...</span>
      </div>

      {/* Status */}
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green text-sm bg-white"
          >
            {ENTITY_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <button
          onClick={handleStatusUpdate}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          Update
        </button>
      </div>

      {/* Transcript URLs */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          Transcript URLs (one per line)
        </label>
        <textarea
          value={transcriptUrls}
          onChange={(e) => setTranscriptUrls(e.target.value)}
          rows={3}
          placeholder="https://storage.example.com/transcript-2024.pdf"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green text-sm font-mono resize-none"
        />
      </div>

      {/* Compliance Score */}
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Compliance Score (0-100)
          </label>
          <input
            type="number"
            min={0}
            max={100}
            value={complianceScore}
            onChange={(e) => setComplianceScore(e.target.value)}
            placeholder="85"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green text-sm"
          />
        </div>
        <button
          onClick={handleTranscriptUpdate}
          disabled={loading}
          className="px-4 py-2 bg-mt-green text-white rounded-lg text-sm font-medium hover:bg-opacity-90 disabled:opacity-50 transition-colors"
        >
          Save Transcripts
        </button>
      </div>

      {message && (
        <div className={`text-sm px-3 py-2 rounded-lg ${
          message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {message.text}
        </div>
      )}
    </div>
  );
}
