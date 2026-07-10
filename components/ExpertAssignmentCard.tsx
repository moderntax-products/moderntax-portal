'use client';

import { useState } from 'react';
import { SlaCountdown } from './SlaCountdown';
import { ExpertTranscriptUpload } from './ExpertTranscriptUpload';
import { ExpertFlagIssue } from './ExpertFlagIssue';
import { EntityNotesThread } from './EntityNotesThread';
import { maskTid } from '@/lib/mask';

interface AssignmentCardProps {
  assignment: {
    id: string;
    entity_id: string;
    status: string;
    sla_deadline: string;
    sla_met: boolean | null;
    completed_at: string | null;
    assigned_at: string;
    expert_notes: string | null;
    miss_reason: string | null;
    request_entities: {
      id: string;
      entity_name: string;
      tid: string;
      tid_kind: string;
      form_type: string;
      years: string[];
      signed_8821_url: string | null;
      admin_uploaded_8821_url: string | null;
      transcript_urls: string[] | null;
      request_id: string;
    };
  };
  onRefresh: () => void;
  /** IRS call multi-select */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string, entityName: string, entityId: string) => void;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  assigned: { label: 'Assigned', color: 'bg-blue-100 text-blue-800' },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-800' },
  completed: { label: 'Completed', color: 'bg-green-100 text-green-800' },
  failed: { label: 'Failed', color: 'bg-red-100 text-red-800' },
};

