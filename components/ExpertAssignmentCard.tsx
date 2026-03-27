'use client';

import { useState } from 'react';
import { SlaCountdown } from './SlaCountdown';
import { ExpertTranscriptUpload } from './ExpertTranscriptUpload';
import { ExpertFlagIssue } from './ExpertFlagIssue';
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
      transcript_urls: string[] | null;
      request_id: string;
    };
  };
  onRefresh: () => void;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  assigned: { label: 'Assigned', color: 'bg-blue-100 text-blue-800' },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-800' },
  completed: { label: 'Completed', color: 'bg-green-100 text-green-800' },
  failed: { label: 'Failed', color: 'bg-red-100 text-red-800' },
};

export function ExpertAssignmentCard({ assignment, onRefresh }: AssignmentCardProps) {
  const [showUpload, setShowUpload] = useState(false);
  const [showFlag, setShowFlag] = useState(false);
  const [startingWork, setStartingWork] = useState(false);

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

  const handleDownload8821 = async () => {
    if (!entity.signed_8821_url) return;
    setDownloading8821(true);
    try {
      const res = await fetch(`/api/expert/download-8821?entityId=${entity.id}`);
      const data = await res.json();
      if (res.ok && data.url) {
        window.open(data.url, '_blank');
      } else {
        console.error('Download failed:', data.error);
        alert(data.error || 'Failed to download 8821');
      }
    } catch (err) {
      console.error('Download error:', err);
      alert('Failed to download 8821');
    } finally {
      setDownloading8821(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-100">
        <div className="flex items-center gap-3">
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

        {/* Uploaded files view (always visible when files exist) */}
        {assignment.status === 'completed' && entity.transcript_urls && entity.transcript_urls.length > 0 && !showUpload && (
          <div className="space-y-1 pt-2 border-t border-gray-100">
            <p className="text-xs font-medium text-green-700">
              Uploaded Files ({entity.transcript_urls.length} / {entity.years.length * 2} expected)
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

          {entity.signed_8821_url && (
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
      </div>
    </div>
  );
}