export function ExpertAssignmentCard({ assignment, onRefresh, selectable, selected, onToggleSelect }: AssignmentCardProps) {
  const [showUpload, setShowUpload] = useState(false);
  const [showFlag, setShowFlag] = useState(false);
  const [startingWork, setStartingWork] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const entity = assignment.request_entities;
  const statusInfo = STATUS_LABELS[assignment.status] || { label: assignment.status, color: 'bg-gray-100 text-gray-800' };

  const handleStartWork = async () => {
    setStartingWork(true);
    try {
      const res = await fetch('/api/expert/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start_work',
          assignmentId: assignment.id,
        }),
      });
      if (res.ok) {
        onRefresh();
      }
    } catch (err) {
      console.error('Failed to start work:', err);
    } finally {
      setStartingWork(false);
    }
  };

  const [downloading8821, setDownloading8821] = useState(false);
  // In-dashboard IRS faxing (Sinch) — replaces the offline fax tool.
  const [showFax, setShowFax] = useState(false);
  const [faxNumber, setFaxNumber] = useState('');
  const [sendingFax, setSendingFax] = useState(false);
  const [faxError, setFaxError] = useState<string | null>(null);
  const [faxes, setFaxes] = useState<Array<{ fax_id: string; to: string; status: string; sent_at: string }>>([]);

  const loadFaxes = async () => {
    try {
      const res = await fetch(`/api/expert/fax-8821?entityId=${entity.id}`);
      if (res.ok) setFaxes((await res.json()).faxes || []);
    } catch { /* non-fatal */ }
  };

  const handleToggleFax = () => {
    const next = !showFax;
    setShowFax(next);
    if (next) loadFaxes();
  };

  const handleSendFax = async () => {
    setFaxError(null);
    setSendingFax(true);
    try {
      const res = await fetch('/api/expert/fax-8821', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId: entity.id, toNumber: faxNumber }),
      });
      const data = await res.json();
      if (!res.ok) { setFaxError(data.error || 'Fax failed to send'); return; }
      setFaxNumber('');
      await loadFaxes();
    } catch {
      setFaxError('Fax failed to send — try again');
    } finally {
      setSendingFax(false);
    }
  };

  const handleDownload8821 = async () => {
    if (!entity.admin_uploaded_8821_url && !entity.signed_8821_url) return;
    setDownloading8821(true);
    setDownloadError(null);
    try {
      const res = await fetch(`/api/expert/download-8821?entityId=${entity.id}`);
      const data = await res.json();
      if (res.ok && data.url) {
        window.open(data.url, '_blank');
      } else {
        console.error('Download failed:', data.error);
        setDownloadError(data.error || 'Failed to download 8821');
      }
    } catch (err) {
      console.error('Download error:', err);
      setDownloadError('Failed to download 8821');
    } finally {
      setDownloading8821(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-100">
        <div className="flex items-center gap-3">
          {selectable && ['assigned', 'in_progress'].includes(assignment.status) && (
            <input
              type="checkbox"
              checked={selected || false}
              onChange={() => onToggleSelect?.(assignment.id, entity.entity_name, entity.id)}
              className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500 cursor-pointer"
              title="Select for IRS PPS call"
            />
          )}
          <h3 className="font-semibold text-gray-900">{entity.entity_name}</h3>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
            {statusInfo.label}
          </span>
        </div>
        <SlaCountdown slaDeadline={assignment.sla_deadline} status={assignment.status} slaMet={assignment.sla_met} completedAt={assignment.completed_at} />
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <span className="text-gray-500 text-xs">TID</span>
            <p className="font-mono text-gray-900">{maskTid(entity.tid, entity.tid_kind as 'EIN' | 'SSN')}</p>
          </div>
          <div>
            <span className="text-gray-500 text-xs">Form</span>
            <p className="text-gray-900">{entity.form_type}</p>
          </div>
          <div>
            <span className="text-gray-500 text-xs">Years</span>
            <p className="text-gray-900">{entity.years.join(', ')}</p>
          </div>
          <div>
            <span className="text-gray-500 text-xs">Assigned</span>
            <p className="text-gray-900">{new Date(assignment.assigned_at).toLocaleDateString()}</p>
          </div>
        </div>

        {assignment.expert_notes && (
          <div className="text-xs text-gray-600 bg-gray-50 p-2 rounded">
            <span className="font-medium">Notes:</span> {assignment.expert_notes}
          </div>
        )}

        {assignment.miss_reason && (
          <div className="text-xs text-red-600 bg-red-50 p-2 rounded">
            <span className="font-medium">Issue:</span> {assignment.miss_reason}
          </div>
        )}

        {/* Uploaded files view (visible on active AND completed assignments) */}
        {entity.transcript_urls && entity.transcript_urls.length > 0 && !showUpload && (
          <div className="space-y-1 pt-2 border-t border-gray-100">
            <p className={`text-xs font-medium ${assignment.status === 'completed' ? 'text-green-700' : 'text-blue-700'}`}>
              {assignment.status === 'completed' ? 'Uploaded' : 'Progress'} ({entity.transcript_urls.length} / {entity.years.length * 2} expected)
            </p>
            <div className="space-y-1">
              {entity.transcript_urls.map((url: string, i: number) => {
                const parts = url.split('/');
                const filename = parts[parts.length - 1].replace(/^\d+-/, '');
                return (
                  <div key={i} className="flex items-center gap-2 text-xs bg-green-50 px-2 py-1.5 rounded">
                    <svg className="w-3.5 h-3.5 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-green-800 truncate">{filename}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Actions — active assignments get full controls, completed get add-file only */}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
          {entity.form_type === 'W2_INCOME' && ['assigned', 'in_progress'].includes(assignment.status) && (
            <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-indigo-100 text-indigo-700 rounded">
              Wage & Income Request
            </span>
          )}

          {/* Experts only ever get the ADMIN-prepared 8821 (their designee +
              re-wet-signed). Until the admin posts it, show a clear pending
              state instead of a download button to a wrong/e-signed form. */}
          {(entity.admin_uploaded_8821_url || entity.signed_8821_url) ? (
            <button
              onClick={handleDownload8821}
              disabled={downloading8821}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {downloading8821 ? 'Loading...' : 'Download 8821'}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200 rounded-lg">
              8821 being prepared by admin
            </span>
          )}

          {(entity.admin_uploaded_8821_url || entity.signed_8821_url) && ['assigned', 'in_progress'].includes(assignment.status) && (
            <button
              onClick={handleToggleFax}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100"
            >
              📠 {showFax ? 'Hide fax' : 'Fax 8821 to IRS'}
            </button>
          )}

          {assignment.status === 'assigned' && (
            <button
              onClick={handleStartWork}
              disabled={startingWork}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200 disabled:opacity-50"
            >
              Start Work
            </button>
          )}

          <button
            onClick={() => { setShowUpload(!showUpload); setShowFlag(false); }}
            className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg ${
              assignment.status === 'completed'
                ? 'bg-green-100 text-green-700 hover:bg-green-200'
                : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            {assignment.status === 'completed' ? 'Add Files' : 'Upload Transcripts'}
          </button>

          {['assigned', 'in_progress'].includes(assignment.status) && (
            <button
              onClick={() => { setShowFlag(!showFlag); setShowUpload(false); }}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-red-100 text-red-700 rounded-lg hover:bg-red-200"
            >
              Flag Issue
            </button>
          )}
        </div>

        {downloadError && (
          <p className="text-xs text-red-600">{downloadError}</p>
        )}

        {/* In-dashboard IRS fax (Sinch) */}
        {showFax && (
          <div className="border border-blue-200 bg-blue-50/50 rounded-lg p-3 space-y-2">
            <p className="text-xs font-medium text-blue-900">Fax this entity&apos;s 8821 straight to the IRS — no external fax tool needed.</p>
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: 'CAF Unit — Ogden', num: '855-214-7522' },
                { label: 'CAF Unit — Memphis', num: '855-214-7519' },
              ].map((p) => (
                <button key={p.num} type="button" onClick={() => setFaxNumber(p.num)}
                  className={`px-2 py-1 text-[11px] rounded border ${faxNumber === p.num ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-blue-700 border-blue-300 hover:bg-blue-100'}`}>
                  {p.label} · {p.num}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="tel"
                value={faxNumber}
                onChange={(e) => setFaxNumber(e.target.value)}
                placeholder="Fax number (e.g. the one the PPS rep gives you)"
                className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                onClick={handleSendFax}
                disabled={sendingFax || !faxNumber.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {sendingFax ? 'Sending…' : 'Send fax'}
              </button>
            </div>
            {faxError && <p className="text-xs text-red-600">{faxError}</p>}
            {faxes.length > 0 && (
              <div className="space-y-1 pt-1">
                {faxes.slice(0, 3).map((f) => {
                  const s = (f.status || '').toUpperCase();
                  const done = s === 'COMPLETED' || s === 'DELIVERED';
                  const failed = s.includes('FAIL');
                  return (
                    <div key={f.fax_id} className={`flex items-center justify-between text-[11px] px-2 py-1 rounded ${done ? 'bg-green-50 text-green-800' : failed ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-600'}`}>
                      <span>→ {f.to}</span>
                      <span className="font-medium">{done ? '✓ Delivered' : failed ? '✗ Failed' : s || 'Queued'} · {new Date(f.sent_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Expandable sections */}
        {showUpload && (
          <ExpertTranscriptUpload
            assignmentId={assignment.id}
            entityId={entity.id}
            entityYears={entity.years}
            existingUrls={entity.transcript_urls || []}
            onComplete={() => { setShowUpload(false); onRefresh(); }}
          />
        )}

        {showFlag && (
          <ExpertFlagIssue
            assignmentId={assignment.id}
            onComplete={() => { setShowFlag(false); onRefresh(); }}
          />
        )}

        {/* Admin <-> expert ops thread for this entity. Replaces Gmail
            ping-pong for per-entity instructions + status updates per
            Joel Abernathy's 2026-05-26 feedback. */}
        <EntityNotesThread entityId={entity.id} canPost viewerRole="expert" />
      </div>
    </div>
  );
}
